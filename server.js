// server.js
// Importa o handler (que é a função exportada pelo addon.js)
const handler = require('./addon');

// Se estiver rodando localmente (NODE_ENV diferente de 'production'), inicia o servidor HTTP
if (process.env.NODE_ENV !== 'production') {
    const { serveHTTP } = require('stremio-addon-sdk');
    // Recupera o builder da variável global definida no addon.js
    const builder = global.__animesdigitalBuilder;
    if (builder) {
        const port = process.env.PORT || 7000;
        serveHTTP(builder.getInterface(), { port });
        console.log(`✅ Addon rodando em http://127.0.0.1:${port}/manifest.json`);
    } else {
        console.error('❌ Builder não encontrado. Verifique o addon.js');
        process.exit(1);
    }
}

// Exporta o handler para o Vercel (serverless)
module.exports = handler;
