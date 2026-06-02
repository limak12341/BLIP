// ── Sentry instrumentation (MUSI być pierwszym require) ─────
const Sentry = require('./instrument');
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

const express = require('express');
const { startBot } = require('./bot.js');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const db = require('./modules/db');
const pf = require('./modules/provablyFair');
const games = require('./modules/games');
const values = require('./modules/values');
const redis = require('./modules/redis');

// ── Inicjalizacja modułów ────────────────────────────────────
db.setValuesModule(values);
values.init();
pf.init(db);

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

redis.init();

const PORT = process.env.PORT || 10000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Konfiguracja admina ──────────────────────────────────────
const adminConfig = db.loadAdmin();

// ── Express middleware ────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, '.')));
app.use(express.json());
app.use(cookieParser());

// ── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: Date.now(),
        connections: io.engine?.clientsCount || 0
    });
});

// ── Route dla /admin ─────────────────────────────────────────
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ── Constants & helpers (shared context) ─────────────────────
const MIN_BET = 1;
const MAX_SOLO_BET = process.env.NODE_ENV === 'test' ? 1000000 : 99999999999999;
const MAX_PVP_BET = process.env.NODE_ENV === 'test' ? 1000000 : 99999999999999999;
const CHAT_RATE_MAX = 3;
const CHAT_RATE_WINDOW = 2000;
const TIP_RATE_MAX = 1;
const TIP_RATE_WINDOW = 3000;
const MAX_LOGIN_ATTEMPTS = process.env.NODE_ENV === 'test' ? 100 : 25;
const LOGIN_WINDOW_MS = 10000;
const MAX_LOGIN_PER_USER = process.env.NODE_ENV === 'test' ? 100 : 15;
const LOGIN_USER_WINDOW_MS = 10000;
const ADMIN_LOGIN_MAX = 5;
const ADMIN_LOGIN_WINDOW_MS = 60000;
const DISCONNECT_GRACE_MS = 30000;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CHAT_HISTORY = 200;
const BOT_SECRET = process.env.BOT_SECRET || '92d79e9b8988a59c4d9a135f8c2d9e7b80e141fb26576a86a857a810fa6a71ce';

// ── In-memory state ──────────────────────────────────────────
const chatHistory = db.loadChat();
const disconnectTimeouts = new Map();
const socketRateLimits = new Map();
const socketActivityTimers = new Map();

// ── Helper functions ─────────────────────────────────────────
function checkRateLimit(key, maxAttempts, windowMs) {
    const now = Date.now();
    let entry = socketRateLimits.get(key);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        socketRateLimits.set(key, entry);
    }
    entry.count++;
    return entry.count <= maxAttempts;
}

function cleanRateLimits() {
    const now = Date.now();
    for (const [key, entry] of socketRateLimits) {
        if (now > entry.resetAt) socketRateLimits.delete(key);
    }
}
let cleanIntervalId;
if (require.main === module) {
    cleanIntervalId = setInterval(cleanRateLimits, 300000);
}

function validateUsername(name) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 20) return false;
    if (!/^[a-zA-Z0-9_\-\\u0100-\\u024F]+$/.test(trimmed)) return false;
    return true;
}

function validateClientSeed(seed) {
    if (!seed || typeof seed !== 'string') return false;
    if (seed.length < 4 || seed.length > 64) return false;
    return /^[a-zA-Z0-9_-]+$/.test(seed);
}

function resetInactivityTimer(socket) {
    const existing = socketActivityTimers.get(socket.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        if (socket.connected) {
            socket.emit('sessionExpired', { message: 'Session expired due to inactivity.' });
            socket.disconnect(true);
        }
        socketActivityTimers.delete(socket.id);
    }, INACTIVITY_TIMEOUT_MS);
    socketActivityTimers.set(socket.id, timer);
}

function normalizeChatMsg(oldMsg) {
    if (oldMsg.userId) return oldMsg;
    const username = oldMsg.user || oldMsg.username || 'System';
    const player = (username !== 'System') ? db.getPlayer(username) : null;
    return {
        userId: oldMsg.userId || (username === 'System' ? 'system' : username),
        username: username,
        avatarUrl: player ? player.avatarUrl || '' : '',
        role: player && player.roles && player.roles.length > 0 ? player.roles[0] : '',
        message: oldMsg.msg || oldMsg.message || '',
        timestamp: oldMsg.time || oldMsg.timestamp || Date.now()
    };
}

// ── Shared context ───────────────────────────────────────────
const context = {
    db, pf, games, redis, values,
    adminConfig,
    chatHistory,
    disconnectTimeouts,
    socketRateLimits,
    socketActivityTimers,
    DATA_DIR,
    BOT_SECRET,
    // Constants
    MIN_BET, MAX_SOLO_BET, MAX_PVP_BET,
    CHAT_RATE_MAX, CHAT_RATE_WINDOW,
    TIP_RATE_MAX, TIP_RATE_WINDOW,
    MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_MS,
    MAX_LOGIN_PER_USER, LOGIN_USER_WINDOW_MS,
    ADMIN_LOGIN_MAX, ADMIN_LOGIN_WINDOW_MS,
    DISCONNECT_GRACE_MS, INACTIVITY_TIMEOUT_MS,
    MAX_CHAT_HISTORY,
    // Helpers
    validateUsername, validateClientSeed,
    checkRateLimit, resetInactivityTimer, normalizeChatMsg
};

// ── Inicjalizacja modułów API ─────────────────────────────────
const setupBotApi = require('./modules/api-bot');
const setupAuthApi = require('./modules/api-auth');
const setupPlayerApi = require('./modules/api-player');
const setupAdminApi = require('./modules/api-admin');
const jackpot = require('./modules/jackpot');
const setupSocketHandlers = require('./modules/socket');

context.jackpot = jackpot;

setupBotApi(app, context);
setupAuthApi(app, context);
setupPlayerApi(app, io, context);
setupAdminApi(app, io, context);
jackpot.setupJackpotApi(app, context);
setupSocketHandlers(io, context);

// ── Provably Fair Routes ──────────────────────────────────────
pf.setupRoutes(app);

// ── Values API ────────────────────────────────────────────────
app.get('/api/values', (req, res) => {
    const category = req.query.category || 'all';
    const items = values.getItems(category);
    res.json({ items, stats: values.getStats() });
});

app.get('/api/values/search', (req, res) => {
    const q = req.query.q || '';
    const category = req.query.category || 'all';
    const limit = parseInt(req.query.limit) || 20;
    const results = values.searchItems(q, category, limit);
    res.json({ results });
});

app.get('/api/values/:name', (req, res) => {
    const name = req.params.name;
    const value = values.getValue(name);
    const all = values.getItems();
    const item = all.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (item) {
        res.json({ name: item.name, value: item.value, rap: item.rap, category: item.category, trend: item.trend });
    } else {
        res.json({ name, value, rap: 0, category: 'unknown', trend: 'neutral' });
    }
});

app.post('/api/values/refresh', async (req, res) => {
    const sessionToken = req.cookies?.bf_admin;
    if (!sessionToken) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const sessionUser = await redis.getSession('admin:' + sessionToken);
    if (sessionUser !== '__admin__') return res.status(401).json({ success: false, message: 'Unauthorized' });
    const stats = await values.forceRefresh();
    res.json({ success: true, stats });
});

app.get('/api/values/stats', (req, res) => {
    const stats = values.getStats();
    res.json(stats);
});

// ── Sentry error handler ─────────────────────────────────────
if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
}

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
    if (!process.env.SENTRY_DSN) {
        console.error('UNHANDLED ERROR:', err);
    }
    res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ─────────────────────────────────────────────
if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);

        // Periodic cleanup: stale games
        setInterval(() => games.clearStaleGames(db), 300000);

        // Start bot
        if (process.env.ENABLE_BOT === 'true') {
            console.log('[SERVER] ENABLE_BOT=true — uruchamiam bota...');
            startBot();
        } else {
            console.log('[SERVER] Bot pominięty (ENABLE_BOT!=true lub nieustawione)');
        }

        // Admin token warning
        if (!process.env.ADMIN_TOKEN && !adminConfig.token) {
            console.warn('⚠️  ADMIN_TOKEN nie skonfigurowany! Panel admina nie będzie dostępny.');
            console.warn('    Ustaw ADMIN_TOKEN w pliku .env, np.: ADMIN_TOKEN=twoj-sekretny-token');
        }

        // Start Jackpot
        const firstJp = games.startJackpotRound();
        console.log('[Jackpot] First round started:', firstJp.id);
        jackpot.startJackpotTimer(io, context);
        setTimeout(() => jackpot.broadcastJackpotStatus(io, firstJp), 500);
    });
}

// ── Graceful shutdown ────────────────────────────────────────
function shutdown() {
    console.log('Shutting down gracefully...');
    jackpot.stopJackpotTimer();
    clearInterval(cleanIntervalId);
    for (const [, entry] of disconnectTimeouts) {
        clearTimeout(entry.timeout);
    }
    disconnectTimeouts.clear();
    for (const [, timer] of socketActivityTimers) {
        clearTimeout(timer);
    }
    socketActivityTimers.clear();
    try { server.close(); } catch (e) { /* ignore */ }
}

if (require.main === module) {
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

module.exports = { app, server, db, pf, games };
