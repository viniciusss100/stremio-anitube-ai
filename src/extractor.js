// src/extractor.js
const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const extractVideoUrl = async (episodeUrl) => {
    try {
        const { data } = await axios.get(episodeUrl, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000
        });
        const $ = cheerio.load(data);

        // Busca iframe do player
        const iframeSrc = $('iframe.metaframe, iframe.rptss, #player1 iframe').attr('src');
        if (!iframeSrc) return null;

        // Extrai parâmetro 'd' da URL (ex: api.anivideo.net/videohls.php?d=...)
        const urlParams = new URLSearchParams(iframeSrc.split('?')[1]);
        let videoUrl = urlParams.get('d');
        
        if (!videoUrl && iframeSrc.includes('.m3u8')) {
            videoUrl = iframeSrc;
        }

        // Se o link for relativo, resolve
        if (videoUrl && videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
        
        return videoUrl;
    } catch (err) {
        console.error(`Erro ao extrair vídeo de ${episodeUrl}:`, err.message);
        return null;
    }
};

module.exports = { extractVideoUrl };
