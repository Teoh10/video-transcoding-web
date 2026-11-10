import Memcached from "memcached";
import { promisify } from "node:util";

// =======================================================
// State
// =======================================================
let memcached = null;
let useMemoryFallback = false;
let backendLogged = false;
const memoryCache = new Map(); // key -> { value: string, exp: number|null }
const nsMemory = new Map();    // sub -> version string e.g. "0", "1"

// =======================================================
// Local memory helpers (fallback if memcached unavailable)
// =======================================================
function memGetLocal(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.exp && entry.exp <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

function memSetLocal(key, value, ttlSeconds) {
  const exp = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
  memoryCache.set(key, { value, exp });
}

function memDelLocal(key) {
  memoryCache.delete(key);
}

// =======================================================
// Connect to memcached
// =======================================================
export function connectToMemcached() {
  if (memcached) return memcached;
  const memcachedAddress = process.env.MEMCACHED_ENDPOINT;
  if (!memcachedAddress) throw new Error("MEMCACHED_ENDPOINT is not set");
  memcached = new Memcached(memcachedAddress, {
    retries: 1,
    retry: 100,         // ms between retries
    timeout: 500,       // operation timeout
    remove: true,       // remove dead servers
  });

  memcached.on("failure", (details) => {
    console.log("Memcached server failure:", details);
  });
  memcached.on("issue", (details) => {
    console.warn("Memcached issue:", details);
  });
  memcached.on("reconnecting", (details) => {
    console.warn("Memcached reconnecting:", details);
  });
  memcached.on("remove", (details) => {
    console.error("Memcached removed server:", details);
    // Lean on in-memory fallback when server removed
    useMemoryFallback = true;
  });

  // Promisified helpers
  memcached.aGet = promisify(memcached.get).bind(memcached);
  memcached.aSet = promisify(memcached.set).bind(memcached);
  memcached.aDel = promisify(memcached.del).bind(memcached);

  if (!backendLogged) {
    backendLogged = true;
    console.log(`[cache] Memcached endpoint: ${memcachedAddress}`);
  }
  return memcached;
}

// =======================================================
// JSON helpers
// =======================================================
export async function cacheGetJSON(key) {
  try {
    const m = connectToMemcached();
    const raw = await m.aGet(key);
    if (process.env.CACHE_DEBUG === "1") console.log("[cache] get JSON memcached", key, raw ? "HIT" : "MISS");
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  } catch (_) {
    useMemoryFallback = true;
    if (process.env.CACHE_DEBUG === "1") console.log("[cache] get JSON memory (fallback)", key);
    const raw = memGetLocal(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
}

export async function cacheSetJSON(key, value, ttlSeconds) {
  try {
    const m = connectToMemcached();
    await m.aSet(key, JSON.stringify(value), ttlSeconds);
    if (process.env.CACHE_DEBUG === "1") console.log("[cache] set JSON memcached", key, ttlSeconds);
  } catch (_) {
    useMemoryFallback = true;
    if (process.env.CACHE_DEBUG === "1") console.log("[cache] set JSON memory (fallback)", key, ttlSeconds);
    try { memSetLocal(key, JSON.stringify(value), ttlSeconds); } catch {}
  }
}

// =======================================================
// Namespace helpers (invalidate-many)
// =======================================================
const NS_TTL = 24 * 60 * 60; // 1 day
async function getNamespace(sub) {
  try {
    const m = connectToMemcached();
    const key = `ns:videos:list:${sub}`;
    const v = await m.aGet(key);
    if (v) return v;
    await m.aSet(key, "0", NS_TTL);
    return "0";
  } catch (_) {
    useMemoryFallback = true;
    if (!nsMemory.has(sub)) nsMemory.set(sub, "0");
    return nsMemory.get(sub);
  }
}

export async function bumpNamespace(sub) {
  try {
    const m = connectToMemcached();
    const key = `ns:videos:list:${sub}`;
    return new Promise((resolve) => {
      m.increment(key, 1, (err, val) => {
        if (err || val === false) {
          m.set(key, "1", NS_TTL, () => resolve(1));
        } else {
          resolve(val);
        }
      });
    });
  } catch (_) {
    useMemoryFallback = true;
    const cur = nsMemory.get(sub) || "0";
    const next = String(Number(cur) + 1);
    nsMemory.set(sub, next);
    return Number(next);
  }
}

export async function buildVideosListKey({ sub, page, perPage, sort }) {
  const ns = await getNamespace(sub);
  return `videos:list:${sub}:v${ns}:p${page}:n${perPage}:s${sort}`;
}

// =======================================================
// Buffer helpers (e.g., thumbnails)
// =======================================================
export async function cacheGetBuffer(key) {
  try {
    const m = connectToMemcached();
    const val = await m.aGet(key);
    if (process.env.CACHE_DEBUG === "1") console.log("[cache] get BUF memcached", key, val ? "HIT" : "MISS");
    if (!val) return null;
    if (Buffer.isBuffer(val)) return val;
    if (typeof val === "string") {
      try { return Buffer.from(val, "base64"); } catch { return null; }
    }
    return null;
  } catch (_) {
    useMemoryFallback = true;
    if (process.env.CACHE_DEBUG === "1") console.log("[cache] get BUF memory (fallback)", key);
    const raw = memGetLocal(key);
    if (!raw) return null;
    if (Buffer.isBuffer(raw)) return raw;
    if (typeof raw === "string") {
      try { return Buffer.from(raw, "base64"); } catch { return null; }
    }
    return null;
  }
}

export async function cacheSetBuffer(key, buffer, ttlSeconds) {
  if (!Buffer.isBuffer(buffer)) throw new Error("cacheSetBuffer expects Buffer");
  try {
    const m = connectToMemcached();
    await m.aSet(key, buffer, ttlSeconds);
    if (process.env.CACHE_DEBUG === "1") console.log("[cache] set BUF memcached", key, buffer.length, ttlSeconds);
  } catch (_) {
    useMemoryFallback = true;
    if (process.env.CACHE_DEBUG === "1") console.log("[cache] set BUF memory (fallback)", key, buffer.length, ttlSeconds);
    try { memSetLocal(key, buffer, ttlSeconds); } catch {}
  }
}

export async function cacheDel(key) {
  try {
    const m = connectToMemcached();
    await m.aDel(key);
  } catch (_) {
    useMemoryFallback = true;
  } finally {
    memDelLocal(key);
  }
}
