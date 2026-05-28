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
            coins: 500,
            gems: 0,
            registered: Date.now(),
            lastDaily: 0,
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
    if (promo.rewardType === 'coins') {
        player.coins += promo.rewardValue;
    } else if (promo.rewardType === 'gems') {
        player.gems += promo.rewardValue;
    }
    promo.used = (promo.used || 0) + 1;
    if (!promo.usedBy) promo.usedBy = [];
    promo.usedBy.push(username);
    saveData(players);
    savePromo(promos);
    return { success: true, type: promo.rewardType, value: promo.rewardValue };
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

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

module.exports = {
    loadData, saveData,
    getPlayer, savePlayer, getAllPlayers, usernameExists, getPlayerCount,
    generateClientSeed,
    loadCooldowns, saveCooldowns,
    loadChat, saveChat,
    loadPromo, savePromo, applyPromoBonus, PROMO_CODE_MAXLEN,
    loadAdmin, saveAdmin,
    loadWarnings, saveWarnings,
    loadBans, saveBans, isBanned, hasRole,
    fmt, escapeHtml
};
