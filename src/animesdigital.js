// src/animesdigital.js
const axios = require('axios');
const cheerio = require('cheerio');
const cache = require('./cache');
const { extractVideoUrl } = require('./extractor');

const BASE_URL = 'https://animesdigital.org';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const request = async (url) => {
    const { data } = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 10000
    });
    return data;
};

// Extrai lista de episódios da página de um anime
const getEpisodeListFromAnimePage = async (animeUrl) => {
    const html = await request(animeUrl);
    const $ = cheerio.load(html);
    const episodes = [];

    // Seletores comuns para lista de episódios no animesdigital
    $('.sidebar_navigation_episodes a, .episodes-list a, .lista-episodios a').each((i, el) => {
        const href = $(el).attr('href');
        const epNum = $(el).find('.episode_list_episodes_num, .ep-num').text().trim();
        if (href && href.includes('/video/a/')) {
            episodes.push({
                id: href.split('/').pop(),
                number: parseInt(epNum) || i + 1,
                title: `Episódio ${epNum}`,
                released: new Date().toISOString().split('T')[0]
            });
        }
    });

    return episodes.sort((a,b) => a.number - b.number);
};

// Obtém metadados do anime (título, poster, sinopse, gêneros)
const getMetaData = async (animeId) => {
    const animeUrl = `${BASE_URL}/anime/a/${animeId}`;
    const html = await request(animeUrl);
    const $ = cheerio.load(html);

    const title = $('h1').first().text().trim() || $('title').text().split('–')[0].trim();
    const poster = $('.poster img, .anime-poster img').attr('src') || '';
    const description = $('.descep_video .info span:last-child, .sinopse').text().trim();
    const genres = [];
    $('.generos a, .genres a').each((i, el) => genres.push($(el).text().trim()));

    const episodes = await getEpisodeListFromAnimePage(animeUrl);

    return {
        id: `animesdigital:${animeId}`,
        type: 'series',
        name: title,
        poster: poster,
        posterShape: 'vertical',
        description: description,
        genres: genres,
        releaseInfo: 'Anime',
        videos: episodes.map(ep => ({
            id: `animesdigital:${ep.id}`,
            title: ep.title,
            released: ep.released,
            season: 1,
            episode: ep.number,
            overview: `Episódio ${ep.number}`
        }))
    };
};

// Últimos episódios (página inicial)
const getLatestEpisodes = async () => {
    const html = await request(BASE_URL);
    const $ = cheerio.load(html);
    const items = [];

    // Seletores da home (ajuste conforme necessário)
    $('.epiContainer .item, .last-episodes .item, .latest-episodes .item').each((i, el) => {
        const title = $(el).find('.title, .anime-title').text().trim();
        const episodeNum = $(el).find('.ep-number, .episode').text().trim();
        const href = $(el).find('a').attr('href');
        if (href && href.includes('/video/a/')) {
            const id = href.split('/').pop();
            items.push({
                id: `animesdigital:${id}`,
                name: `${title} - Ep. ${episodeNum}`,
                poster: $(el).find('img').attr('src') || '',
                posterShape: 'regular'
            });
        }
    });

    return items.slice(0, 50);
};

// Mais Vistos / Popular (carrossel da home)
const getPopularAnimes = async () => {
    const html = await request(BASE_URL);
    const $ = cheerio.load(html);
    const items = [];

    $('.main-carousel .item, .popular-animes .item').each((i, el) => {
        const title = $(el).find('.title, .anime-name').text().trim();
        const href = $(el).find('a').attr('href');
        if (href && href.includes('/anime/a/')) {
            const id = href.split('/').pop();
            items.push({
                id: `animesdigital:${id}`,
                name: title,
                poster: $(el).find('img').attr('src') || '',
                posterShape: 'vertical'
            });
        }
    });

    return items.slice(0, 30);
};

// Animes Recentes
const getRecentAnimes = async () => {
    const html = await request(BASE_URL);
    const $ = cheerio.load(html);
    const items = [];

    $('.main-carousel-an .item, .recent-animes .item').each((i, el) => {
        const title = $(el).find('.title, .anime-name').text().trim();
        const href = $(el).find('a').attr('href');
        if (href && href.includes('/anime/a/')) {
            const id = href.split('/').pop();
            items.push({
                id: `animesdigital:${id}`,
                name: title,
                poster: $(el).find('img').attr('src') || '',
                posterShape: 'vertical'
            });
        }
    });

    return items.slice(0, 30);
};

// Lista completa de animes (paginada)
const getAllAnimes = async (page = 1) => {
    const listUrl = `${BASE_URL}/animes-legendados-online/page/${page}/`;
    try {
        const html = await request(listUrl);
        const $ = cheerio.load(html);
        const items = [];

        $('.anime-list .item, .all-animes .item, .lista-de-animes .item').each((i, el) => {
            const title = $(el).find('.title, .anime-name').text().trim();
            const href = $(el).find('a').attr('href');
            if (href && href.includes('/anime/a/')) {
                const id = href.split('/').pop();
                items.push({
                    id: `animesdigital:${id}`,
                    name: title,
                    poster: $(el).find('img').attr('src') || '',
                    posterShape: 'vertical'
                });
            }
        });

        return items;
    } catch (err) {
        // Fallback: busca via sitemap ou endpoint alternativo
        return [];
    }
};

// Busca por nome
const searchAnimes = async (query) => {
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    const html = await request(searchUrl);
    const $ = cheerio.load(html);
    const items = [];

    $('.result-item, .search-result .item, .anime-item').each((i, el) => {
        const title = $(el).find('.title, .anime-name').text().trim();
        const href = $(el).find('a').attr('href');
        if (href && (href.includes('/anime/a/') || href.includes('/video/a/'))) {
            const id = href.split('/').pop();
            items.push({
                id: `animesdigital:${id}`,
                name: title,
                poster: $(el).find('img').attr('src') || '',
                posterShape: 'vertical'
            });
        }
    });

    return items.slice(0, 50);
};

// Obtém URL do stream para um episódio
const getStreamUrl = async (episodeId) => {
    const episodeUrl = `${BASE_URL}/video/a/${episodeId}`;
    const m3u8 = await extractVideoUrl(episodeUrl);
    if (!m3u8) return [];

    return [{
        name: 'Animes Digital',
        title: 'HD',
        url: m3u8,
        behaviorHints: { notWebReady: false, proxyHeaders: { 'Referer': BASE_URL } }
    }];
};

module.exports = {
    getLatestEpisodes,
    getPopularAnimes,
    getRecentAnimes,
    getAllAnimes,
    searchAnimes,
    getMetaData,
    getStreamUrl
};
