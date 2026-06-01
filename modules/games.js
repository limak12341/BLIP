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

// ═══════════════════════════════════════════════════════════════
//  JACKPOT SYSTEM
// ═══════════════════════════════════════════════════════════════

const JACKPOT_HOUSE_FEE = 0.1;       // 10%
const JACKPOT_MIN_DEPOSIT = 1;
const JACKPOT_BASE_TIMER_MS = 60000; // 60s
const JACKPOT_EXTEND_MS = 15000;     // przedłuż o 15s jeśli ktoś dołączy w ostatnich 10s
const JACKPOT_MIN_TICKET_VALUE = 1;  // 1 bilet za 1 🪙 wartości
const JACKPOT_DISPLAY_MS = 8000;     // pokaż wynik przez 8s przed nową rundą

let activeJackpot = null;
let jackpotTimer = null;

function generateJackpotId() {
    return 'jp_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

function startJackpotRound() {
    const jp = {
        id: generateJackpotId(),
        status: 'waiting',  // waiting -> drawing -> completed
        pot: { coins: 0, items: [] },
        participants: [],
        totalValue: 0,
        totalTickets: 0,
        timerEnd: Date.now() + JACKPOT_BASE_TIMER_MS,
        houseFee: JACKPOT_HOUSE_FEE,
        winner: null,
        winningTicket: null,
        fairResult: null,
        serverSeed: null,
        clientSeed: null,
        nonce: 0,
        createdAt: Date.now()
    };
    activeJackpot = jp;
    return jp;
}

function getJackpot() {
    return activeJackpot;
}

/**
 * Gracz dołącza do jackpota z depozytem.
 * contribution = { coins: number, items?: [{ name, qty, rap }] }
 * Zwraca { success, tickets, value } lub null.
 */
function addToJackpot(username, contribution, db) {
    if (!activeJackpot || activeJackpot.status !== 'waiting') return null;

    let value = contribution.coins || 0;
    if (contribution.items) {
        for (const item of contribution.items) {
            value += (item.rap || 0) * (item.qty || 1);
        }
    }

    if (value < JACKPOT_MIN_DEPOSIT) return null;

    const player = db.getPlayer(username);
    if (player.coins < (contribution.coins || 0)) return null;

    // Sprawdź itemy
    if (contribution.items) {
        const inv = db.getInventory(username);
        for (const item of contribution.items) {
            const invItem = inv.find(i => i.name === item.name);
            if (!invItem || invItem.qty < item.qty) return null;
        }
    }

    // Odejmij coiny
    if (contribution.coins) {
        player.coins -= contribution.coins;
        db.savePlayer(username, player);
    }

    // Odejmij itemy
    if (contribution.items) {
        for (const item of contribution.items) {
            db.removeInventoryItem(username, item.name, item.qty);
        }
    }

    const tickets = Math.max(1, Math.floor(value / JACKPOT_MIN_TICKET_VALUE));

    activeJackpot.pot.coins += contribution.coins || 0;
    if (contribution.items) {
        for (const item of contribution.items) {
            activeJackpot.pot.items.push({
                name: item.name,
                qty: item.qty,
                rap: item.rap || 0,
                owner: username
            });
        }
    }
    activeJackpot.totalValue += value;
    activeJackpot.totalTickets += tickets;

    const existing = activeJackpot.participants.find(p => p.username === username);
    if (existing) {
        existing.tickets += tickets;
        existing.contribution.coins += contribution.coins || 0;
        if (contribution.items) {
            existing.contribution.items.push(...contribution.items);
        }
    } else {
        activeJackpot.participants.push({
            username,
            avatarUrl: player.avatarUrl || '',
            tickets,
            contribution: {
                coins: contribution.coins || 0,
                items: contribution.items || []
            }
        });
    }

    // Przedłuż timer jeśli ktoś dołączył w ostatnich 10s
    const now = Date.now();
    if (activeJackpot.timerEnd - now < 10000) {
        activeJackpot.timerEnd = now + JACKPOT_EXTEND_MS;
    }

    return { success: true, tickets, value };
}

/**
 * Losuje zwycięzcę jackpota używając Provably Fair.
 */
function drawJackpotWinner(pf) {
    if (!activeJackpot || activeJackpot.status !== 'waiting') return null;
    if (activeJackpot.participants.length === 0) {
        activeJackpot.status = 'completed';
        return null;
    }

    activeJackpot.status = 'drawing';

    if (activeJackpot.participants.length === 1) {
        activeJackpot.winner = activeJackpot.participants[0].username;
        activeJackpot.winningTicket = 0;
        activeJackpot.fairResult = 0;
        activeJackpot.status = 'completed';
        return activeJackpot;
    }

    const serverSeed = pf.getCurrentServerSeed();
    const clientSeed = 'jackpot-' + activeJackpot.id;
    const nonce = 0;
    const fairResult = pf.computeFairResult(serverSeed, clientSeed, nonce);

    const totalTickets = activeJackpot.totalTickets;
    const winningTicket = fairResult % totalTickets;

    let cumulative = 0;
    let winner = null;
    for (const participant of activeJackpot.participants) {
        cumulative += participant.tickets;
        if (winningTicket < cumulative) {
            winner = participant.username;
            break;
        }
    }

    activeJackpot.winner = winner || activeJackpot.participants[0].username;
    activeJackpot.winningTicket = winningTicket;
    activeJackpot.fairResult = fairResult;
    activeJackpot.serverSeed = serverSeed;
    activeJackpot.clientSeed = clientSeed;
    activeJackpot.nonce = nonce;
    activeJackpot.status = 'completed';

    return activeJackpot;
}

/**
 * Rozdaje nagrodę zwycięzcy.
 */
function distributeJackpotPrize(db) {
    if (!activeJackpot || !activeJackpot.winner) return null;

    const prizeValue = Math.floor(activeJackpot.totalValue * (1 - activeJackpot.houseFee));
    const houseFee = activeJackpot.totalValue - prizeValue;

    const winner = db.getPlayer(activeJackpot.winner);
    winner.coins = (winner.coins || 0) + prizeValue;
    winner.totalWon = (winner.totalWon || 0) + prizeValue;
    db.savePlayer(activeJackpot.winner, winner);

    return { prizeValue, houseFee };
}

function endJackpotRound() {
    if (jackpotTimer) {
        clearTimeout(jackpotTimer);
        jackpotTimer = null;
    }
    activeJackpot = null;
}

function setJackpotTimer(timer) {
    jackpotTimer = timer;
}

function getJackpotTimer() {
    return jackpotTimer;
}

// ── Jackpot History ──
const JACKPOT_HISTORY_FILE = path.join(DATA_DIR, 'jackpotHistory.json');
const MAX_JACKPOT_HISTORY = 100;

let jackpotHistory = loadJson(JACKPOT_HISTORY_FILE, []);

function saveJackpotHistory() {
    saveJson(JACKPOT_HISTORY_FILE, jackpotHistory);
}

function addJackpotGame(gameData) {
    jackpotHistory.unshift({
        ...gameData,
        timestamp: Date.now()
    });
    if (jackpotHistory.length > MAX_JACKPOT_HISTORY) {
        jackpotHistory.length = MAX_JACKPOT_HISTORY;
    }
    saveJackpotHistory();
}

function getJackpotHistory() {
    return jackpotHistory;
}

module.exports = {
    activeGames, getActiveGames, getActiveGamesList, getGame,
    createGame, removeGame, clearStaleGames,
    addRecentGame, getRecentGames, MAX_RECENT_GAMES,
    addPvpGame, getPvpHistory, getAllPvpHistory, MAX_PVP_HISTORY,

    // Jackpot
    startJackpotRound, getJackpot,
    addToJackpot, drawJackpotWinner, distributeJackpotPrize,
    endJackpotRound, setJackpotTimer, getJackpotTimer,
    JACKPOT_BASE_TIMER_MS, JACKPOT_DISPLAY_MS, JACKPOT_MIN_DEPOSIT,
    addJackpotGame, getJackpotHistory
};
