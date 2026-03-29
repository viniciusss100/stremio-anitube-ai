// index.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { getLatestEpisodes, getPopularAnimes, getRecentAnimes, getAllAnimes, searchAnimes, getMetaData, getStreamUrl } = require('./src/animesdigital');
const cache = require('./src/cache');

const manifest = {
    id: 'com.stremio.animesdigital',
    version: '1.0.0',
    name: 'Animes Digital',
    description: 'Assista animes, desenhos e doramas do animesdigital.org no Stremio',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    catalogs: [
        { id: 'animesdigital_ultimos_eps', name: 'Últimos Episódios', type: 'series', extra: [{ name: 'search' }] },
        { id: 'animesdigital_mais_vistos', name: 'Mais Vistos', type: 'series', extra: [{ name: 'search' }] },
        { id: 'animesdigital_recentes', name: 'Animes Recentes', type: 'series', extra: [{ name: 'search' }] },
        { id: 'animesdigital_lista', name: 'Lista Completa', type: 'series', extra: [{ name: 'search' }] }
    ],
    idPrefixes: ['animesdigital:']
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    const search = extra.search || '';
    let items = [];

    if (id === 'animesdigital_ultimos_eps') items = await getLatestEpisodes();
    else if (id === 'animesdigital_mais_vistos') items = await getPopularAnimes();
    else if (id === 'animesdigital_recentes') items = await getRecentAnimes();
    else if (id === 'animesdigital_lista') items = search ? await searchAnimes(search) : await getAllAnimes();

    return { metas: items };
});

builder.defineMetaHandler(async ({ id }) => {
    const animeId = id.replace('animesdigital:', '');
    const meta = await cache.getOrSet(`meta:${animeId}`, () => getMetaData(animeId));
    return { meta };
});

builder.defineStreamHandler(async ({ id }) => {
    const episodeId = id.replace('animesdigital:', '');
    const streams = await cache.getOrSet(`stream:${episodeId}`, () => getStreamUrl(episodeId));
    return { streams };
});

const { handler } = builder.getInterface();

// Exporta o handler para a Vercel (serverless)
module.exports = handler;

// Se o arquivo for executado diretamente (node index.js), inicia o servidor local
if (require.main === module) {
    const port = process.env.PORT || 7000;
    serveHTTP(builder.getInterface(), { port });
    console.log(`✅ Addon rodando em http://127.0.0.1:${port}/manifest.json`);
}
