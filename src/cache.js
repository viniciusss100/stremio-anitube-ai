'use strict';

/**
 * Cache simples em memória com TTL (Time To Live)
 * Evita requisições repetidas ao AniTube.news
 */
class Cache {
  constructor() {
    this._store = new Map();
  }

  /**
   * Busca um item no cache
   * @param {string} key
   * @returns {*} valor ou undefined se expirado/inexistente
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Armazena um item no cache
   * @param {string} key
   * @param {*} value
   * @param {number} ttlMs - tempo de vida em milissegundos
   */
  set(key, value, ttlMs = 5 * 60 * 1000) {
    this._store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Remove um item do cache
   * @param {string} key
   */
  delete(key) {
    this._store.delete(key);
  }

  /**
   * Limpa todos os itens expirados
   */
  purge() {
    const now = Date.now();
    for (const [key, entry] of this._store.entries()) {
      if (now > entry.expiresAt) {
        this._store.delete(key);
      }
    }
  }
}

// Instâncias únicas de cache com TTLs diferentes
const catalogCache = new Cache();  // 5 min
const metaCache = new Cache();     // 10 min
const streamCache = new Cache();   // 2 min

// Limpar entradas expiradas a cada 10 minutos
setInterval(() => {
  catalogCache.purge();
  metaCache.purge();
  streamCache.purge();
}, 10 * 60 * 1000);

module.exports = { catalogCache, metaCache, streamCache };
