'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper = require('./src/scraper');
const { extractStreams } = require('./src/extractor');
const fetch = require('node-fetch');

// ── Cache em memória ──────────────────────────────────────────────────────────
const cache     = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// ── Manifest ──────────────────────────────────────────────────────────────────
const manifest = {
  id         : 'community.anitube.news',
  version    : '4.0.0',
  name       : '🎌 AniTube.news',
  description: 'Animes dublados e legendados do AniTube.news. Funciona nos catálogos do Stremio, Cinemeta e Kitsu.',
  logo       : 'https://www.anitube.news/wp-content/uploads/logo-anitube-2.png',
  background : 'https://www.anitube.news/wp-content/themes/anitube/img/bg.jpg',

  resources  : ['catalog', 'meta', 'stream'],
  types      : ['series'],

  // idPrefixes define para quais IDs externos o Stremio vai chamar nosso streamHandler.
  // 'anitube:' → catálogos próprios
  // 'tt'       → Cinemeta (IDs IMDB) — o addon aparece ao abrir uma série no Cinemeta
  // 'kitsu:'   → Kitsu addon — o addon aparece ao abrir um anime no Kitsu
  idPrefixes : ['anitube:', 'tt', 'kitsu:'],

  behaviorHints: { configurable: false, adult: false },

  catalogs: [
    // Todos os catálogos têm "search" habilitado.
    // Isso faz com que o addon apareça nos resultados ao pesquisar
    // em QUALQUER catálogo do Stremio (incluindo Cinemeta e Kitsu).
    {
      id   : 'anitube_ultimos',
      type : 'series',
      name : '🆕 AniTube – Últimos Episódios',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'anitube_mais_vistos',
      type : 'series',
      name : '🔥 AniTube – Mais Vistos',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'anitube_recentes',
      type : 'series',
      name : '📺 AniTube – Animes Recentes',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'anitube_lista',
      type : 'series',
      name : '📚 AniTube – Lista Completa',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
  ],
};

const builder = new addonBuilder(manifest);

// ── Catalog Handler ───────────────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ id, extra = {} }) => {
  const skip   = parseInt(extra.skip, 10) || 0;
  const page   = Math.floor(skip / 20) + 1;
  const search = (extra.search || '').trim();

  const key    = `cat:${id}:${search}:${page}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    let metas = [];

    if (search) {
      // Qualquer catálogo com search ativo retorna resultado de busca no AniTube.
      // Isso é o que faz o addon aparecer ao pesquisar no Cinemeta/Kitsu/outros.
      metas = await scraper.searchAnimes(search);
    } else {
      switch (id) {
        case 'anitube_ultimos':     metas = await scraper.getLatestEpisodes(page); break;
        case 'anitube_mais_vistos': metas = await scraper.getMostWatched(page);    break;
        case 'anitube_recentes':    metas = await scraper.getRecentAnimes(page);   break;
        case 'anitube_lista':
        default:                    metas = await scraper.getAnimeList(page);      break;
      }
    }

    if (!Array.isArray(metas)) metas = [];
    const result = { metas, cacheMaxAge: 300 };
    cacheSet(key, result);
    return result;

  } catch (e) {
    console.error(`[Catalog] "${id}":`, e.message);
    return { metas: [] };
  }
});

// ── Meta Handler ──────────────────────────────────────────────────────────────
builder.defineMetaHandler(async ({ id, type }) => {
  // Só responde a IDs nativos do AniTube — outros ficam com o addon que os gerou.
  if (!id.startsWith('anitube:')) return { meta: {} };

  const key    = `meta:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const animeId = id.replace('anitube:', '');
    const result  = await scraper.getAnimeMeta(animeId);
    if (!result?.meta) return { meta: {} };
    cacheSet(key, result);
    return result;
  } catch (e) {
    console.error(`[Meta] "${id}":`, e.message);
    return { meta: {} };
  }
});

// ── Stream Handler ────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ id, type }) => {
  const key    = `stream:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    let streams = [];

    if (id.startsWith('anitube:')) {
      // ── ID nativo: episódio já conhecido ──────────────────────────────────
      streams = await extractAniTubeById(id.replace('anitube:', ''));

    } else if (id.startsWith('tt')) {
      // ── ID IMDB (Cinemeta) ────────────────────────────────────────────────
      // Formato série: "tt1234567:1:3" (temporada 1, episódio 3)
      // Formato filme: "tt1234567" (ignoramos — AniTube não tem filmes)
      const parts   = id.split(':');
      const imdbId  = parts[0];
      const season  = parts[1] ? parseInt(parts[1], 10) : null;
      const episode = parts[2] ? parseInt(parts[2], 10) : null;

      if (type === 'movie') return { streams: [] }; // AniTube não tem filmes

      const { title, aliases } = await resolveImdbTitle(imdbId);
      if (title) streams = await searchAndExtract(title, aliases, season, episode);

    } else if (id.startsWith('kitsu:')) {
      // ── ID Kitsu ──────────────────────────────────────────────────────────
      // Formato: "kitsu:12345:1:3" (série 12345, temp. 1, ep. 3)
      const parts   = id.split(':');
      const kitsuId = `${parts[0]}:${parts[1]}`; // "kitsu:12345"
      const season  = parts[2] ? parseInt(parts[2], 10) : 1;
      const episode = parts[3] ? parseInt(parts[3], 10) : 1;

      const { title, aliases } = await resolveKitsuTitle(kitsuId);
      if (title) streams = await searchAndExtract(title, aliases, season, episode);
    }

    if (!streams.length) return { streams: [] };
    const result = { streams, cacheMaxAge: 300 };
    cacheSet(key, result);
    return result;

  } catch (e) {
    console.error(`[Stream] "${id}":`, e.message);
    return { streams: [] };
  }
});

// ── Extração de streams ───────────────────────────────────────────────────────

async function extractAniTubeById(epId) {
  const sr = await scraper.getEpisodeIframes(epId);
  if (!sr?.sources?.length) return [];
  return extractStreams(sr.sources, sr.episodeUrl);
}

// Resolve título e aliases de um ID IMDB via Cinemeta
async function resolveImdbTitle(imdbId) {
  try {
    const r = await fetch(
      `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`,
      { timeout: 8000 }
    );
    if (!r.ok) return { title: null, aliases: [] };
    const j = await r.json();
    return {
      title  : j?.meta?.name    || null,
      aliases: j?.meta?.aliases || [],
    };
  } catch (_) {
    return { title: null, aliases: [] };
  }
}

// Resolve título e aliases de um ID Kitsu
// FIX: a URL usava "/meta/anime/" mas o Kitsu addon serve sob "/meta/series/",
//      que é o type correto registrado no Stremio para séries de anime.
async function resolveKitsuTitle(kitsuId) {
  try {
    const r = await fetch(
      `https://anime-kitsu.strem.fun/meta/series/${kitsuId}.json`, // era "anime", corrigido para "series"
      { timeout: 8000 }
    );
    if (!r.ok) return { title: null, aliases: [] };
    const j = await r.json();
    return {
      title  : j?.meta?.name    || null,
      aliases: j?.meta?.aliases || [],
    };
  } catch (_) {
    return { title: null, aliases: [] };
  }
}

// ── Busca com verificação de relevância ───────────────────────────────────────
//
// Problema que isso resolve:
//   "Demon Slayer" → AniTube retorna "Slayers" como primeiro resultado
//   porque o site usa o nome JP "Kimetsu no Yaiba".
//
// Solução:
//   1. Gera queries priorizando aliases JP (que é como o AniTube cataloga)
//   2. Para cada query, verifica se algum resultado tem similaridade suficiente
//      com qualquer forma conhecida do título (EN + aliases)
//   3. Só aceita um resultado se ele passa no threshold de similaridade

const SIMILARITY_THRESHOLD = 0.45; // 0 = nada em comum, 1 = idêntico

async function searchAndExtract(title, aliases, season, episode) {
  const queries   = buildQueries(title, aliases);
  const allTitles = buildAllTitles(title, aliases); // todas as formas conhecidas do anime

  let bestMatch = null;
  let bestScore = 0;
  let matchedQuery = '';

  for (const q of queries) {
    let results;
    try {
      results = await scraper.searchAnimes(q);
    } catch (_) {
      continue;
    }
    if (!results?.length) continue;

    // Para cada resultado, calcula o score máximo contra todas as formas do título
    for (const candidate of results) {
      const candidateName = candidate.name || '';
      const score = allTitles.reduce((max, t) => Math.max(max, similarity(t, candidateName)), 0);

      if (score > bestScore) {
        bestScore  = score;
        bestMatch  = candidate;
        matchedQuery = q;
      }
    }

    // Se encontrou match forte o suficiente, para de buscar
    if (bestScore >= SIMILARITY_THRESHOLD) break;
  }

  if (!bestMatch || bestScore < SIMILARITY_THRESHOLD) {
    console.warn(`[AniTube] Sem match confiável para "${title}" (melhor score: ${bestScore.toFixed(2)})`);
    return [];
  }

  console.log(`[AniTube] Match: "${matchedQuery}" → "${bestMatch.name}" (score: ${bestScore.toFixed(2)})`);

  const animeId = bestMatch.id.replace('anitube:', '');
  // FIX: season agora é passado para resolveEpisodeId
  const epId    = await resolveEpisodeId(animeId, season, episode);
  return extractAniTubeById(epId);
}

// Resolve o ID do episódio correto dentro de um anime.
// FIX: adicionado parâmetro `season`; a busca agora prioriza season+episode,
//      depois episode isolado (compatibilidade com séries de temporada única),
//      e por último fallback por índice.
async function resolveEpisodeId(animeId, season, episode) {
  if (!episode || episode <= 0) return animeId;
  try {
    const meta   = await scraper.getAnimeMeta(animeId);
    const videos = meta?.meta?.videos || [];
    if (!videos.length) return animeId;

    const ep = videos.find(v => v.season === season && v.episode === episode) // season + episode (exato)
            || videos.find(v => v.episode === episode)                        // só episode (séries de 1 temporada)
            || videos[episode - 1]                                            // fallback por índice
            || videos[0];
    return ep ? ep.id.replace('anitube:', '') : animeId;
  } catch (_) {
    return animeId;
  }
}

// Gera queries de busca ordenadas por probabilidade de match no AniTube.
// Prioridade: aliases JP > título EN simplificado > título EN completo.
// O AniTube cataloga animes pelo nome JP — aliases costumam tê-lo.
function buildQueries(title, aliases) {
  const seen    = new Set();
  const jpFirst = []; // aliases (geralmente JP) — têm prioridade
  const enLast  = []; // título EN

  function addTo(arr, s) {
    if (!s || s.length < 2) return;
    const clean = s.trim();
    if (!seen.has(clean)) { seen.add(clean); arr.push(clean); }
  }

  // Aliases primeiro (incluem nome JP que o AniTube usa)
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (typeof a !== 'string') continue;
      addTo(jpFirst, a.split(':')[0].split(' - ')[0].trim());
      addTo(jpFirst, a.trim());
    }
  }

  // Título EN: versão simplificada (sem subtítulo) e completa
  addTo(enLast, title.replace(/\s*\(Dub\)/i, '').split(':')[0].split(' - ')[0].trim());
  addTo(enLast, title.replace(/\s*\(Dub\)/i, '').trim());
  addTo(enLast, title);

  return [...jpFirst, ...enLast];
}

// Retorna todas as formas conhecidas do título, normalizadas para comparação
function buildAllTitles(title, aliases) {
  const titles = new Set();

  function add(s) {
    if (s && s.length > 1) titles.add(normalize(s));
  }

  add(title);
  add(title.replace(/\s*\(Dub\)/i, '').trim());
  add(title.split(':')[0].trim());

  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (typeof a === 'string') {
        add(a);
        add(a.split(':')[0].trim());
      }
    }
  }

  return [...titles];
}

// Normaliza string para comparação: minúsculas, sem pontuação, sem artigos
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[:\-–—]/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\b(the|a|an|no|wo|wa|ga|de|ni|to)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Similaridade entre dois strings — combina Jaccard (palavras) + Dice (bigrams).
// Retorna valor entre 0 (nada em comum) e 1 (idênticos).
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;

  // Containment: se um contém o outro integralmente
  if (na.includes(nb) || nb.includes(na)) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  }

  // Jaccard sobre palavras individuais — bom para títulos curtos
  const setA = new Set(na.split(' ').filter(Boolean));
  const setB = new Set(nb.split(' ').filter(Boolean));
  let wordInter = 0;
  for (const w of setA) if (setB.has(w)) wordInter++;
  const jaccard = wordInter / (setA.size + setB.size - wordInter);

  // Dice sobre bigrams — bom para frases mais longas
  const bgA = new Set(bigrams(na));
  const bgB = new Set(bigrams(nb));
  let bgInter = 0;
  for (const bg of bgA) if (bgB.has(bg)) bgInter++;
  const dice = (bgA.size + bgB.size) > 0 ? (2 * bgInter) / (bgA.size + bgB.size) : 0;

  return Math.max(jaccard, dice);
}

// Gera bigrams de palavras de uma string normalizada
function bigrams(s) {
  const words = s.split(' ').filter(Boolean);
  if (words.length === 1) return words; // palavra única: retorna ela mesma
  const out = [];
  for (let i = 0; i < words.length - 1; i++) {
    out.push(`${words[i]} ${words[i + 1]}`);
  }
  return out;
}

module.exports = builder.getInterface();
