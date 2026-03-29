// server.js - apenas para desenvolvimento local (não usado na Vercel)
const { serveHTTP } = require('stremio-addon-sdk');
const builder = require('./addon');
const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port });
console.log(`✅ Addon rodando em http://127.0.0.1:${port}/manifest.json`);
