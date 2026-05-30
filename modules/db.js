const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'players.json');
const COOLDOWN_FILE = path.join(DATA_DIR, 'cooldowns.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const PROMO_FILE = path.join(DATA_DIR, 'promo.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const WARNINGS_FILE = path.join(DATA_DIR, 'warnings.json');
const BANS_FILE = path.join(DATA_DIR, 'bans.json');
const SEEDS_FILE = path.join(DATA_DIR, 'seeds.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Generic data helpers ──
function loadJson(filePath, defaultVal) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) { /* ignore */ }
    return defaultVal;
}

function saveJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ── Player data ──
function loadData() {
    return loadJson(DATA_FILE, {});
}

function saveData(data) {
    saveJson(DATA_FILE, data);
}

function generateClientSeed() {
    return crypto.randomBytes(16).toString('hex');
}

function getPlayer(username) {
    const players = loadData();
    if (!players[username]) {
        players[username] = {
            username,
            coins: 0,
            gems: 0,
            registered: Date.now(),
            totalWagered: 0,
            totalWon: 0,
            gamesPlayed: 0,
            pet: null,
            roles: [],
            clientSeed: generateClientSeed(),
            nonce: 0
        };
        saveData(players);
    }
    return players[username];
}

function savePlayer(username, data) {
    const players = loadData();
    players[username] = data;
    saveData(players);
}

function getAllPlayers() {
    return loadData();
}

function usernameExists(username) {
    const players = loadData();
    return !!players[username];
}

function getPlayerCount() {
    return Object.keys(loadData()).length;
}

// ── Cooldowns ──
function loadCooldowns() {
    return loadJson(COOLDOWN_FILE, {});
}

function saveCooldowns(data) {
    saveJson(COOLDOWN_FILE, data);
}

// ── Chat ──
function loadChat() {
    return loadJson(CHAT_FILE, []);
}

function saveChat(data) {
    saveJson(CHAT_FILE, data);
}

// ── Promo codes ──
const PROMO_CODE_MAXLEN = 30;

function loadPromo() {
    return loadJson(PROMO_FILE, {});
}

function savePromo(data) {
    saveJson(PROMO_FILE, data);
}

function applyPromoBonus(username, code) {
    const promos = loadPromo();
    const promo = promos[code];
    if (!promo || promo.used >= promo.maxUses) return null;
    if (promo.usedBy && promo.usedBy.includes(username)) return { error: 'Code already used' };
    const players = loadData();
    if (!players[username]) players[username] = getPlayer(username);
    const player = players[username];
    
    // Obsługa zarówno starego (rewardType/rewardValue) jak i nowego (rewards array) formatu
    const rewards = promo.rewards || [{ type: promo.rewardType || 'coins', amount: promo.rewardValue || 0 }];
    let appliedValue = 0;
    let appliedType = 'coins';
    
    for (const reward of rewards) {
        if (reward.type === 'coins') {
            const amount = reward.amount || 0;
            player.coins += amount;
            appliedValue += amount;
            appliedType = 'coins';
        } else if (reward.type === 'gems') {
            const qty = reward.qty || 1;
            player.gems += qty;
            appliedValue += qty;
            appliedType = 'gems';
        }
    }
    
    promo.used = (promo.used || 0) + 1;
    if (!promo.usedBy) promo.usedBy = [];
    promo.usedBy.push(username);
    saveData(players);
    savePromo(promos);
    return { success: true, type: appliedType, value: appliedValue };
}

// ── Admin ──
function loadAdmin() {
    return loadJson(ADMIN_FILE, { password: 'admin123', roles: {} });
}

function saveAdmin(data) {
    saveJson(ADMIN_FILE, data);
}

// ── Warnings ──
function loadWarnings() {
    return loadJson(WARNINGS_FILE, {});
}

function saveWarnings(data) {
    saveJson(WARNINGS_FILE, data);
}

// ── Bans ──
function loadBans() {
    return loadJson(BANS_FILE, {});
}

function saveBans(data) {
    saveJson(BANS_FILE, data);
}

function isBanned(username) {
    const bans = loadBans();
    const ban = bans[username];
    if (!ban) return null;
    if (ban.expires && Date.now() > ban.expires) {
        delete bans[username];
        saveBans(bans);
        return null;
    }
    return ban;
}

function hasRole(username, role) {
    const player = getPlayer(username);
    return player.roles && player.roles.includes(role);
}

// ── Utility ──
function fmt(n) {
    const v = Number(n);
    if (v < 1000) return String(v);
    if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0) + 'K';
    if (v < 1_000_000_000) return (v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0) + 'M';
    return (v / 1_000_000_000).toFixed(v < 10_000_000_000 ? 1 : 0) + 'B';
}


// ── Chat Filter (bad words) ──
const FILTER_FILE = path.join(DATA_DIR, 'filter.json');
function loadFilter() {
    return loadJson(FILTER_FILE, { words: [], enabled: true, punishment: 'block' });
}
function saveFilter(data) {
    saveJson(FILTER_FILE, data);
}

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

// ── Seed History (Provably Fair 2.0) ──
function loadSeeds() {
    return loadJson(SEEDS_FILE, []);
}

function saveSeeds(data) {
    saveJson(SEEDS_FILE, data);
}

function saveSeedRecord(record) {
    const seeds = loadSeeds();
    // Usuń poprzedni aktywny (nieujawniony) seed jeśli istnieje
    const idx = seeds.findIndex(s => !s.revealed && s.seed === record.seed);
    if (idx === -1) {
        seeds.push(record);
    } else {
        seeds[idx] = record;
    }
    saveSeeds(seeds);
}

function revealSeedRecord(seed, revealedAt) {
    const seeds = loadSeeds();
    const idx = seeds.findIndex(s => s.seed === seed);
    if (idx !== -1) {
        seeds[idx].revealed = true;
        seeds[idx].revealedAt = revealedAt || Date.now();
        saveSeeds(seeds);
    }
}

function getActiveServerSeed() {
    const seeds = loadSeeds();
    const active = seeds.find(s => !s.revealed);
    return active || null;
}

function getAllSeedRecords() {
    return loadSeeds();
}

function getRevealedSeeds() {
    const seeds = loadSeeds();
    return seeds.filter(s => s.revealed).reverse();
}

function findPlayerByToken(token) {
    // token to bf_token cookie — przeszukaj wszystkich graczy
    const players = loadData();
    for (const username of Object.keys(players)) {
        const p = players[username];
        if (p.token === token) return p;
    }
    return null;
}

function updatePlayerClientSeed(username, clientSeed) {
    const players = loadData();
    if (players[username]) {
        players[username].clientSeed = clientSeed;
        saveData(players);
        return true;
    }
    return false;
}

module.exports = {
    loadFilter, saveFilter,
    loadData, saveData,
    getPlayer, savePlayer, getAllPlayers, usernameExists, getPlayerCount,
    generateClientSeed,
    loadCooldowns, saveCooldowns,
    loadChat, saveChat,
    loadPromo, savePromo, applyPromoBonus, PROMO_CODE_MAXLEN,
    loadAdmin, saveAdmin,
    loadWarnings, saveWarnings,
    loadBans, saveBans, isBanned, hasRole,
    saveSeedRecord, revealSeedRecord, getActiveServerSeed,
    getAllSeedRecords, getRevealedSeeds,
    findPlayerByToken, updatePlayerClientSeed,
    fmt, escapeHtml
};
