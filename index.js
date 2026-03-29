// index.js
const builder = require('./addon');
const { serveHTTP } = require('stremio-addon-sdk');

const addonInterface = builder.getInterface();

// Handler manual para Vercel (serverless)
const handler = async (req, res) => {
    // Extrai o path da URL da requisição
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    // O addonInterface já é um servidor HTTP, mas precisamos adaptar
    // Uma forma simples: criar um pequeno servidor manual que chama o método correto
    // Baseado no código fonte do SDK, o addonInterface possui um método .handler? Não.
    // Na verdade, o SDK fornece serveHTTP, mas para serverless podemos usar o próprio router interno.

    // Solução: usar o getRouter corretamente (já que erro anterior foi por falta de callback)
    const { getRouter } = require('stremio-addon-sdk');
    const router = getRouter(addonInterface);
    
    // Agora chama o router com req, res
    router(req, res);
};

// Exporta o handler
module.exports = handler;

// Para desenvolvimento local
if (require.main === module) {
    const port = process.env.PORT || 7000;
    serveHTTP(addonInterface, { port });
    console.log(`✅ Addon rodando em http://127.0.0.1:${port}/manifest.json`);
}
