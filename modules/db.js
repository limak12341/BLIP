const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

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
    if (!promo) return null;
    if (promo.maxUses > 0 && promo.used >= promo.maxUses) return null;
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

const SALT_ROUNDS = 10;

function saveAdmin(data) {
    // Hash password if it's not already hashed (bcrypt hash starts with $2)
    if (data.password && !data.password.startsWith('$2')) {
        data.password = bcrypt.hashSync(data.password, SALT_ROUNDS);
    }
    saveJson(ADMIN_FILE, data);
}

function verifyAdminPasswordSync(password, hash) {
    try {
        if (hash && hash.startsWith('$2')) {
            return bcrypt.compareSync(password, hash);
        }
        // Fallback to direct comparison for legacy plaintext passwords (migration)
        return password === hash;
    } catch (e) {
        return password === hash;
    }
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

// ── Inventory ──
function getInventory(username) {
    const player = getPlayer(username);
    if (!player.inventory) player.inventory = [];
    return player.inventory;
}

function saveInventory(username, items) {
    const player = getPlayer(username);
    player.inventory = items;
    savePlayer(username, player);
}

function addInventoryItem(username, name, qty, rap) {
    const inv = getInventory(username);
    const existing = inv.find(i => i.name === name);
    if (existing) {
        existing.qty = (existing.qty || 0) + (qty || 1);
    } else {
        inv.push({ name, qty: qty || 1, rap: rap || 0 });
    }
    saveInventory(username, inv);
}

function removeInventoryItem(username, name, qty) {
    const inv = getInventory(username);
    const idx = inv.findIndex(i => i.name === name);
    if (idx === -1) return false;
    const item = inv[idx];
    if ((item.qty || 1) <= qty) {
        inv.splice(idx, 1);
    } else {
        item.qty -= qty;
    }
    saveInventory(username, inv);
    return true;
}

// ── Pets / Items database ──
const PETS_DATABASE = [
    { name: 'Huge Cat', category: 'Huge', rap: 50000 },
    { name: 'Huge Dog', category: 'Huge', rap: 45000 },
    { name: 'Huge Dragon', category: 'Huge', rap: 200000 },
    { name: 'Huge Unicorn', category: 'Huge', rap: 150000 },
    { name: 'Titanic Cat', category: 'Titanic', rap: 500000 },
    { name: 'Titanic Dog', category: 'Titanic', rap: 450000 },
    { name: 'Titanic Dragon', category: 'Titanic', rap: 2000000 },
    { name: 'Gargantuan Cat', category: 'Gargantuan', rap: 5000000 },
    { name: 'Gargantuan Dog', category: 'Gargantuan', rap: 4500000 },
    { name: 'Gem 💎 1M', category: 'Gem', rap: 1000000 },
    { name: 'Gem 💎 10M', category: 'Gem', rap: 10000000 },
    { name: 'Gem 💎 25M', category: 'Gem', rap: 25000000 },
    { name: 'Gem 💎 50M', category: 'Gem', rap: 50000000 },
    { name: 'Gem 💎 100M', category: 'Gem', rap: 100000000 },
    { name: 'Gem 💎 500M', category: 'Gem', rap: 500000000 },
];

function searchPets(query, category) {
    let results = PETS_DATABASE;
    if (query) {
        const q = query.toLowerCase();
        results = results.filter(p => p.name.toLowerCase().includes(q));
    }
    if (category && category !== 'all') {
        results = results.filter(p => p.category.toLowerCase() === category.toLowerCase());
    }
    return results;
}

function getPetsDatabase() {
    return PETS_DATABASE;
}

// ── Requests (deposit/withdraw) ──
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');

function loadRequests() {
    return loadJson(REQUESTS_FILE, []);
}

function saveRequests(data) {
    saveJson(REQUESTS_FILE, data);
}

// ── Gem Merge ──
const GEM_MERGE_RECIPES = [
    { in: 'Gem 💎 1M', inQty: 10, out: 'Gem 💎 10M', outQty: 1 },
    { in: 'Gem 💎 10M', inQty: 5, out: 'Gem 💎 25M', outQty: 2 },
    { in: 'Gem 💎 25M', inQty: 2, out: 'Gem 💎 50M', outQty: 1 },
    { in: 'Gem 💎 50M', inQty: 2, out: 'Gem 💎 100M', outQty: 1 },
    { in: 'Gem 💎 100M', inQty: 5, out: 'Gem 💎 500M', outQty: 1 },
];

function mergeGems(username, recipeIdx) {
    const recipe = GEM_MERGE_RECIPES[recipeIdx];
    if (!recipe) return { ok: false, message: 'Invalid recipe' };
    const inv = getInventory(username);
    const inItem = inv.find(i => i.name === recipe.in);
    if (!inItem || inItem.qty < recipe.inQty) {
        return { ok: false, message: `Need ${recipe.inQty}x ${recipe.in}, have ${inItem ? inItem.qty : 0}` };
    }
    inItem.qty -= recipe.inQty;
    
    // Build new inventory: remove input item if depleted, keep others
    let newInv;
    if (inItem.qty <= 0) {
        newInv = inv.filter(i => i.name !== recipe.in);
    } else {
        newInv = [...inv];
    }
    
    // Add or update output item
    const outExisting = newInv.find(i => i.name === recipe.out);
    if (outExisting) {
        outExisting.qty += recipe.outQty;
    } else {
        newInv.push({ name: recipe.out, qty: recipe.outQty, rap: 0 });
    }
    
    // Single save at the end
    saveInventory(username, newInv);
    return { ok: true, message: `Merged ${recipe.inQty}x ${recipe.in} into ${recipe.outQty}x ${recipe.out}` };
}

// ── Public profile data ──
function getPublicProfile(username) {
    const player = getPlayer(username);
    const gameHistory = player.gameHistory || [];
    const total = player.gamesPlayed || 0;
    const wins = gameHistory.filter(g => g.outcome === 'win').length;
    const losses = total - wins;
    const warnings = loadWarnings();
    
    // Level system
    const xp = player.totalWagered || 0;
    const level = Math.floor(xp / 10000) + 1;
    const levelName = level >= 100 ? 'Mega' : level >= 51 ? 'Ultra' : level >= 16 ? 'Pro' : level >= 1 ? 'Enthusiast' : 'Basic';
    
    return {
        username: player.username,
        avatarUrl: player.avatarUrl || '',
        role: (player.roles && player.roles.length > 0) ? player.roles[0] : '',
        level: level,
        levelName: levelName,
        total,
        wins,
        losses,
        profit: (player.totalWon || 0) - (player.totalWagered || 0),
        balance: player.coins || 0,
        gems: player.gems || 0,
        totalWagered: player.totalWagered || 0,
        totalWon: player.totalWon || 0,
        warnings: (warnings[username] || []).length,
        createdAt: player.registered || 0
    };
}

// ── Player stats (dla dashboardu i profilu) ──
function getPlayerStats(username) {
    const player = getPlayer(username);
    const gameHistory = player.gameHistory || [];
    const total = player.gamesPlayed || 0;
    const wins = gameHistory.filter(g => g.outcome === 'win').length;
    const losses = total - wins;
    const profit = (player.totalWon || 0) - (player.totalWagered || 0);
    const xp = player.totalWagered || 0;
    const level = Math.floor(xp / 10000) + 1;
    const levelName = level >= 100 ? 'Mega' : level >= 51 ? 'Ultra' : level >= 16 ? 'Pro' : level >= 1 ? 'Enthusiast' : 'Basic';
    const xpInLevel = xp % 10000;
    return {
        total, wins, losses, profit,
        level, levelName, xpInLevel, nextLevelXp: 10000,
        coins: player.coins || 0,
        gems: player.gems || 0
    };
}

// ── Leaderboard ──
function getLeaderboard() {
    const players = loadData();
    return Object.values(players)
        .filter(p => (p.gamesPlayed || 0) > 0)
        .sort((a, b) => ((b.totalWon || 0) - (b.totalWagered || 0)) - ((a.totalWon || 0) - (a.totalWagered || 0)))
        .slice(0, 50)
        .map(p => {
            const gameHistory = p.gameHistory || [];
            const wins = gameHistory.filter(g => g.outcome === 'win').length;
            const losses = (p.gamesPlayed || 0) - wins;
            return {
                username: p.username,
                robloxId: p.username,
                avatarUrl: p.avatarUrl || '',
                wins,
                losses,
                profit: (p.totalWon || 0) - (p.totalWagered || 0)
            };
        });
}

// ── Tip player ──
function tipPlayer(senderUsername, targetUsername, amount) {
    const sender = getPlayer(senderUsername);
    const receiver = getPlayer(targetUsername);
    amount = parseInt(amount);
    if (isNaN(amount) || amount <= 0 || sender.coins < amount) {
        return { ok: false, message: 'Not enough coins or invalid amount.' };
    }
    sender.coins -= amount;
    receiver.coins += amount;
    savePlayer(senderUsername, sender);
    savePlayer(targetUsername, receiver);
    return { ok: true, message: `You tipped ${amount} coins to ${targetUsername}!` };
}

module.exports = {
    loadFilter, saveFilter,
    loadData, saveData,
    getPlayer, savePlayer, getAllPlayers, usernameExists, getPlayerCount,
    generateClientSeed,
    loadCooldowns, saveCooldowns,
    loadChat, saveChat,
    loadPromo, savePromo, applyPromoBonus, PROMO_CODE_MAXLEN,
    loadAdmin,    saveAdmin, verifyAdminPasswordSync,
    loadWarnings, saveWarnings,
    loadBans, saveBans, isBanned, hasRole,
    saveSeedRecord, revealSeedRecord, getActiveServerSeed,
    getAllSeedRecords, getRevealedSeeds,
    findPlayerByToken, updatePlayerClientSeed,
    getInventory, saveInventory, addInventoryItem, removeInventoryItem,
    searchPets, getPetsDatabase,
    loadRequests, saveRequests,
    mergeGems, GEM_MERGE_RECIPES,
    getPublicProfile,
    getPlayerStats,
    getLeaderboard,
    tipPlayer,
    fmt, escapeHtml
};
