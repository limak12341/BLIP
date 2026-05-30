try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

const express = require('express');
const { startBot } = require('./bot.js');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

// ── Rate limiting ────────────────────────────────────────────
const loginAttempts = new Map(); // ip -> { count, resetAt }
const MAX_LOGIN_ATTEMPTS = process.env.NODE_ENV === 'test' ? 100 : 5;
const LOGIN_WINDOW_MS = 10000;

// ── General socket rate limiter ───────────────────────────────
const socketRateLimits = new Map(); // key -> { count, resetAt }
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
const cleanIntervalId = setInterval(cleanRateLimits, 300000);

// ── Bet & action limits ───────────────────────────────────────
const MIN_BET = 1;
const MAX_SOLO_BET = process.env.NODE_ENV === 'test' ? 1000000 : 5000;
const MAX_PVP_BET = process.env.NODE_ENV === 'test' ? 1000000 : 50000;
const CHAT_RATE_MAX = 3;      // max wiadomości na okno
const CHAT_RATE_WINDOW = 2000; // 2 sekundy
const TIP_RATE_MAX = 1;
const TIP_RATE_WINDOW = 3000;  // 3 sekundy


// ── Disconnect handling (PVP games) ────────────────────────────
const disconnectTimeouts = new Map(); // username -> { gameId, opponentSocket, opponent, amount, timeout }
const DISCONNECT_GRACE_MS = 30000; // 30 seconds grace period for reconnection

// ── Inactivity timeout ──────────────────────────────────────
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const socketActivityTimers = new Map();

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

function validateUsername(name) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 20) return false;
    if (!/^[a-zA-Z0-9_\-\u0100-\u024F]+$/.test(trimmed)) return false;
    return true;
}

function validateClientSeed(seed) {
    if (!seed || typeof seed !== 'string') return false;
    if (seed.length < 4 || seed.length > 64) return false;
    return /^[a-zA-Z0-9_-]+$/.test(seed);
}

const db = require('./modules/db');
const pf = require('./modules/provablyFair');
const games = require('./modules/games');

// Inicjalizacja Provably Fair z bazą danych
pf.init(db);

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 10000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Express middleware (MUSI być przed pf.setupRoutes) ────────
app.use(express.static(path.join(__dirname, '.')));
app.use(express.json());
app.use(cookieParser());

// ── Route dla /admin ──────────────────────────────────────────
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ── Admin REST API ────────────────────────────────────────────
const adminConfig = db.loadAdmin();

app.post('/admin/login', (req, res) => {
    const { token } = req.body || {};
    const adminToken = adminConfig.token || process.env.ADMIN_TOKEN || 'test-admin-token-123';
    if (token === adminToken) {
        const sessionToken = crypto.randomBytes(16).toString('hex');
        sessions.set(sessionToken, '__admin__');
        res.cookie('bf_admin', sessionToken, {
            maxAge: 24 * 60 * 60 * 1000,
            httpOnly: true,
            sameSite: 'lax'
        });
        return res.json({ success: true });
    }
    return res.status(401).json({ success: false, message: 'Nieprawidłowy token.' });
});

app.post('/admin/logout', (req, res) => {
    const token = req.cookies?.bf_admin;
    if (token) sessions.delete(token);
    res.clearCookie('bf_admin');
    return res.json({ success: true });
});

// ── Admin auth middleware ───────────────────────────────────────
function requireAdmin(req, res, next) {
    const sessionToken = req.cookies?.bf_admin;
    if (!sessionToken || !sessions.has(sessionToken) || sessions.get(sessionToken) !== '__admin__') {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    next();
}

// ── Admin REST API: Promo Codes ─────────────────────────────────
app.get('/api/admin/promo-codes', requireAdmin, (req, res) => {
    const promos = db.loadPromo();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const codes = Object.entries(promos).map(([code, data]) => ({
        _id: code,
        code: data.code,
        rewards: data.rewards || [{ type: data.rewardType || 'coins', amount: data.rewardValue || 0 }],
        active: data.active !== false,
        usedCount: data.used || 0,
        maxUses: data.maxUses || 0,
        createdBy: data.createdBy || 'admin',
        createdAt: data.createdAt || Date.now()
    }));
    const total = codes.length;
    const pages = Math.ceil(total / limit) || 1;
    const paginated = codes.slice((page - 1) * limit, page * limit);
    res.json({ codes: paginated, total, pages, page });
});

app.post('/api/admin/promo-codes', requireAdmin, (req, res) => {
    const { code, rewards, maxUses } = req.body || {};
    if (!code) return res.status(400).json({ success: false, message: 'Podaj nazwę kodu!' });
    
    const promos = db.loadPromo();
    if (promos[code]) return res.status(400).json({ success: false, message: 'Kod już istnieje!' });
    
    promos[code] = {
        code,
        rewards: rewards || [{ type: 'coins', amount: 100 }],
        maxUses: parseInt(maxUses) || 0,
        active: true,
        used: 0,
        usedBy: [],
        createdBy: 'admin',
        createdAt: Date.now()
    };
    db.savePromo(promos);
    res.json({ success: true });
});

app.post('/api/admin/promo-codes/:id/toggle', requireAdmin, (req, res) => {
    const promos = db.loadPromo();
    const code = req.params.id;
    if (!promos[code]) return res.status(404).json({ success: false, message: 'Kod nie znaleziony' });
    promos[code].active = promos[code].active === false ? true : false;
    db.savePromo(promos);
    res.json({ success: true, active: promos[code].active });
});

app.post('/api/admin/promo-codes/:id/delete', requireAdmin, (req, res) => {
    const promos = db.loadPromo();
    const code = req.params.id;
    if (!promos[code]) return res.status(404).json({ success: false, message: 'Kod nie znaleziony' });
    delete promos[code];
    db.savePromo(promos);
    res.json({ success: true });
});

// ── Admin Dashboard API ──────────────────────────────────────
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
    const players = db.getAllPlayers();
    const playerArray = Object.values(players);
    const totalPlayers = playerArray.length;
    const onlinePlayers = io.engine?.clientsCount || 0;

    let totalGames = 0;
    playerArray.forEach(p => { totalGames += p.gamesPlayed || 0; });

    let logs = [];
    try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }
    const totalLogs = logs.length;

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const gamesByDay = {};
    const registrationsByDay = {};
    for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const key = d.toISOString().split('T')[0];
        gamesByDay[key] = 0;
        registrationsByDay[key] = 0;
    }

    playerArray.forEach(p => {
        const regDate = new Date(p.registered).toISOString().split('T')[0];
        if (registrationsByDay[regDate] !== undefined) registrationsByDay[regDate]++;
        if (p.gameHistory) {
            p.gameHistory.forEach(game => {
                const gameDate = new Date(game.timestamp).toISOString().split('T')[0];
                if (gamesByDay[gameDate] !== undefined) gamesByDay[gameDate]++;
            });
        }
    });

    const gamesByHour = {};
    for (let i = 0; i < 24; i++) gamesByHour[i] = 0;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    playerArray.forEach(p => {
        if (p.gameHistory) {
            p.gameHistory.forEach(game => {
                if (game.timestamp >= dayAgo) {
                    const hour = new Date(game.timestamp).getHours();
                    gamesByHour[hour]++;
                }
            });
        }
    });

    const logsByType = {};
    logs.slice(-500).forEach(log => {
        const type = log.type || 'other';
        if (!logsByType[type]) logsByType[type] = 0;
        logsByType[type]++;
    });

    res.json({
        totalGames,
        onlinePlayers,
        totalPlayers,
        totalLogs,
        gamesByDay: Object.entries(gamesByDay).map(([date, count]) => ({ date, count })),
        registrationsByDay: Object.entries(registrationsByDay).map(([date, count]) => ({ date, count })),
        gamesByHour: Object.entries(gamesByHour).map(([hour, count]) => ({ hour: parseInt(hour), count })),
        logsByType: Object.entries(logsByType).map(([type, count]) => ({ type, count }))
    });
});

// ── Admin Players API ─────────────────────────────────────────
app.get('/api/admin/players', requireAdmin, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = (req.query.q || '').toLowerCase();

    const all = db.getAllPlayers();
    let list = Object.entries(all).map(([id, p]) => ({
        _id: id,
        username: p.username || id,
        coins: p.coins || 0,
        gemsCount: p.gems || 0,
        balance: p.coins || 0,
        role: (p.roles && p.roles.length > 0) ? p.roles[0] : '',
        banned: !!db.isBanned(id),
        avatarUrl: p.avatarUrl || '',
        gamesPlayed: p.gamesPlayed || 0,
        registered: p.registered || 0
    }));

    if (search) {
        list = list.filter(p => p.username.toLowerCase().includes(search) || p._id.toLowerCase().includes(search));
    }

    const total = list.length;
    const pages = Math.ceil(total / limit) || 1;
    const paginated = list.slice((page - 1) * limit, page * limit);

    res.json({ players: paginated, total, pages, page });
});

// ── Admin Logs API ───────────────────────────────────────────
app.get('/api/admin/logs', requireAdmin, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const typeFilter = req.query.type || '';

    let logs = [];
    try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }

    if (typeFilter) logs = logs.filter(l => l.type === typeFilter);
    logs.reverse();

    const total = logs.length;
    const pages = Math.ceil(total / limit) || 1;
    const paginated = logs.slice((page - 1) * limit, page * limit);

    res.json({ logs: paginated, total, pages, page });
});

// ── Admin Requests API ────────────────────────────────────────
app.get('/api/admin/requests', requireAdmin, (req, res) => {
    const statusFilter = req.query.status || '';
    const typeFilter = req.query.type || '';

    let requests = [];
    try { requests = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'requests.json'), 'utf8')); } catch (e) { requests = []; }

    if (statusFilter) requests = requests.filter(r => r.status === statusFilter);
    if (typeFilter) requests = requests.filter(r => r.type === typeFilter);
    requests.reverse();

    res.json({ requests });
});

// ── Admin Player Actions API ──────────────────────────────────
app.post('/api/admin/players/:id/warn', requireAdmin, (req, res) => {
    const { reason } = req.body || {};
    if (!reason) return res.status(400).json({ success: false, message: 'Podaj powód' });
    const warnings = db.loadWarnings();
    const username = req.params.id;
    if (!warnings[username]) warnings[username] = [];
    warnings[username].push({ reason, by: 'admin', time: Date.now() });
    db.saveWarnings(warnings);
    res.json({ success: true });
});

app.post('/api/admin/players/:id/role', requireAdmin, (req, res) => {
    const { role } = req.body || {};
    const username = req.params.id;
    const player = db.getPlayer(username);
    if (!player.roles) player.roles = [];
    if (role) {
        if (!player.roles.includes(role)) player.roles.push(role);
    } else {
        player.roles = [];
    }
    db.savePlayer(username, player);
    res.json({ success: true });
});

app.post('/api/admin/players/:id/ban', requireAdmin, (req, res) => {
    const username = req.params.id;
    const bans = db.loadBans();
    bans[username] = { reason: 'Banned by admin', by: 'admin', time: Date.now(), expires: null };
    db.saveBans(bans);
    res.json({ success: true });
});

app.post('/api/admin/players/:id/unban', requireAdmin, (req, res) => {
    const username = req.params.id;
    const bans = db.loadBans();
    delete bans[username];
    db.saveBans(bans);
    res.json({ success: true });
});

app.post('/api/admin/players/:id/balance', requireAdmin, (req, res) => {
    const { amount } = req.body || {};
    const username = req.params.id;
    const player = db.getPlayer(username);
    player.coins = parseInt(amount) || 0;
    db.savePlayer(username, player);
    res.json({ success: true });
});

app.post('/api/admin/players/:id/gems', requireAdmin, (req, res) => {
    const { item } = req.body || {};
    if (!item) return res.status(400).json({ success: false, message: 'Brak przedmiotu' });
    const username = req.params.id;
    const player = db.getPlayer(username);
    const qty = parseInt(item.qty) || 1;
    player.gems = (player.gems || 0) + qty;
    db.savePlayer(username, player);
    res.json({ success: true });
});

// ── Admin System Message API ──────────────────────────────────
app.post('/api/admin/system-message', requireAdmin, (req, res) => {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ success: false, message: 'Brak treści wiadomości' });
    io.emit('systemMessage', message);
    // Zapisz do logów
    let logs = [];
    try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }
    logs.push({ type: 'system-message', description: `Wysłano: "${message}"`, adminUsername: 'admin', timestamp: Date.now() });
    fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), JSON.stringify(logs));
    res.json({ success: true });
});


// ── Admin REST API: Chat Filter ─────────────────────────────────
app.get('/api/admin/chat-filter', requireAdmin, (req, res) => {
    const filter = db.loadFilter();
    res.json(filter);
});

app.post('/api/admin/chat-filter/save', requireAdmin, (req, res) => {
    const { words, enabled, punishment } = req.body || {};
    const filter = db.loadFilter();
    if (Array.isArray(words)) filter.words = words;
    if (typeof enabled === 'boolean') filter.enabled = enabled;
    if (punishment) filter.punishment = punishment;
    db.saveFilter(filter);
    res.json({ success: true });
});

// ── Provably Fair Routes ──────────────────────────────────────
pf.setupRoutes(app);

// Provably Fair seed history API (dla admina)
app.get('/api/provably-fair/seed-history', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    let all = [];
    if (db && db.getAllSeedRecords) {
        all = db.getAllSeedRecords();
    }
    const total = all.length;
    const pages = Math.ceil(total / limit) || 1;
    const slice = all.slice((page - 1) * limit, page * limit).reverse();
    const safe = slice.map(s => ({
        hash: s.hash || (require('crypto').createHash('sha256').update(String(s.seed || '')).digest().toString('hex')),
        revealed: s.revealed || false,
        createdAt: s.createdAt,
        revealedAt: s.revealedAt || null,
        gamesPlayed: s.gamesPlayed || 0
    }));
    res.json({ seeds: safe, page, pages, total });
});

// ── Weryfikacja Bio (kody logowania) ──────────────────────────
const verifyCodes = new Map(); // username -> { code, createdAt }
const sessions = new Map(); // token -> username

// POST /verify-start — generuje kod weryfikacyjny
app.post('/verify-start', (req, res) => {
    const username = (req.body.username || '').trim();
    if (!username || username.length < 2 || username.length > 20) {
        return res.json({ message: 'Nieprawidłowy nick (2-20 znaków).' });
    }
    // Generuj losowy 6-znakowy kod
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    verifyCodes.set(username, { code, createdAt: Date.now() });
    // Czyść stare kody (> 5 min)
    for (const [u, v] of verifyCodes) {
        if (Date.now() - v.createdAt > 300000) verifyCodes.delete(u);
    }
    console.log(`[Verify] Code ${code} generated for ${username}`);
    res.json({ code });
});

// POST /verify-check — weryfikuje i loguje użytkownika
app.post('/verify-check', (req, res) => {
    const username = (req.body.username || '').trim();
    if (!username) {
        return res.json({ success: false, message: 'Brak nicku.' });
    }
    const record = verifyCodes.get(username);
    if (!record) {
        return res.json({ success: false, message: 'Najpierw wygeneruj kod (krok 1).' });
    }
    if (Date.now() - record.createdAt > 300000) {
        verifyCodes.delete(username);
        return res.json({ success: false, message: 'Kod wygasł. Wygeneruj nowy.' });
    }
    
    // Stwórz sesję
    const ban = db.isBanned(username);
    if (ban) {
        return res.json({ success: false, message: 'Jesteś zbanowany: ' + ban.reason });
    }
    
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(token, username);
    
    // Zapisz gracza jeśli nie istnieje
    const player = db.getPlayer(username);
    
    // Usuń kod
    verifyCodes.delete(username);
    
    console.log(`[Verify] ${username} logged in via bio verification`);
    
    // Ustaw ciasteczko sesji
    res.cookie('bf_session', token, {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dni
        httpOnly: true,
        sameSite: 'lax'
    });
    
    res.json({ success: true, username });
});

// Weryfikacja sesji
app.get('/api/session', (req, res) => {
    const token = req.cookies?.bf_session;
    if (!token || !sessions.has(token)) {
        return res.json({ authenticated: false });
    }
    const username = sessions.get(token);
    const player = db.getPlayer(username);
    res.json({
        authenticated: true,
        username,
        coins: player.coins
    });
});

// ── Bot API (dla bot.js) ───────────────────────────────────────────
const BOT_SECRET = process.env.BOT_SECRET || '92d79e9b8988a59c4d9a135f8c2d9e7b80e141fb26576a86a857a810fa6a71ce';

function requireBot(req, res, next) {
    const secret = req.headers['x-bot-secret'];
    if (!secret || secret !== BOT_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
}

// GET /api/bot/pending-deposits — zwraca oczekujące requesty depozytu
app.get('/api/bot/pending-deposits', requireBot, (req, res) => {
    let requests = [];
    try {
        requests = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'requests.json'), 'utf8'));
    } catch (e) {
        requests = [];
    }
    // Zwróć tylko pending (nieprzetworzone przez admina)
    const pending = requests.filter(r => r.status === 'pending' || !r.status);
    res.json({ requests: pending });
});

// POST /api/bot/update-deposit — aktualizuje status requestu
app.post('/api/bot/update-deposit', requireBot, (req, res) => {
    const { requestId, status, totalValue, adminNote } = req.body || {};
    if (!requestId || !status) {
        return res.status(400).json({ error: 'Missing requestId or status' });
    }
    let requests = [];
    try {
        requests = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'requests.json'), 'utf8'));
    } catch (e) {
        requests = [];
    }
    const idx = requests.findIndex(r => r._id === requestId || r.id === requestId);
    if (idx === -1) {
        return res.status(404).json({ error: 'Request not found' });
    }
    requests[idx].status = status;
    if (totalValue !== undefined) requests[idx].totalValue = totalValue;
    if (adminNote) requests[idx].adminNote = adminNote;
    requests[idx].updatedAt = Date.now();
    fs.writeFileSync(path.join(DATA_DIR, 'requests.json'), JSON.stringify(requests, null, 2));
    
    // Zapisz do logów
    let logs = [];
    try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }
    logs.push({
        type: 'bot-deposit',
        description: `Bot: ${status} deposit ${requestId}${totalValue ? ', value: ' + totalValue : ''}`,
        timestamp: Date.now()
    });
    fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), JSON.stringify(logs));
    
    res.json({ success: true, status });
});

// ── Socket.IO ──────────────────────────────────────────────────
const chatHistory = db.loadChat();
const MAX_CHAT_HISTORY = 200;

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    let loggedInUser = null;

    socket.emit('chatHistory', chatHistory.slice(-100));

    socket.on('login', (data) => {
        // Rate limiting
        const ip = socket.handshake?.address || 'unknown';
        const now = Date.now();
        let attempt = loginAttempts.get(ip);
        if (!attempt || now > attempt.resetAt) {
            attempt = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
            loginAttempts.set(ip, attempt);
        }
        attempt.count++;
        if (attempt.count > MAX_LOGIN_ATTEMPTS) {
            const retryAfter = Math.ceil((attempt.resetAt - now) / 1000);
            socket.emit('loginError', { message: `Too many attempts. Try again in ${retryAfter}s.` });
            return;
        }

        const username = (data.username || '').trim();
        
        // Validate username
        if (!validateUsername(username)) {
            socket.emit('loginError', { message: 'Invalid username (2-20 chars, letters/numbers/underscores/hyphens only).' });
            return;
        }

        const ban = db.isBanned(username);
        if (ban) {
            socket.emit('banned', { reason: ban.reason || 'Banned', expires: ban.expires });
            return;
        }
        
        loggedInUser = username;
        
        // Start inactivity timer
        resetInactivityTimer(socket);
        
        const player = db.getPlayer(username);
        socket.emit('loginSuccess', { username, coins: player.coins, gems: player.gems, pet: player.pet, clientSeed: player.clientSeed, nonce: player.nonce, serverSeedHash: pf.getServerSeedHash() });
        // ── Check for pending disconnect timeouts ──
        const pendingDisconnect = disconnectTimeouts.get(username);
        if (pendingDisconnect) {
            clearTimeout(pendingDisconnect.timeout);
            disconnectTimeouts.delete(username);
            // Notify opponent that player reconnected
            if (pendingDisconnect.opponentSocket) {
                const opponentSocket = io.sockets.sockets.get(pendingDisconnect.opponentSocket);
                if (opponentSocket && opponentSocket.connected) {
                    opponentSocket.emit('chatMessage', {
                        user: 'System',
                        msg: `${username} reconnected! The game continues.`,
                        time: Date.now()
                    });
                }
            }
        }
        socket.broadcast.emit('systemMessage', `${username} joined the game!`);
        io.emit('playerListUpdate');
    });

    socket.on('updateUsername', (data) => {
        // Rate limit username changes
        if (!checkRateLimit(`updateName:${loggedInUser}`, 1, 10000)) return;
        const players = db.getAllPlayers();
        const oldName = loggedInUser;
        const newName = data.username;
        if (players[newName]) {
            socket.emit('chatMessage', { user: 'System', msg: 'Username already taken!', time: Date.now() });
            return;
        }
        if (players[oldName]) {
            players[newName] = { ...players[oldName], username: newName };
            delete players[oldName];
            db.saveData(players);
        }
        loggedInUser = newName;
        socket.emit('loginSuccess', { username: newName, coins: players[newName].coins, gems: players[newName].gems, pet: players[newName].pet, clientSeed: players[newName].clientSeed, nonce: players[newName].nonce, serverSeedHash: pf.getServerSeedHash() });
        io.emit('playerListUpdate');
        io.emit('systemMessage', `${oldName} changed name to ${newName}`);
    });

    socket.on('tip', (data) => {
        if (!loggedInUser) return;
        // Rate limiting - max 1 tip per 3 seconds
        if (!checkRateLimit(`tip:${loggedInUser}`, TIP_RATE_MAX, TIP_RATE_WINDOW)) return;
        const sender = db.getPlayer(loggedInUser);
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount <= 0) return;
        if (sender.coins < amount) {
            socket.emit('chatMessage', { user: 'System', msg: 'Not enough coins!', time: Date.now() });
            return;
        }
        const receiver = db.getPlayer(data.target);
        sender.coins -= amount;
        receiver.coins += amount;
        db.savePlayer(loggedInUser, sender);
        db.savePlayer(data.target, receiver);
        io.emit('systemMessage', `${loggedInUser} tipped ${amount} coins to ${data.target}! 💰`);
        io.emit('playerListUpdate');
    });

    // Reset inactivity timer on any activity
    socket.onAny(() => {
        if (loggedInUser) resetInactivityTimer(socket);
    });

    socket.on('chatMessage', (data) => {
        if (!loggedInUser) return;
        // Rate limiting - max 3 messages per 2 seconds
        if (!checkRateLimit(`chat:${loggedInUser}`, CHAT_RATE_MAX, CHAT_RATE_WINDOW)) return;
                const rawMsg = (data.msg || '').substring(0, 500);
        // Chat filter - bad words
        const filterData = db.loadFilter();
        if (filterData.enabled !== false && filterData.words && filterData.words.length > 0) {
            const lowerMsg = rawMsg.toLowerCase();
            let found = false;
            for (let fi = 0; fi < filterData.words.length; fi++) {
                const fword = filterData.words[fi];
                if (fword && lowerMsg.indexOf(fword.toLowerCase()) !== -1) { found = true; break; }
            }
            if (found) {
                if (filterData.punishment === 'block' || filterData.punishment === 'warn') {
                    socket.emit('chatMessage', { user: 'System', msg: '⚠️ Your message contains prohibited words!', time: Date.now() });
                    return;
                } else if (filterData.punishment === 'censor') {
                    let censored = rawMsg;
                    for (let ci = 0; ci < filterData.words.length; ci++) {
                        const cword = filterData.words[ci];
                        if (cword) {
                            const re = new RegExp(cword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                            censored = censored.replace(re, '***');
                        }
                    }
                    const msgCensored = db.escapeHtml(censored);
                    const chatMsgCensored = { user: loggedInUser, msg: msgCensored, time: Date.now() };
                    chatHistory.push(chatMsgCensored);
                    if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
                    db.saveChat(chatHistory);
                    io.emit('chatMessage', chatMsgCensored);
                    return;
                }
            }
        }
        const msg = db.escapeHtml(rawMsg);
        const chatMsg = { user: loggedInUser, msg, time: Date.now() };
        chatHistory.push(chatMsg);
        if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
        db.saveChat(chatHistory);
        io.emit('chatMessage', chatMsg);
    });

    socket.on('systemMessage', (data) => {
        if (!loggedInUser) return;
        io.emit('systemMessage', db.escapeHtml((data.msg || '').substring(0, 500)));
    });

    socket.on('whisper', (data) => {
        if (!loggedInUser) return;
        // Rate limit whispers
        if (!checkRateLimit(`whisper:${loggedInUser}`, 3, 2000)) return;
        io.emit('whisper', { from: loggedInUser, to: data.target, msg: db.escapeHtml((data.msg || '').substring(0, 500)) });
    });

    socket.on('coinflip', (data) => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        let amount = parseInt(data.amount);
        if (isNaN(amount) || amount <= 0) return;
        
        // Min/max bet check
        if (amount < MIN_BET) {
            socket.emit('coinflipResult', { win: false, error: `Minimum bet is ${MIN_BET}!` });
            return;
        }
        const isPVP = data.findGame === true;
        const maxBet = isPVP ? MAX_PVP_BET : MAX_SOLO_BET;
        if (amount > maxBet) {
            socket.emit('coinflipResult', { win: false, error: `Max ${isPVP ? 'PVP' : 'solo'} bet is ${maxBet}!` });
            return;
        }

        // Support gem wagering
        if (data.item && games.WAGER_ITEMS[data.item]) {
            const gemItem = games.WAGER_ITEMS[data.item];
            if (player.gems < 1) { socket.emit('coinflipResult', { win: false, error: 'No gems!' }); return; }
            player.gems -= 1;
            amount = gemItem.value;
        }

        if (player.coins < amount) {
            socket.emit('coinflipResult', { win: false, error: 'Not enough coins!' });
            return;
        }

        // Check cooldown
        const cooldowns = db.loadCooldowns();
        const now = Date.now();
        if (cooldowns[loggedInUser] && now - cooldowns[loggedInUser] < 500) {
            socket.emit('coinflipResult', { win: false, error: 'Wait a moment!' });
            return;
        }
        cooldowns[loggedInUser] = now;
        db.saveCooldowns(cooldowns);

        const choice = data.choice || 'heads';
        const isWild = data.wild === true;

        // If looking for a game (PVP)
        if (data.findGame) {
            const existingId = Object.keys(games.activeGames).find(id => {
                const g = games.activeGames[id];
                return g.status === 'waiting' && g.creator !== loggedInUser;
            });
            if (existingId) {
                const game = games.activeGames[existingId];
                if (game.amount !== amount) {
                    socket.emit('coinflipResult', { win: false, error: 'Amount mismatch!' });
                    return;
                }
                // Mark game as active for disconnect handling
                game.status = 'active';
                // Join existing game - use Provably Fair
                const serverSeed = pf.getCurrentServerSeed();
                const clientSeed = player.clientSeed;
                const nonce = player.nonce;
                const fairResult = pf.computeFairResult(serverSeed, clientSeed, nonce);
                const win = fairResult < 500000 ? (choice === 'heads') : (choice === 'tails');

                // Rotate seeds after each game
                player.nonce++;
                db.savePlayer(loggedInUser, player);
                const gamePlayer = db.getPlayer(game.creator);

                // Przygotuj dane Provably Fair
                const pfData = { serverSeed, clientSeed, nonce: player.nonce - 1, result: fairResult, win, gameId: existingId };

                if (win) {
                    const winnings = Math.floor(amount * 2);
                    player.coins += winnings;
                    db.savePlayer(loggedInUser, player);
                    io.to(game.creatorSocket).emit('coinflipResult', { win: false, amount, result: !win ? 'tails' : 'heads', opponent: loggedInUser, gameOver: true });
                    io.to(game.creatorSocket).emit('provablyFairResult', { ...pfData, opponent: true });
                    socket.emit('coinflipResult', { win: true, amount: winnings, result: win ? (choice === 'heads' ? 'heads' : 'tails') : (choice === 'heads' ? 'tails' : 'heads'), opponent: game.creator, gameOver: true });
                    socket.emit('provablyFairResult', { ...pfData, opponent: false });
                } else {
                    const winnings = Math.floor(amount * 2);
                    gamePlayer.coins += winnings;
                    db.savePlayer(game.creator, gamePlayer);
                    io.to(game.creatorSocket).emit('coinflipResult', { win: true, amount: winnings, result: !win ? 'tails' : 'heads', opponent: loggedInUser, gameOver: true });
                    io.to(game.creatorSocket).emit('provablyFairResult', { ...pfData, opponent: true });
                    socket.emit('coinflipResult', { win: false, amount, result: win ? (choice === 'heads' ? 'heads' : 'tails') : (choice === 'heads' ? 'tails' : 'heads'), opponent: game.creator, gameOver: true });
                    socket.emit('provablyFairResult', { ...pfData, opponent: false });
                }

                // ── Live Feed: add recent game ──
                const winner = win ? loggedInUser : game.creator;
                const loser = win ? game.creator : loggedInUser;
                games.addRecentGame({
                    type: 'coinflip',
                    winner,
                    loser,
                    amount
                });
                io.emit('recentGamesUpdated', games.getRecentGames());

                pf.rotateServerSeed();
                delete games.activeGames[existingId];
                io.emit('gameListUpdate', Object.values(games.activeGames));
                return;
            }

            // Create new game (rate limited: max 1 per 5s)
            if (!checkRateLimit(`createGame:${loggedInUser}`, 1, 5000)) {
                socket.emit('coinflipResult', { win: false, error: 'You can only create 1 game per 5 seconds!' });
                return;
            }
            player.coins -= amount;
            db.savePlayer(loggedInUser, player);
            const game = {
                id: socket.id + '-' + Date.now(),
                creator: loggedInUser,
                creatorSocket: socket.id,
                amount,
                status: 'waiting',
                choice: choice,
                isWild: isWild,
                timestamp: Date.now()
            };
            games.activeGames[game.id] = game;
            socket.emit('coinflipResult', { waiting: true, gameId: game.id, amount });
            io.emit('gameListUpdate', Object.values(games.activeGames));
            return;
        }

        // Solo coinflip - use Provably Fair 2.0
        player.coins -= amount;
        const serverSeed = pf.getCurrentServerSeed();
        const clientSeed = player.clientSeed;
        const nonce = player.nonce;
        const fairResult = pf.computeFairResult(serverSeed, clientSeed, nonce);
        const win = isWild ? Math.random() < 0.49 : (fairResult < 490000 ? choice === 'heads' : choice === 'tails');

        player.nonce++;

        // Przygotuj dane Provably Fair dla frontendu
        const pfData = { serverSeed, clientSeed, nonce: nonce, result: fairResult, win, gameId: socket.id + '-' + Date.now() };

        if (win) {
            const bonus = games.getPetBonus(loggedInUser, db);
            const winnings = Math.floor(amount * 2 * bonus);
            player.coins += winnings;
            player.totalWon += winnings;
            socket.emit('coinflipResult', { win: true, amount: winnings, result: isWild ? 'wild' : (choice === 'heads' ? 'heads' : 'tails') });
        } else {
            socket.emit('coinflipResult', { win: false, amount, result: isWild ? 'wild' : (choice === 'heads' ? 'tails' : 'heads') });
        }
        socket.emit('provablyFairResult', pfData);

        player.totalWagered += amount;
        player.gamesPlayed++;

        // ── Live Feed: add recent game for solo ──
        games.addRecentGame({
            type: 'coinflip',
            winner: win ? loggedInUser : 'House',
            loser: win ? 'House' : loggedInUser,
            amount
        });
        io.emit('recentGamesUpdated', games.getRecentGames());

        // Record fair result in history
        const gameRecord = {
            serverSeedHash: pf.getServerSeedHash(),
            clientSeed,
            nonce,
            result: fairResult,
            outcome: win ? 'win' : 'loss',
            amount,
            timestamp: Date.now()
        };
        if (!player.gameHistory) player.gameHistory = [];
        player.gameHistory.push(gameRecord);
        if (player.gameHistory.length > 50) player.gameHistory.shift();

        db.savePlayer(loggedInUser, player);
        pf.rotateServerSeed();
        io.emit('playerListUpdate');
    });

    socket.on('getPlayerInfo', (data) => {
        const player = db.getPlayer(data.username);
        socket.emit('playerInfo', {
            username: player.username,
            coins: player.coins,
            gems: player.gems,
            pet: player.pet,
            totalWagered: player.totalWagered || 0,
            totalWon: player.totalWon || 0,
            gamesPlayed: player.gamesPlayed || 0,
            clientSeed: player.clientSeed,
            nonce: player.nonce,
            registered: player.registered
        });
    });

    // Provably Fair - client seed management
    socket.on('getClientSeed', () => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        socket.emit('clientSeedInfo', { clientSeed: player.clientSeed, nonce: player.nonce, serverSeedHash: pf.getServerSeedHash() });
    });

    socket.on('setClientSeed', (data) => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        const newSeed = data.seed;
        if (newSeed && !validateClientSeed(newSeed)) {
            socket.emit('chatMessage', { user: 'System', msg: 'Invalid client seed (4-64 chars, letters/numbers/underscores/hyphens only).', time: Date.now() });
            return;
        }
        player.clientSeed = newSeed || db.generateClientSeed();
        player.nonce = 0;
        db.savePlayer(loggedInUser, player);
        socket.emit('clientSeedInfo', { clientSeed: player.clientSeed, nonce: 0, serverSeedHash: pf.getServerSeedHash() });
    });

    socket.on('rotateClientSeed', () => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        player.clientSeed = db.generateClientSeed();
        player.nonce = 0;
        db.savePlayer(loggedInUser, player);
        socket.emit('clientSeedInfo', { clientSeed: player.clientSeed, nonce: 0, serverSeedHash: pf.getServerSeedHash() });
    });

    // Admin - seed management
    socket.on('adminRotateServerSeed', () => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const hash = pf.rotateServerSeed();
        io.emit('serverSeedRotated', { serverSeedHash: hash });
        socket.emit('chatMessage', { user: 'System', msg: 'Server seed rotated!', time: Date.now() });
    });

    // Profile / Stats
    socket.on('getProfile', (data) => {
        const username = data.username || loggedInUser;
        if (!username) return;
        const player = db.getPlayer(username);
        socket.emit('profileInfo', {
            username: player.username,
            coins: player.coins,
            gems: player.gems,
            pet: player.pet,
            totalWagered: player.totalWagered || 0,
            totalWon: player.totalWon || 0,
            gamesPlayed: player.gamesPlayed || 0,
            registered: player.registered,
            clientSeed: player.clientSeed,
            nonce: player.nonce,
            gameHistory: player.gameHistory || []
        });
    });

    // Tip
    socket.on('tipPlayer', (data) => {
        if (!loggedInUser) return;
        // Rate limiting - max 1 tip per 3 seconds
        if (!checkRateLimit(`tipPlayer:${loggedInUser}`, TIP_RATE_MAX, TIP_RATE_WINDOW)) return;
        const sender = db.getPlayer(loggedInUser);
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount <= 0 || sender.coins < amount) return;
        const receiver = db.getPlayer(data.target);
        sender.coins -= amount;
        receiver.coins += amount;
        db.savePlayer(loggedInUser, sender);
        db.savePlayer(data.target, receiver);
        io.emit('systemMessage', `${loggedInUser} tipped ${amount} coins to ${data.target}! 💰`);
        io.emit('playerListUpdate');
        socket.emit('chatMessage', { user: 'System', msg: `You tipped ${amount} coins to ${data.target}!`, time: Date.now() });
    });

    // Admin actions
    const adminActions = ['adminGiveCoins', 'adminGiveGems', 'adminSetCoins', 'adminResetPlayer', 'adminDeletePlayer'];
    adminActions.forEach(action => {
        socket.on(action, (data) => {
            if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
            const target = db.getPlayer(data.username);
            if (action === 'adminGiveCoins') target.coins += parseInt(data.amount);
            else if (action === 'adminGiveGems') target.gems += parseInt(data.amount);
            else if (action === 'adminSetCoins') target.coins = parseInt(data.amount);
            else if (action === 'adminResetPlayer') {
                const fresh = {
                    username: data.username, coins: 500, gems: 0, registered: Date.now(),
                    lastDaily: 0, totalWagered: 0, totalWon: 0, gamesPlayed: 0,
                    pet: null, roles: [], clientSeed: db.generateClientSeed(), nonce: 0
                };
                db.savePlayer(data.username, fresh);
                io.emit('playerListUpdate');
                socket.emit('adminResult', { success: true });
                return;
            } else if (action === 'adminDeletePlayer') {
                const players = db.loadData();
                delete players[data.username];
                db.saveData(players);
                io.emit('playerListUpdate');
                socket.emit('adminResult', { success: true });
                return;
            }
            db.savePlayer(data.username, target);
            io.emit('playerListUpdate');
            socket.emit('adminResult', { success: true });
        });
    });

    socket.on('adminSendToAll', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        io.emit('systemMessage', data.msg);
    });

    socket.on('adminSetRole', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const target = db.getPlayer(data.username);
        if (!target.roles) target.roles = [];
        if (data.action === 'add' && !target.roles.includes(data.role)) {
            target.roles.push(data.role);
        } else if (data.action === 'remove') {
            target.roles = target.roles.filter(r => r !== data.role);
        }
        db.savePlayer(data.username, target);
        socket.emit('adminResult', { success: true });
    });

    socket.on('adminWarn', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const warnings = db.loadWarnings();
        if (!warnings[data.username]) warnings[data.username] = [];
        warnings[data.username].push({ reason: data.reason, by: loggedInUser, time: Date.now() });
        db.saveWarnings(warnings);
        socket.emit('adminResult', { success: true });
        io.emit('systemMessage', `${data.username} received a warning: ${data.reason}`);
    });

    socket.on('adminBan', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const bans = db.loadBans();
        bans[data.username] = { reason: data.reason, by: loggedInUser, time: Date.now(), expires: data.expires || null };
        db.saveBans(bans);
        io.emit('playerBanned', { username: data.username, reason: data.reason });
        io.emit('systemMessage', `${data.username} has been banned: ${data.reason}`);
        socket.emit('adminResult', { success: true });
    });

    socket.on('adminUnban', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const bans = db.loadBans();
        delete bans[data.username];
        db.saveBans(bans);
        io.emit('systemMessage', `${data.username} has been unbanned.`);
        socket.emit('adminResult', { success: true });
    });

    socket.on('adminDeletePromo', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const promos = db.loadPromo();
        delete promos[data.code];
        db.savePromo(promos);
        socket.emit('adminPromos', promos);
    });

    socket.on('adminSetPassword', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const admin = db.loadAdmin();
        admin.password = data.password;
        db.saveAdmin(admin);
    });

    // Daily reward
    socket.on('dailyReward', () => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        const now = Date.now();
        const msSinceLast = now - (player.lastDaily || 0);
        if (msSinceLast < 86400000) {
            const hoursLeft = Math.ceil((86400000 - msSinceLast) / 3600000);
            socket.emit('chatMessage', { user: 'System', msg: `Daily in ${hoursLeft}h!`, time: now });
            return;
        }
        const reward = 200;
        player.coins += reward;
        player.lastDaily = now;
        db.savePlayer(loggedInUser, player);
        socket.emit('chatMessage', { user: 'System', msg: `Daily ${reward} coins claimed!`, time: now });
        io.emit('playerListUpdate');
    });

    // Shop
    socket.on('buyItem', (data) => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        const item = games.PETS[data.item] || games.WAGER_ITEMS[data.item];
        if (!item) return;
        if (player.coins < item.cost && item.cost) {
            socket.emit('chatMessage', { user: 'System', msg: 'Not enough coins!', time: Date.now() });
            return;
        }
        if (item.cost) {
            player.coins -= item.cost;
        }
        if (item.type === 'pet') {
            if (player.pet) {
                // Pet merge system
                const currentPet = games.PETS[player.pet];
                if (currentPet && currentPet.rarity === item.rarity) {
                    const mergeResult = games.mergePets(player.pet, data.item);
                    if (mergeResult) {
                        player.pet = mergeResult;
                        socket.emit('chatMessage', { user: 'System', msg: `Pets merged! You got ${games.PETS[mergeResult].displayName}!`, time: Date.now() });
                    } else {
                        socket.emit('chatMessage', { user: 'System', msg: 'Merge failed! Pet lost.', time: Date.now() });
                        player.pet = null;
                    }
                } else {
                    socket.emit('chatMessage', { user: 'System', msg: `You can only merge pets of the same rarity! You have ${currentPet ? currentPet.displayName : 'none'}.`, time: Date.now() });
                    player.coins += item.cost; // Refund
                }
            } else {
                player.pet = data.item;
                socket.emit('chatMessage', { user: 'System', msg: `You bought ${item.displayName}!`, time: Date.now() });
            }
        } else if (item.type === 'gem') {
            player.gems += 1;
            socket.emit('chatMessage', { user: 'System', msg: `You bought 1x ${item.displayName}!`, time: Date.now() });
        }
        db.savePlayer(loggedInUser, player);
        io.emit('playerListUpdate');
    });

    socket.on('usePromo', (data) => {
        if (!loggedInUser) return;
        const result = db.applyPromoBonus(loggedInUser, data.code);
        if (result && result.error) {
            socket.emit('chatMessage', { user: 'System', msg: result.error, time: Date.now() });
        } else if (result && result.success) {
            socket.emit('chatMessage', { user: 'System', msg: `Promo applied: +${result.value} ${result.type}!`, time: Date.now() });
        } else {
            socket.emit('chatMessage', { user: 'System', msg: 'Invalid code!', time: Date.now() });
        }
        io.emit('playerListUpdate');
    });

    // Admin data
    socket.on('adminGetPlayers', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const players = db.getAllPlayers();
        const page = data.page || 1;
        const search = data.search || '';
        const pageSize = 20;
        let list = Object.values(players);
        if (search) list = list.filter(p => p.username && p.username.toLowerCase().includes(search.toLowerCase()));
        const totalPages = Math.ceil(list.length / pageSize);
        const paginated = list.slice((page - 1) * pageSize, page * pageSize);
        socket.emit('adminPlayers', { players: paginated, totalPages, page });
    });

    socket.on('adminGetPlayer', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const player = db.getPlayer(data.username);
        socket.emit('adminPlayerDetail', player);
    });

    socket.on('adminGetLogs', () => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        try {
            const logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8'));
            socket.emit('adminLogs', logs);
        } catch (e) {
            socket.emit('adminLogs', []);
        }
    });

    socket.on('adminGetWarnings', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const warnings = db.loadWarnings();
        socket.emit('adminWarnings', data && data.username ? { [data.username]: warnings[data.username] || [] } : warnings);
    });

    socket.on('adminGetBans', () => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const bans = db.loadBans();
        socket.emit('adminBans', bans);
    });

    socket.on('adminLogin', (data) => {
        const admin = db.loadAdmin();
        if (data.password === admin.password) {
            const player = db.getPlayer(data.username);
            if (!player.roles) player.roles = [];
            if (!player.roles.includes('admin')) {
                player.roles.push('admin');
                db.savePlayer(data.username, player);
            }
            socket.emit('adminLoginSuccess', { success: true });
        } else {
            socket.emit('adminLoginSuccess', { success: false });
        }
    });

    socket.on('adminGetPromos', () => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const promos = db.loadPromo();
        socket.emit('adminPromos', promos);
    });

    socket.on('adminCreatePromo', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const promos = db.loadPromo();
        const rewards = data.rewards || [{ type: data.rewardType || 'coins', amount: parseInt(data.rewardValue) || 100 }];
        promos[data.code] = {
            code: data.code,
            rewards: rewards,
            maxUses: parseInt(data.maxUses) || 10,
            active: true,
            used: 0,
            usedBy: [],
            createdBy: loggedInUser,
            createdAt: Date.now()
        };
        db.savePromo(promos);
        socket.emit('adminPromos', promos);
    });

    socket.on('leaderboard', () => {
        const players = db.getAllPlayers();
        const sorted = Object.values(players)
            .filter(p => p.coins > 0)
            .sort((a, b) => b.coins - a.coins)
            .slice(0, 50)
            .map((p, i) => ({ rank: i + 1, username: p.username, coins: p.coins, gems: p.gems, pet: p.pet }));
        socket.emit('leaderboardData', sorted);
    });

    // ── Live Feed: send recent games on request ──
    socket.on('getRecentGames', () => {
        socket.emit('recentGamesUpdated', games.getRecentGames());
    });

    // Disconnect
    socket.on('checkSession', () => {
        const token = socket.handshake?.headers?.cookie
            ?.split('; ')
            ?.find(c => c.startsWith('bf_session='))
            ?.split('=')[1];
        if (token && sessions.has(token)) {
            const username = sessions.get(token);
            loggedInUser = username;
            const player = db.getPlayer(username);
            
            // ── Check for pending disconnect timeouts ──
            const pendingDisconnect = disconnectTimeouts.get(username);
            if (pendingDisconnect) {
                clearTimeout(pendingDisconnect.timeout);
                disconnectTimeouts.delete(username);
                if (pendingDisconnect.opponentSocket) {
                    const opponentSocket = io.sockets.sockets.get(pendingDisconnect.opponentSocket);
                    if (opponentSocket && opponentSocket.connected) {
                        opponentSocket.emit('chatMessage', {
                            user: 'System',
                            msg: `${username} reconnected! The game continues.`,
                            time: Date.now()
                        });
                    }
                }
            }
            socket.emit('sessionOk', {
                username,
                robloxId: username,
                avatarUrl: player.avatarUrl || '',
                coins: player.coins || 0,
                gems: player.gems || 0,
                pet: player.pet || null,
                clientSeed: player.clientSeed,
                nonce: player.nonce || 0
            });
        } else {
            socket.emit('sessionNone');
        }
    });

    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id, loggedInUser ? '('+loggedInUser+')' : '');
        const timer = socketActivityTimers.get(socket.id);
        if (timer) clearTimeout(timer);
        socketActivityTimers.delete(socket.id);

        const disconnectedUser = loggedInUser;

        // ── Check if player was in an active game ──
        Object.keys(games.activeGames).forEach(id => {
            const game = games.activeGames[id];
            if (!game) return;

            // Game creator disconnects
            if (game.creatorSocket === socket.id) {
                if (game.status === 'waiting') {
                    // Refund coins - game hasn't started yet
                    const player = db.getPlayer(game.creator);
                    player.coins += game.amount;
                    db.savePlayer(game.creator, player);
                    console.log('  Refunded', game.amount, 'coins to', game.creator, '(disconnected while waiting)');
                    delete games.activeGames[id];
                } else if (game.status === 'active' && game.opponentSocket && disconnectedUser) {
                    // Active PVP game - start grace timeout
                    console.log('  PVP game in progress, starting grace timeout for', game.creator);

                    const timeout = setTimeout(() => {
                        // Opponent wins by default
                        const opponentPlayer = db.getPlayer(game.opponent);
                        if (opponentPlayer && game.opponentSocket) {
                            const opponentSocket = io.sockets.sockets.get(game.opponentSocket);
                            if (opponentSocket && opponentSocket.connected) {
                                const winnings = Math.floor(game.amount * 2);
                                opponentPlayer.coins += winnings;
                                db.savePlayer(game.opponent, opponentPlayer);
                                opponentSocket.emit('coinflipResult', {
                                    win: true,
                                    amount: winnings,
                                    result: 'opponent_disconnected',
                                    opponent: game.creator,
                                    gameOver: true,
                                    reason: 'Opponent disconnected - you win!'
                                });
                                io.emit('systemMessage', game.opponent + ' won by default - ' + game.creator + ' disconnected!');
                            }
                        }
                        delete games.activeGames[id];
                        io.emit('gameListUpdate', Object.values(games.activeGames));
                        io.emit('playerListUpdate');
                        if (disconnectedUser) disconnectTimeouts.delete(disconnectedUser);
                    }, DISCONNECT_GRACE_MS);

                    disconnectTimeouts.set(disconnectedUser, {
                        gameId: id,
                        opponentSocket: game.opponentSocket,
                        opponent: game.opponent,
                        amount: game.amount,
                        timeout: timeout
                    });

                    // Notify opponent
                    if (game.opponentSocket) {
                        const opponentSocket = io.sockets.sockets.get(game.opponentSocket);
                        if (opponentSocket && opponentSocket.connected) {
                            opponentSocket.emit('chatMessage', {
                                user: 'System',
                                msg: game.creator + ' disconnected! They have 30 seconds to reconnect, otherwise you win by default.',
                                time: Date.now()
                            });
                        }
                    }
                }
            }

            // Opponent disconnects
            if (game.opponentSocket === socket.id && game.status === 'active') {
                console.log('  PVP opponent disconnected from game', id);
                if (game.creatorSocket) {
                    const creatorSocket = io.sockets.sockets.get(game.creatorSocket);
                    if (creatorSocket && creatorSocket.connected) {
                        creatorSocket.emit('chatMessage', {
                            user: 'System',
                            msg: 'Your opponent ' + game.opponent + ' disconnected! They have 30 seconds to reconnect, otherwise you win by default.',
                            time: Date.now()
                        });
                    }
                }
            }
        });        io.emit('gameListUpdate', Object.values(games.activeGames));
        io.emit('playerListUpdate');
    });

});

// ── Start server ──────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// ── Start bot (jeśli ENABLE_BOT=true i ROBLOX_COOKIE ustawione) ─
if (process.env.ENABLE_BOT === 'true') {
    console.log('[SERVER] ENABLE_BOT=true — uruchamiam bota...');
    startBot();
} else {
    console.log('[SERVER] Bot pominięty (ENABLE_BOT!=true lub nieustawione)');
}

// ── Graceful shutdown ──────────────────────────────────────────
function shutdown() {
    console.log('Shutting down gracefully...');
    clearInterval(cleanIntervalId);
    // Clear all disconnect timeouts
    for (const [, entry] of disconnectTimeouts) {
        clearTimeout(entry.timeout);
    }
    disconnectTimeouts.clear();
    // Clear all inactivity timers
    for (const [, timer] of socketActivityTimers) {
        clearTimeout(timer);
    }
    socketActivityTimers.clear();
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server, db, pf, games };

