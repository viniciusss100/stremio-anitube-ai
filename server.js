// server.js
const { serveHTTP } = require('stremio-addon-sdk');
const { getInterface } = require('./addon'); // Não funciona porque addon.js exporta só a função handler

// Precisamos reconstruir o builder localmente para o serveHTTP
// OU melhor: reutilizar o mesmo código localmente
// Vamos importar o addon.js de forma diferente?

// Solução: mover a lógica de construção para um arquivo separado? Não.
// Para desenvolvimento local, vamos simplesmente recriar o builder aqui mesmo.
// Mas para não duplicar, faremos um require do addon.js e extrair o builder de dentro?

// Como addon.js exporta apenas a função handler, não temos acesso ao builder.
// Então, para local, vamos criar um arquivo auxiliar ou simplesmente rodar com o SDK?

// Alternativa mais simples: no ambiente local, usamos o mesmo código do addon.js,
// mas invocamos o serveHTTP diretamente. Vamos modificar o addon.js para também
// iniciar o servidor quando NODE_ENV não for 'production'.

// Porém, isso pode conflitar com a exportação da função handler.
// O ideal é ter dois entry points: um para Vercel (addon.js) e outro para local (server.js).
// Para não repetir código, vamos criar um arquivo `lib.js` com a lógica comum.

// Mas por simplicidade, sugiro manter o addon.js como está e criar um server.js que
// importa o mesmo código usando um pequeno truque: adicionar no addon.js uma verificação
// de ambiente e iniciar o servidor se não estiver na Vercel.

// Vou reescrever o addon.js para ser compatível com ambos.
