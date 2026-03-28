'use strict';

/**
 * ══════════════════════════════════════════════════════════════════
 * Stremio Addon – AniTube.news  v3.3.0 + Bypass SuperFlix
 * CORREÇÕES:
 * - Proxy HLS agora lida com Master Playlist (multi-qualidade)
 * - Sub-playlists (.m3u8 aninhadas) também são proxiadas
 * - Segmentos .ts e .webp são corretamente proxiados
 * - CORS habilitado para compatibilidade com Stremio Web
 * - Player local adicionado para bypass da proteção de iframe
 * ══════════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const app  = express();
const PORT = parseInt(process.env.PORT || '7000', 10);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

// ───────────────────────────────────────────────────────────────────────────
// CORS — necessário para Stremio Web e players externos
// ───────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ───────────────────────────────────────────────────────────────────────────
// UTILITÁRIO: resolver URL relativa a partir de uma base
// ───────────────────────────────────────────────────────────────────────────
function resolveUrl(base, relative) {
  if (!relative) return base;
  if (relative.startsWith('http://') || relative.startsWith('https://')) return relative;
  if (relative.startsWith('//')) return 'https:' + relative;
  try {
    return new URL(relative, base).toString();
  } catch (_) {
    const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
    return baseDir + relative;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// PROXY DE M3U8 — lida com Master Playlist e Media Playlist
// ───────────────────────────────────────────────────────────────────────────
app.get('/proxy/m3u8', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL faltante');

  console.log(`[Proxy M3U8] Processando: ${url}`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer'   : referer || 'https://www.anitube.news/',
        'Origin'    : 'https://www.anitube.news',
        'Accept'    : '*/*',
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} para ${url}`);

    const content = await response.text();
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    const encodedReferer = encodeURIComponent(referer || 'https://www.anitube.news/');

    const lines    = content.split('\n');
    const newLines = [];
    let isMaster   = false;

    if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
      isMaster = true;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        newLines.push(line);
        continue;
      }

      if (trimmed.startsWith('#')) {
        const rewritten = trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
          const fullUri = resolveUrl(baseUrl, uri);
          const proxyUri = `${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(fullUri)}&referer=${encodedReferer}`;
          return `URI="${proxyUri}"`;
        });
        newLines.push(rewritten);
        continue;
      }

      const fullUrl = resolveUrl(baseUrl, trimmed);

      if (isMaster || trimmed.endsWith('.m3u8') || trimmed.includes('.m3u8?')) {
        const proxyUrl = `${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(fullUrl)}&referer=${encodedReferer}`;
        newLines.push(proxyUrl);
      } else {
        const proxyUrl = `${PUBLIC_URL}/proxy/segment?url=${encodeURIComponent(fullUrl)}&referer=${encodedReferer}`;
        newLines.push(proxyUrl);
      }
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(newLines.join('\n'));

  } catch (e) {
    console.error(`[Proxy M3U8] Erro: ${e.message}`);
    res.status(500).send(e.message);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PROXY DE SEGMENTO — serve .ts, .webp e outros segmentos de vídeo
// ───────────────────────────────────────────────────────────────────────────
app.get('/proxy/segment', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL faltante');

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer'   : referer || 'https://www.anitube.news/',
        'Origin'    : 'https://www.anitube.news',
        'Accept'    : '*/*',
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || 'video/mp2t';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    response.body.pipe(res);

  } catch (e) {
    console.error(`[Proxy Segmento] Erro: ${e.message}`);
    res.status(500).send(e.message);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PLAYER EMBED (Bypass de Proteção do SuperFlix)
// ───────────────────────────────────────────────────────────────────────────
app.get('/player', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL faltante');

  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SuperFlix Player</title>
      <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
        iframe { width: 100%; height: 100%; border: none; }
      </style>
    </head>
    <body>
      <iframe src="${url}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
    </body>
    </html>
  `);
});

// ───────────────────────────────────────────────────────────────────────────
// STREMIO ADDON SDK
// ───────────────────────────────────────────────────────────────────────────
const addonRouter = getRouter(addonInterface);
app.use(addonRouter);

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       Stremio Addon – AniTube.news  v3.3.0       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  ✅  Servidor rodando com PROXY HLS corrigido!   ║');
  console.log('║  ✅  Player bypass SuperFlix ativado!            ║');
  console.log('║                                                  ║');
  console.log(`║  📋  Para instalar no Stremio (Desktop):         ║`);
  console.log(`║      http://127.0.0.1:${PORT}/manifest.json         ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  PUBLIC_URL configurado: ${PUBLIC_URL}`);
  console.log('  (Para acesso remoto, defina PUBLIC_URL no .env)');
  console.log('');
});
