// server.js
const builder = require('./addon');

// Exporta o handler HTTP para ser usado no Vercel (serverless)
// O método getInterface() retorna um objeto com a função 'handler'
module.exports = builder.getInterface();

// Se estiver rodando localmente (não em produção), inicia o servidor HTTP
if (process.env.NODE_ENV !== 'production') {
    const { serveHTTP } = require('stremio-addon-sdk');
    const port = process.env.PORT || 7000;
    serveHTTP(builder.getInterface(), { port });
    console.log(`✅ Addon rodando em http://127.0.0.1:${port}/manifest.json`);
}
