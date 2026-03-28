'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper  = require('./src/scraper');
const { extractStreams } = require('./src/extractor');
const { getAllStreams } = require('./src/providers');

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache   = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(k); return null; }
  return e.value;
}
function cacheSet(k, v) { cache.set(k, { value: v, ts: Date.now() }); }

// ── Manifest ──────────────────────────────────────────────────────────────────
const manifest = {
  id         : 'community.anitube.v1',
  version    : '1.0.0',
  name       : '🎌 AniTube (sem SuperFlix)',
  description: 'AniTube.news (animes JP). SuperFlix removido.',
  logo       : 'https://www.anitube.news/wp-content/uploads/logo-anitube-2.png',
  background : 'https://www.anitube.news/wp-content/themes/anitube/img/bg.jpg',

  resources  : ['catalog', 'meta', 'stream'],
  types      : ['series', 'movie'],

  // idPrefixes: mantemos apenas os necessários
  idPrefixes : ['anitube:', 'tt', 'kitsu:'],

  behaviorHints: { configurable: false, adult: false },

  catalogs: [
    // AniTube
    {
      id   : 'anitube_ultimos_eps',
      type : 'series',
      name : '🆕 AniTube – Últimos Episódios',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
    },
    {
      id   : 'anitube_mais_vistos',
      type : 'series',
      name : '🔥 AniTube – Mais Vistos',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
    },
    {
      id   : 'anitube_recentes',
      type : 'series',
      name : '📺 AniTube – Animes Recentes',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
    },
    {
      id   : 'anitube_lista',
      type : 'series',
      name : '📚 AniTube – Lista Completa',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
    },
  ],
};

const builder = new addonBuilder(manifest);

// ── Catalog Handler ───────────────────────────────────────────────────────────
builder.defineCatalogHandler(async function(args) {
  const id     = args.id;
  const extra  = args.extra || {};
  const skip   = parseInt(extra.skip, 10) || 0;
  const page   = Math.floor(skip / 20) + 1;
  const search = (extra.search || '').trim();

  const key    = 'cat:' + id + ':' + search + ':' + page;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    let metas = [];

    if (id.startsWith('anitube_')) {
      if (search) metas = await scraper.searchAnimes(search);
      else {
        switch (id) {
          case 'anitube_ultimos_eps': metas = await scraper.getLatestEpisodes(page); break;
          case 'anitube_mais_vistos': metas = await scraper.getMostWatched(page);    break;
          case 'anitube_recentes':    metas = await scraper.getRecentAnimes(page);   break;
          case 'anitube_lista':
          default:                    metas = await scraper.getAnimeList(page);      break;
        }
      }
    } else {
      metas = [];
    }

    if (!Array.isArray(metas)) metas = [];
    const result = { metas, cacheMaxAge: 300 };
    cacheSet(key, result);
    return result;
  } catch (e) {
    console.error('[Catalog] "' + id + '":', e.message);
    return { metas: [] };
  }
});

// ── Meta Handler ──────────────────────────────────────────────────────────────
builder.defineMetaHandler(async function(args) {
  const id   = args.id;
  const type = args.type;
  const key  = 'meta:' + id + ':' + type;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    let result;

    if (id.startsWith('anitube:')) {
      result = await scraper.getAnimeMeta(id.replace('anitube:', ''));
    } else if (id.startsWith('tt')) {
      // Sem SuperFlix: tentamos buscar via Cinemeta/TMDB se necessário
      // Reaproveite scraper/fetch helpers se tiver função para isso; caso contrário retorna vazio
      // Mantemos compatibilidade mínima retornando meta vazio para tt
      return { meta: {} };
    } else {
      return { meta: {} };
    }

    if (!result || !result.meta) return { meta: {} };
    cacheSet(key, result);
    return result;
  } catch (e) {
    console.error('[Meta] "' + id + '":', e.message);
    return { meta: {} };
  }
});

// ── Stream Handler ────────────────────────────────────────────────────────────
builder.defineStreamHandler(async function(args) {
  const id   = args.id;
  const type = args.type;
  const key  = 'stream:' + id;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    let streams = [];

    // AniTube nativo
    if (id.startsWith('anitube:')) {
      const epId = id.replace('anitube:', '');
      const sr   = await scraper.getEpisodeIframes(epId);
      if (sr && sr.sources && sr.sources.length) {
        streams = await extractStreams(sr.sources, sr.episodeUrl);
      }
    }

    // IDs IMDB — mantemos getAllStreams, mas sem SuperFlix (providers.js já ajustado)
    else if (id.startsWith('tt')) {
      const parts   = id.split(':');
      const imdbId  = parts[0];
      const season  = parts[1] !== undefined ? parseInt(parts[1], 10) : null;
      const episode = parts[2] !== undefined ? parseInt(parts[2], 10) : null;
      const isMovie = (type === 'movie');

      streams = await getAllStreams(imdbId, type, season, episode);

      // Fallback AniTube
      if (!isMovie && streams.length < 2) {
        const atStreams = await tryAniTube(imdbId, type, season, episode);
        streams.push.apply(streams, atStreams);
      }
    }

    // Kitsu fallback
    else if (id.startsWith('kitsu:')) {
      const parts   = id.split(':');
      const kitsuId = parts[0] + ':' + parts[1];
      const season  = parts[2] ? parseInt(parts[2], 10) : 1;
      const episode = parts[3] ? parseInt(parts[3], 10) : 1;

      const atStreams = await tryAniTubeKitsu(kitsuId, season, episode);
      streams.push.apply(streams, atStreams);
    }

    if (!streams.length) return { streams: [] };
    const result = { streams, cacheMaxAge: 300 };
    cacheSet(key, result);
    return result;
  } catch (e) {
    console.error('[Stream] "' + id + '":', e.message);
    return { streams: [] };
  }
});

// ── Helpers AniTube (mantidos) ───────────────────────────────────────────────
async function tryAniTube(imdbId, type, season, episode) {
  try {
    const fetch   = require('node-fetch');
    const cinType = type === 'movie' ? 'movie' : 'series';
    let title = null, aliases = [];

    try {
      const r = await fetch('https://v3-cinemeta.strem.io/meta/' + cinType + '/' + imdbId + '.json', { timeout: 8000 });
      if (r.ok) { const j = await r.json(); title = (j && j.meta && j.meta.name) || null; aliases = (j && j.meta && j.meta.aliases) || []; }
    } catch (_) {}

    if (!title) return [];
    return await searchAndExtractAniTube(title, aliases, season, episode);
  } catch (e) {
    console.warn('[AniTube/IMDB]', e.message);
    return [];
  }
}

async function tryAniTubeKitsu(kitsuId, season, episode) {
  try {
    const fetch = require('node-fetch');
    let title = null, aliases = [];

    try {
      const r = await fetch('https://anime-kitsu.strem.fun/meta/anime/' + kitsuId + '.json', { timeout: 8000 });
      if (r.ok) { const j = await r.json(); title = (j && j.meta && j.meta.name) || null; aliases = (j && j.meta && j.meta.aliases) || []; }
    } catch (_) {}

    if (!title) return [];
    return await searchAndExtractAniTube(title, aliases, season, episode);
  } catch (e) {
    console.warn('[AniTube/Kitsu]', e.message);
    return [];
  }
}

async function searchAndExtractAniTube(title, aliases, season, episode) {
  const queries = new Set();
  queries.add(title.replace(/\(Dub\)/i, '').split(':')[0].split(' - ')[0].trim());
  queries.add(title.replace(/\(Dub\)/i, '').trim());
  if (Array.isArray(aliases)) {
    aliases.forEach(function(a) {
      if (typeof a === 'string' && a.length > 1) {
        queries.add(a.split(':')[0].split(' - ')[0].trim());
      }
    });
  }

  let results = [];
  for (const q of queries) {
    if (!q || q.length < 2) continue;
    try {
      results = await scraper.searchAnimes(q);
      if (results && results.length) break;
    } catch (_) {}
  }

  if (!results || !results.length) return [];

  const animeId = results[0].id.replace('anitube:', '');
  let epId = animeId;

  if (episode && episode > 0) {
    try {
      const meta   = await scraper.getAnimeMeta(animeId);
      const videos = (meta && meta.meta && meta.meta.videos) || [];
      const ep     = videos.find(function(v) { return v.episode === episode; }) ||
                     videos[episode - 1] ||
                     videos[0];
      if (ep) epId = ep.id.replace('anitube:', '');
    } catch (_) {}
  }

  const sr = await scraper.getEpisodeIframes(epId);
  if (!sr || !sr.sources || !sr.sources.length) return [];
  const st = await extractStreams(sr.sources, sr.episodeUrl);
  return st.map(function(s) { return Object.assign({}, s, { name: '🎌 AniTube | ' + (s.name || '') }); });
}

module.exports = builder.getInterface();
