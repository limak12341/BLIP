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
// Bot secret — ten sam co w bot.js / .env
const BOT_SECRET           = process.env.BOT_SECRET  || 'zmien-mnie-bot-secret-123';

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
            qty: Math.max(1, Math.min(9999, parseInt(it?.qty || 1, 10) || 1)),
            rap: Math.max(0, parseInt(it?.rap) || 0)
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

function requireBot(req, res, next) {
    const secret = req.headers['x-bot-secret'];
    if (!secret || secret !== BOT_SECRET) return res.status(401).json({ message: 'Brak dostępu bota.' });
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
            const newUser = { _id: robloxId, username, avatarUrl };
            db.insert(newUser, (err2, inserted) => callback(inserted));
        }
    });
}


function saveLobbyGame(game) {
    lobbyDb.update(
        { _id: game.id },
        {
            _id: game.id,
            id: game.id,
            items: game.items,
            totalValue: game.totalValue,
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
                items: doc.items,
                totalValue: doc.totalValue,
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
        gameId: game.id,
        totalValue: game.totalValue || 0,
        joinValue: game.joinValue || 0,
        winningSide,
        timestamp: Date.now(),
        players: [game.creator.robloxId, game.joiner.robloxId],
        creator: { robloxId: game.creator.robloxId, username: game.creator.username, avatarUrl: game.creator.avatarUrl, side: game.creator.side, won: creatorWon },
        joiner: { robloxId: game.joiner.robloxId, username: game.joiner.username, avatarUrl: game.joiner.avatarUrl, side: game.joiner.side, won: !creatorWon },
        creatorItems: game.items,
        joinerItems: game.joinerItems
    };
    gamesDb.insert(record, (err) => { if (err) console.error('Błąd zapisu historii:', err); });
}


function getHistory(robloxId, callback) {
    gamesDb.find({ players: robloxId }).sort({ timestamp: -1 }).limit(30).exec((err, docs) => callback(err ? [] : docs));
}

function broadcastGames() {
    const list = [...activeGames.values()].map(g => ({
        id: g.id,
        items: g.items,
        totalValue: g.totalValue || 0,
        status: g.status,
        createdAt: g.createdAt,
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
        robloxUserId: req.session.robloxId,   // dla bota (wiadomości Roblox)
        username: req.session.username || '',
        items,
        note,
        totalValue: 0,      // wypełni bot po wycenie RAP
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

// ── API: PET DATABASE (BigGames API) ────────────────────────────
// Cache dla petów i RAP
let _petsCache = [];
let _petsAt = 0;
let _rapCache = {};
let _rapAt = 0;
const CACHE_MS = 5 * 60_000; // 5 min

async function getRap() {
    if (Date.now() - _rapAt < CACHE_MS) return _rapCache;
    try {
        const res = await axios.get('https://ps99.biggamesapi.io/api/rap', { timeout: 10000 });
        const data = res.data?.data || [];
        _rapCache = {};
        _rapAt = Date.now();
        data.forEach(it => {
            if (!it?.configData?.id) return;
            const baseId = it.configData.id;
            const pt = it.configData.pt;
            const sh = it.configData.sh;
            let suffix = '';
            if (sh && pt === 1) suffix = ' [Shiny Golden]';
            else if (sh && pt === 2) suffix = ' [Shiny Rainbow]';
            else if (sh) suffix = ' [Shiny]';
            else if (pt === 1) suffix = ' [Golden]';
            else if (pt === 2) suffix = ' [Rainbow]';
            _rapCache[baseId + suffix] = it.value || 0;
        });
        console.log(`[RAP] Pobrano ${Object.keys(_rapCache).length} wycen z BigGames`);
    } catch (e) {
        console.warn('[RAP] Błąd:', e.message);
    }
    return _rapCache;
}

async function getPetsCollection() {
    if (Date.now() - _petsAt < CACHE_MS && _petsCache.length) return _petsCache;
    try {
        const res = await axios.get('https://ps99.biggamesapi.io/api/collection/Pets', { timeout: 15000 });
        const data = res.data?.data || [];
        _petsCache = data;
        _petsAt = Date.now();
        console.log(`[PETS] Pobrano ${data.length} petów z BigGames`);
    } catch (e) {
        console.warn('[PETS] Błąd:', e.message);
    }
    return _petsCache;
}

function rapLookup(rap, name) {
    if (!name) return 0;
    const id = name.replace(/\s+/g, '');
    return rap[id] || rap[name] || 0;
}

// Endpoint: wyszukiwarka petów (dla frontendu)
app.get('/api/pets/search', async (req, res) => {
    const q = safeStr(req.query.q).toLowerCase();
    const category = safeStr(req.query.category).toLowerCase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    
    const [pets, rap] = await Promise.all([getPetsCollection(), getRap()]);
    
    let results = [];
    const seen = new Set();
    
    for (const pet of pets) {
        const name = pet?.configData?.name || pet?.configName || '';
        if (!name) continue;
        
        // Filtruj po kategorii
        if (category && (pet.category || '').toLowerCase() !== category) continue;
        
        // Filtruj po nazwie
        const baseNameLower = name.toLowerCase();
        if (q && !baseNameLower.includes(q)) continue;
        
        // Generuj wszystkie warianty (normal, golden, rainbow, shiny, shiny golden, shiny rainbow)
        // Używamy bezpośrednio nazwy (ze spacjami) — RAP cache używa ID z BigGames które też ma spacje
        const baseId = name;
        const variantSuffixes = ['', ' [Golden]', ' [Rainbow]', ' [Shiny]', ' [Shiny Golden]', ' [Shiny Rainbow]'];
        
        // Najpierw sprawdź czy któryś wariant ma RAP > 0
        let hasValue = false;
        for (const suffix of variantSuffixes) {
            const r = rap[baseId + suffix] || 0;
            if (r > 0) { hasValue = true; break; }
        }
        if (!hasValue) continue; // pomiń pety bez wartości rynkowej
        
        // Dodaj każdy wariant z wartością RAP
        for (const suffix of variantSuffixes) {
            const rapValue = rap[baseId + suffix] || 0;
            if (rapValue <= 0) continue;
            
            const variantName = name + suffix;
            const key = variantName.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            
            results.push({
                name: variantName,
                category: pet.category || 'Unknown',
                rap: rapValue,
                huge: !!pet.configData?.huge,
                thumbnail: pet.configData?.thumbnail || '',
            });
        }
    }
    
    // Sortuj: najpierw ogony, potem po RAP malejąco
    results.sort((a, b) => {
        const aCat = a.category === 'Titanic' ? 0 : a.category === 'Gargantuan' ? 1 : a.category === 'Huge' ? 2 : 3;
        const bCat = b.category === 'Titanic' ? 0 : b.category === 'Gargantuan' ? 1 : b.category === 'Huge' ? 2 : 3;
        if (aCat !== bCat) return aCat - bCat;
        return (b.rap || 0) - (a.rap || 0);
    });
    
    const total = results.length;
    const start = (page - 1) * limit;
    results = results.slice(start, start + limit);
    
    res.json({
        results,
        total,
        page,
        pages: Math.ceil(total / limit),
    });
});

// Endpoint: kategorie do filtrowania
app.get('/api/pets/categories', async (req, res) => {
    const pets = await getPetsCollection();
    const cats = new Set(pets.map(p => p.category).filter(Boolean));
    res.json({ categories: [...cats].sort() });
});

// Endpoint dla admina/frontu — wycena pojedynczego itemu
app.get('/api/item-value', async (req, res) => {
    const name = safeStr(req.query.name);
    if (!name) return res.status(400).json({ message: 'Podaj nazwę itemu.' });
    const rap = await getRap();
    const value = rapLookup(rap, name);
    res.json({ name, value, source: 'BigGames RAP' });
});

// ── API: BOT ──────────────────────────────────────────────────
// Bot pobiera pending depozyty do wyceny
app.get('/api/bot/pending-deposits', requireBot, (req, res) => {
    requestsDb.find({ type: 'deposit', status: 'pending' })
        .sort({ createdAt: 1 })
        .limit(50)
        .exec((err, docs) => {
            res.json({ requests: err ? [] : (docs || []) });
        });
});

// Bot aktualizuje request (dodaje wycenę RAP lub odrzuca)
app.post('/api/bot/update-deposit', requireBot, (req, res) => {
    const id         = safeStr(req.body.requestId);
    const status     = safeStr(req.body.status);    // 'valued' | 'rejected'
    const adminNote  = safeStr(req.body.adminNote || '').slice(0, 500);
    const totalValue = parseInt(req.body.totalValue) || 0;

    if (!id) return res.status(400).json({ message: 'Brak requestId.' });
    if (!['valued', 'rejected'].includes(status)) return res.status(400).json({ message: 'Zły status.' });

    requestsDb.findOne({ _id: id }, (err, doc) => {
        if (!doc) return res.status(404).json({ message: 'Nie znaleziono.' });
        if (!['pending'].includes(doc.status)) return res.json({ ok: true, skipped: true });

        const update = { status, adminNote, totalValue, updatedAt: Date.now() };

        if (status === 'rejected') {
            requestsDb.update({ _id: id }, { $set: update }, {}, () => res.json({ ok: true }));
        } else {
            // 'valued' — czeka na admina, zapisz wycenę
            requestsDb.update({ _id: id }, { $set: update }, {}, () => res.json({ ok: true }));
        }
    });
});

// Endpoint: inventarz z RAP (dla frontendu coinflip)
app.get('/api/inventory/with-rap', requireLogin, async (req, res) => {
    try {
        const rapRes = await axios.get('https://ps99.biggamesapi.io/api/rap', { timeout: 8000 });
        const rapData = rapRes.data?.data || [];
        const rapMap = {};
        rapData.forEach(it => {
            if (!it?.configData?.id) return;
            const baseId = it.configData.id;
            const pt = it.configData.pt;
            const sh = it.configData.sh;
            let suffix = '';
            if (sh && pt === 1) suffix = ' [Shiny Golden]';
            else if (sh && pt === 2) suffix = ' [Shiny Rainbow]';
            else if (sh) suffix = ' [Shiny]';
            else if (pt === 1) suffix = ' [Golden]';
            else if (pt === 2) suffix = ' [Rainbow]';
            rapMap[baseId + suffix] = it.value || 0;
        });        getInventory(req.session.robloxId, (items) => {
            const enriched = items.map(it => {
                // Proste wyszukiwanie: najpierw dokładna nazwa, potem stripped
                let rap = rapMap[it.name] || 0;
                if (!rap) {
                    const stripped = it.name.replace(/\s+/g, '');
                    rap = rapMap[stripped] || 0;
                }
                // Dla wariantów (Golden/Rainbow/Shiny): wyciągnij suffix
                if (!rap) {
                    const m = it.name.match(/\s+(\[.*?])$/);
                    if (m) {
                        const base = it.name.slice(0, m.index).replace(/\s+/g, '');
                        rap = rapMap[base + ' ' + m[1]] || 0;
                    }
                }
                return { ...it, rap };
            });
            res.json({ items: enriched });
        });
        } catch (e) {
            console.warn('[RAP] Error fetching:', e.message);
            getInventory(req.session.robloxId, (items) => res.json({ items }));
    }
});

// ── LEADERBOARD ─────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
    gamesDb.find({}).sort({ timestamp: -1 }).exec((err, docs) => {
        if (err) return res.json({ leaderboard: [] });

        const stats = {};
        docs.forEach(r => {
            if (!r.creator || !r.joiner) return;
            [r.creator, r.joiner].forEach(p => {
                if (!p || !p.robloxId) return;
                if (!stats[p.robloxId]) {
                    stats[p.robloxId] = {
                        robloxId: p.robloxId,
                        username: p.username || 'Unknown',
                        avatarUrl: p.avatarUrl || '',
                        wins: 0,
                        losses: 0,
                        profit: 0,
                        totalBet: 0
                    };
                }
                if (p.won) {
                    stats[p.robloxId].wins++;
                    const opponentValue = r.creator.robloxId === p.robloxId ? (r.joinValue || 0) : (r.totalValue || 0);
                    stats[p.robloxId].profit += opponentValue;
                } else {
                    stats[p.robloxId].losses++;
                    const myValue = r.creator.robloxId === p.robloxId ? (r.totalValue || 0) : (r.joinValue || 0);
                    stats[p.robloxId].profit -= myValue;
                }
                const betValue = r.creator.robloxId === p.robloxId ? (r.totalValue || 0) : (r.joinValue || 0);
                stats[p.robloxId].totalBet += betValue;
            });
        });

        const leaderboard = Object.values(stats)
            .sort((a, b) => b.profit - a.profit)
            .slice(0, 50);

        res.json({ leaderboard });
    });
});

// ── PROFIL: STATYSTYKI ────────────────────────────────────────
app.get('/api/profile/stats', requireLogin, (req, res) => {
    getHistory(req.session.robloxId, (records) => {
        if (!records.length) {
            return res.json({ total: 0, wins: 0, losses: 0, profit: 0 });
        }
        let wins = 0, losses = 0, profit = 0;
        records.forEach(r => {
            const me = r.creator.robloxId === req.session.robloxId ? r.creator : r.joiner;
            if (me.won) { wins++; profit += (r.totalValue || 0); }
            else { losses++; profit -= (r.totalValue || 0); }
        });
        res.json({ total: records.length, wins, losses, profit });
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
        if (!['pending', 'valued'].includes(doc.status)) return res.status(400).json({ message: 'To zgłoszenie nie może być już zatwierdzone.' });

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
        if (!['pending', 'valued'].includes(doc.status)) return res.status(400).json({ message: 'To zgłoszenie nie może być już odrzucone.' });

        requestsDb.update(
            { _id: id },
            { $set: { status: 'rejected', adminNote, updatedAt: Date.now() } },
            {},
            () => res.json({ ok: true })
        );
    });
});

// ── ESCROW DB (itemy zablokowane podczas coinflip) ─────────────
const escrowDb = new Datastore({ filename: path.join(__dirname, 'baza_escrow.db'), autoload: true });

function holdItems(userId, items, gameId, callback) {
    // Usuń itemy z inventory i zapisz w escrow
    removeFromInventory(userId, items, (result) => {
        if (!result.ok) return callback({ ok: false, message: result.message });
        const escrowDoc = {
            _id: gameId + '_' + userId,
            userId,
            items,
            gameId,
            heldAt: Date.now()
        };
        escrowDb.insert(escrowDoc, (err) => {
            if (err) {
                // rollback
                addToInventory(userId, items, () => {});
                return callback({ ok: false, message: 'Błąd escrow.' });
            }
            callback({ ok: true });
        });
    });
}

function releaseItems(gameId, winnerUserId, loserUserId, callback) {
    escrowDb.find({ gameId }, (err, docs) => {
        if (!docs || docs.length < 2) return callback({ ok: false, message: 'Brak escrow.' });
        // Znajdź itemy winnera i losera
        const winnerEscrow = docs.find(d => d.userId === winnerUserId);
        const loserEscrow = docs.find(d => d.userId === loserUserId);
        
        // Winner dostaje wszystkie itemy (swoje + losera)
        const allItems = [
            ...(winnerEscrow?.items || []),
            ...(loserEscrow?.items || [])
        ];
        
        addToInventory(winnerUserId, allItems, (newItems) => {
            // Usuń escrow
            escrowDb.remove({ gameId }, {}, () => {
                callback({ ok: true, items: newItems });
            });
        });
    });
}

function returnItemsToOwner(gameId, userId, callback) {
    escrowDb.findOne({ gameId, userId }, (err, doc) => {
        if (!doc) return callback({ ok: false });
        addToInventory(userId, doc.items, () => {
            escrowDb.remove({ _id: doc._id }, {}, () => callback({ ok: true }));
        });
    });
}



// ── SOCKETS (coinflip) ────────────────────────────────────────
io.on('connection', (socket) => {
    const sess = socket.request.session;
    socket.on('checkSession', () => {
        if (sess?.robloxId) {
            getOrCreateUser(sess.robloxId, sess.username, sess.avatarUrl, (user) => {
                socket.emit('sessionOk', { username: user.username, avatarUrl: user.avatarUrl, robloxId: user._id });
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
        const side = data.side;
        const items = sanitizeItems(data.items);
        if (!['heads','tails'].includes(side)) return socket.emit('gameError', 'Nieprawidłowa strona.');
        if (!items.length) return socket.emit('gameError', 'Dodaj przynajmniej 1 item do zakładu.');

        // Zablokuj itemy w escrow
        holdItems(sess.robloxId, items, 'temp', (result) => {
            if (!result.ok) return socket.emit('gameError', result.message);

            const gameId = `G${gameCounter++}`;
            const totalValue = items.reduce((s, it) => s + (it.rap || 0) * it.qty, 0);
            const game = {
                id: gameId,
                items,
                totalValue,
                status: 'waiting',
                createdAt: Date.now(),
                creator: { robloxId: sess.robloxId, username: sess.username, avatarUrl: sess.avatarUrl, side, socketId: socket.id },
                joiner: null
            };
            activeGames.set(gameId, game);
            saveLobbyGame(game);
            // Aktualizuj escrow z właściwym gameId
            escrowDb.update({ userId: sess.robloxId, gameId: 'temp' }, { $set: { gameId } }, {}, () => {});
            socket.emit('gameCreated', { gameId });
            broadcastGames();
        });
    });

    socket.on('cancelGame', (data) => {
        if (!sess?.robloxId) return socket.emit('gameError', 'Nie jesteś zalogowany!');
        const game = activeGames.get(data.gameId);
        if (!game || game.status !== 'waiting') return socket.emit('gameError', 'Gry nie można anulować.');
        if (game.creator.robloxId !== sess.robloxId) return socket.emit('gameError', 'Tylko twórca może anulować grę.');
        // Zwróć itemy z escrow twórcy
        returnItemsToOwner(game.id, sess.robloxId, (result) => {
            activeGames.delete(game.id);
            removeLobbyGame(game.id);
            broadcastGames();
        });
    });

    socket.on('joinGame', (data) => {
        if (!sess?.robloxId) return socket.emit('gameError', 'Nie jesteś zalogowany!');
        const game = activeGames.get(data.gameId);
        if (!game || game.status !== 'waiting' || game.creator.robloxId === sess.robloxId) return socket.emit('gameError', 'Gra niedostępna.');

        // Pobierz itemy jointera z frontendu (wybrane w modalu)
        const joinItems = sanitizeItems(data.items);
        if (!joinItems.length) return socket.emit('gameError', 'Dodaj przynajmniej 1 item do zakładu.');

        // Sprawdź czy wartość itemów jest w zakresie ±7.5% wartości gry
        const joinValue = joinItems.reduce((s, it) => s + (it.rap || 0) * it.qty, 0);
        const minVal = Math.round(game.totalValue * 0.925);
        const maxVal = Math.round(game.totalValue * 1.075);
        if (joinValue < minVal || joinValue > maxVal) {
            const fmtV = (v) => v.toLocaleString('en-US');
            return socket.emit('gameError', `Twoje itemy muszą mieć wartość w zakresie ${fmtV(minVal)}-${fmtV(maxVal)} 🪙 (±7.5% od ${fmtV(game.totalValue)})`);
        }

        // Zablokuj itemy jointera w escrow
        holdItems(sess.robloxId, joinItems, game.id, (result) => {
            if (!result.ok) return socket.emit('gameError', result.message);

            game.joiner = { robloxId: sess.robloxId, username: sess.username, avatarUrl: sess.avatarUrl, socketId: socket.id, side: game.creator.side === 'heads' ? 'tails' : 'heads' };
            game.joinerItems = joinItems;
            game.joinValue = joinValue;
            game.status = 'flipping';
            removeLobbyGame(game.id);
            broadcastGames();

            const flipPayload = {
                gameId: game.id,
                items: game.items,
                totalValue: game.totalValue,
                joinerItems: game.joinerItems,
                joinValue: game.joinValue,
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
                const winnerId = creatorWon ? game.creator.robloxId : game.joiner.robloxId;
                const loserId = creatorWon ? game.joiner.robloxId : game.creator.robloxId;

                // Przekaż wszystkie itemy zwycięzcy
                releaseItems(game.id, winnerId, loserId, (releaseResult) => {
                    const resultBase = {
                        ...flipPayload,
                        winningSide,
                        prize: joinValue + game.totalValue
                    };
                    if (creatorSock) {
                        creatorSock.emit('gameResult', {
                            ...resultBase,
                            won: creatorWon,
                            prize: creatorWon ? resultBase.prize : 0
                        });
                    }
                    socket.emit('gameResult', {
                        ...resultBase,
                        won: !creatorWon,
                        prize: !creatorWon ? resultBase.prize : 0
                    });

                    saveGameToHistory(game, winningSide);
                    activeGames.delete(game.id);
                    broadcastGames();
                });
            }, 2600);
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
