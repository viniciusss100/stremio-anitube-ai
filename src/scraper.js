'use strict';

/**
 * Scraper para AniTube.news - Versão v3.2.1 (Restaurada v2.1.1)
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.anitube.news';

const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Referer: BASE_URL + '/',
};

async function fetchHTML(url, timeout = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractId(url) {
  if (!url) return null;
  let m = url.match(/\/video\/(\d+)\/?/);
  if (m) return m[1];
  m = url.match(/\/(\d{4,})b/);
  if (m) return m[1];
  return null;
}

function cleanTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/\s*[–\-]\s*Todos os Epis.+$/i, '')
    .replace(/\s*[–\-]\s*Epis[oó]dio\s*\d+.*$/i, '')
    .replace(/\s*[–\-]\s*Epis[oó]dios.*$/i, '')
    .replace(/&#8211;/g, '–')
    .replace(/&amp;/g, '&')
    .trim();
}

function extractEpisodeNumber(title) {
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

function makeMetaPreview(id, name, poster) {
  return {
    id: `anitube:${id}`,
    type: 'series',
    name: cleanTitle(name),
    poster: poster || '',
    posterShape: 'poster',
  };
}

function parseAniItems($, selector) {
  const results = [];
  const seen = new Set();
  $(selector).each((_, el) => {
    const $a = $(el).find('a').first();
    const href = $a.attr('href') || '';
    const id = extractId(href);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name = $a.attr('title') || $(el).find('.aniItemNome').first().text().trim() || '';
    const poster = $(el).find('img').first().attr('src') || $(el).find('img').first().attr('data-src') || '';
    if (!name) return;
    results.push(makeMetaPreview(id, name, poster));
  });
  return results;
}

function parseEpiItems($) {
  const results = [];
  const seen = new Set();
  $('div.epiItem').each((_, el) => {
    const $a = $(el).find('a').first();
    const href = $a.attr('href') || '';
    const id = extractId(href);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const rawName = $a.attr('title') || $(el).find('.epiItemNome').first().text().trim() || '';
    const poster = $(el).find('img').first().attr('src') || $(el).find('img').first().attr('data-src') || '';
    if (!rawName) return;
    results.push({
      id: `anitube:${id}`,
      type: 'series',
      name: rawName.trim(),
      poster,
      posterShape: 'poster',
    });
  });
  return results;
}

async function getLatestEpisodes() {
  const html = await fetchHTML(BASE_URL + '/');
  const $ = cheerio.load(html);
  return parseEpiItems($);
}

async function getMostWatched() {
  const html = await fetchHTML(BASE_URL + '/');
  const $ = cheerio.load(html);
  let targetContainer = null;
  $('.aniContainer').each((_, container) => {
    if (targetContainer) return;
    const title = $(container).find('.aniContainerTitulo').first().text();
    if (title.toLowerCase().includes('mais vistos') || title.includes('ほとんど見た')) {
      targetContainer = container;
    }
  });
  if (targetContainer) {
    const items = parseAniItems($, $(targetContainer).find('.aniItem'));
    if (items.length > 0) return items;
  }
  return parseAniItems($, '.aniContainer:first-child .aniItem');
}

async function getRecentAnimes() {
  const html = await fetchHTML(BASE_URL + '/');
  const $ = cheerio.load(html);
  let targetContainer = null;
  $('.aniContainer').each((_, container) => {
    if (targetContainer) return;
    const title = $(container).find('.aniContainerTitulo').first().text();
    if (title.toLowerCase().includes('recentes') || title.includes('最近')) {
      targetContainer = container;
    }
  });
  if (targetContainer) {
    const items = parseAniItems($, $(targetContainer).find('.aniItem'));
    if (items.length > 0) return items;
  }
  const containers = $('.aniContainer').toArray();
  if (containers.length >= 2) return parseAniItems($, $(containers[1]).find('.aniItem'));
  return [];
}

async function getAnimeList(page = 1) {
  const url = page === 1 ? `${BASE_URL}/lista-de-animes-online/` : `${BASE_URL}/lista-de-animes-online/page/${page}/`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  return parseAniItems($, 'div.aniItem');
}

async function searchAnimes(query) {
  const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const aniResults = parseAniItems($, 'div.aniItem');
  if (aniResults.length > 0) return aniResults;
  return parseEpiItems($);
}

async function getAnimeMeta(animeId) {
  const url = `${BASE_URL}/video/${animeId}/`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const rawTitle = $('h1').first().text().trim() || $('title').first().text().split('–')[0].trim();
  const title = cleanTitle(rawTitle);
  const poster = $('#capaAnime img').first().attr('src') || $('meta[property="og:image"]').attr('content') || '';
  const description = $('#sinopse2').text().trim() || $('meta[name="description"]').attr('content') || '';
  const genres = [];
  let year = '';
  $('.boxAnimeSobre .boxAnimeSobreLinha').each((_, el) => {
    const text = $(el).text().trim();
    if (text.startsWith('Gênero:')) {
      genres.push(...text.replace('Gênero:', '').split(',').map((s) => s.trim()).filter(Boolean));
    } else if (text.startsWith('Ano:')) {
      year = text.replace('Ano:', '').trim();
    }
  });
  const videos = [];
  $('.pagAniListaContainer a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const epId = extractId(href);
    if (!epId) return;
    const epTitle = $(el).attr('title') || $(el).text().trim() || `Episódio ${i + 1}`;
    const epNum = extractEpisodeNumber(epTitle) || (epTitle.match(/\b(\d+)\b/) ? parseInt(epTitle.match(/\b(\d+)\b/)[1], 10) : i + 1);
    videos.push({
      id: `anitube:${epId}`,
      title: `Episódio ${epNum}`,
      season: 1,
      episode: epNum,
      released: new Date(0).toISOString(),
    });
  });
  if (videos.length === 0 && url.includes('/video/')) {
    const epNum = extractEpisodeNumber(rawTitle) || 1;
    videos.push({
      id: `anitube:${animeId}`,
      title: `Episódio ${epNum}`,
      season: 1,
      episode: epNum,
      released: new Date(0).toISOString(),
    });
  }
  videos.sort((a, b) => a.episode - b.episode);
  return {
    meta: {
      id: `anitube:${animeId}`,
      type: 'series',
      name: title,
      poster,
      posterShape: 'poster',
      background: $('meta[property="og:image"]').attr('content') || poster,
      description,
      genres,
      year: year || undefined,
      website: url,
      videos,
    },
  };
}

async function getEpisodeIframes(epId) {
  const url = `${BASE_URL}/video/${epId}/`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const sources = [];
  $('div.pagEpiAbasItem').each((_, aba) => {
    const tabName = $(aba).text().trim() || 'Player';
    const tabTarget = $(aba).attr('aba-target');
    if (!tabTarget) return;
    const container = $(`div#${tabTarget}`);
    if (!container.length) return;
    // O seletor .metaframe é fundamental!
    const iframeSrc = container.find('iframe.metaframe').first().attr('src');
    if (!iframeSrc) return;
    sources.push({ name: tabName, iframeSrc, containerId: tabTarget });
  });
  return { sources, episodeUrl: url };
}

module.exports = {
  getLatestEpisodes,
  getMostWatched,
  getRecentAnimes,
  getAnimeList,
  searchAnimes,
  getAnimeMeta,
  getEpisodeIframes,
  extractId,
  cleanTitle,
  fetchHTML,
  BASE_URL,
};
