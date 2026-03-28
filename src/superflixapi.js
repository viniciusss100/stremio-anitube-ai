'use strict';

/**
 * superflixapi.js — v3.0.0
 *
 * PROBLEMA 1 CORRIGIDO: Catálogos SF vazios.
 *   O endpoint /lista?category=...&format=json NAO EXISTE MAIS.
 *   Endpoints reais: /filmes /series /animes (HTML com links)
 *   Scrapar os IDs IMDB/TMDB do HTML e enriquecer via Cinemeta.
 *
 * PROBLEMA 2 CORRIGIDO: buildSFStreams removido daqui (era quem gerava externalUrl).
 *   Streams agora vêm 100% de providers.js (extração real M3U8/MP4).
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

// ── Cache de metadata Cinemeta ────────────────────────────────────────────────
const _metaCache = new Map();
const META_TTL   = 24 * 3600 * 1000;

async function fetchMeta(imdbId, type) {
  const key    = imdbId + ':' + type;
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
      const m    = href.match(/\/(filme|serie|anime|dorama)\/((tt\d+|\d{5,}))/);
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

async function buildMetas(ids, stremioType, page) {
  page = page || 1;
  const SIZE  = 20;
  const slice = ids.slice((page - 1) * SIZE, page * SIZE);
  const type  = stremioType === 'movie' ? 'movie' : 'series';

  const out = await Promise.allSettled(slice.map(async function(id) {
    // IDs numéricos (TMDB) sem chave: tenta endpoint externo com IMDB
    let imdbId = id;
    if (!id.startsWith('tt') && TMDB_KEY) {
      try {
        const ep = type === 'movie'
          ? 'https://api.themoviedb.org/3/movie/' + id + '?language=pt-BR'
          : 'https://api.themoviedb.org/3/tv/'    + id + '?language=pt-BR';
        const r = await safeFetch(ep, { headers: { Authorization: 'Bearer ' + TMDB_KEY } });
        if (r.ok) { const j = await r.json(); if (j.imdb_id) imdbId = j.imdb_id; }
      } catch (_) {}
    }
    if (!imdbId.startsWith('tt')) return null;
    const meta = await fetchMeta(imdbId, type);
    if (!meta || !meta.name) return null;
    return { id: imdbId, type: stremioType, name: meta.name, poster: meta.poster || '', posterShape: 'poster', year: meta.year || undefined };
  }));

  return out.filter(function(r) { return r.status === 'fulfilled' && r.value; }).map(function(r) { return r.value; });
}

async function getMovies(page)  { return buildMetas(await scrapeSFList('/filmes'), 'movie',  page); }
async function getSeries(page)  { return buildMetas(await scrapeSFList('/series'), 'series', page); }
async function getAnimes(page)  { return buildMetas(await scrapeSFList('/animes'), 'series', page); }

// ── Calendário ────────────────────────────────────────────────────────────────
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
      out.push({ id, type: 'series', name: ep.title || ep.name || id, poster: ep.poster || ep.image || '', posterShape: 'poster' });
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
  const cinType = type === 'movie' ? 'movie' : 'series';
  let results = [];

  if (TMDB_KEY) {
    try {
      const ep = sfType === 'movie'
        ? 'https://api.themoviedb.org/3/search/movie?query=' + q + '&language=pt-BR'
        : 'https://api.themoviedb.org/3/search/tv?query='    + q + '&language=pt-BR';
      const r = await safeFetch(ep, { headers: { Authorization: 'Bearer ' + TMDB_KEY } });
      if (r.ok) {
        const j = await r.json();
        results = (j.results || []).slice(0, 15).map(function(i) {
          return { id: i.imdb_id || ('tmdb:' + i.id), type: sfType, name: i.title || i.name || '', poster: i.poster_path ? 'https://image.tmdb.org/t/p/w500' + i.poster_path : '', posterShape: 'poster' };
        }).filter(function(m) { return m.name; });
      }
    } catch (_) {}
  }

  if (!results.length) {
    try {
      const r = await safeFetch('https://v3-cinemeta.strem.io/catalog/' + cinType + '/top/search=' + q + '.json');
      if (r.ok) {
        const j = await r.json();
        results = (j.metas || []).slice(0, 15).map(function(m) {
          return { id: m.id, type: sfType, name: m.name || m.title || '', poster: m.poster || '', posterShape: 'poster' };
        }).filter(function(m) { return m.id && m.name; });
      }
    } catch (_) {}
  }

  return results;
}

module.exports = { getMovies, getSeries, getAnimes, getRecentEpisodes, searchContent, fetchMeta };
