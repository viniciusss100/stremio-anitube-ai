'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper = require('./src/scraper');
const animesdigital = require('./src/providers/animesdigital');
const { extractStreams } = require('./src/extractor');
const fetch = require('node-fetch');

// ── Cache em memória ──────────────────────────────────────────────────────────
const cache     = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// ── Manifest ──────────────────────────────────────────────────────────────────
const manifest = {
  id         : 'community.anitube.news',
  version    : '4.1.0',
  name       : '🎌 AniTube.news + AnimesDigital',
  description: 'Animes do AniTube.news e AnimesDigital.org. Funciona nos catálogos do Stremio, Cinemeta e Kitsu.',
  logo       : 'https://www.anitube.news/wp-content/uploads/logo-anitube-2.png',
  background : 'https://www.anitube.news/wp-content/themes/anitube/img/bg.jpg',

  resources  : ['catalog', 'meta', 'stream'],
  types      : ['series'],

  idPrefixes : ['anitube:', 'tt', 'kitsu:'],

  behaviorHints: { configurable: false, adult: false },

  catalogs: [
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

    {
      id   : 'animesdigital_ultimos',
      type : 'series',
      name : '🆕 AnimesDigital – Últimos Episódios',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'animesdigital_recentes',
      type : 'series',
      name : '📺 AnimesDigital – Animes Recentes',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'animesdigital_lista',
      type : 'series',
      name : '📚 AnimesDigital – Lista Completa',
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
      let primary = [];
      let secondary = [];

      try {
        primary = await scraper.searchAnimes(search);
      } catch (_) {}

      try {
        secondary = await animesdigital.searchAnimes(search);
      } catch (_) {}

      metas = mergeMetas(primary, secondary);
    } else {
      switch (id) {
        case 'anitube_ultimos':
          metas = await scraper.getLatestEpisodes(page);
          break;

        case 'anitube_mais_vistos':
          metas = await scraper.getMostWatched(page);
          break;

        case 'anitube_recentes':
          metas = await scraper.getRecentAnimes(page);
          break;

        case 'anitube_lista':
          metas = await scraper.getAnimeList(page);
          break;

        case 'animesdigital_ultimos':
          metas = await animesdigital.getLatestEpisodes(page);
          break;

        case 'animesdigital_recentes':
          metas = await animesdigital.getRecentAnimes(page);
          break;

        case 'animesdigital_lista':
          metas = await animesdigital.getAnimeList(page);
          break;

        default:
          metas = [];
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
  if (!id.startsWith('anitube:')) return { meta: {} };

  const key    = `meta:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const animeId = id.replace('anitube:', '');

    let result = null;

    try {
      result = await scraper.getAnimeMeta(animeId);
    } catch (_) {}

    if (!result?.meta) {
      try {
        result = await animesdigital.getAnimeMeta(animeId);
      } catch (_) {}
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

    if (id.startsWith('anitube:')) {
      streams = await extractAniTubeById(id.replace('anitube:', ''));

    } else if (id.startsWith('tt')) {
      const parts   = id.split(':');
      const imdbId  = parts[0];
      const season  = parts[1] ? parseInt(parts[1], 10) : null;
      const episode = parts[2] ? parseInt(parts[2], 10) : null;

      if (type === 'movie') return { streams: [] };

      const { title, aliases } = await resolveImdbTitle(imdbId);
      if (title) streams = await searchAndExtract(title, aliases, season, episode);

    } else if (id.startsWith('kitsu:')) {
      const parts   = id.split(':');
      const kitsuId = `${parts[0]}:${parts[1]}`;
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

// Resolve título e aliases de um ID IMDB via Cinemeta
async function resolveImdbTitle(imdbId) {
  try {
    const r = await fetch(
      `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`,
      { timeout: 8000 }
    );
    if (!r.ok) return { title: null, aliases: [] };
    const j = await r.json();
    return {
      title  : j?.meta?.name    || null,
      aliases: j?.meta?.aliases || [],
    };
  } catch (_) {
    return { title: null, aliases: [] };
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
      title  : j?.meta?.name    || null,
      aliases: j?.meta?.aliases || [],
    };
  } catch (_) {
    return { title: null, aliases: [] };
  }
}

const SIMILARITY_THRESHOLD = 0.45;

async function searchAndExtract(title, aliases, season, episode) {
  const queries   = buildQueries(title, aliases);
  const allTitles = buildAllTitles(title, aliases);

  let bestMatch = null;
  let bestScore = 0;
  let matchedQuery = '';

  for (const q of queries) {
    let aniTubeResults = [];
    let animesDigitalResults = [];

    try {
      aniTubeResults = await scraper.searchAnimes(q);
    } catch (_) {}

    try {
      animesDigitalResults = await animesdigital.searchAnimes(q);
    } catch (_) {}

    const results = mergeMetas(aniTubeResults, animesDigitalResults);
    if (!results?.length) continue;

    for (const candidate of results) {
      const candidateName = candidate.name || '';
      const score = allTitles.reduce(
        (max, t) => Math.max(max, similarity(t, candidateName)),
        0
      );

      if (score > bestScore) {
        bestScore   = score;
        bestMatch   = candidate;
        matchedQuery = q;
      }
    }

    if (bestScore >= SIMILARITY_THRESHOLD) break;
  }

  if (!bestMatch || bestScore < SIMILARITY_THRESHOLD) {
    console.warn(`[Addon] Sem match confiável para "${title}" (melhor score: ${bestScore.toFixed(2)})`);
    return [];
  }

  console.log(`[Addon] Match: "${matchedQuery}" → "${bestMatch.name}" (score: ${bestScore.toFixed(2)})`);

  const animeId = bestMatch.id.replace('anitube:', '');
  const epId    = await resolveEpisodeId(animeId, episode);
  return extractAniTubeById(epId);
}

async function resolveEpisodeId(animeId, episode) {
  if (!episode || episode <= 0) return animeId;

  try {
    let meta = null;

    try {
      meta = await scraper.getAnimeMeta(animeId);
    } catch (_) {}

    if (!meta?.meta?.videos?.length) {
      try {
        meta = await animesdigital.getAnimeMeta(animeId);
      } catch (_) {}
    }

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

function buildQueries(title, aliases) {
  const seen    = new Set();
  const jpFirst = [];
  const enLast  = [];

  function addTo(arr, s) {
    if (!s || s.length < 2) return;
    const clean = s.trim();
    if (!seen.has(clean)) {
      seen.add(clean);
      arr.push(clean);
    }
  }

  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (typeof a !== 'string') continue;
      addTo(jpFirst, a.split(':')[0].split(' - ')[0].trim());
      addTo(jpFirst, a.trim());
    }
  }

  addTo(enLast, title.replace(/\s*\(Dub\)/i, '').split(':')[0].split(' - ')[0].trim());
  addTo(enLast, title.replace(/\s*\(Dub\)/i, '').trim());
  addTo(enLast, title);

  return [...jpFirst, ...enLast];
}

function buildAllTitles(title, aliases) {
  const titles = new Set();

  function add(s) {
    if (s && s.length > 1) titles.add(normalize(s));
  }

  add(title);
  add(title.replace(/\s*\(Dub\)/i, '').trim());
  add(title.split(':')[0].trim());

  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (typeof a === 'string') {
        add(a);
        add(a.split(':')[0].trim());
      }
    }
  }

  return [...titles];
}

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[:\-–—]/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\b(the|a|an|no|wo|wa|ga|de|ni|to)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;

  if (na.includes(nb) || nb.includes(na)) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  }

  const setA = new Set(na.split(' ').filter(Boolean));
  const setB = new Set(nb.split(' ').filter(Boolean));
  let wordInter = 0;
  for (const w of setA) if (setB.has(w)) wordInter++;
  const jaccard = wordInter / (setA.size + setB.size - wordInter);

  const bgA = new Set(bigrams(na));
  const bgB = new Set(bigrams(nb));
  let bgInter = 0;
  for (const bg of bgA) if (bgB.has(bg)) bgInter++;
  const dice = (bgA.size + bgB.size) > 0 ? (2 * bgInter) / (bgA.size + bgB.size) : 0;

  return Math.max(jaccard, dice);
}

function bigrams(s) {
  const words = s.split(' ').filter(Boolean);
  if (words.length === 1) return words;
  const out = [];
  for (let i = 0; i < words.length - 1; i++) {
    out.push(`${words[i]} ${words[i + 1]}`);
  }
  return out;
}

function mergeMetas(primary = [], secondary = []) {
  const out = [];
  const seen = new Set();

  for (const item of [...primary, ...secondary]) {
    if (!item || !item.id) continue;
    const key = normalize(item.name || item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

module.exports = builder.getInterface();
