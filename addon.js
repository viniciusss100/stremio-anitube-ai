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
  version: '3.3.0',
  name: '🎌 AniTube.news',
  description: 'Addon para AniTube.news: busca, últimos episódios, mais vistos, animes recentes e lista completa.',
  logo: 'https://www.anitube.news/wp-content/uploads/logo-anitube-2.png',
  background: 'https://www.anitube.news/wp-content/themes/anitube/img/bg.jpg',

  // CORREÇÃO 1: Adicionado 'movie' e 'tt' no idPrefixes para aceitar IDs do Cinemeta/TMDB
  // Isso permite que o addon forneça streams quando o usuário busca via outros catálogos
  resources: ['catalog', 'meta', 'stream'],
  types: ['series', 'movie'],
  idPrefixes: ['anitube:', 'tt'],

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

    if (!Array.isArray(metas)) {
      console.warn(`[Catalog] Resposta inesperada do scraper para "${id}":`, metas);
      metas = [];
    }

    const result = { metas, cacheMaxAge: 300 };
    cacheSet(cacheKey, result);
    return result;

  } catch (e) {
    console.error(`[Catalog] Erro ao buscar catálogo "${id}":`, e);
    return { metas: [] };
  }
});

// ───────────────────────────────────────────────────────────────────────────
// META HANDLER
// ───────────────────────────────────────────────────────────────────────────
builder.defineMetaHandler(async ({ id, type }) => {
  // Só responde a IDs nativos do AniTube
  if (!id.startsWith('anitube:')) return { meta: {} };

  const animeId  = id.replace('anitube:', '');
  const cacheKey = `meta:${animeId}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const result = await scraper.getAnimeMeta(animeId);

    if (!result || !result.meta) {
      console.warn(`[Meta] Nenhum meta retornado para id "${animeId}"`);
      return { meta: {} };
    }

    cacheSet(cacheKey, result);
    return result;

  } catch (e) {
    console.error(`[Meta] Erro ao buscar meta para id "${animeId}":`, e);
    return { meta: {} };
  }
});

// ───────────────────────────────────────────────────────────────────────────
// STREAM HANDLER
// ───────────────────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ id, type }) => {
  const cacheKey = `stream:${id}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    let epId = null;

    if (id.startsWith('anitube:')) {
      // ── Fluxo nativo: ID já é do AniTube ──
      epId = id.replace('anitube:', '');

    } else if (id.startsWith('tt')) {
      // ── CORREÇÃO 2: Suporte a IDs externos (IMDB/Cinemeta/outros catálogos) ──
      // O Stremio passa o ID no formato "tt1234567:season:episode" para séries
      // ou apenas "tt1234567" para filmes.
      // Estratégia: extrair o título da meta via Cinemeta e buscar no AniTube.
      console.log(`[Stream] ID externo recebido: ${id} — buscando no AniTube...`);

      const streamResult = await handleExternalId(id, type);
      if (streamResult) {
        cacheSet(cacheKey, streamResult);
        return streamResult;
      }
      return { streams: [] };
    } else {
      console.warn(`[Stream] ID desconhecido: ${id}`);
      return { streams: [] };
    }

    // Fluxo nativo AniTube
    const scraperResult = await scraper.getEpisodeIframes(epId);

    if (!scraperResult) {
      console.warn(`[Stream] getEpisodeIframes retornou nulo para "${epId}"`);
      return { streams: [] };
    }

    const { sources, episodeUrl } = scraperResult;

    if (!Array.isArray(sources) || sources.length === 0) {
      console.warn(`[Stream] Nenhuma fonte encontrada para "${epId}"`);
      return { streams: [] };
    }

    const streams = await extractStreams(sources, episodeUrl);

    if (!Array.isArray(streams) || streams.length === 0) {
      console.warn(`[Stream] Nenhuma stream extraída para "${epId}"`);
      return { streams: [] };
    }

    const result = { streams, cacheMaxAge: 300 };
    cacheSet(cacheKey, result);
    return result;

  } catch (e) {
    console.error(`[Stream] Erro ao buscar streams para "${id}":`, e);
    return { streams: [] };
  }
});

// ───────────────────────────────────────────────────────────────────────────
// HANDLER PARA IDs EXTERNOS (IMDB / Cinemeta)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Quando o Stremio envia um ID do tipo "tt1234567" ou "tt1234567:1:2"
 * (série com temporada e episódio), buscamos o título via Cinemeta,
 * depois pesquisamos no AniTube e tentamos extrair a stream do episódio
 * correspondente.
 */
async function handleExternalId(id, type) {
  try {
    // Separar partes do ID: imdbId, season, episode
    const parts    = id.split(':');
    const imdbId   = parts[0];
    const season   = parts[1] ? parseInt(parts[1], 10) : null;
    const episode  = parts[2] ? parseInt(parts[2], 10) : null;

    // Buscar título no Cinemeta
    const metaType = (type === 'movie') ? 'movie' : 'series';
    const metaUrl  = `https://v3-cinemeta.strem.io/meta/${metaType}/${imdbId}.json`;
    const fetch    = require('node-fetch');

    let title = null;
    try {
      const metaRes = await fetch(metaUrl, { timeout: 10000 });
      if (metaRes.ok) {
        const metaJson = await metaRes.json();
        title = metaJson?.meta?.name || metaJson?.meta?.title || null;
      }
    } catch (e) {
      console.warn(`[Stream/External] Falha ao buscar Cinemeta para ${imdbId}:`, e.message);
    }

    if (!title) {
      console.warn(`[Stream/External] Não foi possível obter título para ${imdbId}`);
      return null;
    }

    console.log(`[Stream/External] Título encontrado: "${title}" — buscando no AniTube...`);

    // Pesquisar no AniTube pelo título
    const searchResults = await scraper.searchAnimes(title);

    if (!searchResults || searchResults.length === 0) {
      console.warn(`[Stream/External] Nenhum resultado no AniTube para "${title}"`);
      return null;
    }

    // Pegar o primeiro resultado (mais relevante)
    const bestMatch = searchResults[0];
    const animeId   = bestMatch.id.replace('anitube:', '');

    console.log(`[Stream/External] Melhor resultado: "${bestMatch.name}" (id: ${animeId})`);

    // Se for série, precisamos encontrar o episódio correto
    let epId = animeId;

    if (season !== null && episode !== null) {
      // Buscar a lista de episódios via meta
      try {
        const metaResult = await scraper.getAnimeMeta(animeId);
        const videos     = metaResult?.meta?.videos || [];

        // Tentar achar o episódio pelo número
        const matchedEp = videos.find(v => v.episode === episode) ||
                          videos[episode - 1] ||
                          videos[0];

        if (matchedEp) {
          epId = matchedEp.id.replace('anitube:', '');
          console.log(`[Stream/External] Episódio mapeado: S${season}E${episode} → epId=${epId}`);
        }
      } catch (e) {
        console.warn(`[Stream/External] Falha ao buscar episódios:`, e.message);
      }
    }

    // Extrair streams do episódio encontrado
    const scraperResult = await scraper.getEpisodeIframes(epId);

    if (!scraperResult || !Array.isArray(scraperResult.sources) || scraperResult.sources.length === 0) {
      console.warn(`[Stream/External] Nenhuma fonte para epId=${epId}`);
      return null;
    }

    const streams = await extractStreams(scraperResult.sources, scraperResult.episodeUrl);

    if (!Array.isArray(streams) || streams.length === 0) {
      console.warn(`[Stream/External] Nenhuma stream extraída para epId=${epId}`);
      return null;
    }

    return { streams, cacheMaxAge: 300 };

  } catch (e) {
    console.error(`[Stream/External] Erro ao processar ID externo "${id}":`, e);
    return null;
  }
}

module.exports = builder.getInterface();
