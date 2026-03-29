// server.js
const builder = require('./addon');

// Obtém a interface do addon (contém a função handler)
const { handler } = builder.getInterface();

// Exporta a função handler para o Vercel (serverless)
module.exports = handler;

// Se estiver rodando localmente (NODE_ENV diferente de 'production'), inicia o servidor HTTP
if (process.env.NODE_ENV !== 'production') {
    const { serveHTTP } = require('stremio-addon-sdk');
    const port = process.env.PORT || 7000;
    serveHTTP(builder.getInterface(), { port });
    console.log(`✅ Addon rodando em http://127.0.0.1:${port}/manifest.json`);
}
