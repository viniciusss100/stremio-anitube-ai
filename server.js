'use strict';

/**
 * ══════════════════════════════════════════════════════════════════
 *  Stremio Addon – AniTube.news  v3.0.0 (FHD Fixed)
 * ══════════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { getInterface } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const app = express();
const PORT = parseInt(process.env.PORT || '7000', 10);

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

// ───────────────────────────────────────────────────────────────────────────
// PROXY DE M3U8 (Para fixar FHD/HLS)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rota para processar o arquivo .m3u8 e reescrever as URLs dos segmentos
 */
app.get('/proxy/m3u8', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL faltante');

  console.log(`[Proxy] Processando M3U8: ${url}`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer': referer || 'https://www.anitube.news/',
        'Accept': '*/*'
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    let content = await response.text();
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

    // Reescrever as URLs dos segmentos (.webp, .ts, etc)
    // Procurar por linhas que não começam com # (são URLs)
    const lines = content.split('\n');
    const newLines = lines.map(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        let fullUrl = line;
        if (!line.startsWith('http')) {
          fullUrl = baseUrl + line;
        }
        // Encode para passar como parâmetro
        const proxyUrl = `${req.protocol}://${req.get('host')}/proxy/segment?url=${encodeURIComponent(fullUrl)}&referer=${encodeURIComponent(referer || 'https://www.anitube.news/')}`;
        return proxyUrl;
      }
      return line;
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(newLines.join('\n'));
  } catch (e) {
    console.error(`[Proxy] Erro M3U8: ${e.message}`);
    res.status(500).send(e.message);
  }
});

/**
 * Rota para servir os segmentos de vídeo com os headers corretos
 */
app.get('/proxy/segment', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('URL faltante');

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer': referer || 'https://www.anitube.news/',
        'Accept': '*/*'
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // Repassar os headers originais de cache e tipo
    res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    // Stream do corpo da resposta para economizar memória
    response.body.pipe(res);
  } catch (e) {
    console.error(`[Proxy] Erro Segmento: ${e.message}`);
    res.status(500).send(e.message);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// STREMIO ADDON SDK
// ───────────────────────────────────────────────────────────────────────────

const { serveHTTP } = require('stremio-addon-sdk');

// O SDK do Stremio por padrão usa sua própria instância do Express.
// Vamos usar o serveHTTP mas integrando nossa rota personalizada.
// Mas o jeito mais fácil no SDK é passar a interface e deixar ele rodar, 
// então vamos rodar nosso Express na porta e deixar o SDK rodar junto ou em cima.

// Jeito correto: usar o addonInterface com o Express que já criamos
const { getRouter } = require('stremio-addon-sdk');
const addonRouter = getRouter(addonInterface);

app.use(addonRouter);

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       Stremio Addon – AniTube.news  v3.0.0       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  ✅  Servidor rodando com PROXY FHD ativo!       ║');
  console.log('║                                                  ║');
  console.log(`║  📋  Para instalar no Stremio (Desktop):         ║`);
  console.log(`║      http://127.0.0.1:${PORT}/manifest.json         ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
