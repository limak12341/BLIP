const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Persistent data directory ──
const DATA_DIR = path.join(__dirname, '..', 'data');
const PVP_HISTORY_FILE = path.join(DATA_DIR, 'pvpHistory.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

// ── Active Games Management ──
const activeGames = {};

function getActiveGames() {
    return activeGames;
}

function getActiveGamesList() {
    return Object.values(activeGames);
}

function getGame(gameId) {
    return activeGames[gameId];
}

function createGame(gameId, gameData) {
    activeGames[gameId] = gameData;
}

function removeGame(gameId) {
    delete activeGames[gameId];
}

function clearStaleGames(db) {
    const now = Date.now();
    Object.keys(activeGames).forEach(id => {
        if (now - activeGames[id].timestamp > 300000) { // 5 min
            if (activeGames[id].status === 'waiting') {
                const player = db.getPlayer(activeGames[id].creator);
                player.coins += activeGames[id].amount;
                db.savePlayer(activeGames[id].creator, player);
            }
            delete activeGames[id];
        }
    });
}

// ── Recent Games Feed ──
const MAX_RECENT_GAMES = 30;
const recentGames = [];

function addRecentGame(gameData) {
    recentGames.unshift({
        ...gameData,
        timestamp: Date.now()
    });
    if (recentGames.length > MAX_RECENT_GAMES) {
        recentGames.length = MAX_RECENT_GAMES;
    }
}

function getRecentGames() {
    return recentGames;
}

// ── PVP Game History (permanent storage) ──
const MAX_PVP_HISTORY = 200;
let pvpHistory = loadJson(PVP_HISTORY_FILE, []);

function savePvpHistory() {
    saveJson(PVP_HISTORY_FILE, pvpHistory);
}

function addPvpGame(gameData) {
    pvpHistory.unshift({
        ...gameData,
        timestamp: Date.now()
    });
    if (pvpHistory.length > MAX_PVP_HISTORY) {
        pvpHistory.length = MAX_PVP_HISTORY;
    }
    savePvpHistory();
}

function getPvpHistory(username) {
    if (!username) return [];
    try {
        return (pvpHistory || []).filter(g => {
            if (!g) return false;
            const creatorName = typeof g.creator === 'string' ? g.creator : (g.creator?.username || '');
            const joinerName = typeof g.joiner === 'string' ? g.joiner : (g.joiner?.username || '');
            return creatorName === username || joinerName === username;
        });
    } catch (err) {
        console.error('[getPvpHistory] Error:', err.message);
        return [];
    }
}

function getAllPvpHistory() {
    return pvpHistory;
}

module.exports = {
    activeGames, getActiveGames, getActiveGamesList, getGame,
    createGame, removeGame, clearStaleGames,
    addRecentGame, getRecentGames, MAX_RECENT_GAMES,
    addPvpGame, getPvpHistory, getAllPvpHistory, MAX_PVP_HISTORY
};
