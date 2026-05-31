// ── Redis Client with automatic in-memory fallback ─────────────
const Redis = require('ioredis');

let client = null;
let enabled = false;

// ── In-memory fallback stores ──
const mem = new Map();         // key -> { value, expiresAt }
const memLists = new Map();    // key -> [items]
const RATE_LIMIT_CLEANUP_MS = 60000;

// ── Initialize ──
function init() {
    const url = process.env.REDIS_URL || '';
    if (url) {
        try {
            client = new Redis(url, {
                maxRetriesPerRequest: 2,
                retryStrategy(times) {
                    if (times > 3) return null; // stop retrying after 3 attempts
                    return Math.min(times * 500, 3000);
                },
                lazyConnect: true,
                enableOfflineQueue: false,
                connectTimeout: 5000
            });

            client.on('connect', () => {
                console.log('[Redis] Connected successfully');
                enabled = true;
            });

            client.on('error', (err) => {
                if (enabled) {
                    console.warn('[Redis] Connection error, falling back to in-memory:', err.message);
                    enabled = false;
                }
            });

            client.connect().catch((err) => {
                console.warn('[Redis] Connection failed (' + err.message + '), using in-memory fallback');
                enabled = false;
                client = null;
            });

            // Set a timeout - if not connected in 5s, use fallback
            setTimeout(() => {
                if (!enabled && client) {
                    console.log('[Redis] Timeout reached, using in-memory fallback');
                    try { client.disconnect(); } catch (e) { /* ignore */ }
                    client = null;
                }
            }, 5000);
        } catch (err) {
            console.warn('[Redis] Init error:', err.message, '- using in-memory fallback');
            enabled = false;
            client = null;
        }
    } else {
        console.log('[Redis] REDIS_URL not set, using in-memory fallback');
    }
}

function isReady() { return enabled && client; }

// ── Memory helpers ──
function memSet(key, value, ttlMs) {
    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
    mem.set(key, { value, expiresAt });
}

function memGet(key) {
    const entry = mem.get(key);
    if (!entry) return null;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
        mem.delete(key);
        return null;
    }
    return entry.value;
}

function memDel(key) {
    mem.delete(key);
}

function memCleanup() {
    const now = Date.now();
    for (const [key, entry] of mem) {
        if (entry.expiresAt > 0 && now > entry.expiresAt) {
            mem.delete(key);
        }
    }
    // Clean empty lists (older than 30 min)
    const cutoff = now - 30 * 60 * 1000;
    for (const [key] of memLists) {
        // Simple cleanup: delete lists with no activity (not tracked, just clear expired)
    }
}

// ── Generic key-value API ──
async function set(key, value, ttlMs) {
    if (isReady()) {
        try {
            const str = typeof value === 'string' ? value : JSON.stringify(value);
            if (ttlMs > 0) {
                await client.setex(key, Math.ceil(ttlMs / 1000), str);
            } else {
                await client.set(key, str);
            }
            return;
        } catch (err) { /* fall through */ }
    }
    memSet(key, value, ttlMs);
}

async function get(key) {
    if (isReady()) {
        try {
            const val = await client.get(key);
            if (val === null) return null;
            // Try parse as JSON, fall back to string
            try { return JSON.parse(val); } catch (e) { return val; }
        } catch (err) { /* fall through */ }
    }
    return memGet(key);
}

async function del(key) {
    if (isReady()) {
        try { await client.del(key); return; } catch (err) { /* fall through */ }
    }
    memDel(key);
}

// ── Rate Limiter: atomic INCR + EXPIRE ──
async function checkRateLimit(key, maxAttempts, windowMs) {
    if (isReady()) {
        try {
            const redisKey = 'rl:' + key;
            const count = await client.incr(redisKey);
            if (count === 1) {
                await client.pexpire(redisKey, windowMs);
            }
            return count <= maxAttempts;
        } catch (err) { /* fall through */ }
    }
    // In-memory fallback
    const now = Date.now();
    let entry = memGet('rl:' + key);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
    }
    entry.count++;
    memSet('rl:' + key, entry, Math.max(windowMs, entry.resetAt - now));
    return entry.count <= maxAttempts;
}

// ── Login rate limiting (combines IP + per-user limits) ──
async function checkLoginRateLimit(ip, username, maxPerIp, maxPerUser, windowMs) {
    const ipOk = await checkRateLimit('login_ip:' + ip, maxPerIp, windowMs);
    if (!ipOk) return { ok: false, retryAfter: 0, type: 'ip' };

    if (username) {
        const userOk = await checkRateLimit('login_user:' + username.toLowerCase(), maxPerUser, windowMs);
        if (!userOk) return { ok: false, retryAfter: 0, type: 'user' };
    }

    return { ok: true };
}

// ── Session management ──
async function setSession(token, username, ttlMs) {
    await set('session:' + token, username, ttlMs);
}

async function getSession(token) {
    return await get('session:' + token);
}

async function delSession(token) {
    await del('session:' + token);
}

// ── Chat history (List operations) ──
const MAX_CHAT = 200;

async function addChatMessage(msg) {
    if (isReady()) {
        try {
            await client.lpush('chat', JSON.stringify(msg));
            await client.ltrim('chat', 0, MAX_CHAT - 1);
            return;
        } catch (err) { /* fall through */ }
    }
    // In-memory fallback
    if (!memLists.has('chat')) memLists.set('chat', []);
    const list = memLists.get('chat');
    list.unshift(msg);
    if (list.length > MAX_CHAT) list.length = MAX_CHAT;
}

async function getChatHistory(count) {
    if (isReady()) {
        try {
            const items = await client.lrange('chat', 0, count - 1);
            return items.map(i => {
                try { return JSON.parse(i); } catch (e) { return null; }
            }).filter(Boolean);
        } catch (err) { /* fall through */ }
    }
    const list = memLists.get('chat') || [];
    return list.slice(0, count);
}

async function getChatHistoryCount() {
    if (isReady()) {
        try { return await client.llen('chat'); } catch (err) { /* fall through */ }
    }
    return (memLists.get('chat') || []).length;
}

// ── Verification codes ──
const VERIFY_CODE_TTL = 5 * 60 * 1000; // 5 min

async function setVerifyCode(username, code) {
    await set('verify:' + username, code, VERIFY_CODE_TTL);
}

async function getVerifyCode(username) {
    return await get('verify:' + username);
}

async function delVerifyCode(username) {
    await del('verify:' + username);
}

// ── Admin login rate limiting ──
// ── Cleanup ──
let cleanupInterval = null;

function startCleanup(intervalMs) {
    if (cleanupInterval) clearInterval(cleanupInterval);
    cleanupInterval = setInterval(memCleanup, intervalMs || RATE_LIMIT_CLEANUP_MS);
}

function stopCleanup() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}

async function quit() {
    stopCleanup();
    if (client) {
        try {
            await client.quit();
        } catch (e) { /* ignore */ }
    }
}

// ── Export ──
module.exports = {
    init, isReady,
    set, get, del,
    checkRateLimit,
    checkLoginRateLimit,

    setSession, getSession, delSession,
    addChatMessage, getChatHistory, getChatHistoryCount,
    setVerifyCode, getVerifyCode, delVerifyCode,
    startCleanup, stopCleanup, quit
};
