'use strict';

/**
 * Extrator de streams para RedeCanais — v1.0.0
 *
 * O RedeCanais embeda conteúdo via:
 *   1. Blogger (mesmo esquema que AniTube)
 *   2. Players de terceiros (streamtape, mixdrop, filemoon, etc.)
 *   3. HLS direto em iframes próprios
 *   4. Redirecionamentos encadeados
 */

const fetch  = require('node-fetch');
const crypto = require('crypto');

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                   'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_MOBILE  = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
                   '(KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

const PORT       = parseInt(process.env.PORT || '7000', 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

const RC_BASE_URL = (process.env.RC_BASE_URL || 'https://redecanais.dev').replace(/\/$/, '');

// ── Utilitários ─────────────────────────────────────────────────────────────

async function safeFetch(url, opts = {}, timeout = 15000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractBloggerToken(url) {
  const m = url.match(/[?&]token=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function decodeGoogleVideoUrl(raw) {
  let url = raw;
  for (let i = 0; i < 4; i++) {
    url = url.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    url = url.replace(/\\\//g, '/').replace(/\\\\/g, '\\').replace(/\\=/g, '=').replace(/\\&/g, '&');
  }
  return url.replace(/^"+|"+$/g, '').trim();
}

function extractItagFromUrl(url) {
  const m = url.match(/[&?]itag[=%](\d+)/i) || url.match(/itag=(\d+)/);
  return m ? parseInt(m[1], 10) : 18;
}

const ITAG_QUALITY = { 37: 1080, 22: 720, 59: 480, 18: 360 };
const QUALITY_LABEL = { 1080: 'FHD 1080p', 720: 'HD 720p', 480: 'SD 480p', 360: 'SD 360p' };

function parseGoogleVideoUrls(responseText) {
  const videos  = [];
  const cleaned = responseText.replace(/^\)\]}'[\s\n]*/, '');
  const wrbMatch = cleaned.match(/\[\s*\[\s*"wrb\.fr"\s*,[^,]+,\s*"([\s\S]+?)"\s*,\s*null/);
  let jsonStr    = wrbMatch ? wrbMatch[1] : cleaned;
  jsonStr = jsonStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
                   .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  const urlPattern = /"((?:https?:(?:\\\/|\/))[^"]*?googlevideo[^"]*?)",\[(\d+)\]/g;
  let m;
  while ((m = urlPattern.exec(jsonStr)) !== null) {
    const decoded = decodeGoogleVideoUrl(m[1]);
    const itag    = parseInt(m[2], 10);
    if (decoded?.includes('googlevideo.com')) {
      videos.push({ url: decoded, itag, quality: ITAG_QUALITY[itag] || 360 });
    }
  }

  if (!videos.length) {
    const fallback = /https?:[^\s"'<>]*googlevideo\.com[^\s"'<>\\]+/g;
    while ((m = fallback.exec(jsonStr)) !== null) {
      const decoded = decodeGoogleVideoUrl(m[0]);
      const itag    = extractItagFromUrl(decoded);
      if (!videos.some(v => v.itag === itag)) {
        videos.push({ url: decoded, itag, quality: ITAG_QUALITY[itag] || 360 });
      }
    }
  }

  const seen   = new Set();
  const unique = videos.filter(v => { if (seen.has(v.itag)) return false; seen.add(v.itag); return true; });
  const order  = [37, 22, 59, 18];
  unique.sort((a, b) => {
    const ia = order.indexOf(a.itag), ib = order.indexOf(b.itag);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return unique;
}

async function fetchBloggerStreams(token) {
  const reqid  = Math.floor(10000 + Math.random() * 89999);
  const bl     = 'boq_bloggeruiserver_20260317.01_p0';
  const apiUrl = `https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute?rpcids=WcwnYd&source-path=%2Fvideo.g&bl=${bl}&_reqid=${reqid}&rt=c`;
  const body   = `f.req=[[[\"WcwnYd\",\"[\\\"${token}\\\"]\",null,\"generic\"]]]&`;
  try {
    const res = await safeFetch(apiUrl, {
      method : 'POST',
      headers: { 'User-Agent': UA_MOBILE, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
      body,
    });
    if (!res.ok) return [];
    return parseGoogleVideoUrls(await res.text());
  } catch (_) { return []; }
}

// ── Extratores por tipo de player ────────────────────────────────────────────

/**
 * Streamtape: extrai URL de download direto.
 * Padrão: document.getElementById('ideoooolink').innerHTML = "/...";
 */
async function extractStreamtape(iframeSrc, referer) {
  try {
    const res = await safeFetch(iframeSrc, {
      headers: { 'User-Agent': UA_DESKTOP, Referer: referer, Accept: 'text/html,*/*' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m    = html.match(/getElementById\(['"]ideoooolink['"]\)\.innerHTML\s*=\s*"([^"]+)"/);
    if (m) {
      const url = 'https:' + m[1].replace(/\s/g, '');
      return { url, name: 'RedeCanais | Streamtape', description: 'Streamtape', behaviorHints: { notWebReady: false } };
    }
    // Alternativa mais recente
    const m2 = html.match(/\.href\s*=\s*"(\/\/streamtape[^"]+)"/);
    if (m2) {
      return { url: 'https:' + m2[1], name: 'RedeCanais | Streamtape', description: 'Streamtape', behaviorHints: { notWebReady: false } };
    }
  } catch (_) {}
  return null;
}

/**
 * Mixdrop: extrai o link wurl do script inline.
 * Padrão: MDCore.wurl="https://...";
 */
async function extractMixdrop(iframeSrc, referer) {
  try {
    const res = await safeFetch(iframeSrc, {
      headers: { 'User-Agent': UA_DESKTOP, Referer: referer },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m    = html.match(/MDCore\.wurl\s*=\s*"([^"]+)"/);
    if (m) {
      const url = m[1].startsWith('http') ? m[1] : 'https:' + m[1];
      return { url, name: 'RedeCanais | Mixdrop', description: 'Mixdrop', behaviorHints: { notWebReady: false } };
    }
  } catch (_) {}
  return null;
}

/**
 * Extrator genérico: busca M3U8, Blogger, e outros padrões no HTML do iframe.
 */
async function extractGeneric(iframeSrc, referer) {
  try {
    const res = await safeFetch(iframeSrc, {
      headers: { 'User-Agent': UA_MOBILE, Referer: referer || RC_BASE_URL + '/', Accept: 'text/html,*/*' },
      redirect: 'follow',
    });
    if (!res.ok) return [];
    const html   = await res.text();
    const result = [];

    // Blogger
    const bloggerMatch = html.match(/src=["'](https?:\/\/(?:www\.)?blogger\.com\/video\.g[^"']+)["']/i);
    if (bloggerMatch) {
      const bUrl  = bloggerMatch[1].replace(/&amp;/g, '&');
      const token = extractBloggerToken(bUrl);
      if (token) {
        const vids = await fetchBloggerStreams(token);
        for (const v of vids) {
          const label = QUALITY_LABEL[v.quality] || `${v.quality}p`;
          result.push({
            url        : v.url,
            name       : 'RedeCanais | Blogger',
            description: `GoogleVideo ${label}`,
            behaviorHints: {
              notWebReady: false,
              proxyHeaders: { request: { Referer: 'https://youtube.googleapis.com/', 'User-Agent': UA_MOBILE } },
            },
          });
        }
        return result;
      }
    }

    // HLS M3U8
    const m3u8Patterns = [
      /["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i,
      /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i,
      /source\s+src=["'](https?:\/\/[^"']+\.m3u8)/i,
      /hls\s*:\s*["'](https?:\/\/[^"']+\.m3u8)/i,
    ];
    for (const pat of m3u8Patterns) {
      const m = html.match(pat);
      if (m) {
        const proxyUrl = `${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(m[1])}&referer=${encodeURIComponent(referer || RC_BASE_URL + '/')}`;
        result.push({ url: proxyUrl, name: 'RedeCanais | HLS', description: 'HLS Stream', behaviorHints: { notWebReady: false } });
        break;
      }
    }

    // MP4 direto
    if (!result.length) {
      const mp4Match = html.match(/["'](https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*)/i);
      if (mp4Match) {
        result.push({ url: mp4Match[1], name: 'RedeCanais | MP4', description: 'Direto', behaviorHints: { notWebReady: false } });
      }
    }

    return result;
  } catch (_) {
    return [];
  }
}

// ── Função principal ─────────────────────────────────────────────────────────

async function extractStreamsRC(sources, episodeUrl) {
  const streams = [];
  const referer = episodeUrl || RC_BASE_URL + '/';

  for (const source of sources) {
    const { name, iframeSrc } = source;
    if (!iframeSrc) continue;
    const fullSrc = iframeSrc.startsWith('//') ? 'https:' + iframeSrc : iframeSrc;

    // Roteamento por domínio do player
    if (fullSrc.includes('streamtape.')) {
      const s = await extractStreamtape(fullSrc, referer);
      if (s) streams.push({ ...s, name: `RedeCanais | ${name}` });

    } else if (fullSrc.includes('mixdrop.')) {
      const s = await extractMixdrop(fullSrc, referer);
      if (s) streams.push({ ...s, name: `RedeCanais | ${name}` });

    } else if (fullSrc.includes('blogger.com/video.g')) {
      const token = extractBloggerToken(fullSrc);
      if (token) {
        const vids = await fetchBloggerStreams(token);
        for (const v of vids) {
          const label = QUALITY_LABEL[v.quality] || `${v.quality}p`;
          streams.push({
            url        : v.url,
            name       : `RedeCanais | ${name}`,
            description: `GoogleVideo ${label}`,
            behaviorHints: {
              notWebReady: false,
              proxyHeaders: { request: { Referer: 'https://youtube.googleapis.com/', 'User-Agent': UA_MOBILE } },
            },
          });
        }
      }

    } else {
      // Genérico para todos os outros (filemoon, doodstream, etc.)
      const extracted = await extractGeneric(fullSrc, referer);
      for (const s of extracted) {
        streams.push({ ...s, name: `RedeCanais | ${name}` });
      }
    }
  }

  return streams;
}

module.exports = { extractStreamsRC };
