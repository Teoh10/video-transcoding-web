const Memcached = require("memcached");
const util = require("node:util");

const memcachedAddress =
  process.env.MEMCACHED_ENDPOINT || "127.0.0.1:11211"; // fallback for local

let memcached = null;

function connectToMemcached() {
  if (memcached) return memcached;
  memcached = new Memcached(memcachedAddress, {
    retries: 1,
    retry: 100,         // ms between retries
    timeout: 500,       // operation timeout
    remove: true,       // remove dead servers
  });

  memcached.on("failure", (details) => {
    console.log("Memcached server failure:", details);
  });

  // Promisified helpers (same pattern you used)
  memcached.aGet = util.promisify(memcached.get).bind(memcached);
  memcached.aSet = util.promisify(memcached.set).bind(memcached);
  memcached.aDel = util.promisify(memcached.del).bind(memcached);

  return memcached;
}

// Read-through get: return JSON object or null
async function cacheGetJSON(key) {
  const m = connectToMemcached();
  const raw = await m.aGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Set JSON with TTL seconds
async function cacheSetJSON(key, value, ttlSeconds) {
  const m = connectToMemcached();
  await m.aSet(key, JSON.stringify(value), ttlSeconds);
}

// Namespace version token per user so we can “invalidate many” by bumping one key
const NS_TTL = 24 * 60 * 60; // 1 day
async function getNamespace(sub) {
  const m = connectToMemcached();
  const key = `ns:videos:list:${sub}`;
  const v = await m.aGet(key);
  if (v) return v;
  // initialize to "0" if not present
  await m.aSet(key, "0", NS_TTL);
  return "0";
}

async function bumpNamespace(sub) {
  const m = connectToMemcached();
  const key = `ns:videos:list:${sub}`;
  // memcached has 'incr'. If key not set, set then incr.
  return new Promise((resolve) => {
    m.increment(key, 1, (err, val) => {
      if (err || val === false) {
        m.set(key, "1", NS_TTL, () => resolve(1));
      } else {
        resolve(val);
      }
    });
  });
}

// Build the cache key for list endpoint
async function buildVideosListKey({ sub, page, perPage, sort }) {
  const ns = await getNamespace(sub);      // e.g., "0", "1", ...
  return `videos:list:${sub}:v${ns}:p${page}:n${perPage}:s${sort}`;
}

module.exports = {
  connectToMemcached,
  cacheGetJSON,
  cacheSetJSON,
  bumpNamespace,
  buildVideosListKey,
};
