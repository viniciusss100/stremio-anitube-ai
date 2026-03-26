'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper = require('./src/scraper');
const { extractStreams } = require('./src/extractor');

// ───────────────────────────────────────────────────────────────────────────
// CACHE SIMPLES EM MEMÓRIA
// ───────────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// ───────────────────────────────────────────────────────────────────────────
// MANIFEST
// ───────────────────────────────────────────────────────────────────────────
const manifest = {
  id: 'community.anitube.news',
  version: '3.2.7',
  name: '🎌 AniTube.news',
  description: 'Addon para AniTube.news: busca, últimos episódios, mais vistos, animes recentes e lista completa.',
  logo: 'https://www.anitube.news/wp-content/uploads/logo-anitube-2.png',
  background: 'https://www.anitube.news/wp-content/themes/anitube/img/bg.jpg',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],           // 'anime' não é tipo nativo do Stremio — removido
  idPrefixes: ['anitube:'],
  behaviorHints: {
    configurable: false,
    adult: false,
  },
  catalogs: [
    {
      id: 'anitube_search',
      type: 'series',
      name: '🔍 AniTube – Busca',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id: 'anitube_ultimos_eps',
      type: 'series',
      name: '🆕 AniTube – Últimos Episódios',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      id: 'anitube_mais_vistos',
      type: 'series',
      name: '🔥 AniTube – Mais Vistos',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      id: 'anitube_recentes',
      type: 'series',
      name: '📺 AniTube – Animes Recentes',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      id: 'anitube_lista',
      type: 'series',
      name: '📚 AniTube – Lista Completa',
      extra: [{ name: 'skip', isRequired: false }],
    },
  ],
};

const builder = new addonBuilder(manifest);

// ───────────────────────────────────────────────────────────────────────────
// CATALOG HANDLER
// ───────────────────────────────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ id, type, extra }) => {
  const skip   = parseInt(extra.skip, 10) || 0;
  const page   = Math.floor(skip / 20) + 1;
  const search = (extra.search || '').trim();

  // Chave de cache única por catálogo + parâmetros
  const cacheKey = `catalog:${id}:${search}:${skip}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    let metas = [];

    if (search) {
      metas = await scraper.searchAnimes(search);
    } else {
      switch (id) {
        case 'anitube_ultimos_eps':
          metas = await scraper.getLatestEpisodes(page);
          break;
        case 'anitube_mais_vistos':
          metas = await scraper.getMostWatched(page);
          break;
        case 'anitube_recentes':
          metas = await scraper.getRecentAnimes(page);
          break;
        case 'anitube_lista':
        case 'anitube_search':
        default:
          metas = await scraper.getAnimeList(page);
          break;
      }
    }

    // Garante que metas é sempre um array válido
    if (!Array.isArray(metas)) {
      console.warn(`[Catalog] Resposta inesperada do scraper para \"${id}\":`, metas);
      metas = [];
    }

    const result = { metas, cacheMaxAge: 300 }; // sugere 5 min de cache ao cliente
    cacheSet(cacheKey, result);
    return result;

  } catch (e) {
    console.error(`[Catalog] Erro ao buscar catálogo \"${id}\":`, e);
    return { metas: [] };
  }
});

// ───────────────────────────────────────────────────────────────────────────
// META HANDLER
// ───────────────────────────────────────────────────────────────────────────
builder.defineMetaHandler(async ({ id, type }) => {
  const animeId  = id.replace('anitube:', '');
  const cacheKey = `meta:${animeId}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const result = await scraper.getAnimeMeta(animeId);

    if (!result || !result.meta) {
      console.warn(`[Meta] Nenhum meta retornado para id \"${animeId}\"`);
      return { meta: {} };
    }

    cacheSet(cacheKey, result);
    return result;

  } catch (e) {
    console.error(`[Meta] Erro ao buscar meta para id \"${animeId}\":`, e);
    return { meta: {} };
  }
});

// ───────────────────────────────────────────────────────────────────────────
// STREAM HANDLER
// ───────────────────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ id, type }) => {
  const epId     = id.replace('anitube:', '');
  const cacheKey = `stream:${epId}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const scraperResult = await scraper.getEpisodeIframes(epId);

    if (!scraperResult) {
      console.warn(`[Stream] getEpisodeIframes retornou nulo para \"${epId}\"`);
      return { streams: [] };
    }

    const { sources, episodeUrl } = scraperResult;

    if (!Array.isArray(sources) || sources.length === 0) {
      console.warn(`[Stream] Nenhuma fonte encontrada para \"${epId}\"`);
      return { streams: [] };
    }

    const streams = await extractStreams(sources, episodeUrl);

    if (!Array.isArray(streams) || streams.length === 0) {
      console.warn(`[Stream] Nenhuma stream extraída para \"${epId}\"`);
      return { streams: [] };
    }

    const result = { streams, cacheMaxAge: 300 };
    cacheSet(cacheKey, result);
    return result;

  } catch (e) {
    console.error(`[Stream] Erro ao buscar streams para \"${epId}\":`, e);
    return { streams: [] };
  }
});

module.exports = builder.getInterface();
