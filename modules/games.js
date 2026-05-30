const crypto = require('crypto');

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

module.exports = {
    activeGames, getActiveGames, getActiveGamesList, getGame,
    createGame, removeGame, clearStaleGames,
    addRecentGame, getRecentGames, MAX_RECENT_GAMES
};
