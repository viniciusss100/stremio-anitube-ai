// index.js
const { getRouter, serveHTTP } = require('stremio-addon-sdk');
const builder = require('./addon');

const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

// Handler que adapta a chamada para o router
const handler = async (req, res) => {
    // O router espera (req, res, next) - podemos passar uma função vazia para next
    router(req, res, () => {
        res.statusCode = 404;
        res.end('Not Found');
    });
};

module.exports = handler;

// Desenvolvimento local
if (require.main === module) {
    const port = process.env.PORT || 7000;
    serveHTTP(addonInterface, { port });
    console.log(`✅ Addon rodando em http://127.0.0.1:${port}/manifest.json`);
}
