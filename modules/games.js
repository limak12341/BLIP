const crypto = require('crypto');

// ── Pet / Item System ──
const PETS = {
    'common_egg': { name: 'Common Egg', displayName: '🥚 Common Egg', rarity: 'common', bonus: 1.05, cost: 100, type: 'pet' },
    'rare_egg': { name: 'Rare Egg', displayName: '🥚 Rare Egg', rarity: 'rare', bonus: 1.10, cost: 300, type: 'pet' },
    'epic_egg': { name: 'Epic Egg', displayName: '🥚 Epic Egg', rarity: 'epic', bonus: 1.15, cost: 800, type: 'pet' },
    'legendary_egg': { name: 'Legendary Egg', displayName: '🥚 Legendary Egg', rarity: 'legendary', bonus: 1.20, cost: 2000, type: 'pet' },
    'baby_dragon': { name: 'Baby Dragon', displayName: '🐉 Baby Dragon', rarity: 'legendary', bonus: 1.25, cost: 5000, type: 'pet' },
    'phoenix': { name: 'Phoenix', displayName: '🦅 Phoenix', rarity: 'mythic', bonus: 1.30, cost: 10000, type: 'pet' },
};

const WAGER_ITEMS = {
    'small_gem': { name: 'Small Gem', displayName: '💎 Small Gem', value: 10, type: 'gem' },
    'medium_gem': { name: 'Medium Gem', displayName: '💎 Medium Gem', value: 25, type: 'gem' },
    'large_gem': { name: 'Large Gem', displayName: '💎 Large Gem', value: 50, type: 'gem' },
    'royal_gem': { name: 'Royal Gem', displayName: '💎 Royal Gem', value: 100, type: 'gem' },
};

// ── Pet Bonus ──
function getPetBonus(username, db) {
    const player = db.getPlayer(username);
    if (!player.pet) return 1.0;
    const pet = PETS[player.pet];
    return pet ? pet.bonus : 1.0;
}

// ── Pet Merge ──
function mergePets(pet1, pet2) {
    const rarityOrder = ['common', 'rare', 'epic', 'legendary', 'mythic'];
    const p1 = PETS[pet1];
    const p2 = PETS[pet2];
    if (!p1 || !p2) return null;
    if (p1.rarity !== p2.rarity) return null;

    const currentRarityIndex = rarityOrder.indexOf(p1.rarity);
    if (currentRarityIndex < 0 || currentRarityIndex >= rarityOrder.length - 1) return null;

    if (Math.random() < 0.5) {
        const nextRarity = rarityOrder[currentRarityIndex + 1];
        const upgradeOptions = Object.entries(PETS).filter(([k, v]) => v.rarity === nextRarity);
        if (upgradeOptions.length > 0) {
            return upgradeOptions[Math.floor(Math.random() * upgradeOptions.length)][0];
        }
    }
    return null;
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

module.exports = {
    PETS, WAGER_ITEMS,
    getPetBonus, mergePets,
    activeGames, getActiveGames, getActiveGamesList, getGame,
    createGame, removeGame, clearStaleGames,
    addRecentGame, getRecentGames, MAX_RECENT_GAMES
};
