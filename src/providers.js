'use strict';

/**
 * providers.js — v4.0.0
 *
 * PROBLEMA RESOLVIDO: streams abrindo no navegador externo.
 *
 * CAUSA: o código anterior usava `externalUrl`, que instrui o Stremio a abrir
 * o link no browser. Para TV/desktop/mobile, o stream DEVE ser URL direta de
 * vídeo: M3U8 ou MP4 — nunca uma página HTML.
 *
 * SOLUÇÃO: cada provedor faz requisição no servidor, segue iframes/redirects
 * e extrai a URL real antes de retornar ao Stremio.
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

function proxyM3U8(url, referer) {
  return `${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer || '')}`;
}

function extractMedia(html, pageUrl) {
  const out  = [];
  const seen = new Set();
  const m3u8 = [
    /["'`](https?:\/\/[^"'`<>\s]+\.m3u8[^"'`<>\s]*)/gi,
    /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
    /hls\s*[=:]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
    /source\s*[=:]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
    /["']url["']\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
  ];
  for (const p of m3u8) {
    let m;
    while ((m = p.exec(html)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); out.push({ url: proxyM3U8(m[1], pageUrl), type: 'hls' }); }
    }
  }
  if (!out.length) {
    const mp4p = [/["'`](https?:\/\/[^"'`<>\s]+\.mp4[^"'`<>\s]*)/gi];
    for (const p of mp4p) {
      let m;
      while ((m = p.exec(html)) !== null) {
        if (!seen.has(m[1])) { seen.add(m[1]); out.push({ url: m[1], type: 'mp4' }); }
      }
    }
  }
  return out;
}

function makeStream(name, desc, media) {
  // SEM externalUrl — URL direta para o player interno do Stremio
  return {
    url         : media.url,
    name,
    description : `${desc} • ${media.type === 'hls' ? 'HLS' : 'MP4'}`,
    behaviorHints: { notWebReady: false },
  };
}

// Segue iframes aninhados até encontrar M3U8/MP4 (máx 3 níveis)
async function resolveNestedIframes(html, pageUrl, depth = 0) {
  if (depth >= 3) return [];
  const direct = extractMedia(html, pageUrl);
  if (direct.length) return direct;

  const pat = /<iframe[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = pat.exec(html)) !== null) {
    let src = m[1];
    if (src.startsWith('//')) src = 'https:' + src;
    if (!src.startsWith('http')) continue;
    if (/googletagmanager|facebook|doubleclick|analytics|recaptcha/.test(src)) continue;
    try {
      const r = await safeFetch(src, { headers: { 'User-Agent': UA, Referer: pageUrl }, redirect: 'follow' }, 10000);
      if (!r.ok) continue;
      const found = await resolveNestedIframes(await r.text(), src, depth + 1);
      if (found.length) return found;
    } catch (_) {}
  }
  return [];
}

// ── Provedor 1: SuperFlixAPI ──────────────────────────────────────────────────
async function extractSuperFlix(id, isMovie, s, e) {
  const SF  = (process.env.SF_BASE_URL || 'https://superflixapi.run').replace(/\/$/, '');
  const url = isMovie ? `${SF}/filme/${id}` : `${SF}/serie/${id}/${s}/${e}`;
  try {
    // Referer do próprio domínio = parceiro autorizado → remove bloqueio "Acesso Restrito"
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, Referer: `${SF}/`, Origin: SF, Accept: 'text/html,*/*' } });
    if (!r.ok) return [];
    return (await resolveNestedIframes(await r.text(), url)).map(m => makeStream('🇧🇷 SuperFlix BR', 'SuperFlixAPI', m));
  } catch (err) { console.warn('[SuperFlix] Erro:', err.message); return []; }
}

// ── Provedor 2: VidSrc.cc ─────────────────────────────────────────────────────
async function extractVidSrc(id, isMovie, s, e) {
  const url = isMovie ? `https://vidsrc.cc/v2/embed/movie/${id}` : `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}`;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, Referer: 'https://vidsrc.cc/' } });
    if (!r.ok) return [];
    return (await resolveNestedIframes(await r.text(), url)).map(m => makeStream('📺 VidSrc', 'VidSrc.cc', m));
  } catch (err) { console.warn('[VidSrc] Erro:', err.message); return []; }
}

// ── Provedor 3: VidSrc.me ─────────────────────────────────────────────────────
async function extractVidSrcMe(id, isMovie, s, e) {
  const url = isMovie ? `https://vidsrc.me/embed/movie?imdb=${id}` : `https://vidsrc.me/embed/tv?imdb=${id}&season=${s}&episode=${e}`;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, Referer: 'https://vidsrc.me/' } });
    if (!r.ok) return [];
    return (await resolveNestedIframes(await r.text(), url)).map(m => makeStream('📺 VidSrc.me', 'VidSrc.me', m));
  } catch (err) { console.warn('[VidSrc.me] Erro:', err.message); return []; }
}

// ── Provedor 4: AutoEmbed (tem API JSON direta) ───────────────────────────────
async function extractAutoEmbed(id, isMovie, s, e) {
  try {
    const apiUrl = isMovie
      ? `https://autoembed.cc/api/getVideoSource?type=movie&id=${id}`
      : `https://autoembed.cc/api/getVideoSource?type=tv&id=${id}&season=${s}&episode=${e}`;
    const r = await safeFetch(apiUrl, { headers: { 'User-Agent': UA, Referer: 'https://autoembed.cc/', Accept: 'application/json' } });
    if (r.ok) {
      const j   = await r.json();
      const src = j?.videoSource || j?.source || j?.url;
      if (src) {
        const isH = src.includes('.m3u8');
        return [makeStream('🎬 AutoEmbed', 'AutoEmbed', { url: isH ? proxyM3U8(src, 'https://autoembed.cc/') : src, type: isH ? 'hls' : 'mp4' })];
      }
    }
    const embedUrl = isMovie ? `https://autoembed.cc/movie/imdb/${id}` : `https://autoembed.cc/tv/imdb/${id}-${s}-${e}`;
    const r2 = await safeFetch(embedUrl, { headers: { 'User-Agent': UA, Referer: 'https://autoembed.cc/' } });
    if (!r2.ok) return [];
    return (await resolveNestedIframes(await r2.text(), embedUrl)).map(m => makeStream('🎬 AutoEmbed', 'AutoEmbed', m));
  } catch (err) { console.warn('[AutoEmbed] Erro:', err.message); return []; }
}

// ── Provedor 5: 2Embed ────────────────────────────────────────────────────────
async function extract2Embed(id, isMovie, s, e) {
  const url = isMovie ? `https://www.2embed.stream/embed/movie/${id}` : `https://www.2embed.stream/embed/tv/${id}/${s}/${e}`;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.2embed.stream/' } });
    if (!r.ok) return [];
    return (await resolveNestedIframes(await r.text(), url)).map(m => makeStream('📡 2Embed', '2Embed.stream', m));
  } catch (err) { console.warn('[2Embed] Erro:', err.message); return []; }
}

// ── Provedor 6: MultiEmbed VIP ────────────────────────────────────────────────
async function extractMultiEmbed(id, isMovie, s, e) {
  const url = isMovie
    ? `https://multiembed.mov/directstream.php?video_id=${id}`
    : `https://multiembed.mov/directstream.php?video_id=${id}&s=${s}&e=${e}`;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, Referer: 'https://multiembed.mov/' }, redirect: 'follow' });
    if (!r.ok) return [];
    return (await resolveNestedIframes(await r.text(), url)).map(m => makeStream('🌐 SuperEmbed', 'SuperEmbed VIP', m));
  } catch (err) { console.warn('[MultiEmbed] Erro:', err.message); return []; }
}

// ── Provedor 7: GoDrive ───────────────────────────────────────────────────────
async function extractGoDrive(id, isMovie, s, e) {
  const url = isMovie
    ? `https://godriveplayer.com/player.php?imdb=${id}`
    : `https://godriveplayer.com/player.php?imdb=${id}&season=${s}&episode=${e}`;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, Referer: 'https://godriveplayer.com/' } });
    if (!r.ok) return [];
    return (await resolveNestedIframes(await r.text(), url)).map(m => makeStream('☁️ GoDrive', 'GoDrivePlayer', m));
  } catch (err) { console.warn('[GoDrive] Erro:', err.message); return []; }
}

// ── Função principal ──────────────────────────────────────────────────────────
async function getAllStreams(imdbId, type, season, episode) {
  const isMovie = (type === 'movie');
  const s = isMovie ? null : (Number.isFinite(season)  && season  > 0 ? season  : 1);
  const e = isMovie ? null : (Number.isFinite(episode) && episode > 0 ? episode : 1);

  console.log(`[Providers] ${imdbId} | ${isMovie ? 'Filme' : `Série S${s}E${e}`}`);

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
  console.log(`[Providers] ${all.length} stream(s) encontrada(s)`);
  return all;
}

module.exports = { getAllStreams };
