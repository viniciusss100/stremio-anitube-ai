// src/cache.js
const cache = new Map();

const getOrSet = async (key, fetcher, ttl = 3600000) => {
    const now = Date.now();
    if (cache.has(key)) {
        const { value, expires } = cache.get(key);
        if (expires > now) return value;
        cache.delete(key);
    }
    const value = await fetcher();
    cache.set(key, { value, expires: now + ttl });
    return value;
};

const clear = () => cache.clear();

module.exports = { getOrSet, clear };
