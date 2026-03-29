'use strict';

/**
 * server.js — AniTube.news + AnimesDigital Stremio Addon v4.1.0
 *
 * Rotas:
 *   GET /proxy/m3u8    — Proxy de playlists HLS (master + media + segmentos)
 *   GET /proxy/segment — Proxy de segmentos de vídeo (.ts, .m4s, .webp, etc.)
 *   /*                 — Stremio Addon SDK (manifest, catalog, meta, stream)
 */

require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const app = express();
const PORT = parseInt(process.env.PORT || '7000', 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

const UA_PROXY =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ── Utilitário: resolve URL relativa em relação a uma base ───────────────────
function resolveUrl(base, relative) {
  if (!relative) return base;
  if (relative.startsWith('http://') || relative.startsWith('https://')) return relative;
  if (relative.startsWith('//')) return 'https:' + relative;

  try {
    return new URL(relative, base).toString();
  } catch (_) {
    return base.substring(0, base.lastIndexOf('/') + 1) + relative;
  }
}

// ── Identifica headers corretos por domínio ──────────────────────────────────
function buildUpstreamHeaders(targetUrl, referer) {
  let fallbackReferer = 'https://www.anitube.news/';
  let fallbackOrigin = 'https://www.anitube.news';

  try {
    const u = new URL(targetUrl);
    const host = u.hostname.toLowerCase();

    if (host.includes('animesdigital.org')) {
      fallbackReferer = 'https://animesdigital.org/';
      fallbackOrigin = 'https://animesdigital.org';
    } else if (host.includes('anitube.news')) {
      fallbackReferer = 'https://www.anitube.news/';
      fallbackOrigin = 'https://www.anitube.news';
    } else {
      fallbackReferer = referer || `${u.protocol}//${u.host}/`;
      fallbackOrigin = `${u.protocol}//${u.host}`;
    }
  } catch (_) {}

  let finalReferer = referer || fallbackReferer;
  let finalOrigin = fallbackOrigin;

  try {
    finalOrigin = new URL(finalReferer).origin;
  } catch (_) {}

  return {
    'User-Agent': UA_PROXY,
    'Referer': finalReferer,
    'Origin': finalOrigin,
    'Accept': '*/*',
  };
}

// ── Proxy M3U8 ────────────────────────────────────────────────────────────────
app.get('/proxy/m3u8', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('Parâmetro "url" obrigatório');

  try {
    const upstream = await fetch(url, {
      headers: buildUpstreamHeaders(url, referer),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream retornou ${upstream.status}`);
    }

    const text = await upstream.text();
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    const effectiveReferer = referer || guessRefererFromUrl(url);
    const encRef = encodeURIComponent(effectiveReferer);

    const isMaster =
      text.includes('#EXT-X-STREAM-INF') ||
      text.includes('#EXT-X-MEDIA:');

    const rewritten = text
      .split('\n')
      .map((raw) => {
        const line = raw.trim();
        if (!line) return raw;

        if (line.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => {
            const full = resolveUrl(baseUrl, uri);
            return `URI="${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(full)}&referer=${encRef}"`;
          });
        }

        const full = resolveUrl(baseUrl, line);

        if (isMaster || line.endsWith('.m3u8') || line.includes('.m3u8?')) {
          return `${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(full)}&referer=${encRef}`;
        }

        return `${PUBLIC_URL}/proxy/segment?url=${encodeURIComponent(full)}&referer=${encRef}`;
      })
      .join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewritten);

  } catch (e) {
    console.error('[Proxy M3U8]', e.message);
    res.status(500).send(e.message);
  }
});

// ── Proxy Segmento ────────────────────────────────────────────────────────────
app.get('/proxy/segment', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('Parâmetro "url" obrigatório');

  try {
    const upstream = await fetch(url, {
      headers: buildUpstreamHeaders(url, referer),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream retornou ${upstream.status}`);
    }

    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'application/octet-stream'
    );
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);

    upstream.body.pipe(res);

  } catch (e) {
    console.error('[Proxy Segmento]', e.message);
    res.status(500).send(e.message);
  }
});

// ── Helper para inferir referer pelo domínio do recurso ──────────────────────
function guessRefererFromUrl(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const host = u.hostname.toLowerCase();

    if (host.includes('animesdigital.org')) return 'https://animesdigital.org/';
    if (host.includes('anitube.news')) return 'https://www.anitube.news/';

    return `${u.protocol}//${u.host}/`;
  } catch (_) {
    return 'https://www.anitube.news/';
  }
}

// ── Healthcheck opcional ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    name: 'AniTube.news + AnimesDigital',
    version: '4.1.0',
  });
});

// ── Stremio Addon SDK ─────────────────────────────────────────────────────────
app.use(getRouter(addonInterface));

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   🎌 AniTube.news + AnimesDigital – Stremio v4.1    ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Porta   : ${PORT}`);
  console.log(`║  Instalar: ${PUBLIC_URL}/manifest.json`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
});
