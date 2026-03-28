'use strict';

/**
 * providers.js — v3.0.0
 * CORREÇÕES:
 *  - Bug "SnullEnull" corrigido: isMovie agora depende de type==='movie', não de season===null
 *  - season/episode sempre têm fallback para 1 quando série
 *  - Domínios atualizados: autoembed.cc (sem player.), vidsrc.me adicionado
 *  - Novo provedor: multiembed.mov (SuperEmbed VIP)
 */

const fetch = require('node-fetch');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PORT       = parseInt(process.env.PORT || '7000', 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

async function safeFetch(url, opts = {}, timeout = 15000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeout);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function proxyM3U8(url, ref) {
  return `${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(ref || '')}`;
}

function extractMedia(html, pageUrl) {
  const out  = [];
  const seen = new Set();
  const pats = [
    /["'`](https?:\/\/[^"'`<>\s]+\.m3u8[^"'`<>\s]*)/gi,
    /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
    /hls\s*[=:]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
  ];
  for (const p of pats) {
    let m;
    while ((m = p.exec(html)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); out.push({ url: proxyM3U8(m[1], pageUrl), hls: true }); }
    }
  }
  if (!out.length) {
    const mp4 = html.match(/["'](https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*)/i);
    if (mp4) out.push({ url: mp4[1], hls: false });
  }
  return out;
}

function makeStream(name, desc, media) {
  return { url: media.url, name, description: `${desc} • ${media.hls ? 'HLS' : 'MP4'}`, behaviorHints: { notWebReady: false } };
}

// Provedor 1: VidSrc.cc
async function extractVidSrc(id, isMovie, s, e) {
  try {
    const url = isMovie ? `https://vidsrc.cc/v2/embed/movie/${id}` : `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}`;
    const res = await safeFetch(url, { headers: { 'User-Agent': UA, Referer: 'https://vidsrc.cc/' } });
    if (!res.ok) return [];
    return extractMedia(await res.text(), url).map(m => makeStream('📺 VidSrc', 'VidSrc.cc', m));
  } catch (err) { console.warn('[VidSrc] Erro:', err.message); return []; }
}

// Provedor 2: VidSrc.me (domínio original)
async function extractVidSrcMe(id, isMovie, s, e) {
  try {
    const url = isMovie
      ? `https://vidsrc.me/embed/movie?imdb=${id}`
      : `https://vidsrc.me/embed/tv?imdb=${id}&season=${s}&episode=${e}`;
    const res = await safeFetch(url, { headers: { 'User-Agent': UA, Referer: 'https://vidsrc.me/' } });
    if (!res.ok) return [];
    return extractMedia(await res.text(), url).map(m => makeStream('📺 VidSrc.me', 'VidSrc.me', m));
  } catch (err) { console.warn('[VidSrc.me] Erro:', err.message); return []; }
}

// Provedor 3: AutoEmbed (autoembed.cc — sem "player." no domínio)
async function extractAutoEmbed(id, isMovie, s, e) {
  try {
    // API JSON (mais confiável)
    const apiUrl = isMovie
      ? `https://autoembed.cc/api/getVideoSource?type=movie&id=${id}`
      : `https://autoembed.cc/api/getVideoSource?type=tv&id=${id}&season=${s}&episode=${e}`;
    const res = await safeFetch(apiUrl, { headers: { 'User-Agent': UA, Referer: 'https://autoembed.cc/', Accept: 'application/json' } });
    if (res.ok) {
      const json = await res.json();
      const src  = json?.videoSource || json?.source || json?.url;
      if (src) {
        const hls = src.includes('.m3u8');
        return [makeStream('🎬 AutoEmbed', 'AutoEmbed', { url: hls ? proxyM3U8(src, 'https://autoembed.cc/') : src, hls })];
      }
    }
    // Fallback embed page
    const embedUrl = isMovie
      ? `https://autoembed.cc/movie/imdb/${id}`
      : `https://autoembed.cc/tv/imdb/${id}-${s}-${e}`;
    const r2 = await safeFetch(embedUrl, { headers: { 'User-Agent': UA, Referer: 'https://autoembed.cc/' } });
    if (!r2.ok) return [];
    return extractMedia(await r2.text(), embedUrl).map(m => makeStream('🎬 AutoEmbed', 'AutoEmbed', m));
  } catch (err) { console.warn('[AutoEmbed] Erro:', err.message); return []; }
}

// Provedor 4: 2Embed
async function extract2Embed(id, isMovie, s, e) {
  try {
    const url = isMovie
      ? `https://www.2embed.stream/embed/movie/${id}`
      : `https://www.2embed.stream/embed/tv/${id}/${s}/${e}`;
    const res = await safeFetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.2embed.stream/' } });
    if (!res.ok) return [];
    return extractMedia(await res.text(), url).map(m => makeStream('📡 2Embed', '2Embed', m));
  } catch (err) { console.warn('[2Embed] Erro:', err.message); return []; }
}

// Provedor 5: MultiEmbed/SuperEmbed VIP (HLS direto)
async function extractMultiEmbed(id, isMovie, s, e) {
  try {
    const url = isMovie
      ? `https://multiembed.mov/directstream.php?video_id=${id}`
      : `https://multiembed.mov/directstream.php?video_id=${id}&s=${s}&e=${e}`;
    const res = await safeFetch(url, { headers: { 'User-Agent': UA, Referer: 'https://multiembed.mov/' }, redirect: 'follow' });
    if (!res.ok) return [];
    return extractMedia(await res.text(), url).map(m => makeStream('🌐 SuperEmbed', 'SuperEmbed VIP', m));
  } catch (err) { console.warn('[MultiEmbed] Erro:', err.message); return []; }
}

// Provedor 6: SuperFlixAPI (com Referer correto)
async function extractSuperFlix(id, isMovie, s, e) {
  try {
    const SF = (process.env.SF_BASE_URL || 'https://superflixapi.run').replace(/\/$/, '');
    const url = isMovie ? `${SF}/filme/${id}` : `${SF}/serie/${id}/${s}/${e}`;
    const res = await safeFetch(url, {
      headers: { 'User-Agent': UA, Referer: `${SF}/doc`, Origin: SF, Accept: 'text/html,*/*' },
    });
    if (!res.ok) return [];
    const html    = await res.text();
    const medias  = extractMedia(html, url);
    const streams = medias.map(m => makeStream('🇧🇷 SuperFlix BR', 'SuperFlixAPI', m));

    // Tenta iframe aninhado se não achou nada
    if (!streams.length) {
      const im = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (im) {
        const nested = im[1].startsWith('//') ? 'https:' + im[1] : im[1];
        const r2 = await safeFetch(nested, { headers: { 'User-Agent': UA, Referer: url } });
        if (r2.ok) {
          extractMedia(await r2.text(), nested).forEach(m =>
            streams.push(makeStream('🇧🇷 SuperFlix BR', 'SuperFlixAPI', m))
          );
        }
      }
    }
    return streams;
  } catch (err) { console.warn('[SuperFlix] Erro:', err.message); return []; }
}

// Provedor 7: GoDrivePlayer
async function extractGoDrive(id, isMovie, s, e) {
  try {
    const url = isMovie
      ? `https://godriveplayer.com/player.php?imdb=${id}`
      : `https://godriveplayer.com/player.php?imdb=${id}&season=${s}&episode=${e}`;
    const res = await safeFetch(url, { headers: { 'User-Agent': UA, Referer: 'https://godriveplayer.com/' } });
    if (!res.ok) return [];
    return extractMedia(await res.text(), url).map(m => makeStream('☁️ GoDrive', 'GoDrivePlayer', m));
  } catch (err) { console.warn('[GoDrive] Erro:', err.message); return []; }
}

// ── Função principal ──────────────────────────────────────────────────────────
async function getAllStreams(imdbId, type, season, episode) {
  // CORREÇÃO PRINCIPAL: isMovie é determinado pelo type, não pela presença de season
  const isMovie = (type === 'movie');

  // Para séries: garantir que season e episode nunca sejam null/undefined
  const s = isMovie ? null : (typeof season  === 'number' && season  > 0 ? season  : 1);
  const e = isMovie ? null : (typeof episode === 'number' && episode > 0 ? episode : 1);

  console.log(`[Providers] ${imdbId} | ${type} | ${isMovie ? 'Filme' : `S${s}E${e}`}`);

  const results = await Promise.allSettled([
    extractSuperFlix(imdbId, isMovie, s, e),
    extractVidSrc(imdbId, isMovie, s, e),
    extractVidSrcMe(imdbId, isMovie, s, e),
    extractAutoEmbed(imdbId, isMovie, s, e),
    extract2Embed(imdbId, isMovie, s, e),
    extractMultiEmbed(imdbId, isMovie, s, e),
    extractGoDrive(imdbId, isMovie, s, e),
  ]);

  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...(r.value || []));
  }
  console.log(`[Providers] Streams encontradas: ${all.length}`);
  return all;
}

module.exports = { getAllStreams };
