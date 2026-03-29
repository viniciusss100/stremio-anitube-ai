'use strict';

/**
 * Provider animesdigital.org – v1.0.0
 * Catálogo e meta de animesdigitais para o Stremio via AniTube addon.
 * IMPORTANTE: adapte os seletores CSS conforme o HTML do site.
 */

const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const BASE_URL = 'https://animesdigital.org';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent'      : UA,
  'Accept'          : 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language' : 'pt-BR,pt;q=0.9',
  'Referer'         : BASE_URL + '/',
};

// ───────────────────────────────────────────────────────────────────────────
// HTTP com retry
// ───────────────────────────────────────────────────────────────────────────

async function fetchHTML(url, timeout = 15000, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = attempt * 1000;
      console.warn(`[animesdigital] Tentativa ${attempt} falhou para ${url}. Retry em ${wait}ms. Erro: ${err.message}`);
      await new Promise(r => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ───────────────────────────────────────────────────────────────────────────

function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/\s*[-–]\s*Todos os Epis.+\s*$/i, '')
    .replace(/\s*[-–]\s*Epis[óo]dio\s*\d+.*/i, '')
    .replace(/\s*[-–]\s*Epis[óo]dios.*/i, '')
    .replace(/&#8211;/g, '–')
    .replace(/&amp;/g, '&')
    .trim();
}

function extractImgSrc($el) {
  return (
    $el.attr('src') ||
    $el.attr('data-src') ||
    $el.attr('data-lazy-src') ||
    ''
  );
}

function makeMetaPreview(id, name, poster, type = 'series') {
  return {
    id   : `anitube:${id}`,
    type,
    name : cleanTitle(name),
    poster      : poster || '',
    posterShape : 'poster',
  };
}

// ───────────────────────────────────────────────────────────────────────────
// PARSERS GERAIS
// ───────────────────────────────────────────────────────────────────────────

function parseAnimesList($, $elements) {
  const results = [];
  const seen    = new Set();
  $elements.each((_, el) => {
    const $a   = $(el).find('a').first();
    const href = $a.attr('href') || '';
    const id   = extractAnimeIdFromHref(href);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name = $a.attr('title') ||
      $a.find('img').attr('alt') ||
      $a.text().trim();
    const poster = extractImgSrc($(el).find('img').first());
    if (!name) return;
    results.push(makeMetaPreview(id, name, poster));
  });
  return results;
}

function parseEpisodesList($, $episodes) {
  const results = [];
  const seen = new Set();
  $episodes.each((_, el) => {
    const $a   = $(el).find('a').first();
    const href = $a.attr('href') || '';
    const id   = extractEpisodeIdFromHref(href);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const rawTitle = $a.attr('title') ||
      $a.find('.epiTitle').text().trim() ||
      $a.text().trim();
    const poster = extractImgSrc($(el).find('img').first());
    if (!rawTitle) return;
    results.push({
      id          : `anitube:${id}`,
      type        : 'series',
      name        : rawTitle,
      poster,
      posterShape : 'poster',
    });
  });
  return results;
}

// ───────────────────────────────────────────────────────────────────────────
// EXTRATORES DE ID (AJUSTE ESTES SEGUNS A URL REAL NAS PÁGINAS)
// ───────────────────────────────────────────────────────────────────────────

// Exemplo: /anime/one-piece-legendado/
function extractAnimeIdFromHref(href) {
  if (!href) return null;
  const m = href.match(/\/anime\/([^\/]+)\/?$/i);
  const slug = m ? m[1] : null;
  return slug
    ? slug.replace(/-legendado|-dublado$/i, '').replace(/-/g, '_')
    : null;
}

// Exemplo: /episodio/one-piece-leg-1-899/
function extractEpisodeIdFromHref(href) {
  if (!href) return null;
  const m = href.match(/\/episodio\/([^\/]+)\/?$/i);
  const slug = m ? m[1] : null;
  return slug
    ? slug.replace(/-leg|-dub/i, '').replace(/-/g, '_')
    : null;
}

// ───────────────────────────────────────────────────────────────────────────
// FUNÇÕES PÚBLICAS
// ───────────────────────────────────────────────────────────────────────────

async function getLatestEpisodes() {
  const html = await fetchHTML(BASE_URL);
  const $    = cheerio.load(html);
  return parseEpisodesList($, $('.recent-episodes .episode')); // 🔧 ajustar conforme HTML real
}

async function getRecentAnimes() {
  const html = await fetchHTML(BASE_URL);
  const $    = cheerio.load(html);
  return parseAnimesList($, $('.recent-animes .anime-item')); // 🔧 ajustar
}

async function getAnimeList(page = 1) {
  const url = page === 1
    ? `${BASE_URL}/animes/`
    : `${BASE_URL}/animes/page/${page}/`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  return parseAnimesList($, $('.anime-list .anime-item')); // 🔧 ajustar
}

async function searchAnimes(query) {
  if (!query || !query.trim()) return [];
  const url = `${BASE_URL}?s=${encodeURIComponent(query.trim())}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const animeResults = parseAnimesList($, $('.search-animes .anime-item'));
  if (animeResults.length > 0) return animeResults;

  const episodeResults = parseEpisodesList($, $('.search-episodes .episode'));
  if (episodeResults.length > 0) return episodeResults;

  return [];
}

async function getAnimeMeta(animeId) {
  const url = `${BASE_URL}/anime/${animeId}/`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const rawTitle = $('h1.anime-title').text().trim() ||
                   $('title').text().split('|')[0].trim();
  const title = cleanTitle(rawTitle);
  const ogImage = $('meta[property="og:image"]').attr('content') || '';
  const poster = extractImgSrc($('.anime-poster img').first()) || ogImage;
  const description =
    $('.anime-synopsis').text().trim() ||
    $('meta[name="description"]').attr('content') || '';

  const genres = [];
  const stats = $('.anime-stats .stat');
  stats.each((_, el) => {
    const text = $(el).text().trim();
    if (text.includes('Gênero:') || text.includes('Genero:')) {
      const g = text
        .split(':')
        .slice(1)
        .join('')
        .split(',')
        .map(s => s.trim());
      genres.push(...g.filter(Boolean));
    }
  });

  const videos = [];
  const seenEpIds = new Set();
  $('.episodes-list a.episode-link').each((i, el) => {
    const href = $(el).attr('href') || '';
    const epId = extractEpisodeIdFromHref(href);
    if (!epId || seenEpIds.has(epId)) return;
    seenEpIds.add(epId);

    const epTitle = $(el).attr('title') || $(el).text().trim() || `Episódio ${i + 1}`;
    const epNum = extractEpisodeNumber(epTitle) || (i + 1);

    videos.push({
      id       : `anitube:${epId}`,
      title    : `Episódio ${epNum}`,
      season   : 1,
      episode  : epNum,
      released : new Date(0).toISOString(), // idealmente, use data real do site se houver
    });
  });

  if (videos.length === 0) {
    const epNum = extractEpisodeNumber(rawTitle) || 1;
    videos.push({
      id       : `anitube:${animeId}`,
      title    : `Episódio ${epNum}`,
      season   : 1,
      episode  : epNum,
      released : new Date(0).toISOString(),
    });
  }

  videos.sort((a, b) => a.episode - b.episode);

  return {
    meta: {
      id          : `anitube:${animeId}`,
      type        : 'series',
      name        : title,
      poster,
      posterShape : 'poster',
      background  : ogImage || poster,
      description,
      genres,
      website     : url,
      videos,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// UTILITÁRIO: extrai número de episódio do título
// ───────────────────────────────────────────────────────────────────────────

function extractEpisodeNumber(title) {
  if (!title) return null;
  const patterns = [
    /Epis[oó]dio\s*(\d+)/i,
    /Ep\.?\s*(\d+)/i,
    /E(\d+)/i,
    /(\d{3,})/,   // por exemplo: 012, 899 etc.
    /(\d{1,2})/,  // 1..99
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// EXPORTS
// ───────────────────────────────────────────────────────────────────────────

module.exports = {
  getLatestEpisodes,
  getRecentAnimes,
  getAnimeList,
  searchAnimes,
  getAnimeMeta,
  // para testes e reuso interno
  extractAnimeIdFromHref,
  extractEpisodeIdFromHref,
  fetchHTML,
  BASE_URL,
};
