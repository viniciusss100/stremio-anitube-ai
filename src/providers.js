'use strict';

/**
 * providers.js — versão simplificada (Somente provedores que não são SuperFlix)
 */

const fetch = require('node-fetch');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PORT       = parseInt(process.env.PORT || '7000', 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://127.0.0.1:' + PORT).replace(/\/$/, '');

async function safeFetch(url, opts = {}, timeout = 15000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeout);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function proxyM3U8(url, referer) {
  return PUBLIC_URL + '/proxy/m3u8?url=' + encodeURIComponent(url) + '&referer=' + encodeURIComponent(referer || '');
}

function extractMedia(html, pageUrl) {
  const out = [], seen = new Set();
  const m3u8Pats = [
    /["'`](https?:\/\/[^"'`<>\s]+\.m3u8[^"'`<>\s]*)/gi,
    /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
    /hls\s*[=:]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
    /source\s*[=:]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
    /["']url["']\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/gi,
  ];
  for (const p of m3u8Pats) {
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
  return { url: media.url, name, description: desc + ' \u2022 ' + (media.type === 'hls' ? 'HLS' : 'MP4'), behaviorHints: { notWebReady: false } };
}

async function resolveNested(html, pageUrl, depth) {
  if (depth === undefined) depth = 0;
  if (depth >= 3) return [];
  const direct = extractMedia(html, pageUrl);
  if (direct.length) return direct;
  const pat = /<iframe[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = pat.exec(html)) !== null) {
    let src = m[1];
    if (src.startsWith('//')) src = 'https:' + src;
    if (!src.startsWith('http')) continue;
    if (/googletagmanager|facebook|doubleclick|analytics|recaptcha|googlesyndication/.test(src)) continue;
    try {
      const r = await safeFetch(src, { headers: { 'User-Agent': UA, Referer: pageUrl }, redirect: 'follow' }, 10000);
      if (!r.ok) continue;
      const found = await resolveNested(await r.text(), src, depth + 1);
      if (found.length) return found;
    } catch (_) {}
  }
  return [];
}

// 1 VidSrc.cc
async function extractVidSrcCC(id, isMovie, s, e) {
  const url = isMovie ? 'https://vidsrc.cc/v2/embed/movie/' + id : 'https://vidsrc.cc/v2/embed/tv/' + id + '/' + s + '/' + e;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://vidsrc.cc/' } });
    if (!r.ok) return [];
    return (await resolveNested(await r.text(), url)).map(function(m) { return makeStream('📺 VidSrc', 'VidSrc.cc', m); });
  } catch (err) { console.warn('[VidSrc.cc] Erro:', err.message); return []; }
}

// 2 VidSrc.me
async function extractVidSrcMe(id, isMovie, s, e) {
  const url = isMovie ? 'https://vidsrc.me/embed/movie?imdb=' + id : 'https://vidsrc.me/embed/tv?imdb=' + id + '&season=' + s + '&episode=' + e;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://vidsrc.me/' } });
    if (!r.ok) return [];
    return (await resolveNested(await r.text(), url)).map(function(m) { return makeStream('📺 VidSrc.me', 'VidSrc.me', m); });
  } catch (err) { console.warn('[VidSrc.me] Erro:', err.message); return []; }
}

// 3 VidSrc.mov
async function extractVidSrcMov(id, isMovie, s, e) {
  const url = isMovie ? 'https://vidsrc.mov/embed/movie/' + id : 'https://vidsrc.mov/embed/tv/' + id + '/' + s + '/' + e;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://vidsrc.mov/' } });
    if (!r.ok) return [];
    return (await resolveNested(await r.text(), url)).map(function(m) { return makeStream('📺 VidSrc.mov', 'VidSrc.mov', m); });
  } catch (err) { console.warn('[VidSrc.mov] Erro:', err.message); return []; }
}

// 4 VidSrc.icu
async function extractVidSrcIcu(id, isMovie, s, e) {
  const url = isMovie ? 'https://vidsrc.icu/embed/movie/' + id : 'https://vidsrc.icu/embed/tv/' + id + '/' + s + '/' + e;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://vidsrc.icu/' } });
    if (!r.ok) return [];
    return (await resolveNested(await r.text(), url)).map(function(m) { return makeStream('📺 VidSrc.icu', 'VidSrc.icu', m); });
  } catch (err) { console.warn('[VidSrc.icu] Erro:', err.message); return []; }
}

// 5 2Embed.stream
async function extract2Embed(id, isMovie, s, e) {
  const url = isMovie ? 'https://www.2embed.stream/embed/movie/' + id : 'https://www.2embed.stream/embed/tv/' + id + '/' + s + '/' + e;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://www.2embed.stream/' } });
    if (!r.ok) return [];
    return (await resolveNested(await r.text(), url)).map(function(m) { return makeStream('📡 2Embed', '2Embed.stream', m); });
  } catch (err) { console.warn('[2Embed] Erro:', err.message); return []; }
}

// 6 MultiEmbed VIP
async function extractMultiEmbed(id, isMovie, s, e) {
  const url = isMovie
    ? 'https://multiembed.mov/directstream.php?video_id=' + id
    : 'https://multiembed.mov/directstream.php?video_id=' + id + '&s=' + s + '&e=' + e;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://multiembed.mov/' }, redirect: 'follow' });
    if (!r.ok) return [];
    return (await resolveNested(await r.text(), url)).map(function(m) { return makeStream('🌐 SuperEmbed', 'SuperEmbed VIP', m); });
  } catch (err) { console.warn('[MultiEmbed] Erro:', err.message); return []; }
}

// 7 GoDrivePlayer
async function extractGoDrive(id, isMovie, s, e) {
  const url = isMovie
    ? 'https://godriveplayer.com/player.php?imdb=' + id
    : 'https://godriveplayer.com/player.php?imdb=' + id + '&season=' + s + '&episode=' + e;
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://godriveplayer.com/' } });
    if (!r.ok) return [];
    return (await resolveNested(await r.text(), url)).map(function(m) { return makeStream('☁️ GoDrive', 'GoDrivePlayer', m); });
  } catch (err) { console.warn('[GoDrive] Erro:', err.message); return []; }
}

// ── Função principal ──────────────────────────────────────────────────────────
async function getAllStreams(imdbId, type, season, episode) {
  const isMovie = (type === 'movie');
  const s = isMovie ? null : (Number.isFinite(season)  && season  > 0 ? season  : 1);
  const e = isMovie ? null : (Number.isFinite(episode) && episode > 0 ? episode : 1);
  console.log('[Providers] ' + imdbId + ' | ' + (isMovie ? 'Filme' : 'Série S' + s + 'E' + e));

  const results = await Promise.allSettled([
    // Removido SuperFlix; mantemos os demais provedores
    extractVidSrcCC(imdbId, isMovie, s, e),
    extractVidSrcMe(imdbId, isMovie, s, e),
    extractVidSrcMov(imdbId, isMovie, s, e),
    extractVidSrcIcu(imdbId, isMovie, s, e),
    extract2Embed(imdbId, isMovie, s, e),
    extractMultiEmbed(imdbId, isMovie, s, e),
    extractGoDrive(imdbId, isMovie, s, e),
  ]);

  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...(r.value || []));
  }
  console.log('[Providers] ' + all.length + ' stream(s) para ' + imdbId);
  return all;
}

module.exports = { getAllStreams };
