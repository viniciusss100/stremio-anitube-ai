'use strict';

/**
 * superflixapi.js — v3.1.0 (modificado)
 *
 * Mudanças principais:
 * - Metas retornam IDs no formato `sf:<originalId>` (não descartam IDs numéricos).
 * - Exporta função getSFMeta(sfId, stremioType) que tenta enriquecer com IMDB/TMDB/Cinemeta.
 * - Mantém getMovies/getSeries/getAnimes/getRecentEpisodes/searchContent compatíveis.
 */

const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const SF_BASE  = (process.env.SF_BASE_URL || 'https://superflixapi.run').replace(/\/$/, '');
const TMDB_KEY = process.env.TMDB_API_KEY || '';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function safeFetch(url, opts, timeout) {
  opts    = opts    || {};
  timeout = timeout || 15000;
  const ctrl  = new AbortController();
  const timer = setTimeout(function() { ctrl.abort(); }, timeout);
  try {
    return await fetch(url, Object.assign({}, opts, {
      headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, opts.headers || {}),
      signal : ctrl.signal,
    }));
  } finally { clearTimeout(timer); }
}

// ── Cinemeta / TMDB helper (reaproveitado) ──────────────────────────────────
const _metaCache = new Map();
const META_TTL   = 24 * 3600 * 1000;

async function fetchMetaByImdb(imdbId, type) {
  const key = imdbId + ':' + type;
  const cached = _metaCache.get(key);
  if (cached && Date.now() - cached.ts < META_TTL) return cached.value;

  let meta = null;

  if (TMDB_KEY) {
    try {
      const r = await safeFetch(
        'https://api.themoviedb.org/3/find/' + imdbId + '?external_source=imdb_id&language=pt-BR',
        { headers: { Authorization: 'Bearer ' + TMDB_KEY } }
      );
      if (r.ok) {
        const j    = await r.json();
        const item = (j.movie_results || [])[0] || (j.tv_results || [])[0];
        if (item) meta = {
          name: item.title || item.name || '',
          poster: item.poster_path ? 'https://image.tmdb.org/t/p/w500' + item.poster_path : '',
          background: item.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + item.backdrop_path : '',
          description: item.overview || '',
          year: (item.release_date || item.first_air_date || '').split('-')[0],
          genres: [],
        };
      }
    } catch (_) {}
  }

  if (!meta) {
    try {
      const cinType = type === 'movie' ? 'movie' : 'series';
      const r = await safeFetch('https://v3-cinemeta.strem.io/meta/' + cinType + '/' + imdbId + '.json');
      if (r.ok) {
        const j = await r.json();
        const m = j && j.meta;
        if (m && m.name) meta = {
          name: m.name || '', poster: m.poster || '',
          background: m.background || m.poster || '',
          description: m.description || '',
          year: m.year ? String(m.year) : '',
          genres: m.genres || [],
        };
      }
    } catch (_) {}
  }

  if (meta) _metaCache.set(key, { value: meta, ts: Date.now() });
  return meta;
}

// ── Scraping das páginas de listagem SF ──────────────────────────────────────
const _listCache = {}, _listTs = {};
const LIST_TTL   = 3600 * 1000; // 1h

async function scrapeSFList(endpoint) {
  const now = Date.now();
  if (_listCache[endpoint] && now - _listTs[endpoint] < LIST_TTL) return _listCache[endpoint];

  try {
    const r = await safeFetch(SF_BASE + endpoint, { headers: { Referer: SF_BASE + '/' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const $ = cheerio.load(await r.text());

    const ids = [], seen = new Set();
    $('a[href]').each(function(_, el) {
      const href = $(el).attr('href') || '';
      const m    = href.match(/\/(filme|serie|anime|dorama)\/((tt\d+|\d{4,}))/);
      if (!m) return;
      const id = m[2];
      if (!id || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    });

    console.log('[SF] Scraped ' + ids.length + ' IDs de ' + endpoint);
    _listCache[endpoint] = ids;
    _listTs[endpoint]    = now;
    return ids;
  } catch (e) {
    console.warn('[SF] Falha ' + endpoint + ':', e.message);
    return _listCache[endpoint] || [];
  }
}

// ── Constrói metas — agora usa namespace sf: para preservar origem ───────────
async function buildMetas(ids, stremioType, page) {
  page = page || 1;
  const SIZE  = 20;
  const slice = ids.slice((page - 1) * SIZE, page * SIZE);
  const type  = stremioType === 'movie' ? 'movie' : 'series';

  const out = await Promise.allSettled(slice.map(async function(id) {
    // Tentativa: se id já for tt... tentamos buscar meta via Cinemeta/TMDB
    let imdbId = id.startsWith('tt') ? id : null;

    // Se id numérico e TMDB_KEY disponível, tenta mapear para imdb
    if (!imdbId && TMDB_KEY) {
      try {
        const ep = type === 'movie'
          ? 'https://api.themoviedb.org/3/movie/' + id + '?language=pt-BR'
          : 'https://api.themoviedb.org/3/tv/'    + id + '?language=pt-BR';
        const r = await safeFetch(ep, { headers: { Authorization: 'Bearer ' + TMDB_KEY } });
        if (r.ok) { const j = await r.json(); if (j.imdb_id) imdbId = j.imdb_id; }
      } catch (_) {}
    }

    // Se temos imdbId, tenta enriquecer
    let meta = null;
    if (imdbId) {
      meta = await fetchMetaByImdb(imdbId, type);
    }

    // Monta objeto de saída. **ID sempre `sf:<id>`** para preservar origem.
    const outMeta = {
      id: 'sf:' + id,
      type: stremioType,
      name: (meta && meta.name) ? meta.name : ('SuperFlix ' + id),
      poster: (meta && meta.poster) ? meta.poster : '',
      posterShape: 'poster',
      // guarda referência ao imdb quando disponível (útil para stream fallback)
      _sf: { originalId: id, imdbId: imdbId || null },
      year: (meta && meta.year) ? meta.year : undefined,
    };

    return outMeta;
  }));

  return out.filter(function(r) { return r.status === 'fulfilled' && r.value; }).map(function(r) { return r.value; });
}

// ── Calendário ───────────────────────────────────────────────────────────────
let _cal = null, _calTs = 0;
const CAL_TTL = 30 * 60 * 1000;

async function getRecentEpisodes() {
  const now = Date.now();
  if (_cal && now - _calTs < CAL_TTL) return _cal;
  try {
    const r = await safeFetch(SF_BASE + '/calendario.php', { headers: { Referer: SF_BASE + '/' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = await r.json();
    const arr  = Array.isArray(list) ? list : (list.data || list.episodes || []);
    const seen = new Set(), out = [];
    for (const ep of arr) {
      const id = ep.imdb_id || ep.imdb || ep.id || '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id: 'sf:' + id, type: 'series', name: ep.title || ep.name || id, poster: ep.poster || ep.image || '', posterShape: 'poster', _sf: { originalId: id, imdbId: ep.imdb_id || null } });
      if (out.length >= 20) break;
    }
    _cal = out; _calTs = now;
    return out;
  } catch (e) { console.warn('[SF/Cal]', e.message); return _cal || []; }
}

// ── Busca ─────────────────────────────────────────────────────────────────────
async function searchContent(query, type) {
  if (!query || !query.trim()) return [];
  const q = encodeURIComponent(query.trim());
  const sfType  = type === 'movie' ? 'movie' : 'series';
  // Implementação simples: busca na página de listagem e filtra por nome
  try {
    const endpoint = sfType === 'movie' ? '/filmes' : '/series';
    const r = await safeFetch(SF_BASE + endpoint, { headers: { Referer: SF_BASE + '/' } });
    if (!r.ok) return [];
    const $ = cheerio.load(await r.text());
    const results = [];
    const seen = new Set();
    $('a[href]').each(function(_, el) {
      const href = $(el).attr('href') || '';
      const m    = href.match(/\/(filme|serie|anime|dorama)\/((tt\d+|\d{4,}))/);
      if (!m) return;
      const id = m[2];
      if (!id || seen.has(id)) return;
      const title = ($(el).text() || $(el).attr('title') || '').trim();
      if (!title) return;
      if (title.toLowerCase().includes(query.toLowerCase())) {
        seen.add(id);
        results.push({ id: 'sf:' + id, type: sfType, name: title, poster: '', posterShape: 'poster', _sf: { originalId: id } });
      }
    });
    return results;
  } catch (e) {
    console.warn('[SF/Search]', e.message);
    return [];
  }
}

// ── Funções públicas ──────────────────────────────────────────────────────────
async function getMovies(page)  { return buildMetas(await scrapeSFList('/filmes'), 'movie',  page); }
async function getSeries(page)  { return buildMetas(await scrapeSFList('/series'), 'series', page); }
async function getAnimes(page)  { return buildMetas(await scrapeSFList('/animes'), 'series', page); }

module.exports = {
  getMovies,
  getSeries,
  getAnimes,
  getRecentEpisodes,
  searchContent,
  // função utilitária para obter meta detalhada a partir de sf:<id>
  async getSFMeta(sfId, stremioType = 'series') {
    if (!sfId || !sfId.startsWith('sf:')) return null;
    const originalId = sfId.replace('sf:', '');
    // tenta mapear para imdb via TMDB se possível
    let imdbId = originalId.startsWith('tt') ? originalId : null;
    if (!imdbId && TMDB_KEY) {
      try {
        const type = stremioType === 'movie' ? 'movie' : 'tv';
        const ep = type === 'movie'
          ? 'https://api.themoviedb.org/3/movie/' + originalId + '?language=pt-BR'
          : 'https://api.themoviedb.org/3/tv/'    + originalId + '?language=pt-BR';
        const r = await safeFetch(ep, { headers: { Authorization: 'Bearer ' + TMDB_KEY } });
        if (r.ok) { const j = await r.json(); if (j.imdb_id) imdbId = j.imdb_id; }
      } catch (_) {}
    }
    if (imdbId) {
      const meta = await fetchMetaByImdb(imdbId, stremioType === 'movie' ? 'movie' : 'series');
      if (meta) {
        return Object.assign({ id: imdbId, _sf: { originalId, imdbId } }, meta);
      }
    }
    // fallback: retorna meta mínima com sf: id
    return { id: 'sf:' + originalId, name: 'SuperFlix ' + originalId, poster: '', background: '', description: '', genres: [], year: '' };
  }
};
