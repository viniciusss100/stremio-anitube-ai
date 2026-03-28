'use strict';

/**
 * Scraper para RedeCanais — v1.0.0
 *
 * Estrutura de URLs do RedeCanais:
 *   Listagem filmes   : {BASE}/browse-filmes-videos-{page}-date.html
 *   Listagem séries   : {BASE}/browse-series-videos-{page}-date.html
 *   Listagem animes   : {BASE}/browse-animes-videos-{page}-date.html
 *   Listagem desenhos : {BASE}/browse-desenhos-videos-{page}-date.html
 *   Busca             : {BASE}/?s={query}  ou  {BASE}/busca.html?s={query}
 *   Página do título  : {BASE}/{slug}-lista-de-episodios_{id}.html  (séries)
 *                     : {BASE}/{slug}_{id}.html                     (filmes)
 *   Episódio/Video    : {BASE}/{slug}-episodio-{N}-..._{id}.html
 *
 * HTML relevante:
 *   Cards de catálogo : <ul id="pm-grid"> > <li> > <a class="ellipsis" title="..." href="...">
 *   Poster            : <li> > <img data-echo="...">  (lazy load)
 *   Player iframe     : <iframe name="Player" src="...">
 *   Lista de eps      : <ul class="episodios"> > <li> > <a href="...">
 *   Paginação         : <ul class="pagination"> > <li> > <a>
 *
 * DOMÍNIO INSTÁVEL — configurar RC_BASE_URL no .env
 * Padrão de fallback: redecanais.dev
 */

const fetch   = require('node-fetch');
const cheerio = require('cheerio');

// ── Domínio configurável via .env ──────────────────────────────────────────
const RC_BASE_URL = (process.env.RC_BASE_URL || 'https://redecanais.dev').replace(/\/$/, '');

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent'     : UA,
  'Accept'         : 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Referer'        : RC_BASE_URL + '/',
};

// ── HTTP com retry ──────────────────────────────────────────────────────────
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
      const wait = attempt * 1200;
      console.warn(`[RC fetchHTML] Tentativa ${attempt} falhou (${err.message}). Retry em ${wait}ms.`);
      await new Promise(r => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Utilitários ─────────────────────────────────────────────────────────────

/**
 * Extrai o "slug_id" do href do RedeCanais.
 * Ex: "/breaking-bad-5a-temporada_a1b2c3d.html" → "breaking-bad-5a-temporada_a1b2c3d"
 * Esse slug+id é o nosso identificador interno para o conteúdo.
 */
function extractRCId(href) {
  if (!href) return null;
  // Remove domínio se presente
  const path = href.replace(/^https?:\/\/[^/]+/, '');
  // Remove /browse-... (páginas de listagem — não são IDs de conteúdo)
  if (path.startsWith('/browse-')) return null;
  // Remove extensão .html e barra inicial
  const m = path.match(/\/([^/]+)\.html$/);
  return m ? m[1] : null;
}

function cleanTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/\s*[-–]\s*Lista de Epis[oó]dios?/gi, '')
    .replace(/\s*[-–]\s*Todos os Epis[oó]dios?/gi, '')
    .replace(/\s*\(Dublado\)/gi, ' (Dub)')
    .replace(/\s*\(Legendado\)/gi, ' (Leg)')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, '')
    .trim();
}

/**
 * Detecta o tipo de conteúdo pelo slug ou pelo texto da categoria.
 * Retorna 'movie' ou 'series'.
 */
function detectType(slugOrHref, categoryText) {
  const s = (slugOrHref + ' ' + (categoryText || '')).toLowerCase();
  if (s.includes('filmes') || s.includes('filme')) return 'movie';
  if (s.includes('episodio') || s.includes('temporada') ||
      s.includes('serie') || s.includes('series') ||
      s.includes('anime') || s.includes('desenho')) return 'series';
  return 'series'; // fallback conservador
}

function extractImgSrc($el) {
  return (
    $el.attr('data-echo') ||
    $el.attr('data-src')  ||
    $el.attr('data-lazy-src') ||
    $el.attr('src') ||
    ''
  );
}

/**
 * Reconstrói a URL do poster: o RedeCanais usa caminhos relativos em data-echo.
 * Ex: data-echo="/imgs-videos/..." → RC_BASE_URL + "/imgs-videos/..."
 *     data-echo="http://..." → usa direto
 */
function resolveImgUrl(src) {
  if (!src) return '';
  if (src.startsWith('http')) return src;
  if (src.startsWith('//')) return 'https:' + src;
  return RC_BASE_URL + (src.startsWith('/') ? '' : '/') + src;
}

function makeRCMeta(id, name, poster, type) {
  return {
    id         : `rc:${id}`,
    type       : type || 'series',
    name       : cleanTitle(name),
    poster     : resolveImgUrl(poster),
    posterShape: 'poster',
  };
}

// ── Parsers de grid ──────────────────────────────────────────────────────────

/**
 * Parseia <ul id="pm-grid"> do RedeCanais.
 * Cada <li> tem:
 *   <a class="ellipsis" title="Nome" href="/slug_id.html">
 *   <img data-echo="/imgs/...">
 */
function parseGrid($, typeHint) {
  const results = [];
  const seen    = new Set();

  $('#pm-grid li').each((_, el) => {
    const $a    = $(el).find('a.ellipsis').first();
    const href  = $a.attr('href') || '';
    const id    = extractRCId(href);
    if (!id || seen.has(id)) return;
    seen.add(id);

    const name   = $a.attr('title') || $a.text().trim();
    const $img   = $(el).find('img').first();
    const poster = extractImgSrc($img);
    if (!name) return;

    const type = typeHint || detectType(href, '');
    results.push(makeRCMeta(id, name, poster, type));
  });

  return results;
}

/**
 * Pega o número da última página da paginação.
 * <ul class="pagination"> > <li> > <a>N</a>
 * O penúltimo item (antes de "próximo") é geralmente o último número.
 */
function getLastPage($) {
  try {
    const links = $('ul.pagination li a').toArray();
    // Pega todos os que são números
    const nums = links
      .map(el => parseInt($(el).text().trim(), 10))
      .filter(n => !isNaN(n));
    return nums.length > 0 ? Math.max(...nums) : 1;
  } catch (_) {
    return 1;
  }
}

// ── Funções públicas ─────────────────────────────────────────────────────────

async function getLatestMovies(page = 1) {
  const url  = `${RC_BASE_URL}/browse-filmes-videos-${page}-date.html`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  return parseGrid($, 'movie');
}

async function getLatestSeries(page = 1) {
  const url  = `${RC_BASE_URL}/browse-series-videos-${page}-date.html`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  return parseGrid($, 'series');
}

async function getLatestAnimes(page = 1) {
  const url  = `${RC_BASE_URL}/browse-animes-videos-${page}-date.html`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  return parseGrid($, 'series');
}

async function getLatestDesenhos(page = 1) {
  const url  = `${RC_BASE_URL}/browse-desenhos-videos-${page}-date.html`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  return parseGrid($, 'series');
}

/**
 * Catálogo misto (todos os tipos), mais recentes.
 * Busca filmes e séries em paralelo e intercala os resultados.
 */
async function getLatestAll(page = 1) {
  const [movies, series, animes] = await Promise.allSettled([
    getLatestMovies(page),
    getLatestSeries(page),
    getLatestAnimes(page),
  ]);

  const m = movies.status  === 'fulfilled' ? movies.value  : [];
  const s = series.status  === 'fulfilled' ? series.value  : [];
  const a = animes.status  === 'fulfilled' ? animes.value  : [];

  // Intercala: 1 filme, 1 série, 1 anime...
  const result = [];
  const max = Math.max(m.length, s.length, a.length);
  for (let i = 0; i < max; i++) {
    if (m[i]) result.push(m[i]);
    if (s[i]) result.push(s[i]);
    if (a[i]) result.push(a[i]);
  }
  return result;
}

/**
 * Busca por query.
 * URL: {BASE}/?s={query}
 * O RedeCanais também aceita: {BASE}/search.html?q={query}
 */
async function searchContent(query) {
  if (!query || !query.trim()) return [];
  const q    = encodeURIComponent(query.trim());
  const url  = `${RC_BASE_URL}/?s=${q}`;

  let html;
  try {
    html = await fetchHTML(url);
  } catch (_) {
    // fallback com endpoint alternativo
    html = await fetchHTML(`${RC_BASE_URL}/busca.html?s=${q}`);
  }

  const $ = cheerio.load(html);

  // Tenta grid principal primeiro
  const grid = parseGrid($);
  if (grid.length > 0) return grid;

  // Fallback: resultado de busca textual (alguns domínios retornam lista diferente)
  const results = [];
  const seen    = new Set();
  $('a[href$=".html"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const id   = extractRCId(href);
    if (!id || seen.has(id) || href.includes('browse-')) return;
    seen.add(id);
    const name = $(el).attr('title') || $(el).text().trim();
    if (!name || name.length < 2) return;
    const type = detectType(href, '');
    results.push(makeRCMeta(id, name, '', type));
  });

  return results;
}

/**
 * Meta completa de um título.
 * Para séries: scrapa a lista de episódios.
 * Para filmes: retorna meta sem episodes.
 */
async function getContentMeta(rcId) {
  // rcId pode ser:
  //   "breaking-bad-5a-temporada_a1b2c3d"  (série — lista de eps)
  //   "homem-aranha_xyz123"                (filme)
  //   "naruto-episodio-01_abc"             (episódio individual)

  const url  = `${RC_BASE_URL}/${rcId}.html`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);

  // Título
  const rawTitle =
    $('h1.pm-video-title').first().text().trim() ||
    $('h1').first().text().trim() ||
    $('title').first().text().split('–')[0].trim() ||
    $('title').first().text().split('|')[0].trim();

  const title = cleanTitle(rawTitle);

  // Poster / Background
  const ogImage  = $('meta[property="og:image"]').attr('content') || '';
  const poster   =
    resolveImgUrl(extractImgSrc($('.pm-video-thumb img, .thumb img, #capa img').first())) ||
    ogImage;

  // Descrição
  const description =
    $('.pm-video-description, #sinopse, .sinopse').first().text().trim() ||
    $('meta[name="description"]').attr('content') ||
    '';

  // Tipo
  const isMovie = rcId.toLowerCase().includes('filme') ||
                  !rcId.toLowerCase().includes('episodio') &&
                  !rcId.toLowerCase().includes('temporada') &&
                  $('ul.episodios').length === 0 &&
                  $('.pagEpiLista, .episodio-lista').length === 0;

  const type = isMovie ? 'movie' : 'series';

  // ── Episódios (séries/animes) ──
  const videos    = [];
  const seenEpIds = new Set();

  // Seletor principal: <ul class="episodios"> ou <div class="pm-playlist">
  const $epLinks = $('ul.episodios a, .pm-playlist a, ul.PM_List_Episodes a, ' +
                     '.pagAniListaContainer a, ul#pm-list-episodios a');

  $epLinks.each((i, el) => {
    const epHref  = $(el).attr('href') || '';
    const epId    = extractRCId(epHref);
    if (!epId || seenEpIds.has(epId)) return;
    seenEpIds.add(epId);

    const epTitle = $(el).attr('title') || $(el).text().trim() || `Episódio ${i + 1}`;
    const epNum   = extractEpisodeNumber(epTitle) || (i + 1);
    const season  = extractSeasonNumber(epId) || 1;

    videos.push({
      id      : `rc:${epId}`,
      title   : epTitle.trim() || `Episódio ${epNum}`,
      season,
      episode : epNum,
      released: new Date(0).toISOString(),
    });
  });

  // Se não achou lista, tenta <a href="...episodio...">
  if (videos.length === 0) {
    $('a[href*="episodio"]').each((i, el) => {
      const epHref = $(el).attr('href') || '';
      const epId   = extractRCId(epHref);
      if (!epId || seenEpIds.has(epId)) return;
      seenEpIds.add(epId);
      const epTitle = $(el).text().trim() || `Episódio ${i + 1}`;
      const epNum   = extractEpisodeNumber(epTitle) || (i + 1);
      videos.push({
        id      : `rc:${epId}`,
        title   : epTitle,
        season  : 1,
        episode : epNum,
        released: new Date(0).toISOString(),
      });
    });
  }

  // Fallback: o próprio ID é um episódio
  if (videos.length === 0 && type === 'series') {
    const epNum = extractEpisodeNumber(rawTitle) || 1;
    videos.push({
      id      : `rc:${rcId}`,
      title   : `Episódio ${epNum}`,
      season  : 1,
      episode : epNum,
      released: new Date(0).toISOString(),
    });
  }

  videos.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));

  const meta = {
    id         : `rc:${rcId}`,
    type,
    name       : title,
    poster,
    posterShape: 'poster',
    background : ogImage || poster,
    description,
    website    : url,
  };

  if (type === 'series') meta.videos = videos;

  return { meta };
}

/**
 * Retorna o iframe/src do player para um ID (episódio ou filme).
 */
async function getVideoSources(rcId) {
  const url  = `${RC_BASE_URL}/${rcId}.html`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  const sources = [];

  // Player principal: <iframe name="Player" src="...">
  const playerSrc = $('iframe[name="Player"]').first().attr('src') ||
                    $('iframe.pm-video-embed').first().attr('src')  ||
                    $('iframe[src*="embed"]').first().attr('src')   ||
                    $('iframe[src]').first().attr('src');

  if (playerSrc) {
    const fullSrc = playerSrc.startsWith('//') ? 'https:' + playerSrc : playerSrc;
    sources.push({ name: 'Player RC', iframeSrc: fullSrc });
  }

  // Fontes alternativas: abas de players (#player1, #player2...)
  $('[id^="player"], [id^="tab"], [data-tab]').each((_, el) => {
    const iframeSrc =
      $(el).find('iframe[src]').first().attr('src') ||
      $(el).attr('data-src');
    if (!iframeSrc) return;
    const fullSrc = iframeSrc.startsWith('//') ? 'https:' + iframeSrc : iframeSrc;
    if (!sources.some(s => s.iframeSrc === fullSrc)) {
      const tabName = $(el).attr('id') || 'Alternativo';
      sources.push({ name: `RC ${tabName}`, iframeSrc: fullSrc });
    }
  });

  return { sources, episodeUrl: url };
}

// ── Helpers de número ────────────────────────────────────────────────────────

function extractEpisodeNumber(text) {
  if (!text) return null;
  const patterns = [
    /epis[oó]dio[:\s]*(\d+)/i,
    /\bep\.?\s*(\d+)/i,
    /\bE(\d{2,})\b/i,
    /[-_\s](\d{2,})[-_\s]/,
    /\b(\d{1,3})\b/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function extractSeasonNumber(slugOrText) {
  if (!slugOrText) return 1;
  const m = slugOrText.match(/(\d+)[a\-]?[-_]?temporada/i) ||
            slugOrText.match(/season[-_\s]?(\d+)/i) ||
            slugOrText.match(/s(\d{2})/i);
  return m ? parseInt(m[1], 10) : 1;
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  RC_BASE_URL: () => RC_BASE_URL,
  getLatestMovies,
  getLatestSeries,
  getLatestAnimes,
  getLatestDesenhos,
  getLatestAll,
  searchContent,
  getContentMeta,
  getVideoSources,
  extractRCId,
  cleanTitle,
};
