'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper = require('./src/scraper');
const { extractStreams } = require('./src/extractor');
const fetch = require('node-fetch');

// ── Cache em memória ──────────────────────────────────────────────────────────
const cache     = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// ── Manifest ──────────────────────────────────────────────────────────────────
const manifest = {
  id         : 'community.anitube.news',
  version    : '4.0.0',
  name       : '🎌 AniTube.news',
  description: 'Animes dublados e legendados do AniTube.news. Funciona nos catálogos do Stremio, Cinemeta e Kitsu.',
  logo       : 'https://www.anitube.news/wp-content/uploads/logo-anitube-2.png',
  background : 'https://www.anitube.news/wp-content/themes/anitube/img/bg.jpg',

  resources  : ['catalog', 'meta', 'stream'],
  types      : ['series'],

  // idPrefixes define para quais IDs externos o Stremio vai chamar nosso streamHandler.
  // 'anitube:' → catálogos próprios
  // 'tt'       → Cinemeta (IDs IMDB) — o addon aparece ao abrir uma série no Cinemeta
  // 'kitsu:'   → Kitsu addon — o addon aparece ao abrir um anime no Kitsu
  idPrefixes : ['anitube:', 'tt', 'kitsu:'],

  behaviorHints: { configurable: false, adult: false },

  catalogs: [
    // Todos os catálogos têm "search" habilitado.
    // Isso faz com que o addon apareça nos resultados ao pesquisar
    // em QUALQUER catálogo do Stremio (incluindo Cinemeta e Kitsu).
    {
      id   : 'anitube_ultimos',
      type : 'series',
      name : '🆕 AniTube – Últimos Episódios',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'anitube_mais_vistos',
      type : 'series',
      name : '🔥 AniTube – Mais Vistos',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'anitube_recentes',
      type : 'series',
      name : '📺 AniTube – Animes Recentes',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'anitube_lista',
      type : 'series',
      name : '📚 AniTube – Lista Completa',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
  ],
};

const builder = new addonBuilder(manifest);

// ── Catalog Handler ───────────────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ id, extra = {} }) => {
  const skip   = parseInt(extra.skip, 10) || 0;
  const page   = Math.floor(skip / 20) + 1;
  const search = (extra.search || '').trim();

  const key    = `cat:${id}:${search}:${page}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    let metas = [];

    if (search) {
      // Qualquer catálogo com search ativo retorna resultado de busca no AniTube.
      // Isso é o que faz o addon aparecer ao pesquisar no Cinemeta/Kitsu/outros.
      metas = await scraper.searchAnimes(search);
    } else {
      switch (id) {
        case 'anitube_ultimos':     metas = await scraper.getLatestEpisodes(page); break;
        case 'anitube_mais_vistos': metas = await scraper.getMostWatched(page);    break;
        case 'anitube_recentes':    metas = await scraper.getRecentAnimes(page);   break;
        case 'anitube_lista':
        default:                    metas = await scraper.getAnimeList(page);      break;
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
  // Só responde a IDs nativos do AniTube — outros ficam com o addon que os gerou.
  if (!id.startsWith('anitube:')) return { meta: {} };

  const key    = `meta:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const animeId = id.replace('anitube:', '');
    const result  = await scraper.getAnimeMeta(animeId);
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

    if (id.startsWith('anitube:')) {
      // ── ID nativo: episódio já conhecido ──────────────────────────────────
      streams = await extractAniTubeById(id.replace('anitube:', ''));

    } else if (id.startsWith('tt')) {
      // ── ID IMDB (Cinemeta) ────────────────────────────────────────────────
      // Formato série: "tt1234567:1:3" (temporada 1, episódio 3)
      // Formato filme: "tt1234567" (ignoramos — AniTube não tem filmes)
      const parts   = id.split(':');
      const imdbId  = parts[0];
      const season  = parts[1] ? parseInt(parts[1], 10) : null;
      const episode = parts[2] ? parseInt(parts[2], 10) : null;

      if (type === 'movie') return { streams: [] }; // AniTube não tem filmes

      const title = await resolveImdbTitle(imdbId);
      if (title) streams = await searchAndExtract(title, [], season, episode);

    } else if (id.startsWith('kitsu:')) {
      // ── ID Kitsu ──────────────────────────────────────────────────────────
      // Formato: "kitsu:12345:1:3" (série 12345, temp. 1, ep. 3)
      const parts   = id.split(':');
      const kitsuId = `${parts[0]}:${parts[1]}`; // "kitsu:12345"
      const season  = parts[2] ? parseInt(parts[2], 10) : 1;
      const episode = parts[3] ? parseInt(parts[3], 10) : 1;

      const { title, aliases } = await resolveKitsuTitle(kitsuId);
      if (title) streams = await searchAndExtract(title, aliases, season, episode);
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

// ── Extração de streams ───────────────────────────────────────────────────────

async function extractAniTubeById(epId) {
  const sr = await scraper.getEpisodeIframes(epId);
  if (!sr?.sources?.length) return [];
  return extractStreams(sr.sources, sr.episodeUrl);
}

// Resolve título de um ID IMDB via Cinemeta
async function resolveImdbTitle(imdbId) {
  try {
    const r = await fetch(
      `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`,
      { timeout: 8000 }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j?.meta?.name || null;
  } catch (_) {
    return null;
  }
}

// Resolve título e aliases de um ID Kitsu
async function resolveKitsuTitle(kitsuId) {
  try {
    const r = await fetch(
      `https://anime-kitsu.strem.fun/meta/anime/${kitsuId}.json`,
      { timeout: 8000 }
    );
    if (!r.ok) return { title: null, aliases: [] };
    const j = await r.json();
    return {
      title  : j?.meta?.name   || null,
      aliases: j?.meta?.aliases || [],
    };
  } catch (_) {
    return { title: null, aliases: [] };
  }
}

// Busca o anime no AniTube e extrai a stream do episódio correto.
// Tenta múltiplas variações do título para aumentar o match.
async function searchAndExtract(title, aliases, season, episode) {
  // Gera variações de busca priorizando as mais simples
  const queries = buildQueries(title, aliases);

  let results = [];
  for (const q of queries) {
    try {
      results = await scraper.searchAnimes(q);
      if (results.length > 0) {
        console.log(`[AniTube] Match: "${q}" → "${results[0].name}"`);
        break;
      }
    } catch (_) {}
  }

  if (!results.length) {
    console.warn(`[AniTube] Sem resultados para "${title}"`);
    return [];
  }

  const animeId = results[0].id.replace('anitube:', '');
  const epId    = await resolveEpisodeId(animeId, episode);
  return extractAniTubeById(epId);
}

// Resolve o ID do episódio correto dentro de um anime
async function resolveEpisodeId(animeId, episode) {
  if (!episode || episode <= 0) return animeId;
  try {
    const meta   = await scraper.getAnimeMeta(animeId);
    const videos = meta?.meta?.videos || [];
    if (!videos.length) return animeId;

    const ep = videos.find(v => v.episode === episode)
            || videos[episode - 1]
            || videos[0];
    return ep ? ep.id.replace('anitube:', '') : animeId;
  } catch (_) {
    return animeId;
  }
}

// Gera variações do título para aumentar chance de match no AniTube
function buildQueries(title, aliases) {
  const seen    = new Set();
  const queries = [];

  function add(s) {
    if (!s || s.length < 2) return;
    const clean = s.trim();
    if (!seen.has(clean)) { seen.add(clean); queries.push(clean); }
  }

  // Título limpo (sem "(Dub)", sem subtítulo após ":" ou " - ")
  add(title.replace(/\s*\(Dub\)/i, '').split(':')[0].split(' - ')[0].trim());
  // Título sem "(Dub)" mas com subtítulo
  add(title.replace(/\s*\(Dub\)/i, '').trim());
  // Título original completo
  add(title);
  // Aliases (nomes alternativos da API)
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (typeof a === 'string') {
        add(a.split(':')[0].split(' - ')[0].trim());
        add(a.trim());
      }
    }
  }

  return queries;
}

module.exports = builder.getInterface();
