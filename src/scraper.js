'use strict';

/**
 * Scraper para AniTube.news — v3.2.7
 */

const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.anitube.news';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent'      : UA,
  'Accept'          : 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language' : 'pt-BR,pt;q=0.9',
  'Referer'         : BASE_URL + '/',
};

// ───────────────────────────────────────────────────────────────────────────
// HTTP
// ───────────────────────────────────────────────────────────────────────────

/**
 * Busca HTML com retry automático (3 tentativas, backoff de 1 s).
 * @param {string} url
 * @param {number} [timeout=15000]
 * @param {number} [retries=3]
 */
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
      console.warn(`[fetchHTML] Tentativa ${attempt} falhou para ${url}. Retry em ${wait}ms. Erro: ${err.message}`);
      await new Promise(r => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ───────────────────────────────────────────────────────────────────────────

/** Extrai o ID numérico de uma URL do AniTube. */
function extractId(url) {
  if (!url || typeof url !== 'string') return null;
  let m = url.match(/\/video\/(\d+)\/?/);
  if (m) return m[1];
  m = url.match(/\/(\d{4,})b/);
  if (m) return m[1];
  return null;
}

/** Limpa o título removendo sufixos de episódio e entidades HTML. */
function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/\s*[–\-]\s*Todos os Epis.+$/i, '')
    .replace(/\s*[–\-]\s*Epis[oó]dio\s*\d+.*$/i, '')
    .replace(/\s*[–\-]\s*Epis[oó]dios.*$/i, '')
    .replace(/&#8211;/g, '–')
    .replace(/&amp;/g, '&')
    .trim();
}

/** Tenta extrair o número do episódio a partir do título. */
function extractEpisodeNumber(title) {
  if (!title) return null;
  const patterns = [
    /Epis[oó]dio\s*(\d+)/i,
    /Ep\.?\s*(\d+)/i,
    /\bE(\d+)\b/i,
    /\b(\d{3,})\b/,
    /\b(\d{1,2})\b/,
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Constrói um objeto meta mínimo (preview de catálogo).
 * Garante `poster` como string válida (nunca undefined).
 */
function makeMetaPreview(id, name, poster) {
  return {
    id          : `anitube:${id}`,
    type        : 'series',
    name        : cleanTitle(name),
    poster      : poster || '',
    posterShape : 'poster',
  };
}

/**
 * Extrai a imagem preferindo `src` mas fazendo fallback para
 * `data-src` (lazy-load) e depois `data-lazy-src`.
 */
function extractImgSrc($el) {
  return (
    $el.attr('src') ||
    $el.attr('data-src') ||
    $el.attr('data-lazy-src') ||
    ''
  );
}

// ───────────────────────────────────────────────────────────────────────────
// PARSERS
// ───────────────────────────────────────────────────────────────────────────

function parseAniItems($, $elements) {
  const results = [];
  const seen    = new Set();
  $elements.each((_, el) => {
    const $a   = $(el).find('a').first();
    const href = $a.attr('href') || '';
    const id   = extractId(href);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name   = $a.attr('title') || $(el).find('.aniItemNome').first().text().trim();
    const poster = extractImgSrc($(el).find('img').first());
    if (!name) return;
    results.push(makeMetaPreview(id, name, poster));
  });
  return results;
}

function parseEpiItems($) {
  const results = [];
  const seen    = new Set();
  $('div.epiItem').each((_, el) => {
    const $a   = $(el).find('a').first();
    const href = $a.attr('href') || '';
    const id   = extractId(href);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const rawName = ($a.attr('title') || $(el).find('.epiItemNome').first().text()).trim();
    const poster  = extractImgSrc($(el).find('img').first());
    if (!rawName) return;
    results.push({
      id          : `anitube:${id}`,
      type        : 'series',
      name        : rawName,
      poster,
      posterShape : 'poster',
    });
  });
  return results;
}

/**
 * Percorre os `.aniContainer` e retorna o que contém algum dos `keywords`
 * no título, ou `null` se nenhum for encontrado.
 * @param {CheerioStatic} $
 * @param {string[]} keywords
 */
function findContainerByKeywords($, keywords) {
  let found = null;
  $('.aniContainer').each((_, container) => {
    if (found) return false; // break
    const title = $(container).find('.aniContainerTitulo').first().text().toLowerCase();
    if (keywords.some(k => title.includes(k.toLowerCase()))) {
      found = container;
    }
  });
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
// SCRAPING – HOME (compartilhado entre getLatest / getMostWatched / getRecent)
// ───────────────────────────────────────────────────────────────────────────

/** Cache interno da home para evitar 3 GETs na mesma renderização. */
let _homeCache    = null;
let _homeCacheTs  = 0;
const HOME_TTL_MS = 60 * 1000; // 1 min

async function getHomePage() {
  if (_homeCache && Date.now() - _homeCacheTs < HOME_TTL_MS) return _homeCache;
  _homeCache   = cheerio.load(await fetchHTML(BASE_URL + '/'));
  _homeCacheTs = Date.now();
  return _homeCache;
}

// ───────────────────────────────────────────────────────────────────────────
// FUNÇÕES PÚBLICAS
// ───────────────────────────────────────────────────────────────────────────

/** @param {number} [_page] reservado para compatibilidade futura */
async function getLatestEpisodes(_page) {
  const $ = await getHomePage();
  return parseEpiItems($);
}

/** @param {number} [_page] reservado para compatibilidade futura */
async function getMostWatched(_page) {
  const $ = await getHomePage();
  const container = findContainerByKeywords($, ['mais vistos', 'ほとんど見た']);
  if (container) {
    const items = parseAniItems($, $(container).find('.aniItem'));
    if (items.length > 0) return items;
  }
  return parseAniItems($, $('.aniContainer').first().find('.aniItem'));
}

/** @param {number} [_page] reservado para compatibilidade futura */
async function getRecentAnimes(_page) {
  const $ = await getHomePage();
  const container = findContainerByKeywords($, ['recentes', '最近']);
  if (container) {
    const items = parseAniItems($, $(container).find('.aniItem'));
    if (items.length > 0) return items;
  }
  const containers = $('.aniContainer').toArray();
  if (containers.length >= 2) return parseAniItems($, $(containers[1]).find('.aniItem'));
  return [];
}

async function getAnimeList(page = 1) {
  const url  = page === 1
    ? `${BASE_URL}/lista-de-animes-online/`
    : `${BASE_URL}/lista-de-animes-online/page/${page}/`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  return parseAniItems($, $('div.aniItem'));
}

async function searchAnimes(query) {
  if (!query || !query.trim()) return [];
  const url  = `${BASE_URL}/?s=${encodeURIComponent(query.trim())}`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  const aniResults = parseAniItems($, $('div.aniItem'));
  if (aniResults.length > 0) return aniResults;
  return parseEpiItems($);
}

async function getAnimeMeta(animeId) {
  const url  = `${BASE_URL}/video/${animeId}/`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);

  const rawTitle = $('h1').first().text().trim() ||
                   $('title').first().text().split('–')[0].trim();
  const title      = cleanTitle(rawTitle);
  const ogImage    = $('meta[property="og:image"]').attr('content') || '';
  const poster     = extractImgSrc($('#capaAnime img').first())
