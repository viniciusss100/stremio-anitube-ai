'use strict';

/**
 * SuperFlixAPI — Integração v1.0.0
 *
 * A SuperFlixAPI é uma API brasileira pública que fornece players embed
 * para filmes, séries, animes e doramas via ID IMDB ou TMDB.
 *
 * Endpoints documentados (superflixapi.run):
 *   Player filme  : /filme/{imdb_ou_tmdb}
 *   Player série  : /serie/{imdb_ou_tmdb}/{temporada}/{episodio}
 *   Lista IDs     : /lista?category=movie|serie|anime&type=imdb|tmdb&format=json
 *   Calendário    : /calendario.php  (episódios recentes/futuros)
 *
 * Vantagens sobre scraping:
 *   ✅ Sem Cloudflare / sem 403
 *   ✅ Aceita IDs IMDB nativamente (compatível com Cinemeta)
 *   ✅ Catálogo com lista de IDs disponíveis
 *   ✅ Domínio estável
 *   ✅ Sem necessidade de proxy (streams são diretos)
 */

const fetch = require('node-fetch');

// ── Configuração ──────────────────────────────────────────────────────────────
// superflixapi.rest e superflixapi.run são espelhos — .run tem melhor uptime
const SF_BASE    = (process.env.SF_BASE_URL || 'https://superflixapi.run').replace(/\/$/, '');
const TMDB_KEY   = process.env.TMDB_API_KEY || ''; // Opcional — melhora metadados

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PORT       = parseInt(process.env.PORT || '7000', 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

// ── Cache de lista de IDs (pesada, renovada a cada 2h) ───────────────────────
let _listCache   = {};
let _listCacheTs = {};
const LIST_TTL   = 2 * 60 * 60 * 1000; // 2 horas

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function safeFetch(url, opts = {}, timeout = 12000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, {
      ...opts,
      headers: { 'User-Agent': UA, Accept: 'application/json,text/html,*/*', ...(opts.headers || {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Lista de IDs disponíveis na SuperFlixAPI ─────────────────────────────────

/**
 * Busca a lista de IDs de uma categoria no SuperFlixAPI.
 * Retorna array de strings de IDs (IMDB format: "tt0000000").
 * @param {'movie'|'serie'|'anime'} category
 */
async function fetchIdList(category) {
  const now = Date.now();
  if (_listCache[category] && now - _listCacheTs[category] < LIST_TTL) {
    return _listCache[category];
  }

  try {
    const url = `${SF_BASE}/lista?category=${category}&type=imdb&format=json&order=desc`;
    const res = await safeFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    let ids = [];

    // A resposta pode ser um array JSON ou texto com IDs separados por linha/vírgula
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        ids = json.map(item => {
          if (typeof item === 'string') return item.trim();
          return item.imdb || item.id || item.imdb_id || '';
        }).filter(Boolean);
      } else if (json.data) {
        ids = Array.isArray(json.data) ? json.data : [];
      }
    } catch (_) {
      // Fallback: texto com IDs
      ids = text.split(/[\n,\s]+/).map(s => s.trim()).filter(s => s.startsWith('tt'));
    }

    console.log(`[SF] Lista "${category}": ${ids.length} IDs carregados`);
    _listCache[category]   = ids;
    _listCacheTs[category] = now;
    return ids;
  } catch (e) {
    console.warn(`[SF] Falha ao buscar lista "${category}":`, e.message);
    return _listCache[category] || [];
  }
}

// ── Calendário (episódios recentes) ──────────────────────────────────────────

let _calCache   = null;
let _calCacheTs = 0;
const CAL_TTL   = 30 * 60 * 1000; // 30 min

async function fetchCalendar() {
  const now = Date.now();
  if (_calCache && now - _calCacheTs < CAL_TTL) return _calCache;

  try {
    const res = await safeFetch(`${SF_BASE}/calendario.php`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    _calCache   = Array.isArray(json) ? json : (json.data || json.episodes || []);
    _calCacheTs = now;
    return _calCache;
  } catch (e) {
    console.warn('[SF] Falha ao buscar calendário:', e.message);
    return _calCache || [];
  }
}

// ── Metadados via TMDB (enriquece catálogos com poster/nome) ─────────────────

const _tmdbCache = new Map();
const TMDB_TTL   = 24 * 60 * 60 * 1000; // 24h

/**
 * Busca metadados de um título pelo ID IMDB.
 * Usa TMDB se a chave estiver configurada, senão usa Cinemeta (gratuito).
 */
async function fetchMeta(imdbId, type) {
  const key    = `${imdbId}:${type}`;
  const cached = _tmdbCache.get(key);
  if (cached && Date.now() - cached.ts < TMDB_TTL) return cached.value;

  try {
    let meta = null;

    if (TMDB_KEY) {
      // Via TMDB API
      const endpoint = type === 'movie'
        ? `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&language=pt-BR`
        : `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&language=pt-BR`;

      const res = await safeFetch(
        endpoint,
        { headers: { Authorization: `Bearer ${TMDB_KEY}` } }
      );
      if (res.ok) {
        const j    = await res.json();
        const item = (j.movie_results?.[0]) || (j.tv_results?.[0]);
        if (item) {
          meta = {
            name       : item.title || item.name || '',
            poster     : item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
            background : item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : '',
            description: item.overview || '',
            year       : (item.release_date || item.first_air_date || '').split('-')[0],
          };
        }
      }
    }

    if (!meta) {
      // Fallback: Cinemeta (não precisa de chave)
      const cinType = type === 'movie' ? 'movie' : 'series';
      const res     = await safeFetch(`https://v3-cinemeta.strem.io/meta/${cinType}/${imdbId}.json`);
      if (res.ok) {
        const j = await res.json();
        const m = j?.meta;
        if (m) {
          meta = {
            name       : m.name || m.title || '',
            poster     : m.poster || '',
            background : m.background || m.poster || '',
            description: m.description || '',
            year       : m.year || '',
            genres     : m.genres || [],
          };
        }
      }
    }

    if (meta) {
      _tmdbCache.set(key, { value: meta, ts: Date.now() });
    }
    return meta;

  } catch (e) {
    console.warn(`[SF] Falha ao buscar meta para ${imdbId}:`, e.message);
    return null;
  }
}

// ── Construir metas para catálogo Stremio ────────────────────────────────────

/**
 * Dado um array de IDs IMDB, retorna metas enriquecidas com poster/nome.
 * Busca em lotes paralelos de 10 para não sobrecarregar.
 */
async function buildMetas(imdbIds, type, page = 1, pageSize = 20) {
  const start   = (page - 1) * pageSize;
  const pageIds = imdbIds.slice(start, start + pageSize);

  const stremioType = type === 'movie' ? 'movie' : 'series';

  const results = await Promise.allSettled(
    pageIds.map(async imdbId => {
      const meta = await fetchMeta(imdbId, type);
      if (!meta || !meta.name) {
        // Sem metadados: retorna meta mínima com o ID
        return {
          id        : imdbId,
          type      : stremioType,
          name      : imdbId,
          poster    : '',
          posterShape: 'poster',
        };
      }
      return {
        id         : imdbId,
        type       : stremioType,
        name       : meta.name,
        poster     : meta.poster || '',
        posterShape: 'poster',
        year       : meta.year,
      };
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(m => m.name && m.name !== m.id); // descarta sem nome
}

// ── Funções de catálogo ───────────────────────────────────────────────────────

async function getMovies(page = 1) {
  const ids = await fetchIdList('movie');
  return buildMetas(ids, 'movie', page);
}

async function getSeries(page = 1) {
  const ids = await fetchIdList('serie');
  return buildMetas(ids, 'series', page);
}

async function getAnimes(page = 1) {
  const ids = await fetchIdList('anime');
  return buildMetas(ids, 'series', page);
}

/**
 * Episódios recentes (calendário) — ótimo para catálogo "Lançamentos".
 * Cada entrada tem: title, imdb_id, season, episode, date
 */
async function getRecentEpisodes() {
  const calendar = await fetchCalendar();

  const seen    = new Set();
  const results = [];

  for (const ep of calendar) {
    const imdbId = ep.imdb_id || ep.imdb || ep.id;
    if (!imdbId || seen.has(imdbId)) continue;
    seen.add(imdbId);

    results.push({
      id         : imdbId,
      type       : 'series',
      name       : ep.title || ep.name || imdbId,
      poster     : ep.poster || ep.image || '',
      posterShape: 'poster',
      description: ep.overview || '',
    });

    if (results.length >= 20) break;
  }

  return results;
}

/**
 * Busca por título — usa TMDB search + filtra pelos IDs disponíveis na SF.
 * Se TMDB não estiver disponível, busca via Cinemeta.
 */
async function searchContent(query, type) {
  if (!query?.trim()) return [];

  try {
    const q = encodeURIComponent(query.trim());
    let results = [];

    if (TMDB_KEY) {
      const endpoint = type === 'movie'
        ? `https://api.themoviedb.org/3/search/movie?query=${q}&language=pt-BR`
        : `https://api.themoviedb.org/3/search/tv?query=${q}&language=pt-BR`;

      const res = await safeFetch(endpoint, { headers: { Authorization: `Bearer ${TMDB_KEY}` } });
      if (res.ok) {
        const j     = await res.json();
        const items = j.results || [];
        results = items.slice(0, 10).map(item => ({
          tmdbId : item.id?.toString(),
          name   : item.title || item.name || '',
          poster : item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
          year   : (item.release_date || item.first_air_date || '').split('-')[0],
        }));
      }
    }

    // Sem TMDB: usa Cinemeta search
    if (!results.length) {
      const cinType = type === 'movie' ? 'movie' : 'series';
      const res     = await safeFetch(
        `https://v3-cinemeta.strem.io/catalog/${cinType}/top/search=${q}.json`
      );
      if (res.ok) {
        const j = await res.json();
        results = (j.metas || []).slice(0, 10).map(m => ({
          imdbId : m.id,
          name   : m.name || m.title || '',
          poster : m.poster || '',
          year   : m.year || '',
        }));
      }
    }

    const stremioType = type === 'movie' ? 'movie' : 'series';
    return results.map(r => ({
      id         : r.imdbId || r.tmdbId || '',
      type       : stremioType,
      name       : r.name,
      poster     : r.poster,
      posterShape: 'poster',
      year       : r.year,
    })).filter(m => m.id && m.name);

  } catch (e) {
    console.warn('[SF] Erro na busca:', e.message);
    return [];
  }
}

// ── Geração de streams ────────────────────────────────────────────────────────

/**
 * Gera as streams SuperFlixAPI para um conteúdo.
 * O player embed da SF já cuida de resolver o stream internamente.
 *
 * Para o Stremio, retornamos a URL do player como stream.
 * O Stremio consegue reproduzir iframes embed via behaviorHints.
 *
 * Retornamos múltiplos players (SF tem mirrors):
 *   - superflixapi.run (principal)
 *   - superflixapi.rest (espelho)
 */
function buildSFStreams(imdbId, type, season, episode) {
  const streams = [];
  const isMovie = type === 'movie';

  const endpoints = [
    { label: 'SuperFlixAPI',        base: 'https://superflixapi.run'  },
    { label: 'SuperFlixAPI Mirror', base: 'https://superflixapi.rest' },
  ];

  for (const { label, base } of endpoints) {
    let url;
    if (isMovie) {
      url = `${base}/filme/${imdbId}`;
    } else {
      const s = season  || 1;
      const e = episode || 1;
      url = `${base}/serie/${imdbId}/${s}/${e}`;
    }

    streams.push({
      // externalUrl abre o player no browser — funciona no Stremio Desktop e Web
      externalUrl: url,
      name       : `📺 ${label}`,
      description: isMovie
        ? '🇧🇷 Dublado/Legendado • SuperFlixAPI'
        : `🇧🇷 S${season || 1}E${episode || 1} • SuperFlixAPI`,
      behaviorHints: {
        notWebReady: false,
      },
    });
  }

  return streams;
}

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = {
  getMovies,
  getSeries,
  getAnimes,
  getRecentEpisodes,
  searchContent,
  buildSFStreams,
  fetchMeta,
  SF_BASE: () => SF_BASE,
};
