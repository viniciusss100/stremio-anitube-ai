'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper  = require('./src/scraper');         // AniTube
const { extractStreams } = require('./src/extractor');
const sf       = require('./src/superflixapi');    // SuperFlixAPI

// ── Cache ────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.value;
}
function cacheSet(key, value) { cache.set(key, { value, ts: Date.now() }); }

// ── Manifest ─────────────────────────────────────────────────────────────────
const manifest = {
  id         : 'community.anitube.superflix',
  version    : '5.0.0',
  name       : '🎌🎬 AniTube + SuperFlix BR',
  description: 'AniTube.news (animes JP) + SuperFlixAPI (filmes, séries, animes BR dublados/legendados)',
  logo       : 'https://www.anitube.news/wp-content/uploads/logo-anitube-2.png',
  background : 'https://www.anitube.news/wp-content/themes/anitube/img/bg.jpg',
  resources  : ['catalog', 'meta', 'stream'],
  types      : ['series', 'movie'],
  idPrefixes : ['anitube:', 'tt'],
  behaviorHints: { configurable: false, adult: false },
  catalogs: [
    // ── AniTube ──
    { id: 'anitube_search',      type: 'series', name: '🔍 AniTube – Busca',             extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'anitube_ultimos_eps', type: 'series', name: '🆕 AniTube – Últimos Episódios',  extra: [{ name: 'skip', isRequired: false }] },
    { id: 'anitube_mais_vistos', type: 'series', name: '🔥 AniTube – Mais Vistos',        extra: [{ name: 'skip', isRequired: false }] },
    { id: 'anitube_recentes',    type: 'series', name: '📺 AniTube – Animes Recentes',    extra: [{ name: 'skip', isRequired: false }] },
    { id: 'anitube_lista',       type: 'series', name: '📚 AniTube – Lista Completa',     extra: [{ name: 'skip', isRequired: false }] },

    // ── SuperFlixAPI ──
    { id: 'sf_filmes',    type: 'movie',  name: '🎬 SuperFlix BR – Filmes',         extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'sf_series',    type: 'series', name: '📺 SuperFlix BR – Séries',         extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'sf_animes',    type: 'series', name: '🎌 SuperFlix BR – Animes (Dub/Leg)', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'sf_lancamentos', type: 'series', name: '🆕 SuperFlix BR – Lançamentos',   extra: [{ name: 'skip', isRequired: false }] },
  ],
};

const builder = new addonBuilder(manifest);

// ── Catalog Handler ───────────────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ id, type, extra }) => {
  const skip   = parseInt(extra.skip, 10) || 0;
  const page   = Math.floor(skip / 20) + 1;
  const search = (extra.search || '').trim();
  const key    = `cat:${id}:${search}:${page}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    let metas = [];

    // ── AniTube ──
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
    }

    // ── SuperFlixAPI ──
    else if (id.startsWith('sf_')) {
      if (search) {
        const sfType = (id === 'sf_filmes') ? 'movie' : 'series';
        metas = await sf.searchContent(search, sfType);
      } else {
        switch (id) {
          case 'sf_filmes':     metas = await sf.getMovies(page);          break;
          case 'sf_series':     metas = await sf.getSeries(page);          break;
          case 'sf_animes':     metas = await sf.getAnimes(page);          break;
          case 'sf_lancamentos':metas = await sf.getRecentEpisodes();      break;
        }
      }
    }

    if (!Array.isArray(metas)) metas = [];
    const result = { metas, cacheMaxAge: 300 };
    cacheSet(key, result);
    return result;
  } catch (e) {
    console.error(`[Catalog] Erro "${id}":`, e.message);
    return { metas: [] };
  }
});

// ── Meta Handler ──────────────────────────────────────────────────────────────
builder.defineMetaHandler(async ({ id, type }) => {
  // AniTube: meta completo via scraper
  if (id.startsWith('anitube:')) {
    const ckey = `meta:${id}`;
    const cached = cacheGet(ckey);
    if (cached) return cached;
    try {
      const result = await scraper.getAnimeMeta(id.replace('anitube:', ''));
      if (result?.meta) { cacheSet(ckey, result); return result; }
    } catch (e) { console.error(`[Meta] AniTube "${id}":`, e.message); }
    return { meta: {} };
  }

  // IDs IMDB (tt...): enriquecer via Cinemeta/TMDB + adicionar episódios para séries
  if (id.startsWith('tt')) {
    const ckey = `meta:${id}:${type}`;
    const cached = cacheGet(ckey);
    if (cached) return cached;
    try {
      const metaData = await sf.fetchMeta(id, type);
      if (!metaData) return { meta: {} };

      const stremioType = type === 'movie' ? 'movie' : 'series';
      const meta = {
        id, type: stremioType,
        name       : metaData.name,
        poster     : metaData.poster,
        background : metaData.background,
        description: metaData.description,
        genres     : metaData.genres,
        year       : metaData.year,
      };

      const result = { meta };
      cacheSet(ckey, result);
      return result;
    } catch (e) {
      console.error(`[Meta] IMDB "${id}":`, e.message);
      return { meta: {} };
    }
  }

  return { meta: {} };
});

// ── Stream Handler ────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ id, type }) => {
  const ckey   = `stream:${id}`;
  const cached = cacheGet(ckey);
  if (cached) return cached;

  try {
    let streams = [];

    // ── AniTube nativo ──
    if (id.startsWith('anitube:')) {
      const epId = id.replace('anitube:', '');
      const sr   = await scraper.getEpisodeIframes(epId);
      if (sr?.sources?.length) {
        streams = await extractStreams(sr.sources, sr.episodeUrl);
      }
    }

    // ── IDs IMDB (tt...) — nativos para SuperFlixAPI ──
    else if (id.startsWith('tt')) {
      // O Stremio envia "tt1234567:season:episode" para séries
      const parts   = id.split(':');
      const imdbId  = parts[0];
      const season  = parts[1] ? parseInt(parts[1], 10) : null;
      const episode = parts[2] ? parseInt(parts[2], 10) : null;
      const isMovie = type === 'movie' || (season === null);

      // SuperFlixAPI streams (player embed)
      const sfStreams = sf.buildSFStreams(imdbId, isMovie ? 'movie' : 'series', season, episode);
      streams.push(...sfStreams);

      // Se for série/anime, também tenta AniTube como fallback
      if (!isMovie) {
        const atStreams = await tryAniTubeById(imdbId, season, episode);
        streams.push(...atStreams);
      }
    }

    else {
      return { streams: [] };
    }

    if (!streams.length) return { streams: [] };
    const result = { streams, cacheMaxAge: 300 };
    cacheSet(ckey, result);
    return result;

  } catch (e) {
    console.error(`[Stream] Erro "${id}":`, e.message);
    return { streams: [] };
  }
});

// ── Fallback AniTube para IDs IMDB ───────────────────────────────────────────
async function tryAniTubeById(imdbId, season, episode) {
  try {
    const fetch   = require('node-fetch');
    const cinType = 'series';

    // Busca título via Cinemeta
    let title = null;
    try {
      const r = await fetch(`https://v3-cinemeta.strem.io/meta/${cinType}/${imdbId}.json`, { timeout: 8000 });
      if (r.ok) { const j = await r.json(); title = j?.meta?.name || null; }
    } catch (_) {}

    if (!title) return [];

    const results = await scraper.searchAnimes(title);
    if (!results?.length) return [];

    const animeId = results[0].id.replace('anitube:', '');
    let epId = animeId;

    if (season !== null && episode !== null) {
      const meta   = await scraper.getAnimeMeta(animeId);
      const videos = meta?.meta?.videos || [];
      const ep     = videos.find(v => v.episode === episode) || videos[episode - 1] || videos[0];
      if (ep) epId = ep.id.replace('anitube:', '');
    }

    const sr = await scraper.getEpisodeIframes(epId);
    if (!sr?.sources?.length) return [];

    const streams = await extractStreams(sr.sources, sr.episodeUrl);
    return streams.map(s => ({ ...s, name: `🎌 AniTube | ${s.name || ''}`.trim() }));
  } catch (_) {
    return [];
  }
}

module.exports = builder.getInterface();
