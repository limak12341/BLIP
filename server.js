const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Rate limiting ────────────────────────────────────────────
const loginAttempts = new Map(); // ip -> { count, resetAt }
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10000;

// ── Inactivity timeout ──────────────────────────────────────
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const socketActivityTimers = new Map();

function resetInactivityTimer(socket) {
    const existing = socketActivityTimers.get(socket.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        if (socket.connected) {
            socket.emit('sessionExpired', { message: 'Session expired due to inactivity.' });
            socket.disconnect(true);
        }
        socketActivityTimers.delete(socket.id);
    }, INACTIVITY_TIMEOUT_MS);
    socketActivityTimers.set(socket.id, timer);
}

function validateUsername(name) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 20) return false;
    if (!/^[a-zA-Z0-9_\-\u0100-\u024F]+$/.test(trimmed)) return false;
    return true;
}

const db = require('./modules/db');
const pf = require('./modules/provablyFair');
const games = require('./modules/games');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 10000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Provably Fair Routes ──────────────────────────────────────
pf.setupRoutes(app);

// ── Express ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '.')));
app.use(express.json());

// ── Socket.IO ──────────────────────────────────────────────────
const chatHistory = db.loadChat();
const MAX_CHAT_HISTORY = 200;

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    let loggedInUser = null;

    socket.emit('chatHistory', chatHistory.slice(-100));

    socket.on('login', (data) => {
        // Rate limiting
        const ip = socket.handshake?.address || 'unknown';
        const now = Date.now();
        let attempt = loginAttempts.get(ip);
        if (!attempt || now > attempt.resetAt) {
            attempt = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
            loginAttempts.set(ip, attempt);
        }
        attempt.count++;
        if (attempt.count > MAX_LOGIN_ATTEMPTS) {
            const retryAfter = Math.ceil((attempt.resetAt - now) / 1000);
            socket.emit('loginError', { message: `Too many attempts. Try again in ${retryAfter}s.` });
            return;
        }

        const username = (data.username || '').trim();
        
        // Validate username
        if (!validateUsername(username)) {
            socket.emit('loginError', { message: 'Invalid username (2-20 chars, letters/numbers/underscores/hyphens only).' });
            return;
        }

        const ban = db.isBanned(username);
        if (ban) {
            socket.emit('banned', { reason: ban.reason || 'Banned', expires: ban.expires });
            return;
        }
        
        loggedInUser = username;
        
        // Start inactivity timer
        resetInactivityTimer(socket);
        
        const player = db.getPlayer(username);
        socket.emit('loginSuccess', { username, coins: player.coins, gems: player.gems, pet: player.pet, clientSeed: player.clientSeed, nonce: player.nonce, serverSeedHash: pf.getServerSeedHash() });
        socket.broadcast.emit('systemMessage', `${username} joined the game!`);
        io.emit('playerListUpdate');
    });

    socket.on('updateUsername', (data) => {
        const players = db.getAllPlayers();
        const oldName = loggedInUser;
        const newName = data.username;
        if (players[newName]) {
            socket.emit('chatMessage', { user: 'System', msg: 'Username already taken!', time: Date.now() });
            return;
        }
        if (players[oldName]) {
            players[newName] = { ...players[oldName], username: newName };
            delete players[oldName];
            db.saveData(players);
        }
        loggedInUser = newName;
        socket.emit('loginSuccess', { username: newName, coins: players[newName].coins, gems: players[newName].gems, pet: players[newName].pet, clientSeed: players[newName].clientSeed, nonce: players[newName].nonce, serverSeedHash: pf.getServerSeedHash() });
        io.emit('playerListUpdate');
        io.emit('systemMessage', `${oldName} changed name to ${newName}`);
    });

    socket.on('tip', (data) => {
        if (!loggedInUser) return;
        const sender = db.getPlayer(loggedInUser);
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount <= 0) return;
        if (sender.coins < amount) {
            socket.emit('chatMessage', { user: 'System', msg: 'Not enough coins!', time: Date.now() });
            return;
        }
        const receiver = db.getPlayer(data.target);
        sender.coins -= amount;
        receiver.coins += amount;
        db.savePlayer(loggedInUser, sender);
        db.savePlayer(data.target, receiver);
        io.emit('systemMessage', `${loggedInUser} tipped ${amount} coins to ${data.target}! 💰`);
        io.emit('playerListUpdate');
    });

    // Reset inactivity timer on any activity
    socket.onAny(() => {
        if (loggedInUser) resetInactivityTimer(socket);
    });

    socket.on('chatMessage', (data) => {
        if (!loggedInUser) return;
        const msg = (data.msg || '').substring(0, 500);
        const chatMsg = { user: loggedInUser, msg, time: Date.now() };
        chatHistory.push(chatMsg);
        if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
        db.saveChat(chatHistory);
        io.emit('chatMessage', chatMsg);
    });

    socket.on('systemMessage', (data) => {
        if (!loggedInUser) return;
        io.emit('systemMessage', data.msg);
    });

    socket.on('whisper', (data) => {
        if (!loggedInUser) return;
        io.emit('whisper', { from: loggedInUser, to: data.target, msg: data.msg });
    });

    socket.on('coinflip', (data) => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        let amount = parseInt(data.amount);
        if (isNaN(amount) || amount <= 0) return;

        // Support gem wagering
        if (data.item && games.WAGER_ITEMS[data.item]) {
            const gemItem = games.WAGER_ITEMS[data.item];
            if (player.gems < 1) { socket.emit('coinflipResult', { win: false, error: 'No gems!' }); return; }
            player.gems -= 1;
            amount = gemItem.value;
        }

        if (player.coins < amount) {
            socket.emit('coinflipResult', { win: false, error: 'Not enough coins!' });
            return;
        }

        // Check cooldown
        const cooldowns = db.loadCooldowns();
        const now = Date.now();
        if (cooldowns[loggedInUser] && now - cooldowns[loggedInUser] < 500) {
            socket.emit('coinflipResult', { win: false, error: 'Wait a moment!' });
            return;
        }
        cooldowns[loggedInUser] = now;
        db.saveCooldowns(cooldowns);

        const choice = data.choice || 'heads';
        const isWild = data.wild === true;

        // If looking for a game (PVP)
        if (data.findGame) {
            const existingId = Object.keys(games.activeGames).find(id => {
                const g = games.activeGames[id];
                return g.status === 'waiting' && g.creator !== loggedInUser;
            });
            if (existingId) {
                const game = games.activeGames[existingId];
                if (game.amount !== amount) {
                    socket.emit('coinflipResult', { win: false, error: 'Amount mismatch!' });
                    return;
                }
                // Join existing game - use Provably Fair
                const serverSeed = pf.getCurrentServerSeed();
                const clientSeed = player.clientSeed;
                const nonce = player.nonce;
                const fairResult = pf.computeFairResult(serverSeed, clientSeed, nonce);
                const win = fairResult.result < 50 ? (choice === 'heads') : (choice === 'tails');

                // Rotate seeds after each game
                player.nonce++;
                db.savePlayer(loggedInUser, player);
                const gamePlayer = db.getPlayer(game.creator);

                if (win) {
                    const bonus = games.getPetBonus(loggedInUser, db);
                    const winnings = Math.floor(amount * 2 * bonus);
                    player.coins += winnings;
                    db.savePlayer(loggedInUser, player);
                    io.to(game.creatorSocket).emit('coinflipResult', { win: false, amount, result: !win ? 'tails' : 'heads', opponent: loggedInUser, gameOver: true });
                    socket.emit('coinflipResult', { win: true, amount: winnings, result: win ? (choice === 'heads' ? 'heads' : 'tails') : (choice === 'heads' ? 'tails' : 'heads'), opponent: game.creator, gameOver: true, fairHash: fairResult.hash });
                } else {
                    const bonus = games.getPetBonus(game.creator, db);
                    const winnings = Math.floor(amount * 2 * bonus);
                    gamePlayer.coins += winnings;
                    db.savePlayer(game.creator, gamePlayer);
                    io.to(game.creatorSocket).emit('coinflipResult', { win: true, amount: winnings, result: !win ? 'tails' : 'heads', opponent: loggedInUser, gameOver: true, fairHash: fairResult.hash });
                    socket.emit('coinflipResult', { win: false, amount, result: win ? (choice === 'heads' ? 'heads' : 'tails') : (choice === 'heads' ? 'tails' : 'heads'), opponent: game.creator, gameOver: true, fairHash: fairResult.hash });
                }

                // ── Live Feed: add recent game ──
                const winner = win ? loggedInUser : game.creator;
                const loser = win ? game.creator : loggedInUser;
                games.addRecentGame({
                    type: 'coinflip',
                    winner,
                    loser,
                    amount
                });
                io.emit('recentGamesUpdated', games.getRecentGames());

                pf.rotateServerSeed();
                delete games.activeGames[existingId];
                io.emit('gameListUpdate', Object.values(games.activeGames));
                return;
            }

            // Create new game
            player.coins -= amount;
            db.savePlayer(loggedInUser, player);
            const game = {
                id: socket.id + '-' + Date.now(),
                creator: loggedInUser,
                creatorSocket: socket.id,
                amount,
                status: 'waiting',
                choice: choice,
                isWild: isWild,
                timestamp: Date.now()
            };
            games.activeGames[game.id] = game;
            socket.emit('coinflipResult', { waiting: true, gameId: game.id, amount });
            io.emit('gameListUpdate', Object.values(games.activeGames));
            return;
        }

        // Solo coinflip - use Provably Fair
        player.coins -= amount;
        const serverSeed = pf.getCurrentServerSeed();
        const clientSeed = player.clientSeed;
        const nonce = player.nonce;
        const fairResult = pf.computeFairResult(serverSeed, clientSeed, nonce);
        const win = isWild ? Math.random() < 0.5 : (fairResult.result < 50 ? choice === 'heads' : choice === 'tails');

        player.nonce++;

        if (win) {
            const bonus = games.getPetBonus(loggedInUser, db);
            const winnings = Math.floor(amount * 2 * bonus);
            player.coins += winnings;
            player.totalWon += winnings;
            socket.emit('coinflipResult', { win: true, amount: winnings, result: isWild ? 'wild' : (choice === 'heads' ? 'heads' : 'tails'), fairHash: fairResult.hash });
        } else {
            socket.emit('coinflipResult', { win: false, amount, result: isWild ? 'wild' : (choice === 'heads' ? 'tails' : 'heads'), fairHash: fairResult.hash });
        }
        player.totalWagered += amount;
        player.gamesPlayed++;

        // ── Live Feed: add recent game for solo ──
        games.addRecentGame({
            type: 'coinflip',
            winner: win ? loggedInUser : 'House',
            loser: win ? 'House' : loggedInUser,
            amount
        });
        io.emit('recentGamesUpdated', games.getRecentGames());

        // Record fair hash in history
        const gameRecord = {
            serverSeedHash: pf.getServerSeedHash(),
            clientSeed,
            nonce,
            resultHash: fairResult.hash,
            outcome: win ? 'win' : 'loss',
            amount,
            timestamp: Date.now()
        };
        if (!player.gameHistory) player.gameHistory = [];
        player.gameHistory.push(gameRecord);
        if (player.gameHistory.length > 50) player.gameHistory.shift();

        db.savePlayer(loggedInUser, player);
        pf.rotateServerSeed();
        io.emit('playerListUpdate');
    });

    socket.on('getPlayerInfo', (data) => {
        const player = db.getPlayer(data.username);
        socket.emit('playerInfo', {
            username: player.username,
            coins: player.coins,
            gems: player.gems,
            pet: player.pet,
            totalWagered: player.totalWagered || 0,
            totalWon: player.totalWon || 0,
            gamesPlayed: player.gamesPlayed || 0,
            clientSeed: player.clientSeed,
            nonce: player.nonce,
            registered: player.registered
        });
    });

    // Provably Fair - client seed management
    socket.on('getClientSeed', () => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        socket.emit('clientSeedInfo', { clientSeed: player.clientSeed, nonce: player.nonce, serverSeedHash: pf.getServerSeedHash() });
    });

    socket.on('setClientSeed', (data) => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        player.clientSeed = data.seed || db.generateClientSeed();
        player.nonce = 0;
        db.savePlayer(loggedInUser, player);
        socket.emit('clientSeedInfo', { clientSeed: player.clientSeed, nonce: 0, serverSeedHash: pf.getServerSeedHash() });
    });

    socket.on('rotateClientSeed', () => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        player.clientSeed = db.generateClientSeed();
        player.nonce = 0;
        db.savePlayer(loggedInUser, player);
        socket.emit('clientSeedInfo', { clientSeed: player.clientSeed, nonce: 0, serverSeedHash: pf.getServerSeedHash() });
    });

    // Admin - seed management
    socket.on('adminRotateServerSeed', () => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const hash = pf.rotateServerSeed();
        io.emit('serverSeedRotated', { serverSeedHash: hash });
        socket.emit('chatMessage', { user: 'System', msg: 'Server seed rotated!', time: Date.now() });
    });

    // Profile / Stats
    socket.on('getProfile', (data) => {
        const username = data.username || loggedInUser;
        if (!username) return;
        const player = db.getPlayer(username);
        socket.emit('profileInfo', {
            username: player.username,
            coins: player.coins,
            gems: player.gems,
            pet: player.pet,
            totalWagered: player.totalWagered || 0,
            totalWon: player.totalWon || 0,
            gamesPlayed: player.gamesPlayed || 0,
            registered: player.registered,
            clientSeed: player.clientSeed,
            nonce: player.nonce,
            gameHistory: player.gameHistory || []
        });
    });

    // Tip
    socket.on('tipPlayer', (data) => {
        if (!loggedInUser) return;
        const sender = db.getPlayer(loggedInUser);
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount <= 0 || sender.coins < amount) return;
        const receiver = db.getPlayer(data.target);
        sender.coins -= amount;
        receiver.coins += amount;
        db.savePlayer(loggedInUser, sender);
        db.savePlayer(data.target, receiver);
        io.emit('systemMessage', `${loggedInUser} tipped ${amount} coins to ${data.target}! 💰`);
        io.emit('playerListUpdate');
        socket.emit('chatMessage', { user: 'System', msg: `You tipped ${amount} coins to ${data.target}!`, time: Date.now() });
    });

    // Admin actions
    const adminActions = ['adminGiveCoins', 'adminGiveGems', 'adminSetCoins', 'adminResetPlayer', 'adminDeletePlayer'];
    adminActions.forEach(action => {
        socket.on(action, (data) => {
            if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
            const target = db.getPlayer(data.username);
            if (action === 'adminGiveCoins') target.coins += parseInt(data.amount);
            else if (action === 'adminGiveGems') target.gems += parseInt(data.amount);
            else if (action === 'adminSetCoins') target.coins = parseInt(data.amount);
            else if (action === 'adminResetPlayer') {
                const fresh = {
                    username: data.username, coins: 500, gems: 0, registered: Date.now(),
                    lastDaily: 0, totalWagered: 0, totalWon: 0, gamesPlayed: 0,
                    pet: null, roles: [], clientSeed: db.generateClientSeed(), nonce: 0
                };
                db.savePlayer(data.username, fresh);
                io.emit('playerListUpdate');
                socket.emit('adminResult', { success: true });
                return;
            } else if (action === 'adminDeletePlayer') {
                const players = db.loadData();
                delete players[data.username];
                db.saveData(players);
                io.emit('playerListUpdate');
                socket.emit('adminResult', { success: true });
                return;
            }
            db.savePlayer(data.username, target);
            io.emit('playerListUpdate');
            socket.emit('adminResult', { success: true });
        });
    });

    socket.on('adminSendToAll', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        io.emit('systemMessage', data.msg);
    });

    socket.on('adminSetRole', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const target = db.getPlayer(data.username);
        if (!target.roles) target.roles = [];
        if (data.action === 'add' && !target.roles.includes(data.role)) {
            target.roles.push(data.role);
        } else if (data.action === 'remove') {
            target.roles = target.roles.filter(r => r !== data.role);
        }
        db.savePlayer(data.username, target);
        socket.emit('adminResult', { success: true });
    });

    socket.on('adminWarn', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const warnings = db.loadWarnings();
        if (!warnings[data.username]) warnings[data.username] = [];
        warnings[data.username].push({ reason: data.reason, by: loggedInUser, time: Date.now() });
        db.saveWarnings(warnings);
        socket.emit('adminResult', { success: true });
        io.emit('systemMessage', `${data.username} received a warning: ${data.reason}`);
    });

    socket.on('adminBan', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const bans = db.loadBans();
        bans[data.username] = { reason: data.reason, by: loggedInUser, time: Date.now(), expires: data.expires || null };
        db.saveBans(bans);
        io.emit('playerBanned', { username: data.username, reason: data.reason });
        io.emit('systemMessage', `${data.username} has been banned: ${data.reason}`);
        socket.emit('adminResult', { success: true });
    });

    socket.on('adminUnban', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const bans = db.loadBans();
        delete bans[data.username];
        db.saveBans(bans);
        io.emit('systemMessage', `${data.username} has been unbanned.`);
        socket.emit('adminResult', { success: true });
    });

    socket.on('adminDeletePromo', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const promos = db.loadPromo();
        delete promos[data.code];
        db.savePromo(promos);
        socket.emit('adminPromos', promos);
    });

    socket.on('adminSetPassword', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const admin = db.loadAdmin();
        admin.password = data.password;
        db.saveAdmin(admin);
    });

    // Daily reward
    socket.on('dailyReward', () => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        const now = Date.now();
        const msSinceLast = now - (player.lastDaily || 0);
        if (msSinceLast < 86400000) {
            const hoursLeft = Math.ceil((86400000 - msSinceLast) / 3600000);
            socket.emit('chatMessage', { user: 'System', msg: `Daily in ${hoursLeft}h!`, time: now });
            return;
        }
        const reward = 200;
        player.coins += reward;
        player.lastDaily = now;
        db.savePlayer(loggedInUser, player);
        socket.emit('chatMessage', { user: 'System', msg: `Daily ${reward} coins claimed!`, time: now });
        io.emit('playerListUpdate');
    });

    // Shop
    socket.on('buyItem', (data) => {
        if (!loggedInUser) return;
        const player = db.getPlayer(loggedInUser);
        const item = games.PETS[data.item] || games.WAGER_ITEMS[data.item];
        if (!item) return;
        if (player.coins < item.cost && item.cost) {
            socket.emit('chatMessage', { user: 'System', msg: 'Not enough coins!', time: Date.now() });
            return;
        }
        if (item.cost) {
            player.coins -= item.cost;
        }
        if (item.type === 'pet') {
            if (player.pet) {
                // Pet merge system
                const currentPet = games.PETS[player.pet];
                if (currentPet && currentPet.rarity === item.rarity) {
                    const mergeResult = games.mergePets(player.pet, data.item);
                    if (mergeResult) {
                        player.pet = mergeResult;
                        socket.emit('chatMessage', { user: 'System', msg: `Pets merged! You got ${games.PETS[mergeResult].displayName}!`, time: Date.now() });
                    } else {
                        socket.emit('chatMessage', { user: 'System', msg: 'Merge failed! Pet lost.', time: Date.now() });
                        player.pet = null;
                    }
                } else {
                    socket.emit('chatMessage', { user: 'System', msg: `You can only merge pets of the same rarity! You have ${currentPet ? currentPet.displayName : 'none'}.`, time: Date.now() });
                    player.coins += item.cost; // Refund
                }
            } else {
                player.pet = data.item;
                socket.emit('chatMessage', { user: 'System', msg: `You bought ${item.displayName}!`, time: Date.now() });
            }
        } else if (item.type === 'gem') {
            player.gems += 1;
            socket.emit('chatMessage', { user: 'System', msg: `You bought 1x ${item.displayName}!`, time: Date.now() });
        }
        db.savePlayer(loggedInUser, player);
        io.emit('playerListUpdate');
    });

    socket.on('usePromo', (data) => {
        if (!loggedInUser) return;
        const result = db.applyPromoBonus(loggedInUser, data.code);
        if (result && result.error) {
            socket.emit('chatMessage', { user: 'System', msg: result.error, time: Date.now() });
        } else if (result && result.success) {
            socket.emit('chatMessage', { user: 'System', msg: `Promo applied: +${result.value} ${result.type}!`, time: Date.now() });
        } else {
            socket.emit('chatMessage', { user: 'System', msg: 'Invalid code!', time: Date.now() });
        }
        io.emit('playerListUpdate');
    });

    // Admin data
    socket.on('adminGetPlayers', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const players = db.getAllPlayers();
        const page = data.page || 1;
        const search = data.search || '';
        const pageSize = 20;
        let list = Object.values(players);
        if (search) list = list.filter(p => p.username && p.username.toLowerCase().includes(search.toLowerCase()));
        const totalPages = Math.ceil(list.length / pageSize);
        const paginated = list.slice((page - 1) * pageSize, page * pageSize);
        socket.emit('adminPlayers', { players: paginated, totalPages, page });
    });

    socket.on('adminGetPlayer', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const player = db.getPlayer(data.username);
        socket.emit('adminPlayerDetail', player);
    });

    socket.on('adminGetLogs', () => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        try {
            const logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8'));
            socket.emit('adminLogs', logs);
        } catch (e) {
            socket.emit('adminLogs', []);
        }
    });

    socket.on('adminGetWarnings', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const warnings = db.loadWarnings();
        socket.emit('adminWarnings', data && data.username ? { [data.username]: warnings[data.username] || [] } : warnings);
    });

    socket.on('adminGetBans', () => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const bans = db.loadBans();
        socket.emit('adminBans', bans);
    });

    socket.on('adminLogin', (data) => {
        const admin = db.loadAdmin();
        if (data.password === admin.password) {
            const player = db.getPlayer(data.username);
            if (!player.roles) player.roles = [];
            if (!player.roles.includes('admin')) {
                player.roles.push('admin');
                db.savePlayer(data.username, player);
            }
            socket.emit('adminLoginSuccess', { success: true });
        } else {
            socket.emit('adminLoginSuccess', { success: false });
        }
    });

    socket.on('adminGetPromos', () => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const promos = db.loadPromo();
        socket.emit('adminPromos', promos);
    });

    socket.on('adminCreatePromo', (data) => {
        if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
        const promos = db.loadPromo();
        promos[data.code] = {
            code: data.code,
            rewardType: data.rewardType || 'coins',
            rewardValue: parseInt(data.rewardValue) || 100,
            maxUses: parseInt(data.maxUses) || 10,
            used: 0,
            usedBy: []
        };
        db.savePromo(promos);
        socket.emit('adminPromos', promos);
    });

    socket.on('leaderboard', () => {
        const players = db.getAllPlayers();
        const sorted = Object.values(players)
            .filter(p => p.coins > 0)
            .sort((a, b) => b.coins - a.coins)
            .slice(0, 50)
            .map((p, i) => ({ rank: i + 1, username: p.username, coins: p.coins, gems: p.gems, pet: p.pet }));
        socket.emit('leaderboardData', sorted);
    });

    // ── Live Feed: send recent games on request ──
    socket.on('getRecentGames', () => {
        socket.emit('recentGamesUpdated', games.getRecentGames());
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        const timer = socketActivityTimers.get(socket.id);
        if (timer) clearTimeout(timer);
        socketActivityTimers.delete(socket.id);
        Object.keys(games.activeGames).forEach(id => {
            if (games.activeGames[id].creatorSocket === socket.id) {
                if (games.activeGames[id].status === 'waiting') {
                    const player = db.getPlayer(games.activeGames[id].creator);
                    player.coins += games.activeGames[id].amount;
                    db.savePlayer(games.activeGames[id].creator, player);
                }
                delete games.activeGames[id];
            }
        });
        io.emit('gameListUpdate', Object.values(games.activeGames));
        io.emit('playerListUpdate');
    });
});

// ── Clear inactive games periodically ─────────────────────────
games.clearStaleGames(db);

setInterval(() => {
    games.clearStaleGames(db);
}, 60000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    
    // Emit initial recent games broadcast
    setInterval(() => {
        io.emit('recentGamesUpdated', games.getRecentGames());
    }, 15000);
});
