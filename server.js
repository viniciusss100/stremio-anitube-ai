// server.js
// Reexporta o handler já exportado pelo addon.js
const handler = require('./addon');

// Se estiver rodando localmente (NODE_ENV diferente de 'production'), inicia o servidor HTTP
if (process.env.NODE_ENV !== 'production') {
    const { serveHTTP } = require('stremio-addon-sdk');
    // Importa o builder do addon.js (exportado como propriedade)
    const { builder } = require('./addon');
    const port = process.env.PORT || 7000;
    serveHTTP(builder.getInterface(), { port });
    console.log(`✅ Addon rodando em http://127.0.0.1:${port}/manifest.json`);
}

// Exporta o handler para o Vercel (serverless)
module.exports = handler;
