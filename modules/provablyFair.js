const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SERVER_SEEDS_FILE = path.join(DATA_DIR, 'server_seeds.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Server Seed Management ──
function getServerSeeds() {
    try {
        if (fs.existsSync(SERVER_SEEDS_FILE)) {
            return JSON.parse(fs.readFileSync(SERVER_SEEDS_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }

    // Init with 100 pre-generated seeds
    const seeds = [];
    for (let i = 0; i < 100; i++) {
        seeds.push(crypto.randomBytes(32).toString('hex'));
    }
    const data = { seeds, currentIndex: 0 };
    fs.writeFileSync(SERVER_SEEDS_FILE, JSON.stringify(data, null, 2));
    return data;
}

function saveServerSeeds(data) {
    fs.writeFileSync(SERVER_SEEDS_FILE, JSON.stringify(data, null, 2));
}

function getCurrentServerSeed() {
    const data = getServerSeeds();
    return data.seeds[data.currentIndex];
}

function getServerSeedHash() {
    const seed = getCurrentServerSeed();
    return crypto.createHash('sha256').update(seed).digest('hex');
}

function rotateServerSeed() {
    const data = getServerSeeds();
    data.currentIndex++;
    if (data.currentIndex >= data.seeds.length) {
        // Generate 50 more seeds
        for (let i = 0; i < 50; i++) {
            data.seeds.push(crypto.randomBytes(32).toString('hex'));
        }
    }
    saveServerSeeds(data);
    return getServerSeedHash();
}

function getRevealedSeeds(count = 5) {
    const data = getServerSeeds();
    const revealed = [];
    const startIndex = Math.max(0, data.currentIndex - count);
    for (let i = startIndex; i < data.currentIndex; i++) {
        revealed.push({ index: i, seed: data.seeds[i] });
    }
    return revealed;
}

// ── Fair Result Computation ──
function computeFairResult(serverSeed, clientSeed, nonce) {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}:${nonce}`);
    const hash = hmac.digest('hex');
    // Convert to a number between 0 and 9999 (for 0.01% precision)
    const num = parseInt(hash.substring(0, 8), 16) % 10000;
    const result = num / 100; // 0.00 to 99.99
    return { result, hash, num };
}

// ── Seed Info ──
function getSeedInfo() {
    const data = getServerSeeds();
    return {
        currentIndex: data.currentIndex,
        totalSeeds: data.seeds.length,
        remainingSeeds: data.seeds.length - data.currentIndex - 1,
        serverSeedHash: getServerSeedHash()
    };
}

// ── Express Routes Setup ──
function setupRoutes(app) {
    // REST API endpoints for Provably Fair
    app.get('/api/provably-fair/seed-hash', (req, res) => {
        res.json({ serverSeedHash: getServerSeedHash() });
    });

    app.get('/api/provably-fair/revealed-seeds', (req, res) => {
        const count = parseInt(req.query.count) || 5;
        res.json({ seeds: getRevealedSeeds(count) });
    });

    app.post('/api/provably-fair/rotate-seed', (req, res) => {
        const hash = rotateServerSeed();
        res.json({ serverSeedHash: hash });
    });

    app.post('/api/provably-fair/verify', (req, res) => {
        const { serverSeed, clientSeed, nonce } = req.body;
        if (!serverSeed || !clientSeed || nonce === undefined) {
            return res.status(400).json({ error: 'Missing parameters' });
        }
        const result = computeFairResult(serverSeed, clientSeed, nonce);
        res.json(result);
    });

    app.get('/api/provably-fair/seed-info', (req, res) => {
        res.json(getSeedInfo());
    });

    app.get('/api/provably-fair/status', (req, res, next) => {
        // This is handled by the main server.js for session context
        next();
    });

    app.post('/api/provably-fair/client-seed', (req, res, next) => {
        // This is handled by the main server.js for session context
        next();
    });

    app.post('/api/provably-fair/rotate', (req, res, next) => {
        // This is handled by the main server.js for session context
        next();
    });
}

module.exports = {
    getServerSeeds, saveServerSeeds,
    getCurrentServerSeed, getServerSeedHash,
    rotateServerSeed, getRevealedSeeds,
    computeFairResult, getSeedInfo,
    setupRoutes
};
