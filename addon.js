'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper = require('./src/scraper');
const { extractStreams } = require('./src/extractor');

const manifest = {
  id: 'community.anitube.news',
  version: '3.2.6',
  name: '🎌 AniTube.news (V3.2 Final PRO)',
  description: 'Addon v3.2.6: FUSÃO PERFEITA v2.1.1 (Google Video OK) + v3.0.0 (FHD HLS Proxy OK). Integrado com AniTube.news.',
  logo: 'https://www.anitube.news/wp-content/uploads/logo-anitube-2.png',
  background: 'https://www.anitube.news/wp-content/themes/anitube/img/bg.jpg',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series', 'anime'],
  idPrefixes: ['anitube:'],
  catalogs: [
    {
      id: 'anitube_search',
      type: 'series',
      name: '🔍 AniTube – Busca',
      extra: [{ name: 'search', isRequired: false }]
    },
    {
      id: 'anitube_ultimos_eps',
      type: 'series',
      name: '🆕 AniTube – Últimos Episódios',
    },
    {
      id: 'anitube_mais_vistos',
      type: 'series',
      name: '🔥 AniTube – Mais Vistos',
    },
    {
      id: 'anitube_recentes',
      type: 'series',
      name: '📺 AniTube – Animes Recentes',
    },
    {
      id: 'anitube_lista',
      type: 'series',
      name: '📚 AniTube – Lista Completa',
      extra: [{ name: 'skip', isRequired: false }]
    },
  ],
};

const builder = new addonBuilder(manifest);

// ───────────────────────────────────────────────────────────────────────────
// CATALOG HANDLER
// ───────────────────────────────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ id, extra }) => {
  try {
    if (extra.search) {
      return { metas: await scraper.searchAnimes(extra.search) };
    }

    const page = Math.floor((extra.skip || 0) / 20) + 1;

    switch (id) {
      case 'anitube_ultimos_eps':
        return { metas: await scraper.getLatestEpisodes() };

      case 'anitube_mais_vistos':
        return { metas: await scraper.getMostWatched() };

      case 'anitube_recentes':
        return { metas: await scraper.getRecentAnimes() };

      case 'anitube_lista':
      case 'anitube_search': // Fallback para o catálogo de busca sem query
      default:
        return { metas: await scraper.getAnimeList(page) };
    }

  } catch (e) {
    console.error(`[Catalog] Erro: ${e.message}`);
    return { metas: [] };
  }
});

// ───────────────────────────────────────────────────────────────────────────
// META HANDLER
// ───────────────────────────────────────────────────────────────────────────
builder.defineMetaHandler(async ({ id }) => {
  const animeId = id.replace('anitube:', '');
  try {
    return await scraper.getAnimeMeta(animeId);
  } catch (e) {
    console.error(`[Meta] Erro: ${e.message}`);
    return { meta: {} };
  }
});

// ───────────────────────────────────────────────────────────────────────────
// STREAM HANDLER
// ───────────────────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ id }) => {
  const epId = id.replace('anitube:', '');
  try {
    const { sources, episodeUrl } = await scraper.getEpisodeIframes(epId);
    if (!sources || sources.length === 0) return { streams: [] };

    const streams = await extractStreams(sources, episodeUrl);
    return { streams };
  } catch (e) {
    console.error(`[Stream] Erro: ${e.message}`);
    return { streams: [] };
  }
});

module.exports = builder.getInterface();
