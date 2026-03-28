'use strict';

/**
 * providers.js — v2.0.0
 *
 * Provedores de stream por ID IMDB/TMDB — sem scraping, sem Cloudflare.
 *
 * Estratégia:
 *   O Stremio não consegue reproduzir players embed diretamente (são páginas HTML).
 *   Para cada provedor, nosso servidor faz a requisição, extrai a URL real
 *   do stream (M3U8 / MP4) do HTML/JS da página, e entrega ao Stremio.
 *
 * Provedores integrados (todos gratuitos, sem chave de API):
 *   1. VidSrc.cc    — maior cobertura, múltiplos servidores, HLS
 *   2. AutoEmbed    — player.autoembed.cc, retorna JSON com fontes
 *   3. 2Embed       — 2embed.stream, HLS em múltiplas qualidades
 *   4. SuperFlixAPI — superflixapi.run (com Referer correto via proxy)
 *   5. GoDrivePlayer— player.php?imdb=, HLS direto
 */

const fetch  = require('node-fetch');
const crypto = require('crypto');

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                   '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_MOBILE  = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
                   '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const PORT       = parseInt(process.env.PORT || '7000', 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function safeFetch(url, opts = {}, timeout = 15000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Proxy M3U8 helper — envolve URL no proxy local ───────────────────────────
function proxyM3U8(url, referer) {
  return `${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer || '')}`;
}

// ────────────────────────────────────────────────────────────────────────────
// PROVEDOR 1: VidSrc.cc
// Documentação: https://vidsrc.cc
// Endpoint filme: https://vidsrc.cc/v2/embed/movie/{imdbId}
// Endpoint série: https://vidsrc.cc/v2/embed/tv/{imdbId}/{season}/{episode}
// Estratégia: fetch da página → extrai sourceUrl da chamada JS interna
// ────────────────────────────────────────────────────────────────────────────
async function extractVidSrc(imdbId, type, season, episode) {
  const streams = [];
  try {
    const isMovie = type === 'movie';
    const pageUrl = isMovie
      ? `https://vidsrc.cc/v2/embed/movie/${imdbId}`
      : `https://vidsrc.cc/v2/embed/tv/${imdbId}/${season || 1}/${episode || 1}`;

    const res = await safeFetch(pageUrl, {
      headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://vidsrc.cc/' },
    });
    if (!res.ok) return streams;
    const html = await res.text();

    // VidSrc carrega fontes via script — procura apiUrl ou sourceUrl
    const apiMatch =
      html.match(/sourceUrl\s*[=:]\s*["']([^"']+\.m3u8[^"']*)/i) ||
      html.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)/i) ||
      html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);

    if (apiMatch) {
      streams.push({
        url        : proxyM3U8(apiMatch[1], pageUrl),
        name       : '📺 VidSrc',
        description: 'VidSrc.cc • HLS',
        behaviorHints: { notWebReady: false },
      });
    }

    // VidSrc às vezes retorna o endpoint de sources via JSON interno
    const srcJsonMatch = html.match(/srcs\s*[:=]\s*(\[[^\]]+\])/);
    if (srcJsonMatch) {
      try {
        const srcs = JSON.parse(srcJsonMatch[1]);
        for (const s of srcs) {
          const u = s.file || s.src || s.url;
          if (u && u.includes('.m3u8')) {
            streams.push({
              url        : proxyM3U8(u, pageUrl),
              name       : `📺 VidSrc (${s.label || 'HLS'})`,
              description: `VidSrc.cc • ${s.label || 'HLS'}`,
              behaviorHints: { notWebReady: false },
            });
          }
        }
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[VidSrc] Erro:', e.message);
  }
  return streams;
}

// ────────────────────────────────────────────────────────────────────────────
// PROVEDOR 2: AutoEmbed (player.autoembed.cc)
// Endpoint filme: https://player.autoembed.cc/embed/movie/{imdbId}
// Endpoint série: https://player.autoembed.cc/embed/tv/{imdbId}/{season}/{episode}
// Tem API JSON: /api/getVideoSource?type=movie&id={imdbId}
// ────────────────────────────────────────────────────────────────────────────
async function extractAutoEmbed(imdbId, type, season, episode) {
  const streams = [];
  try {
    const isMovie = type === 'movie';

    // Tenta API JSON primeiro (mais confiável)
    const apiUrl = isMovie
      ? `https://player.autoembed.cc/api/getVideoSource?type=movie&id=${imdbId}`
      : `https://player.autoembed.cc/api/getVideoSource?type=tv&id=${imdbId}&season=${season || 1}&episode=${episode || 1}`;

    const apiRes = await safeFetch(apiUrl, {
      headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://autoembed.cc/', Accept: 'application/json' },
    });

    if (apiRes.ok) {
      const json = await apiRes.json();
      // Resposta: { videoSource: "https://...m3u8", subtitles: [...] }
      const src = json?.videoSource || json?.source || json?.url;
      if (src && (src.includes('.m3u8') || src.includes('.mp4'))) {
        const isHLS = src.includes('.m3u8');
        streams.push({
          url        : isHLS ? proxyM3U8(src, 'https://player.autoembed.cc/') : src,
          name       : '🎬 AutoEmbed',
          description: `AutoEmbed • ${isHLS ? 'HLS' : 'MP4'}`,
          behaviorHints: { notWebReady: false },
        });
      }
    }

    // Fallback: página HTML
    if (!streams.length) {
      const pageUrl = isMovie
        ? `https://player.autoembed.cc/embed/movie/${imdbId}`
        : `https://player.autoembed.cc/embed/tv/${imdbId}/${season || 1}/${episode || 1}`;

      const res = await safeFetch(pageUrl, {
        headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://autoembed.cc/' },
      });
      if (res.ok) {
        const html = await res.text();
        const m    = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
        if (m) {
          streams.push({
            url        : proxyM3U8(m[1], pageUrl),
            name       : '🎬 AutoEmbed',
            description: 'AutoEmbed • HLS',
            behaviorHints: { notWebReady: false },
          });
        }
      }
    }
  } catch (e) {
    console.warn('[AutoEmbed] Erro:', e.message);
  }
  return streams;
}

// ────────────────────────────────────────────────────────────────────────────
// PROVEDOR 3: 2Embed (2embed.stream)
// Endpoint filme: https://www.2embed.stream/embed/movie/{imdbId}
// Endpoint série: https://www.2embed.stream/embed/tv/{imdbId}/{season}/{episode}
// ────────────────────────────────────────────────────────────────────────────
async function extract2Embed(imdbId, type, season, episode) {
  const streams = [];
  try {
    const isMovie = type === 'movie';
    const pageUrl = isMovie
      ? `https://www.2embed.stream/embed/movie/${imdbId}`
      : `https://www.2embed.stream/embed/tv/${imdbId}/${season || 1}/${episode || 1}`;

    const res = await safeFetch(pageUrl, {
      headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://www.2embed.stream/' },
    });
    if (!res.ok) return streams;
    const html = await res.text();

    // Procura por URLs M3U8 no JS inline
    const patterns = [
      /["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
      /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
      /source\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
    ];

    const found = new Set();
    for (const pat of patterns) {
      let m;
      while ((m = pat.exec(html)) !== null) {
        if (!found.has(m[1])) {
          found.add(m[1]);
          streams.push({
            url        : proxyM3U8(m[1], pageUrl),
            name       : '📡 2Embed',
            description: '2Embed.stream • HLS',
            behaviorHints: { notWebReady: false },
          });
        }
      }
    }

    // MP4 como fallback
    if (!streams.length) {
      const mp4 = html.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)/i);
      if (mp4) {
        streams.push({
          url        : mp4[1],
          name       : '📡 2Embed',
          description: '2Embed.stream • MP4',
          behaviorHints: { notWebReady: false },
        });
      }
    }
  } catch (e) {
    console.warn('[2Embed] Erro:', e.message);
  }
  return streams;
}

// ────────────────────────────────────────────────────────────────────────────
// PROVEDOR 4: SuperFlixAPI (com Referer correto via proxy)
// O "Acesso Restrito" acontece porque falta o Referer de um site parceiro.
// Nosso proxy injeta o Referer correto (superflixapi.rest/doc) e extrai o stream.
// ────────────────────────────────────────────────────────────────────────────
async function extractSuperFlix(imdbId, type, season, episode) {
  const streams = [];
  try {
    const isMovie = type === 'movie';
    const SF_BASE = (process.env.SF_BASE_URL || 'https://superflixapi.run').replace(/\/$/, '');

    const pageUrl = isMovie
      ? `${SF_BASE}/filme/${imdbId}`
      : `${SF_BASE}/serie/${imdbId}/${season || 1}/${episode || 1}`;

    // Injeta Referer de domínio parceiro — resolve o "Acesso Restrito"
    const res = await safeFetch(pageUrl, {
      headers: {
        'User-Agent': UA_DESKTOP,
        'Referer'   : `${SF_BASE}/doc`,          // Referer do próprio site = parceiro autorizado
        'Origin'    : SF_BASE,
        'Accept'    : 'text/html,*/*',
      },
    });

    if (!res.ok) return streams;
    const html = await res.text();

    // Extrai M3U8 do JS inline do player
    const m3u8Patterns = [
      /["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/gi,
      /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
      /hls\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
      /source\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
    ];

    const found = new Set();
    for (const pat of m3u8Patterns) {
      let m;
      while ((m = pat.exec(html)) !== null) {
        if (!found.has(m[1])) {
          found.add(m[1]);
          streams.push({
            url        : proxyM3U8(m[1], pageUrl),
            name       : '🇧🇷 SuperFlix BR',
            description: `SuperFlixAPI • HLS${isMovie ? '' : ` S${season||1}E${episode||1}`}`,
            behaviorHints: { notWebReady: false },
          });
        }
      }
    }

    // Procura iframes aninhados (SF às vezes embeda outro player)
    if (!streams.length) {
      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (iframeMatch && !iframeMatch[1].includes(SF_BASE)) {
        // Tenta extrair do iframe aninhado
        const nested = await extractFromIframe(iframeMatch[1], pageUrl);
        streams.push(...nested.map(s => ({ ...s, name: `🇧🇷 SuperFlix BR` })));
      }
    }
  } catch (e) {
    console.warn('[SuperFlix] Erro:', e.message);
  }
  return streams;
}

// ────────────────────────────────────────────────────────────────────────────
// PROVEDOR 5: GoDrivePlayer
// Endpoint: https://godriveplayer.com/player.php?imdb={imdbId}
// ────────────────────────────────────────────────────────────────────────────
async function extractGoDrive(imdbId, type, season, episode) {
  const streams = [];
  try {
    const isMovie = type === 'movie';
    let pageUrl = `https://godriveplayer.com/player.php?imdb=${imdbId}`;
    if (!isMovie) pageUrl += `&season=${season || 1}&episode=${episode || 1}`;

    const res = await safeFetch(pageUrl, {
      headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://godriveplayer.com/' },
    });
    if (!res.ok) return streams;
    const html = await res.text();

    const m = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
    if (m) {
      streams.push({
        url        : proxyM3U8(m[1], pageUrl),
        name       : '☁️ GoDrive',
        description: 'GoDrivePlayer • HLS',
        behaviorHints: { notWebReady: false },
      });
    }
  } catch (e) {
    console.warn('[GoDrive] Erro:', e.message);
  }
  return streams;
}

// ── Extrator genérico de iframes aninhados ────────────────────────────────────
async function extractFromIframe(iframeSrc, referer) {
  const streams = [];
  try {
    const fullSrc = iframeSrc.startsWith('//') ? 'https:' + iframeSrc : iframeSrc;
    const res = await safeFetch(fullSrc, {
      headers: { 'User-Agent': UA_DESKTOP, Referer: referer },
      redirect: 'follow',
    });
    if (!res.ok) return streams;
    const html = await res.text();

    const m3u8 = html.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i);
    if (m3u8) {
      streams.push({
        url        : proxyM3U8(m3u8[1], fullSrc),
        name       : 'HLS',
        description: 'HLS',
        behaviorHints: { notWebReady: false },
      });
    }
    const mp4 = !m3u8 && html.match(/["'](https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*)/i);
    if (mp4) {
      streams.push({ url: mp4[1], name: 'MP4', description: 'MP4', behaviorHints: { notWebReady: false } });
    }
  } catch (_) {}
  return streams;
}

// ── Função principal: agrega todos os provedores em paralelo ──────────────────

/**
 * Busca streams de todos os provedores em paralelo.
 * Retorna os primeiros resultados válidos de cada provedor.
 * @param {string} imdbId  — ex: "tt0816692"
 * @param {'movie'|'series'} type
 * @param {number|null} season
 * @param {number|null} episode
 */
async function getAllStreams(imdbId, type, season, episode) {
  const stremioType = type === 'movie' ? 'movie' : 'series';

  console.log(`[Providers] Buscando streams: ${imdbId} (${stremioType}) S${season}E${episode}`);

  const results = await Promise.allSettled([
    extractSuperFlix(imdbId, stremioType, season, episode),
    extractVidSrc(imdbId, stremioType, season, episode),
    extractAutoEmbed(imdbId, stremioType, season, episode),
    extract2Embed(imdbId, stremioType, season, episode),
    extractGoDrive(imdbId, stremioType, season, episode),
  ]);

  const allStreams = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      allStreams.push(...r.value);
    }
  }

  console.log(`[Providers] Total de streams encontradas: ${allStreams.length}`);
  return allStreams;
}

module.exports = { getAllStreams };
