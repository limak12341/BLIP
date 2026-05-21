const express    = require('express');
const session    = require('express-session');
const axios      = require('axios');
const http       = require('http');
const path       = require('path');
const os         = require('os');
const Datastore  = require('@seald-io/nedb');
const { Server } = require('socket.io');

// ── KONFIGURACJA ─────────────────────────────────────────────
const ROBLOX_CLIENT_ID     = process.env.ROBLOX_CLIENT_ID || 'TWÓJ_CLIENT_ID';
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET || 'TWÓJ_CLIENT_SECRET';
const REDIRECT_URI         = process.env.REDIRECT_URI || 'http://localhost:5000/auth/callback';
const PORT                 = process.env.PORT || 5000;
const SESSION_SECRET       = process.env.SESSION_SECRET || 'zmien-na-losowy-ciag-znakow-xyz987';
const IS_PRODUCTION        = process.env.NODE_ENV === 'production';

// Admin (do panelu /admin) – ustaw w env na Render/GitHub itp.
// Przykład: ADMIN_TOKEN=jakis-losowy-ciag-32-znaki
const ADMIN_TOKEN          = process.env.ADMIN_TOKEN || 'zmien-mnie-admin-token';

// ── INICJALIZACJA ─────────────────────────────────────────────
const app    = express();
if (IS_PRODUCTION) app.set('trust proxy', 1);
const server = http.createServer(app);
const io     = new Server(server);

// Bazy: gracze, historia, oczekujące gry w lobby
const db      = new Datastore({ filename: path.join(__dirname, 'baza_graczy.db'),  autoload: true });
const gamesDb = new Datastore({ filename: path.join(__dirname, 'baza_historii.db'), autoload: true });
const lobbyDb = new Datastore({ filename: path.join(__dirname, 'baza_lobby.db'),   autoload: true });

// Depozyty / wypłaty / inventarz na stronie
const inventoryDb = new Datastore({ filename: path.join(__dirname, 'baza_inventory.db'), autoload: true });
const requestsDb  = new Datastore({ filename: path.join(__dirname, 'baza_requests.db'),  autoload: true });

// Indeksy
gamesDb.ensureIndex({ fieldName: 'players', sparse: true });
requestsDb.ensureIndex({ fieldName: 'userId', sparse: true });
requestsDb.ensureIndex({ fieldName: 'status', sparse: true });
requestsDb.ensureIndex({ fieldName: 'type', sparse: true });

const activeGames = new Map();
let gameCounter = 1;
const tempCodes = new Map();

function normalizeUsername(raw) {
    return String(raw || '').trim();
}

function safeStr(v) {
    return String(v || '').trim();
}

function newId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeItems(items) {
    if (!Array.isArray(items)) return [];
    return items
        .map(it => ({
            name: safeStr(it?.name).slice(0, 80),
            qty: Math.max(1, Math.min(9999, parseInt(it?.qty || 1, 10) || 1))
        }))
        .filter(it => it.name.length > 0);
}

async function fetchRobloxUserByUsername(username) {
    const lookup = await axios.post(
        'https://users.roblox.com/v1/usernames/users',
        { usernames: [username], excludeBannedUsers: true }
    );
    const entry = lookup.data?.data?.[0];
    if (!entry || entry.requestedUsername.toLowerCase() !== username.toLowerCase()) {
        return null;
    }
    return entry;
}

// ── SESSION MIDDLEWARE ────────────────────────────────────────
const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: IS_PRODUCTION,
        sameSite: 'lax'
    }
});
app.use(sessionMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname)));
io.engine.use(sessionMiddleware);

function requireLogin(req, res, next) {
    if (!req.session?.robloxId) return res.status(401).json({ message: 'Nie jesteś zalogowany.' });
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session?.isAdmin) return res.status(401).json({ message: 'Brak uprawnień admin.' });
    next();
}

// ── INVENTARZ (na stronie) ────────────────────────────────────
function getInventory(userId, callback) {
    inventoryDb.findOne({ _id: userId }, (err, doc) => {
        if (doc?.items) return callback(doc.items);
        const fresh = { _id: userId, items: [] };
        inventoryDb.insert(fresh, () => callback([]));
    });
}

function addToInventory(userId, items, callback) {
    getInventory(userId, (cur) => {
        const map = new Map();
        cur.forEach(it => map.set(it.name.toLowerCase(), { name: it.name, qty: it.qty }));
        items.forEach(it => {
            const key = it.name.toLowerCase();
            const prev = map.get(key);
            if (prev) prev.qty += it.qty;
            else map.set(key, { name: it.name, qty: it.qty });
        });
        const merged = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
        inventoryDb.update({ _id: userId }, { $set: { items: merged } }, { upsert: true }, () => callback(merged));
    });
}

function removeFromInventory(userId, items, callback) {
    getInventory(userId, (cur) => {
        const map = new Map();
        cur.forEach(it => map.set(it.name.toLowerCase(), { name: it.name, qty: it.qty }));
        // walidacja: czy wystarczy
        for (const it of items) {
            const key = it.name.toLowerCase();
            const prev = map.get(key);
            if (!prev || prev.qty < it.qty) return callback({ ok: false, message: `Brak itemu lub za mało sztuk: ${it.name}` });
        }
        // odejmij
        items.forEach(it => {
            const key = it.name.toLowerCase();
            const prev = map.get(key);
            prev.qty -= it.qty;
            if (prev.qty <= 0) map.delete(key);
        });
        const merged = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
        inventoryDb.update({ _id: userId }, { $set: { items: merged } }, { upsert: true }, () => callback({ ok: true, items: merged }));
    });
}

// ── FUNKCJE BAZOWE ───────────────────────────────────────────
function getOrCreateUser(robloxId, username, avatarUrl, callback) {
    db.findOne({ _id: robloxId }, (err, doc) => {
        if (doc) {
            db.update({ _id: robloxId }, { $set: { username, avatarUrl } }, {}, () => callback({ ...doc, username, avatarUrl }));
        } else {
            const newUser = { _id: robloxId, username, avatarUrl, balance: 1000 };
            db.insert(newUser, (err2, inserted) => callback(inserted));
        }
    });
}

function updateBalance(robloxId, newBalance, callback) {
    db.update({ _id: robloxId }, { $set: { balance: newBalance } }, {}, callback);
}

function saveLobbyGame(game) {
    lobbyDb.update(
        { _id: game.id },
        {
            _id: game.id,
            id: game.id,
            bet: game.bet,
            status: game.status,
            createdAt: game.createdAt,
            creator: game.creator
        },
        { upsert: true },
        (err) => { if (err) console.error('saveLobbyGame:', err); }
    );
}

function removeLobbyGame(gameId) {
    lobbyDb.remove({ _id: gameId }, {}, (err) => {
        if (err) console.error('removeLobbyGame:', err);
    });
}

function loadLobbyGames(callback) {
    lobbyDb.find({ status: 'waiting' }, (err, docs) => {
        if (err || !docs.length) return callback();
        docs.forEach(doc => {
            activeGames.set(doc.id, {
                id: doc.id,
                bet: doc.bet,
                status: doc.status,
                createdAt: doc.createdAt,
                creator: { ...doc.creator, socketId: null },
                joiner: null
            });
            const num = parseInt(String(doc.id).replace(/\D/g, ''), 10);
            if (num >= gameCounter) gameCounter = num + 1;
        });
        callback(docs.length);
    });
}

function saveGameToHistory(game, winningSide) {
    const creatorWon = game.creator.side === winningSide;
    const record = {
        gameId: game.id, bet: game.bet, winningSide, timestamp: Date.now(),
        players: [game.creator.robloxId, game.joiner.robloxId],
        creator: { robloxId: game.creator.robloxId, username: game.creator.username, avatarUrl: game.creator.avatarUrl, side: game.creator.side, won: creatorWon },
        joiner: { robloxId: game.joiner.robloxId, username: game.joiner.username, avatarUrl: game.joiner.avatarUrl, side: game.joiner.side, won: !creatorWon }
    };
    gamesDb.insert(record, (err) => { if (err) console.error('Błąd zapisu historii:', err); });
}

function getHistory(robloxId, callback) {
    gamesDb.find({ players: robloxId }).sort({ timestamp: -1 }).limit(30).exec((err, docs) => callback(err ? [] : docs));
}

function broadcastGames() {
    const list = [...activeGames.values()].map(g => ({
        id: g.id, bet: g.bet, status: g.status, createdAt: g.createdAt,
        creator: { robloxId: g.creator.robloxId, username: g.creator.username, avatarUrl: g.creator.avatarUrl, side: g.creator.side }
    }));
    io.emit('gamesList', list);
}

// ── WERYFIKACJA BIO ───────────────────────────────────────────
app.post('/verify-start', (req, res) => {
    const username = normalizeUsername(req.body.username);
    if (!username) return res.status(400).json({ message: 'Podaj nick!' });

    const code = 'blox' + Math.random().toString(36).substring(2, 6).toUpperCase();
    tempCodes.set(username.toLowerCase(), { code, displayName: username });
    res.json({ code });
});

app.post('/verify-check', async (req, res) => {
    const username = normalizeUsername(req.body.username);
    const pending = tempCodes.get(username.toLowerCase());

    if (!pending) {
        return res.status(400).json({ message: 'Najpierw wygeneruj kod!' });
    }

    try {
        const userEntry = await fetchRobloxUserByUsername(username);
        if (!userEntry) {
            return res.status(404).json({ message: 'Nie znaleziono gracza o tym nicku!' });
        }

        const userId = userEntry.id;
        const profileRes = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
        const bio = profileRes.data.description || '';

        if (!bio.includes(pending.code)) {
            return res.json({
                success: false,
                message: 'Kod nie znaleziony w Bio! Upewnij się, że zapisałeś profil na Robloxie.'
            });
        }

        const avatarRes = await axios.get(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`
        );
        const avatarUrl = avatarRes.data?.data?.[0]?.imageUrl || '';

        const displayName = pending.displayName || userEntry.name || username;

        req.session.robloxId = userId.toString();
        req.session.username = displayName;
        req.session.avatarUrl = avatarUrl;
        tempCodes.delete(username.toLowerCase());

        getOrCreateUser(req.session.robloxId, displayName, avatarUrl, () => {
            res.json({ success: true });
        });
    } catch (e) {
        console.error('verify-check:', e.message);
        res.status(500).json({ message: 'Błąd serwera. Spróbuj za chwilę.' });
    }
});

// ── OAUTH ROBLOX (opcjonalnie) ─────────────────────────────────
app.get('/auth/roblox', (req, res) => {
    const params = new URLSearchParams({
        client_id: ROBLOX_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'openid profile',
        state: 'bloxyflip_state'
    });
    res.redirect(`https://apis.roblox.com/oauth/v1/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error || !code) return res.redirect('/?error=auth_failed');
    try {
        const tokenRes = await axios.post(
            'https://apis.roblox.com/oauth/v1/token',
            new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
                client_id: ROBLOX_CLIENT_ID,
                client_secret: ROBLOX_CLIENT_SECRET
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const userRes = await axios.get('https://apis.roblox.com/oauth/v1/userinfo', {
            headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
        });
        const { sub: robloxId, name: username, picture: avatarUrl } = userRes.data;
        req.session.robloxId = String(robloxId);
        req.session.username = username;
        req.session.avatarUrl = avatarUrl || '';
        getOrCreateUser(req.session.robloxId, username, req.session.avatarUrl, () => {
            res.redirect('/');
        });
    } catch (err) {
        res.redirect('/?error=token_failed');
    }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ── API: INVENTARZ / DEPOZYT / WYPŁATA ─────────────────────────
app.get('/api/inventory', requireLogin, (req, res) => {
    getInventory(req.session.robloxId, (items) => res.json({ items }));
});

app.get('/api/requests', requireLogin, (req, res) => {
    requestsDb.find({ userId: req.session.robloxId }).sort({ createdAt: -1 }).limit(50).exec((err, docs) => {
        res.json({ requests: err ? [] : (docs || []) });
    });
});

// Zgłoszenie depozytu (użytkownik deklaruje co wysłał trade'em)
app.post('/api/deposit/request', requireLogin, (req, res) => {
    const items = sanitizeItems(req.body.items);
    const note = safeStr(req.body.note).slice(0, 300);
    if (!items.length) return res.status(400).json({ message: 'Dodaj przynajmniej 1 item.' });

    const doc = {
        _id: newId('dep'),
        type: 'deposit',
        status: 'pending',
        userId: req.session.robloxId,
        username: req.session.username || '',
        items,
        note,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    requestsDb.insert(doc, (err) => {
        if (err) return res.status(500).json({ message: 'Błąd zapisu zgłoszenia.' });
        res.json({ ok: true, request: doc });
    });
});

// Zgłoszenie wypłaty (strona odejmie itemy dopiero po akceptacji admina)
app.post('/api/withdraw/request', requireLogin, (req, res) => {
    const items = sanitizeItems(req.body.items);
    const note = safeStr(req.body.note).slice(0, 300);
    if (!items.length) return res.status(400).json({ message: 'Dodaj przynajmniej 1 item.' });

    // waliduj, czy user ma te itemy na stronie
    removeFromInventory(req.session.robloxId, items, (check) => {
        if (!check.ok) return res.status(400).json({ message: check.message });
        // cofamy zmianę (realnie odejmiemy dopiero po approve admina)
        addToInventory(req.session.robloxId, items, () => {
            const doc = {
                _id: newId('wd'),
                type: 'withdraw',
                status: 'pending',
                userId: req.session.robloxId,
                username: req.session.username || '',
                items,
                note,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            requestsDb.insert(doc, (err) => {
                if (err) return res.status(500).json({ message: 'Błąd zapisu zgłoszenia.' });
                res.json({ ok: true, request: doc });
            });
        });
    });
});

// ── ADMIN ────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.post('/admin/login', (req, res) => {
    const token = safeStr(req.body.token);
    if (!token) return res.status(400).json({ message: 'Podaj token.' });
    if (token !== ADMIN_TOKEN) return res.status(401).json({ message: 'Zły token.' });
    req.session.isAdmin = true;
    res.json({ ok: true });
});

app.post('/admin/logout', (req, res) => {
    req.session.isAdmin = false;
    res.json({ ok: true });
});

app.get('/api/admin/requests', requireAdmin, (req, res) => {
    const status = safeStr(req.query.status);
    const type = safeStr(req.query.type);
    const q = {};
    if (status) q.status = status;
    if (type) q.type = type;
    requestsDb.find(q).sort({ createdAt: -1 }).limit(200).exec((err, docs) => {
        res.json({ requests: err ? [] : (docs || []) });
    });
});

app.post('/api/admin/requests/:id/approve', requireAdmin, (req, res) => {
    const id = safeStr(req.params.id);
    const adminNote = safeStr(req.body.adminNote).slice(0, 300);
    requestsDb.findOne({ _id: id }, (err, doc) => {
        if (!doc) return res.status(404).json({ message: 'Nie znaleziono zgłoszenia.' });
        if (doc.status !== 'pending') return res.status(400).json({ message: 'To zgłoszenie nie jest już pending.' });

        const items = sanitizeItems(doc.items);
        if (!items.length) return res.status(400).json({ message: 'Brak itemów w zgłoszeniu.' });

        if (doc.type === 'deposit') {
            addToInventory(doc.userId, items, () => {
                requestsDb.update(
                    { _id: id },
                    { $set: { status: 'approved', adminNote, updatedAt: Date.now() } },
                    {},
                    () => res.json({ ok: true })
                );
            });
            return;
        }

        if (doc.type === 'withdraw') {
            // przy wypłacie odejmujemy itemy dopiero teraz
            removeFromInventory(doc.userId, items, (result) => {
                if (!result.ok) return res.status(400).json({ message: result.message });
                requestsDb.update(
                    { _id: id },
                    { $set: { status: 'sent', adminNote, updatedAt: Date.now() } },
                    {},
                    () => res.json({ ok: true })
                );
            });
            return;
        }

        res.status(400).json({ message: 'Nieznany typ.' });
    });
});

app.post('/api/admin/requests/:id/reject', requireAdmin, (req, res) => {
    const id = safeStr(req.params.id);
    const adminNote = safeStr(req.body.adminNote).slice(0, 300);
    requestsDb.findOne({ _id: id }, (err, doc) => {
        if (!doc) return res.status(404).json({ message: 'Nie znaleziono zgłoszenia.' });
        if (doc.status !== 'pending') return res.status(400).json({ message: 'To zgłoszenie nie jest już pending.' });

        requestsDb.update(
            { _id: id },
            { $set: { status: 'rejected', adminNote, updatedAt: Date.now() } },
            {},
            () => res.json({ ok: true })
        );
    });
});

// ── SOCKETS (coinflip) ────────────────────────────────────────
io.on('connection', (socket) => {
    const sess = socket.request.session;
    socket.on('checkSession', () => {
        if (sess?.robloxId) {
            getOrCreateUser(sess.robloxId, sess.username, sess.avatarUrl, (user) => {
                socket.emit('sessionOk', { username: user.username, avatarUrl: user.avatarUrl, balance: user.balance, robloxId: user._id });
                broadcastGames();
            });
        } else socket.emit('sessionNone');
    });

    socket.on('getHistory', () => {
        if (!sess?.robloxId) return;
        getHistory(sess.robloxId, (records) => socket.emit('historyData', records));
    });

    socket.on('createGame', (data) => {
        if (!sess?.robloxId) return socket.emit('gameError', 'Nie jesteś zalogowany!');
        const bet = parseInt(data.bet);
        const side = data.side;
        if (isNaN(bet) || bet < 1 || !['heads','tails'].includes(side)) return socket.emit('gameError', 'Nieprawidłowe dane.');
        db.findOne({ _id: sess.robloxId }, (err, user) => {
            if (!user || bet > user.balance) return socket.emit('gameError', 'Za mało monet!');
            updateBalance(sess.robloxId, user.balance - bet, () => {
                socket.emit('balanceUpdate', user.balance - bet);
                const gameId = `G${gameCounter++}`;
                const game = {
                    id: gameId,
                    bet,
                    status: 'waiting',
                    createdAt: Date.now(),
                    creator: { robloxId: sess.robloxId, username: sess.username, avatarUrl: sess.avatarUrl, side, socketId: socket.id },
                    joiner: null
                };
                activeGames.set(gameId, game);
                saveLobbyGame(game);
                socket.emit('gameCreated', { gameId });
                broadcastGames();
            });
        });
    });

    socket.on('cancelGame', (data) => {
        if (!sess?.robloxId) return socket.emit('gameError', 'Nie jesteś zalogowany!');
        const game = activeGames.get(data.gameId);
        if (!game || game.status !== 'waiting') return socket.emit('gameError', 'Gry nie można anulować.');
        if (game.creator.robloxId !== sess.robloxId) return socket.emit('gameError', 'Tylko twórca może anulować grę.');
        db.findOne({ _id: sess.robloxId }, (err, user) => {
            if (!user) return socket.emit('gameError', 'Nie znaleziono konta.');
            const newBalance = user.balance + game.bet;
            updateBalance(sess.robloxId, newBalance, () => {
                activeGames.delete(game.id);
                removeLobbyGame(game.id);
                socket.emit('balanceUpdate', newBalance);
                broadcastGames();
            });
        });
    });

    socket.on('joinGame', (data) => {
        if (!sess?.robloxId) return socket.emit('gameError', 'Nie jesteś zalogowany!');
        const game = activeGames.get(data.gameId);
        if (!game || game.status !== 'waiting' || game.creator.robloxId === sess.robloxId) return socket.emit('gameError', 'Gra niedostępna.');
        db.findOne({ _id: sess.robloxId }, (err, user) => {
            if (!user || game.bet > user.balance) return socket.emit('gameError', 'Za mało monet!');
            updateBalance(sess.robloxId, user.balance - game.bet, () => {
                socket.emit('balanceUpdate', user.balance - game.bet);
                game.joiner = { robloxId: sess.robloxId, username: sess.username, avatarUrl: sess.avatarUrl, socketId: socket.id, side: game.creator.side === 'heads' ? 'tails' : 'heads' };
                game.status = 'flipping';
                removeLobbyGame(game.id);
                broadcastGames();

                const flipPayload = {
                    gameId: game.id,
                    bet: game.bet,
                    creator: {
                        username: game.creator.username,
                        avatarUrl: game.creator.avatarUrl,
                        side: game.creator.side
                    },
                    joiner: {
                        username: game.joiner.username,
                        avatarUrl: game.joiner.avatarUrl,
                        side: game.joiner.side
                    }
                };
                const creatorSock = io.sockets.sockets.get(game.creator.socketId);
                if (creatorSock) creatorSock.emit('flipStart', flipPayload);
                socket.emit('flipStart', flipPayload);

                setTimeout(() => {
                    const winningSide = Math.random() < 0.5 ? 'heads' : 'tails';
                    const creatorWon = game.creator.side === winningSide;
                    const prize = game.bet * 2;
                    const winnerId = creatorWon ? game.creator.robloxId : game.joiner.robloxId;
                    db.findOne({ _id: winnerId }, (err2, doc) => {
                        if (doc) {
                            const newBal = doc.balance + prize;
                            updateBalance(winnerId, newBal, () => {
                                const winnerSock = creatorWon ? creatorSock : socket;
                                if (winnerSock) winnerSock.emit('balanceUpdate', newBal);
                            });
                        }
                    });
                    saveGameToHistory(game, winningSide);

                    const resultBase = { ...flipPayload, winningSide };
                    if (creatorSock) {
                        creatorSock.emit('gameResult', {
                            ...resultBase,
                            won: creatorWon,
                            prize: creatorWon ? prize : 0
                        });
                    }
                    socket.emit('gameResult', {
                        ...resultBase,
                        won: !creatorWon,
                        prize: !creatorWon ? prize : 0
                    });

                    activeGames.delete(game.id);
                    broadcastGames();
                }, 2600);
            });
        });
    });

    socket.on('disconnect', () => { /* tu logika rozłączenia */ });
});

function getLocalAddresses() {
    const ips = [];
    for (const iface of Object.values(os.networkInterfaces())) {
        for (const cfg of iface) {
            if (cfg.family === 'IPv4' && !cfg.internal) ips.push(cfg.address);
        }
    }
    return ips;
}

server.listen(PORT, '0.0.0.0', () => {
    loadLobbyGames((restored) => {
        if (restored) console.log(`↻ Przywrócono ${restored} gier z lobby`);
    });
    console.log(`\n✅ BFLIP działa:`);
    console.log(`   Ty (ten komputer):  http://localhost:${PORT}`);
    const ips = getLocalAddresses();
    if (ips.length) {
        console.log(`   Inni w tej samej sieci Wi‑Fi:`);
        ips.forEach(ip => console.log(`   → http://${ip}:${PORT}`));
    } else {
        console.log(`   (nie wykryto adresu LAN — sprawdź ipconfig)`);
    }
    console.log(`\n🔐 Admin panel:  http://localhost:${PORT}/admin  (token z env: ADMIN_TOKEN)\n`);
});

