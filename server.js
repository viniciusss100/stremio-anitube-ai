'use strict';

/**
 * server.js — AniTube.news Stremio Addon v4.0.0
 *
 * Rotas:
 *   GET /proxy/m3u8    — Proxy de playlists HLS (master + media + segmentos)
 *   GET /proxy/segment — Proxy de segmentos de vídeo (.ts, .webp)
 *   /*                 — Stremio Addon SDK (manifest, catalog, meta, stream)
 */

require('dotenv').config();

const express = require('express');
const fetch   = require('node-fetch');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const app        = express();
const PORT       = parseInt(process.env.PORT || '7000', 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

const UA_PROXY = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
                 '(KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ── Utilitário: resolve URL relativa em relação a uma base ────────────────────
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

// ── Proxy M3U8 ────────────────────────────────────────────────────────────────
// Reescreve URLs de segmentos e sub-playlists para passarem pelo proxy,
// garantindo que os headers corretos (Referer, UA) sejam enviados.
app.get('/proxy/m3u8', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('Parâmetro "url" obrigatório');

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': UA_PROXY,
        'Referer'   : referer || 'https://www.anitube.news/',
        'Origin'    : 'https://www.anitube.news',
        'Accept'    : '*/*',
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream retornou ${upstream.status}`);
    }

    const text    = await upstream.text();
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    const encRef  = encodeURIComponent(referer || 'https://www.anitube.news/');

    // Detecta se é Master Playlist (contém referências a sub-playlists)
    const isMaster = text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA:');

    const rewritten = text.split('\n').map(raw => {
      const line = raw.trim();
      if (!line) return raw;

      // Linha de comentário/tag — reescreve apenas URI="..." dentro das tags
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const full = resolveUrl(baseUrl, uri);
          return `URI="${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(full)}&referer=${encRef}"`;
        });
      }

      // Linha de URI — sub-playlist ou segmento
      const full = resolveUrl(baseUrl, line);
      if (isMaster || line.endsWith('.m3u8') || line.includes('.m3u8?')) {
        return `${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(full)}&referer=${encRef}`;
      }
      return `${PUBLIC_URL}/proxy/segment?url=${encodeURIComponent(full)}&referer=${encRef}`;

    }).join('\n');

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
    const headers = {
      'User-Agent': UA_PROXY,
      'Referer'   : referer || 'https://www.anitube.news/',
      'Origin'    : 'https://www.anitube.news',
      'Accept'    : '*/*',
    };

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(url, { headers });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream retornou ${upstream.status}`);
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const passthroughHeaders = [
      'content-length',
      'content-range',
      'accept-ranges',
      'etag',
      'last-modified',
    ];

    for (const header of passthroughHeaders) {
      const value = upstream.headers.get(header);
      if (value) {
        res.setHeader(header, value);
      }
    }

    upstream.body.pipe(res);

  } catch (e) {
    console.error('[Proxy Segmento]', e.message);
    res.status(500).send(e.message);
  }
});

// ── Stremio Addon SDK ─────────────────────────────────────────────────────────
app.use(getRouter(addonInterface));

app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║      🎌 AniTube.news – Stremio Addon v4.0     ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  Porta   : ${PORT}                               ║`);
  console.log(`║  Instalar: ${PUBLIC_URL}/manifest.json`);
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
});
