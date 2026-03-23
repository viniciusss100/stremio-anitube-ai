# 🎌 Stremio Addon — AniTube.news  v2.0.0

Addon para o [Stremio](https://www.stremio.com/) que integra o conteúdo de [AniTube.news](https://www.anitube.news/), um dos maiores portais de animes em português do Brasil.

---

## ✨ Funcionalidades

| Recurso | Descrição |
|---|---|
| 🆕 **Últimos Episódios** | Seção `div.epiContainer` da home |
| 🔥 **Mais Vistos** | Carrossel `div.main-carousel` |
| 📺 **Animes Recentes** | Carrossel `div.main-carousel-an` |
| 📚 **Lista Completa** | Todos os animes, paginados (20/página) |
| 🔍 **Busca** | Pesquisa por nome dentro do Stremio |
| 📄 **Meta completo** | Título, poster, sinopse, gêneros, ano, 131+ episódios |
| ▶️ **Streams HLS** | M3U8 direto do CDN (`videohls.php?d=`) |
| 💾 **Cache** | Cache em memória por TTL para reduzir carga |

---

## 🔧 Como funciona a extração de vídeo

```
Página do Episódio (div.pagEpiAbas)
└── div.pagEpiAbasContainer → iframe.metaframe[src]
    ├── api.anivideo.net/videohls.php?d=<url_m3u8>
    │   └── Extração direta do parâmetro "d" → HLS/M3U8
    └── anitube.news/xxx/bg.mp4?p=1&q=
        └── Fetch do iframe proxy → busca m3u8/mp4/Blogger
            └── blogger.com/video.g?token=…
                └── POST batchexecute → GoogleVideo URLs
```

---

## 🚀 Instalação

### Pré-requisitos
- [Node.js](https://nodejs.org/) v16+
- npm

### Passos

```bash
# 1. Entre na pasta do projeto
cd stremio-anitube

# 2. Instale as dependências
npm install

# 3. Inicie o servidor
npm start
```

### Instalar no Stremio

1. Abra o **Stremio**
2. Vá em **Addons → + Add Addon**
3. Cole: `http://127.0.0.1:7000/manifest.json`
4. Clique em **Install** ✅

---

## ⚙️ Configuração

```bash
cp .env.example .env
```

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `7000` | Porta do servidor HTTP |

---

## 📡 Endpoints Validados

| Endpoint | Status | Descrição |
|---|---|---|
| `GET /manifest.json` | ✅ | Manifesto com 4 catálogos |
| `GET /catalog/series/anitube_ultimos_eps.json` | ✅ | 20+ últimos episódios |
| `GET /catalog/series/anitube_mais_vistos.json` | ✅ | Animes mais vistos |
| `GET /catalog/series/anitube_recentes.json` | ✅ | Animes recentes |
| `GET /catalog/series/anitube_lista.json` | ✅ | Lista completa (paginada) |
| `GET /catalog/series/anitube_lista/search=naruto.json` | ✅ | Busca funcional |
| `GET /meta/series/anitube:{id}.json` | ✅ | Meta + lista de 131 episódios |
| `GET /stream/series/anitube:{id}.json` | ✅ | Stream HLS direto |

---

## 🗂️ Estrutura

```
stremio-anitube/
├── addon.js            ← Manifesto + handlers (catalog, meta, stream)
├── server.js           ← Servidor HTTP via stremio-addon-sdk
├── package.json
├── .env.example
├── src/
│   ├── scraper.js      ← Scraping real do AniTube.news (seletores CSS)
│   ├── extractor.js    ← Extração de vídeo: HLS, Proxy, Blogger
│   └── cache.js        ← Cache em memória com TTL
└── README.md
```

---

## ⚠️ Aviso Legal

Este é um projeto **não oficial**, de código aberto, de uso pessoal.
Realiza scraping do AniTube.news para integração com o Stremio.
Os direitos sobre o conteúdo pertencem aos respectivos titulares.

---

## 📝 Licença

MIT
