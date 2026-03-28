'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper  = require('./src/scraper');
const { extractStreams } = require('./src/extractor');
const sf       = require('./src/superflixapi');
const { getAllStreams } = require('./src/providers');

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function cacheGet(k) { const e=cache.get(k); if(!e) return null; if(Date.now()-e.ts>CACHE_TTL){cache.delete(k);return null;} return e.value; }
function cacheSet(k,v) { cache.set(k,{value:v,ts:Date.now()}); }

// ── Manifest ──────────────────────────────────────────────────────────────────
const manifest = {
  id: 'community.anitube.superflix.v6',
  version: '6.0.0',
  name: '🎌🎬 AniTube + SuperFlix BR',
  description: 'AniTube.news (animes) + SuperFlixAPI (filmes/séries BR) com streams reais extraídas de VidSrc, AutoEmbed, 2Embed e mais.',
  logo: 'https://www.anitube.news/wp-content/uploads/logo-anitube-2.png',
  background: 'https://www.anitube.news/wp-content/themes/anitube/img/bg.jpg',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series', 'movie'],
  idPrefixes: ['anitube:', 'tt'],
  behaviorHints: { configurable: false, adult: false },
  catalogs: [
    // AniTube
    { id: 'anitube_search',      type: 'series', name: '🔍 AniTube – Busca',             extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'anitube_ultimos_eps', type: 'series', name: '🆕 AniTube – Últimos Episódios',  extra: [{ name: 'skip', isRequired: false }] },
    { id: 'anitube_mais_vistos', type: 'series', name: '🔥 AniTube – Mais Vistos',        extra: [{ name: 'skip', isRequired: false }] },
    { id: 'anitube_recentes',    type: 'series', name: '📺 AniTube – Animes Recentes',    extra: [{ name: 'skip', isRequired: false }] },
    { id: 'anitube_lista',       type: 'series', name: '📚 AniTube – Lista Completa',     extra: [{ name: 'skip', isRequired: false }] },
    // SuperFlix catálogos
    { id: 'sf_filmes',      type: 'movie',  name: '🎬 SuperFlix BR – Filmes',           extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'sf_series',      type: 'series', name: '📺 SuperFlix BR – Séries',           extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'sf_animes',      type: 'series', name: '🎌 SuperFlix BR – Animes (Dub/Leg)', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'sf_lancamentos', type: 'series', name: '🆕 SuperFlix BR – Lançamentos',      extra: [{ name: 'skip', isRequired: false }] },
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
    } else if (id.startsWith('sf_')) {
      if (search) {
        const sfType = (id === 'sf_filmes') ? 'movie' : 'series';
        metas = await sf.searchContent(search, sfType);
      } else {
        switch (id) {
          case 'sf_filmes':      metas = await sf.getMovies(page);         break;
          case 'sf_series':      metas = await sf.getSeries(page);         break;
          case 'sf_animes':      metas = await sf.getAnimes(page);         break;
          case 'sf_lancamentos': metas = await sf.getRecentEpisodes();     break;
        }
      }
    }

    if (!Array.isArray(metas)) metas = [];
    const result = { metas, cacheMaxAge: 300 };
    cacheSet(key, result);
    return result;
  } catch (e) {
    console.error(`[Catalog] "${id}":`, e.message);
    return { metas: [] };
  }
});

// ── Meta Handler ──────────────────────────────────────────────────────────────
builder.defineMetaHandler(async ({ id, type }) => {
  const key    = `meta:${id}:${type}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    let result;

    if (id.startsWith('anitube:')) {
      result = await scraper.getAnimeMeta(id.replace('anitube:', ''));
    } else if (id.startsWith('tt')) {
      const data = await sf.fetchMeta(id, type);
      if (!data) return { meta: {} };
      result = {
        meta: {
          id, type: type === 'movie' ? 'movie' : 'series',
          name: data.name, poster: data.poster,
          background: data.background, description: data.description,
          genres: data.genres, year: data.year,
        },
      };
    }

    if (!result?.meta) return { meta: {} };
    cacheSet(key, result);
    return result;
  } catch (e) {
    console.error(`[Meta] "${id}":`, e.message);
    return { meta: {} };
  }
});

// ── Stream Handler ────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ id, type }) => {
  const key    = `stream:${id}`;
  const cached = cacheGet(key);
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

    // ── IDs IMDB/TMDB ── usa múltiplos provedores reais
    else if (id.startsWith('tt')) {
      const parts   = id.split(':');
      const imdbId  = parts[0];
      const season  = parts[1] ? parseInt(parts[1], 10) : null;
      const episode = parts[2] ? parseInt(parts[2], 10) : null;
      const isMovie = type === 'movie' || season === null;

      // Busca em paralelo: SuperFlix + VidSrc + AutoEmbed + 2Embed + GoDrive
      streams = await getAllStreams(imdbId, isMovie ? 'movie' : 'series', season, episode);

      // Fallback AniTube para animes (type series)
      if (!isMovie && streams.length < 2) {
        const atStreams = await tryAniTube(imdbId, season, episode);
        streams.push(...atStreams);
      }
    }

    else {
      return { streams: [] };
    }

    if (!streams.length) return { streams: [] };
    const result = { streams, cacheMaxAge: 300 };
    cacheSet(key, result);
    return result;
  } catch (e) {
    console.error(`[Stream] "${id}":`, e.message);
    return { streams: [] };
  }
});

// ── Fallback AniTube ──────────────────────────────────────────────────────────
async function tryAniTube(imdbId, season, episode) {
  try {
    const fetch = require('node-fetch');
    let title   = null;
    try {
      const r = await fetch(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`, { timeout: 8000 });
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
    const st = await extractStreams(sr.sources, sr.episodeUrl);
    return st.map(s => ({ ...s, name: `🎌 AniTube | ${s.name || ''}`.trim() }));
  } catch (_) { return []; }
}

module.exports = builder.getInterface();
