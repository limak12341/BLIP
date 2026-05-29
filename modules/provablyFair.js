const crypto = require('crypto');

// ═══════════════════════════════════════
//  PROVABLY FAIR 2.0
// ═══════════════════════════════════════
//
//  Algorytm:
//    1. serverSeed = 64 znaki hex (512-bit)
//    2. serverSeedHash = SHA-256(SHA-256(SHA-256(serverSeed)))
//       → potrójne hashowanie dla bezpieczeństwa
//    3. fairResult = HMAC-SHA512(serverSeed, `${clientSeed}-${nonce}`)
//       → pierwszych 7 znaków hex → liczba 0-999,999
//    4. Po każdej grze seed jest rotowany, a stary zapisywany do DB
// ═══════════════════════════════════════

let currentServerSeed = null;
let seedHistory = [];        // bufor w pamięci (ostatnie 100)
const MAX_MEMORY_HISTORY = 100;
let db = null;               // wstrzykiwany z zewnątrz przez init(dbInstance)

// ── Inicjalizacja ──────────────────────────────────────────────
function init(dbInstance) {
    db = dbInstance;
    loadOrCreateSeed();
}

function generateServerSeed() {
    return crypto.randomBytes(32).toString('hex'); // 64 znaki hex
}

// Potrójne SHA-256
function tripleSha256(data) {
    const first = crypto.createHash('sha256').update(data).digest();
    const second = crypto.createHash('sha256').update(first).digest();
    const third = crypto.createHash('sha256').update(second).digest();
    return third.toString('hex');
}

function loadOrCreateSeed() {
    // Próbujemy wczytać aktywny seed z DB
    if (db && db.getActiveServerSeed) {
        const stored = db.getActiveServerSeed();
        if (stored && stored.seed) {
            currentServerSeed = stored.seed;
            return;
        }
    }
    // Albo generujemy nowy
    currentServerSeed = generateServerSeed();
    const hash = tripleSha256(currentServerSeed);

    if (db && db.saveSeedRecord) {
        db.saveSeedRecord({
            seed: currentServerSeed,
            hash: hash,
            revealed: false,
            createdAt: Date.now(),
            gamesPlayed: 0
        });
    }

    seedHistory.push({ seed: currentServerSeed, hash, revealed: false, createdAt: Date.now() });
    if (seedHistory.length > MAX_MEMORY_HISTORY) seedHistory.shift();
}

// ── Główne funkcje ─────────────────────────────────────────────

function getCurrentServerSeed() {
    return currentServerSeed;
}

function getServerSeedHash() {
    if (!currentServerSeed) return null;
    return tripleSha256(currentServerSeed);
}

function computeFairResult(serverSeed, clientSeed, nonce) {
    // HMAC-SHA512(serverSeed, `${clientSeed}-${nonce}`)
    const hmac = crypto.createHmac('sha512', serverSeed);
    hmac.update(`${clientSeed}-${nonce}`);
    const digest = hmac.digest('hex');
    // Pierwsze 7 znaków hex → liczba całkowita
    const hex = digest.substring(0, 7);
    const number = parseInt(hex, 16);
    return number % 1000000; // 0 – 999,999
}

function rotateServerSeed() {
    // Zapisz stary seed jako ujawniony
    const oldSeed = currentServerSeed;
    const oldHash = tripleSha256(oldSeed);

    if (db && db.revealSeedRecord) {
        db.revealSeedRecord(oldSeed, Date.now());
    }

    // Wygeneruj nowy seed
    currentServerSeed = generateServerSeed();
    const newHash = tripleSha256(currentServerSeed);

    if (db && db.saveSeedRecord) {
        db.saveSeedRecord({
            seed: currentServerSeed,
            hash: newHash,
            revealed: false,
            createdAt: Date.now(),
            gamesPlayed: 0
        });
    }

    // Aktualizuj in-memory history
    const existingIdx = seedHistory.findIndex(s => s.seed === oldSeed);
    if (existingIdx !== -1) {
        seedHistory[existingIdx].revealed = true;
    } else {
        seedHistory.push({ seed: oldSeed, hash: oldHash, revealed: true, createdAt: Date.now() });
    }
    seedHistory.push({ seed: currentServerSeed, hash: newHash, revealed: false, createdAt: Date.now() });
    if (seedHistory.length > MAX_MEMORY_HISTORY * 2) {
        seedHistory = seedHistory.slice(-MAX_MEMORY_HISTORY);
    }

    return oldSeed;
}

// ── REST API ────────────────────────────────────────────────────
function setupRoutes(app) {
    // Pobierz aktualny hash seeda
    app.get('/api/provably-fair/seed-hash', (req, res) => {
        const hash = getServerSeedHash();
        res.json({ hash });
    });

    // Pobierz info o seedzie (hash, nonce itp)
    app.get('/api/provably-fair/seed-info', (req, res) => {
        res.json({
            serverSeedHash: getServerSeedHash(),
            algorithm: 'SHA-256×3 + HMAC-SHA512'
        });
    });

    // Pobierz ujawnione seedy z historii (z DB)
    app.get('/api/provably-fair/revealed-seeds', (req, res) => {
        let list = [];
        if (db && db.getRevealedSeeds) {
            list = db.getRevealedSeeds();
        } else {
            list = seedHistory.filter(s => s.revealed).slice(-50).reverse();
        }
        // Nie wysyłamy seeda, tylko hash i timestamp
        const safe = list.map(s => ({
            hash: tripleSha256(s.seed || ''),
            revealedAt: s.revealedAt || s.createdAt,
            gamesPlayed: s.gamesPlayed || 0
        }));
        res.json({ seeds: safe });
    });

    // Pobierz pełną historię seedów (administracyjnie)
    app.get('/api/provably-fair/seed-history', (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        let all = [];
        if (db && db.getAllSeedRecords) {
            all = db.getAllSeedRecords();
        } else {
            all = [...seedHistory].reverse();
        }

        const total = all.length;
        const pages = Math.ceil(total / limit) || 1;
        const slice = all.slice((page - 1) * limit, page * limit);

        const safe = slice.map(s => ({
            hash: tripleSha256(s.seed || ''),
            revealed: s.revealed || false,
            createdAt: s.createdAt,
            revealedAt: s.revealedAt || null,
            gamesPlayed: s.gamesPlayed || 0
        }));

        res.json({ seeds: safe, page, pages, total });
    });

    // Zweryfikuj konkretną grę
    app.post('/api/provably-fair/verify', (req, res) => {
        const { serverSeed, clientSeed, nonce, expectedResult } = req.body || {};
        if (!serverSeed || clientSeed === undefined || nonce === undefined) {
            return res.status(400).json({ success: false, message: 'Brak wymaganych pól: serverSeed, clientSeed, nonce' });
        }
        const computedResult = computeFairResult(serverSeed, clientSeed, nonce);
        const computedHash = tripleSha256(serverSeed);
        res.json({
            success: true,
            serverSeedHash: computedHash,
            clientSeed,
            nonce,
            computedResult,
            expectedResult: expectedResult !== undefined ? expectedResult : null,
            match: expectedResult !== undefined ? computedResult === expectedResult : null
        });
    });

    // Zmień clientSeed
    app.post('/api/provably-fair/client-seed', (req, res) => {
        const { username, clientSeed } = req.body || {};
        if (!username || !clientSeed) {
            return res.status(400).json({ success: false, message: 'Brak username lub clientSeed' });
        }
        // Zweryfikuj przez cookie sesji
        const token = req.cookies?.bf_token;
        if (!token || !db || !db.findPlayerByToken) {
            return res.status(401).json({ success: false, message: 'Nieautoryzowany' });
        }
        const player = db.findPlayerByToken(token);
        if (!player || player.username !== username) {
            return res.status(403).json({ success: false, message: 'Brak dostępu' });
        }
        if (db.updatePlayerClientSeed) {
            db.updatePlayerClientSeed(username, clientSeed);
        }
        res.json({ success: true, clientSeed });
    });

    // Pobierz status (dla frontendu — szczegółowy)
    app.get('/api/provably-fair/status', (req, res) => {
        const token = req.cookies?.bf_token;
        let player = null;
        if (token && db && db.findPlayerByToken) {
            player = db.findPlayerByToken(token);
        }
        res.json({
            serverSeedHash: getServerSeedHash(),
            algorithm: 'SHA-256×3 + HMAC-SHA512',
            clientSeed: player ? player.clientSeed : null,
            nonce: player ? player.nonce : null
        });
    });
}

// ── Eksport ─────────────────────────────────────────────────────
module.exports = {
    init,
    getCurrentServerSeed,
    getServerSeedHash,
    computeFairResult,
    rotateServerSeed,
    setupRoutes
};
