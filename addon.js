'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper   = require('./src/scraper');
const scraperRC = require('./src/scraper-rc');
const { extractStreams }   = require('./src/extractor');
const { extractStreamsRC } = require('./src/extractor-rc');

// CACHE
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value) { cache.set(key, { value, ts: Date.now() }); }

// MANIFEST
const manifest = {
  id: 'community.anitube.redecanais',
  version: '4.0.0',
  name: '🎌📺 AniTube + RedeCanais',
  description: 'Addon combinado: AniTube.news (animes) + RedeCanais (filmes, séries, animes, desenhos)',
  logo: 'https://www.anitube.news/wp-content/uploads/logo-anitube-2.png',
  background: 'https://www.anitube.news/wp-content/themes/anitube/img/bg.jpg',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series', 'movie'],
  idPrefixes: ['anitube:', 'rc:', 'tt'],
  behaviorHints: { configurable: false, adult: false },
  catalogs: [
    { id: 'anitube_search',       type: 'series', name: '🔍 AniTube – Busca',             extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'anitube_ultimos_eps',  type: 'series', name: '🆕 AniTube – Últimos Episódios',  extra: [{ name: 'skip', isRequired: false }] },
    { id: 'anitube_mais_vistos',  type: 'series', name: '🔥 AniTube – Mais Vistos',        extra: [{ name: 'skip', isRequired: false }] },
    { id: 'anitube_recentes',     type: 'series', name: '📺 AniTube – Animes Recentes',    extra: [{ name: 'skip', isRequired: false }] },
    { id: 'anitube_lista',        type: 'series', name: '📚 AniTube – Lista Completa',     extra: [{ name: 'skip', isRequired: false }] },
    { id: 'rc_lancamentos',       type: 'movie',  name: '🎬 RedeCanais – Filmes Recentes', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'rc_series',            type: 'series', name: '📺 RedeCanais – Séries Recentes', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'rc_animes',            type: 'series', name: '🎌 RedeCanais – Animes',          extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'rc_desenhos',          type: 'series', name: '🐭 RedeCanais – Desenhos',        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'rc_tudo',              type: 'series', name: '🌐 RedeCanais – Tudo',            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
  ],
};

const builder = new addonBuilder(manifest);

// CATALOG HANDLER
builder.defineCatalogHandler(async ({ id, type, extra }) => {
  const skip   = parseInt(extra.skip, 10) || 0;
  const page   = Math.floor(skip / 20) + 1;
  const search = (extra.search || '').trim();
  const cacheKey = `catalog:${id}:${search}:${skip}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    let metas = [];

    if (id.startsWith('anitube_')) {
      if (search) {
        metas = await scraper.searchAnimes(search);
      } else {
        switch (id) {
          case 'anitube_ultimos_eps': metas = await scraper.getLatestEpisodes(page); break;
          case 'anitube_mais_vistos': metas = await scraper.getMostWatched(page);    break;
          case 'anitube_recentes':    metas = await scraper.getRecentAnimes(page);   break;
          default:                    metas = await scraper.getAnimeList(page);      break;
        }
      }
    } else if (id.startsWith('rc_')) {
      if (search) {
        const all = await scraperRC.searchContent(search);
        if (id === 'rc_lancamentos') metas = all.filter(m => m.type === 'movie');
        else if (id === 'rc_series') metas = all.filter(m => m.type === 'series');
        else metas = all;
      } else {
        switch (id) {
          case 'rc_lancamentos': metas = await scraperRC.getLatestMovies(page);   break;
          case 'rc_series':      metas = await scraperRC.getLatestSeries(page);   break;
          case 'rc_animes':      metas = await scraperRC.getLatestAnimes(page);   break;
          case 'rc_desenhos':    metas = await scraperRC.getLatestDesenhos(page); break;
          default:               metas = await scraperRC.getLatestAll(page);      break;
        }
      }
    }

    if (!Array.isArray(metas)) metas = [];
    const result = { metas, cacheMaxAge: 300 };
    cacheSet(cacheKey, result);
    return result;
  } catch (e) {
    console.error(`[Catalog] Erro "${id}":`, e.message);
    return { metas: [] };
  }
});

// META HANDLER
builder.defineMetaHandler(async ({ id, type }) => {
  if (!id.startsWith('anitube:') && !id.startsWith('rc:')) return { meta: {} };
  const cacheKey = `meta:${id}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    let result;
    if (id.startsWith('anitube:')) result = await scraper.getAnimeMeta(id.replace('anitube:', ''));
    else if (id.startsWith('rc:'))  result = await scraperRC.getContentMeta(id.replace('rc:', ''));
    if (!result?.meta) return { meta: {} };
    cacheSet(cacheKey, result);
    return result;
  } catch (e) {
    console.error(`[Meta] Erro "${id}":`, e.message);
    return { meta: {} };
  }
});

// STREAM HANDLER
builder.defineStreamHandler(async ({ id, type }) => {
  const cacheKey = `stream:${id}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    let streams = [];

    if (id.startsWith('anitube:')) {
      const sr = await scraper.getEpisodeIframes(id.replace('anitube:', ''));
      if (sr?.sources?.length) streams = await extractStreams(sr.sources, sr.episodeUrl);
    } else if (id.startsWith('rc:')) {
      const sr = await scraperRC.getVideoSources(id.replace('rc:', ''));
      if (sr?.sources?.length) streams = await extractStreamsRC(sr.sources, sr.episodeUrl);
    } else if (id.startsWith('tt')) {
      const result = await handleExternalId(id, type);
      if (result) { cacheSet(cacheKey, result); return result; }
      return { streams: [] };
    } else {
      return { streams: [] };
    }

    if (!streams?.length) return { streams: [] };
    const result = { streams, cacheMaxAge: 300 };
    cacheSet(cacheKey, result);
    return result;
  } catch (e) {
    console.error(`[Stream] Erro "${id}":`, e.message);
    return { streams: [] };
  }
});

// EXTERNAL IDs (IMDB)
async function handleExternalId(id, type) {
  try {
    const parts   = id.split(':');
    const imdbId  = parts[0];
    const season  = parts[1] ? parseInt(parts[1], 10) : null;
    const episode = parts[2] ? parseInt(parts[2], 10) : null;
    const fetch   = require('node-fetch');

    let title = null;
    try {
      const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type === 'movie' ? 'movie' : 'series'}/${imdbId}.json`, { timeout: 10000 });
      if (r.ok) { const j = await r.json(); title = j?.meta?.name || j?.meta?.title || null; }
    } catch (_) {}

    if (!title) return null;
    console.log(`[Ext] "${title}" — buscando...`);

    let streams = await tryRCSearch(title, type, season, episode);
    if (!streams?.length && type !== 'movie') streams = await tryAniTubeSearch(title, season, episode);
    if (!streams?.length) return null;
    return { streams, cacheMaxAge: 300 };
  } catch (e) {
    console.error(`[Ext] Erro "${id}":`, e.message);
    return null;
  }
}

async function tryRCSearch(title, type, season, episode) {
  try {
    const results = await scraperRC.searchContent(title);
    if (!results?.length) return null;
    const rcId = results[0].id.replace('rc:', '');
    let epId   = rcId;
    if (season !== null && episode !== null) {
      const meta   = await scraperRC.getContentMeta(rcId);
      const videos = meta?.meta?.videos || [];
      const ep     = videos.find(v => v.episode === episode) || videos[episode - 1] || videos[0];
      if (ep) epId = ep.id.replace('rc:', '');
    }
    const sr = await scraperRC.getVideoSources(epId);
    if (!sr?.sources?.length) return null;
    return await extractStreamsRC(sr.sources, sr.episodeUrl);
  } catch (_) { return null; }
}

async function tryAniTubeSearch(title, season, episode) {
  try {
    const results = await scraper.searchAnimes(title);
    if (!results?.length) return null;
    const animeId = results[0].id.replace('anitube:', '');
    let   epId    = animeId;
    if (season !== null && episode !== null) {
      const meta   = await scraper.getAnimeMeta(animeId);
      const videos = meta?.meta?.videos || [];
      const ep     = videos.find(v => v.episode === episode) || videos[episode - 1] || videos[0];
      if (ep) epId = ep.id.replace('anitube:', '');
    }
    const sr = await scraper.getEpisodeIframes(epId);
    if (!sr?.sources?.length) return null;
    return await extractStreams(sr.sources, sr.episodeUrl);
  } catch (_) { return null; }
}

module.exports = builder.getInterface();
