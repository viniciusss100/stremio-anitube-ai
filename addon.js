'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper  = require('./src/scraper');
const { extractStreams } = require('./src/extractor');
const sf       = require('./src/superflixapi');
const { getAllStreams } = require('./src/providers');

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
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
  id         : 'community.anitube.superflix.v8',
  version    : '8.0.0',
  name       : '🎌🎬 AniTube + SuperFlix BR',
  description: 'AniTube.news (animes JP) + SuperFlixAPI + VidSrc + AutoEmbed (filmes/séries BR). Reproduz no player do Stremio.',
  logo       : 'https://www.anitube.news/wp-content/uploads/logo-anitube-2.png',
  background : 'https://www.anitube.news/wp-content/themes/anitube/img/bg.jpg',
  resources  : ['catalog', 'meta', 'stream'],
  types      : ['series', 'movie'],
  idPrefixes : ['anitube:', 'tt', 'kitsu:'],
  behaviorHints: { configurable: false, adult: false },
  catalogs: [
    // ── AniTube ──
    {
      id   : 'anitube_search',
      type : 'series',
      name : '🔍 AniTube – Busca',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'anitube_ultimos_eps',
      type : 'series',
      name : '🆕 AniTube – Últimos Episódios',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      id   : 'anitube_mais_vistos',
      type : 'series',
      name : '🔥 AniTube – Mais Vistos',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      id   : 'anitube_recentes',
      type : 'series',
      name : '📺 AniTube – Animes Recentes',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      id   : 'anitube_lista',
      type : 'series',
      name : '📚 AniTube – Lista Completa',
      extra: [{ name: 'skip', isRequired: false }],
    },
    // ── SuperFlix BR ──
    {
      id   : 'sf_filmes',
      type : 'movie',
      name : '🎬 SuperFlix BR – Filmes',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'sf_series',
      type : 'series',
      name : '📺 SuperFlix BR – Séries',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'sf_animes',
      type : 'series',
      name : '🎌 SuperFlix BR – Animes (Dub/Leg)',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'sf_lancamentos',
      type : 'series',
      name : '🆕 SuperFlix BR – Lançamentos',
      extra: [{ name: 'skip', isRequired: false }],
    },
  ],
};

const builder = new addonBuilder(manifest);

// ── Catalog Handler ───────────────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ id, type, extra }) => {
  const skip   = parseInt(extra.skip, 10) || 0;
  const page   = Math.floor(skip / 20) + 1;
  // CORREÇÃO: ignora parâmetros extras desconhecidos silenciosamente
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
          case 'anitube_search':
          case 'anitube_lista':
          default:                    metas = await scraper.getAnimeList(page);      break;
        }
      }
    } else if (id.startsWith('sf_')) {
      if (search) {
        const sfType = (id === 'sf_filmes') ? 'movie' : 'series';
        metas = await sf.searchContent(search, sfType);
      } else {
        switch (id) {
          case 'sf_filmes':      metas = await sf.getMovies(page);      break;
          case 'sf_series':      metas = await sf.getSeries(page);      break;
          case 'sf_animes':      metas = await sf.getAnimes(page);      break;
          case 'sf_lancamentos': metas = await sf.getRecentEpisodes();  break;
          default:               metas = [];                            break;
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
          id,
          type       : type === 'movie' ? 'movie' : 'series',
          name       : data.name,
          poster     : data.poster,
          background : data.background,
          description: data.description,
          genres     : data.genres,
          year       : data.year,
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

    // ── 1. AniTube Nativo ──────────────────────────────────────────────────────
    if (id.startsWith('anitube:')) {
      const epId = id.replace('anitube:', '');
      const sr   = await scraper.getEpisodeIframes(epId);
      if (sr?.sources?.length) {
        streams = await extractStreams(sr.sources, sr.episodeUrl);
      }
    }

    // ── 2. IDs IMDB — múltiplos provedores, stream direto no Stremio ───────────
    else if (id.startsWith('tt')) {
      const parts   = id.split(':');
      const imdbId  = parts[0];
      const season  = parts[1] !== undefined ? parseInt(parts[1], 10) : null;
      const episode = parts[2] !== undefined ? parseInt(parts[2], 10) : null;
      const isMovie = (type === 'movie');

      // CORREÇÃO PRINCIPAL: usa getAllStreams que extrai M3U8/MP4 reais
      // Não usa mais buildSFStreams (que retornava externalUrl e abria o browser)
      streams = await getAllStreams(imdbId, type, season, episode);

      // Fallback: AniTube para séries/animes quando provedores internacionais não têm
      if (!isMovie && streams.length < 2) {
        const atStreams = await tryAniTubeFallback(imdbId, type, season, episode);
        streams.push(...atStreams);
      }
    }

    // ── 3. IDs Kitsu (anime) ───────────────────────────────────────────────────
    else if (id.startsWith('kitsu:')) {
      const parts   = id.split(':');
      const episode = parts[2] ? parseInt(parts[2], 10) : 1;
      const atStreams = await tryAniTubeFallback(id, type, 1, episode);
      streams.push(...atStreams);
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
async function tryAniTubeFallback(stremioId, type, season, episode) {
  try {
    const fetch = require('node-fetch');
    let title   = null;
    let aliases = [];

    if (stremioId.startsWith('tt')) {
      const imdbId  = stremioId.split(':')[0];
      const cinType = type === 'movie' ? 'movie' : 'series';
      try {
        const r = await fetch(`https://v3-cinemeta.strem.io/meta/${cinType}/${imdbId}.json`, { timeout: 8000 });
        if (r.ok) { const j = await r.json(); title = j?.meta?.name || null; aliases = j?.meta?.aliases || []; }
      } catch (_) {}
    } else if (stremioId.startsWith('kitsu:')) {
      const kitsuId = stremioId.split(':').slice(0, 2).join(':');
      try {
        const r = await fetch(`https://anime-kitsu.strem.fun/meta/anime/${kitsuId}.json`, { timeout: 8000 });
        if (r.ok) { const j = await r.json(); title = j?.meta?.name || null; aliases = j?.meta?.aliases || []; }
      } catch (_) {}
    }

    if (!title) return [];

    // Tenta variações do título
    const queries = new Set();
    queries.add(title.replace(/\(Dub\)/i, '').split(':')[0].split('-')[0].trim());
    queries.add(title.replace(/\(Dub\)/i, '').trim());
    if (Array.isArray(aliases)) {
      aliases.forEach(a => { if (typeof a === 'string') queries.add(a.split(':')[0].split('-')[0].trim()); });
    }

    let results = [];
    for (const q of queries) {
      if (!q || q.length < 2) continue;
      results = await scraper.searchAnimes(q);
      if (results?.length) break;
    }

    if (!results?.length) return [];

    const animeId = results[0].id.replace('anitube:', '');
    let epId      = animeId;

    if (episode !== null && type !== 'movie') {
      const meta   = await scraper.getAnimeMeta(animeId);
      const videos = meta?.meta?.videos || [];
      const ep     = videos.find(v => v.episode === episode) || videos[(episode || 1) - 1] || videos[0];
      if (ep) epId = ep.id.replace('anitube:', '');
    }

    const sr = await scraper.getEpisodeIframes(epId);
    if (!sr?.sources?.length) return [];
    const st = await extractStreams(sr.sources, sr.episodeUrl);
    return st.map(s => ({ ...s, name: `🎌 AniTube | ${s.name || ''}`.trim() }));
  } catch (e) {
    console.warn('[AniTube Fallback] Erro:', e.message);
    return [];
  }
}

module.exports = builder.getInterface();
