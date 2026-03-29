// index.js
const { getRouter } = require('stremio-addon-sdk');
const builder = require('./addon');

// getRouter retorna uma função HTTP pronta para serverless (Vercel, AWS Lambda)
const handler = getRouter(builder.getInterface());

// Exporta a função handler (o que a Vercel espera)
module.exports = handler;

// Se o arquivo for executado diretamente (node index.js), inicia servidor local
if (require.main === module) {
    const { serveHTTP } = require('stremio-addon-sdk');
    const port = process.env.PORT || 7000;
    serveHTTP(builder.getInterface(), { port });
    console.log(`✅ Addon rodando em http://127.0.0.1:${port}/manifest.json`);
}
