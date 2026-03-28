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

// Melhorado: extractSuperFlix com heurísticas para HTML ofuscado e fallback para domínios alternativos
async function extractSuperFlix(id, isMovie, s, e) {
  const SF_CANDIDATES = [
    (process.env.SF_BASE_URL || 'https://superflixapi.run').replace(/\/$/, ''),
    'https://superflixapi.rest'
  ];
  const pathMain = isMovie ? '/filme/' + id : '/serie/' + id + '/' + s + '/' + e;
  const pathAlt  = isMovie ? '/filme/' + id : '/serie/' + id + '/' + s + '/' + e;

  // Headers mais completos para reduzir bloqueios
  const commonHeaders = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://google.com/',
    'Connection': 'keep-alive',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document'
  };

  async function tryFetch(u) {
    const start = Date.now();
    try {
      console.log('[SuperFlix] GET', u);
      const r = await safeFetch(u, { headers: commonHeaders }, 20000);
      const took = Date.now() - start;
      console.log('[SuperFlix] Response', r.status, 'took', took + 'ms', 'for', u);
      const text = await r.text();
      const snippet = text ? text.substring(0, 1600).replace(/\n/g, ' ') : '';
      console.log('[SuperFlix] Body snippet:', snippet);
      return { ok: r.ok, status: r.status, html: text };
    } catch (err) {
      console.warn('[SuperFlix] Erro fetch', err.message, 'para', u);
      return { ok: false, error: err.message, html: '' };
    }
  }

  // 1) tenta candidatos diretos (evita redirect)
  for (const base of SF_CANDIDATES) {
    const url = base + pathMain;
    const res = await tryFetch(url);
    if (res.ok) {
      // tenta extrair nested normalmente
      const found = await resolveNested(res.html, url);
      if (found && found.length) {
        return found.map(m => makeStream('🇧🇷 SuperFlix BR', 'SuperFlixAPI', m));
      }

      // Se não encontrou, tenta heurística: extrair todas as URLs do HTML e testar cada uma
      // (útil quando player está dentro de script ofuscado ou carregado por src externo)
      const urls = new Set();
      const urlRegex = /https?:\/\/[^\s"'<>]+/g;
      let m;
      while ((m = urlRegex.exec(res.html)) !== null) {
        const candidate = m[0].replace(/&amp;/g, '&');
        // filtra domínios irrelevantes
        if (/googletagmanager|doubleclick|analytics|recaptcha|chorumebbbbgoza|ads|adservice/i.test(candidate)) continue;
        urls.add(candidate);
      }

      // Tenta cada URL encontrada (limitado a 20 para evitar loops)
      let tries = 0;
      for (const u of urls) {
        if (tries++ > 20) break;
        try {
          const r2 = await safeFetch(u, { headers: commonHeaders }, 15000);
          if (!r2 || !r2.ok) continue;
          const html2 = await r2.text();
          const nested = await resolveNested(html2, u);
          if (nested && nested.length) {
            return nested.map(m => makeStream('🇧🇷 SuperFlix BR', 'SuperFlixAPI', m));
          }
        } catch (_) {}
      }

      // nada encontrado neste base, tenta próximo candidate
    } else {
      // se status 301/302, tenta seguir location manualmente
      if (res.status === 301 || res.status === 302) {
        // safeFetch normalmente segue redirects, mas logamos para debug
        console.log('[SuperFlix] Redirect recebido para', base + pathMain);
      }
    }
  }

  // 2) fallback: tenta endpoints alternativos conhecidos (ex.: /player, /watch) — adicionar conforme necessário
  const altPaths = [
    isMovie ? '/watch/filme/' + id : '/watch/serie/' + id + '/' + s + '/' + e,
    isMovie ? '/player/filme/' + id : '/player/serie/' + id + '/' + s + '/' + e
  ];
  for (const base of SF_CANDIDATES) {
    for (const p of altPaths) {
      try {
        const res = await tryFetch(base + p);
        if (res.ok) {
          const found = await resolveNested(res.html, base + p);
          if (found && found.length) return found.map(m => makeStream('🇧🇷 SuperFlix BR', 'SuperFlixAPI', m));
        }
      } catch (_) {}
    }
  }

  // 3) se chegou aqui, não encontrou nada
  console.log('[SuperFlix] Nenhum media encontrado para id', id);
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
