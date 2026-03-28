'use strict';

/**
 * providers.js — v5.1.0 (modificado)
 *
 * Exporta extractSuperFlix individualmente para uso direto quando ID for sf:...
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

// DEBUG / fallback extractSuperFlix
async function extractSuperFlix(id, isMovie, s, e) {
  const SF = (process.env.SF_BASE_URL || 'https://superflixapi.run').replace(/\/$/, '');
  const url = isMovie ? SF + '/filme/' + id : SF + '/serie/' + id + '/' + s + '/' + e;
  const altUrl = isMovie ? SF + '/embed/filme/' + id : SF + '/embed/serie/' + id + '/' + s + '/' + e;

  const tryUrl = async (u) => {
    const start = Date.now();
    try {
      console.log('[SuperFlix] GET', u);
      const r = await safeFetch(u, {
        headers: {
          'User-Agent': UA,
          'Referer': SF + '/',
          'Origin': SF,
          'Accept': 'text/html,*/*',
        },
      }, 15000);
      const took = Date.now() - start;
      console.log('[SuperFlix] Response', r.status, 'took', took + 'ms', 'for', u);
      const text = await r.text();
      const snippet = text ? text.substring(0, 1200).replace(/\n/g, ' ') : '';
      console.log('[SuperFlix] Body snippet:', snippet);
      if (/cloudflare|attention required|captcha|bot verification|jschl_vc/i.test(snippet)) {
        console.warn('[SuperFlix] Possível bloqueio anti-bot detectado em', u);
        return { ok: false, blocked: true, html: text };
      }
      if (!r.ok) return { ok: false, blocked: false, html: text };
      const found = await resolveNested(text, u);
      return { ok: true, blocked: false, html: text, found };
    } catch (err) {
      console.warn('[SuperFlix] Erro fetch', err.message, 'para', u);
      return { ok: false, blocked: false, error: err.message };
    }
  };

  const res1 = await tryUrl(url);
  if (res1.ok && Array.isArray(res1.found) && res1.found.length) {
    return res1.found.map(m => makeStream('🇧🇷 SuperFlix BR', 'SuperFlixAPI', m));
  }

  if (res1.blocked || !res1.ok || (res1.found && res1.found.length === 0)) {
    console.log('[SuperFlix] Tentando fallback embed URL:', altUrl);
    const res2 = await tryUrl(altUrl);
    if (res2.ok && Array.isArray(res2.found) && res2.found.length) {
      return res2.found.map(m => makeStream('🇧🇷 SuperFlix BR', 'SuperFlixAPI', m));
    }
    if (res2.blocked) {
      console.warn('[SuperFlix] Bloqueio detectado no embed fallback para id', id);
      return [];
    }
  }

  if (res1.ok && res1.found && res1.found.length === 0) {
    console.log('[SuperFlix] Nenhum media encontrado nas páginas para id', id);
  }
  return [];
}

// ── Função principal ──────────────────────────────────────────────────────────
async function getAllStreams(imdbId, type, season, episode) {
  const isMovie = (type === 'movie');
  const s = isMovie ? null : (Number.isFinite(season)  && season  > 0 ? season  : 1);
  const e = isMovie ? null : (Number.isFinite(episode) && episode > 0 ? episode : 1);
  console.log('[Providers] ' + imdbId + ' | ' + (isMovie ? 'Filme' : 'Série S' + s + 'E' + e));

  const results = await Promise.allSettled([
    extractSuperFlix(imdbId, isMovie, s, e),
    // mantenha as outras chamadas conforme seu arquivo original
    // extractVidSrcCC(imdbId, isMovie, s, e),
    // extractVidSrcMe(imdbId, isMovie, s, e),
    // extractVidSrcMov(imdbId, isMovie, s, e),
    // extractVidSrcIcu(imdbId, isMovie, s, e),
    // extract2Embed(imdbId, isMovie, s, e),
    // extractMultiEmbed(imdbId, isMovie, s, e),
    // extractGoDrive(imdbId, isMovie, s, e),
  ]);

  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...(r.value || []));
  }
  console.log('[Providers] ' + all.length + ' stream(s) para ' + imdbId);
  return all;
}

module.exports = { getAllStreams, extractSuperFlix };
