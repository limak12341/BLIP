/**
 * Socket.IO — wszystkie event handlery
 */

const crypto = require('crypto');

module.exports = function setupSocketHandlers(io, context) {
    const { db, pf, games, redis, jackpot } = context;
    const {
        chatHistory, disconnectTimeouts, socketActivityTimers, socketRateLimits,
        MIN_BET, MAX_SOLO_BET, MAX_PVP_BET,
        CHAT_RATE_MAX, CHAT_RATE_WINDOW,
        TIP_RATE_MAX, TIP_RATE_WINDOW,
        MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_MS,
        MAX_LOGIN_PER_USER, LOGIN_USER_WINDOW_MS,
        DISCONNECT_GRACE_MS, INACTIVITY_TIMEOUT_MS,
        MAX_CHAT_HISTORY,
        validateUsername, validateClientSeed,
        checkRateLimit, resetInactivityTimer, normalizeChatMsg
    } = context;

    // ── Sync chat → Redis (przy starcie) ──
    (async () => {
        try {
            const redisCount = await redis.getChatHistoryCount();
            if (redisCount === 0 && chatHistory.length > 0) {
                for (const msg of chatHistory.slice(-100).reverse()) {
                    await redis.addChatMessage(msg);
                }
                console.log('[Chat] Synced', chatHistory.length, 'messages to Redis');
            }
        } catch (e) { /* Redis not available */ }
    })();

    io.on('connection', (socket) => {
        console.log('New connection:', socket.id);
        let loggedInUser = null;

        // ── Send initial state on connect ──
        socket.emit('chatHistory', chatHistory.slice(-100).map(normalizeChatMsg));
        socket.emit('gamesList', Object.values(games.activeGames));

        // ── Process chat message ──
        function processChatMessage(user, rawMsg) {
            if (!user) return;
            if (!checkRateLimit(`chat:${user}`, CHAT_RATE_MAX, CHAT_RATE_WINDOW)) return;

            const msg = (rawMsg || '').substring(0, 500);
            if (!msg.trim()) return;

            const filterData = db.loadFilter();
            if (filterData.enabled !== false && filterData.words && filterData.words.length > 0) {
                const lowerMsg = msg.toLowerCase();
                let found = false;
                for (let fi = 0; fi < filterData.words.length; fi++) {
                    const fword = filterData.words[fi];
                    if (fword && lowerMsg.indexOf(fword.toLowerCase()) !== -1) { found = true; break; }
                }
                if (found) {
                    if (filterData.punishment === 'block' || filterData.punishment === 'warn') {
                        socket.emit('newChatMessage', {
                            userId: 'system', username: 'System', avatarUrl: '', role: '',
                            message: '⚠️ Your message contains prohibited words!', timestamp: Date.now()
                        });
                        return;
                    } else if (filterData.punishment === 'censor') {
                        let censored = msg;
                        for (let ci = 0; ci < filterData.words.length; ci++) {
                            const cword = filterData.words[ci];
                            if (cword) {
                                const re = new RegExp(cword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                                censored = censored.replace(re, '***');
                            }
                        }
                        const playerInfo = db.getPlayer(user);
                        const newMsg = {
                            userId: user, username: user,
                            avatarUrl: playerInfo.avatarUrl || '',
                            role: (playerInfo.roles && playerInfo.roles.length > 0) ? playerInfo.roles[0] : '',
                            message: db.escapeHtml(censored),
                            timestamp: Date.now()
                        };
                        chatHistory.push(newMsg);
                        if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
                        db.saveChat(chatHistory);
                        redis.addChatMessage(newMsg).catch(() => {});
                        io.emit('newChatMessage', newMsg);
                        return;
                    }
                }
            }

            const playerInfo = db.getPlayer(user);
            const newMsg = {
                userId: user, username: user,
                avatarUrl: playerInfo.avatarUrl || '',
                role: (playerInfo.roles && playerInfo.roles.length > 0) ? playerInfo.roles[0] : '',
                message: db.escapeHtml(msg),
                timestamp: Date.now()
            };
            chatHistory.push(newMsg);
            if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
            db.saveChat(chatHistory);
            redis.addChatMessage(newMsg).catch(() => {});
            io.emit('newChatMessage', newMsg);
        }

        // ── login ──
        socket.on('login', async (data) => {
            const ip = socket.handshake?.address || 'unknown';
            const username = (data.username || '').trim();

            const rateResult = await redis.checkLoginRateLimit(
                ip, username,
                MAX_LOGIN_ATTEMPTS, MAX_LOGIN_PER_USER,
                LOGIN_WINDOW_MS
            );
            if (!rateResult.ok) {
                socket.emit('loginError', { message: 'Too many attempts. Try again later.' });
                return;
            }

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
            resetInactivityTimer(socket, socketActivityTimers);

            const player = db.getPlayer(username);
            socket.emit('loginSuccess', {
                username, coins: player.coins, gems: player.gems,
                pet: player.pet, clientSeed: player.clientSeed,
                nonce: player.nonce, serverSeedHash: pf.getServerSeedHash()
            });

            const pendingDisconnect = disconnectTimeouts.get(username);
            if (pendingDisconnect) {
                clearTimeout(pendingDisconnect.timeout);
                disconnectTimeouts.delete(username);
                if (pendingDisconnect.opponentSocket) {
                    const opponentSocket = io.sockets.sockets.get(pendingDisconnect.opponentSocket);
                    if (opponentSocket && opponentSocket.connected) {
                        opponentSocket.emit('chatMessage', {
                            user: 'System',
                            msg: `${username} reconnected! The game continues.`,
                            time: Date.now()
                        });
                    }
                }
            }

            socket.broadcast.emit('systemMessage', `${username} joined the game!`);
            io.emit('playerListUpdate');
        });

        // ── updateUsername ──
        socket.on('updateUsername', (data) => {
            if (!checkRateLimit(`updateName:${loggedInUser}`, 1, 10000)) return;
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
            const p = players[newName];
            socket.emit('loginSuccess', {
                username: newName, coins: p.coins, gems: p.gems, pet: p.pet,
                clientSeed: p.clientSeed, nonce: p.nonce, serverSeedHash: pf.getServerSeedHash()
            });
            io.emit('playerListUpdate');
            io.emit('systemMessage', `${oldName} changed name to ${newName}`);
        });

        // ── tip (socket version) ──
        socket.on('tip', (data) => {
            if (!loggedInUser) return;
            if (!checkRateLimit(`tip:${loggedInUser}`, TIP_RATE_MAX, TIP_RATE_WINDOW)) return;
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

        // ── Reset inactivity timer on any activity ──
        socket.onAny(() => {
            if (loggedInUser) resetInactivityTimer(socket, socketActivityTimers);
        });

        // ── Chat events ──
        socket.on('sendChatMessage', (data) => {
            processChatMessage(loggedInUser, data.message || data.msg || '');
        });

        socket.on('chatMessage', (data) => {
            processChatMessage(loggedInUser, data.msg || data.message || '');
        });

        socket.on('systemMessage', (data) => {
            if (!loggedInUser) return;
            io.emit('systemMessage', db.escapeHtml((data.msg || '').substring(0, 500)));
        });

        socket.on('whisper', (data) => {
            if (!loggedInUser) return;
            if (!checkRateLimit(`whisper:${loggedInUser}`, 3, 2000)) return;
            io.emit('whisper', {
                from: loggedInUser,
                to: data.target,
                msg: db.escapeHtml((data.msg || '').substring(0, 500))
            });
        });

        // ── Coinflip ──
        socket.on('coinflip', (data) => {
            if (!loggedInUser) return;
            const player = db.getPlayer(loggedInUser);
            let amount = parseInt(data.amount);
            if (isNaN(amount) || amount <= 0) return;

            if (amount < MIN_BET) {
                socket.emit('coinflipResult', { win: false, error: `Minimum bet is ${MIN_BET}!` });
                return;
            }
            const isPVP = data.findGame === true;
            const maxBet = isPVP ? MAX_PVP_BET : MAX_SOLO_BET;
            if (amount > maxBet) {
                socket.emit('coinflipResult', { win: false, error: `Max ${isPVP ? 'PVP' : 'solo'} bet is ${maxBet}!` });
                return;
            }

            if (player.coins < amount) {
                socket.emit('coinflipResult', { win: false, error: 'Not enough coins!' });
                return;
            }

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

            // PVP Find Game
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
                    game.status = 'active';
                    game.opponent = loggedInUser;
                    game.opponentSocket = socket.id;

                    const serverSeed = pf.getCurrentServerSeed();
                    const clientSeed = player.clientSeed;
                    const nonce = player.nonce;
                    const fairResult = pf.computeFairResult(serverSeed, clientSeed, nonce);
                    const win = fairResult < 500000 ? (choice === 'heads') : (choice === 'tails');

                    player.nonce++;
                    db.savePlayer(loggedInUser, player);
                    const gamePlayer = db.getPlayer(game.creator);

                    const pfData = { serverSeed, clientSeed, nonce: player.nonce - 1, result: fairResult, win, gameId: existingId };

                    if (win) {
                        const winnings = Math.floor(amount * 2);
                        player.coins += winnings;
                        db.savePlayer(loggedInUser, player);
                        io.to(game.creatorSocket).emit('coinflipResult', { win: false, amount, result: !win ? 'tails' : 'heads', opponent: loggedInUser, gameOver: true });
                        io.to(game.creatorSocket).emit('provablyFairResult', { ...pfData, opponent: true });
                        socket.emit('coinflipResult', { win: true, amount: winnings, result: win ? (choice === 'heads' ? 'heads' : 'tails') : (choice === 'heads' ? 'tails' : 'heads'), opponent: game.creator, gameOver: true });
                        socket.emit('provablyFairResult', { ...pfData, opponent: false });
                    } else {
                        const winnings = Math.floor(amount * 2);
                        gamePlayer.coins += winnings;
                        db.savePlayer(game.creator, gamePlayer);
                        io.to(game.creatorSocket).emit('coinflipResult', { win: true, amount: winnings, result: !win ? 'tails' : 'heads', opponent: loggedInUser, gameOver: true });
                        io.to(game.creatorSocket).emit('provablyFairResult', { ...pfData, opponent: true });
                        socket.emit('coinflipResult', { win: false, amount, result: win ? (choice === 'heads' ? 'heads' : 'tails') : (choice === 'heads' ? 'tails' : 'heads'), opponent: game.creator, gameOver: true });
                        socket.emit('provablyFairResult', { ...pfData, opponent: false });
                    }

                    const winner = win ? loggedInUser : game.creator;
                    const loser = win ? game.creator : loggedInUser;
                    games.addRecentGame({ type: 'coinflip', winner, loser, amount });
                    io.emit('recentGamesUpdated', games.getRecentGames());

                    const joinerPlayer = db.getPlayer(loggedInUser);
                    const creatorPlayer = db.getPlayer(game.creator);
                    games.addPvpGame({
                        creator: { username: game.creator, side: game.choice || 'heads', won: !win, avatarUrl: creatorPlayer.avatarUrl || '' },
                        joiner: { username: loggedInUser, side: choice, won: win, avatarUrl: joinerPlayer.avatarUrl || '' },
                        totalValue: amount * 2
                    });

                    const pvpGameRecord = {
                        serverSeedHash: pf.getServerSeedHash(),
                        clientSeed, nonce, result: fairResult,
                        outcome: win ? 'win' : 'loss', amount, type: 'pvp',
                        opponent: win ? game.creator : loggedInUser,
                        timestamp: Date.now()
                    };
                    if (!creatorPlayer.gameHistory) creatorPlayer.gameHistory = [];
                    creatorPlayer.gameHistory.push({ ...pvpGameRecord, outcome: !win ? 'win' : 'loss', opponent: loggedInUser });
                    if (creatorPlayer.gameHistory.length > 50) creatorPlayer.gameHistory.shift();
                    db.savePlayer(game.creator, creatorPlayer);

                    if (!joinerPlayer.gameHistory) joinerPlayer.gameHistory = [];
                    joinerPlayer.gameHistory.push(pvpGameRecord);
                    if (joinerPlayer.gameHistory.length > 50) joinerPlayer.gameHistory.shift();
                    db.savePlayer(loggedInUser, joinerPlayer);

                    pf.rotateServerSeed();
                    delete games.activeGames[existingId];
                    io.emit('gamesList', Object.values(games.activeGames));
                    return;
                }

                // Create new game
                if (!checkRateLimit(`createGame:${loggedInUser}`, 1, 5000)) {
                    socket.emit('coinflipResult', { win: false, error: 'You can only create 1 game per 5 seconds!' });
                    return;
                }
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
                io.emit('gamesList', Object.values(games.activeGames));
                return;
            }

            // Solo coinflip
            player.coins -= amount;
            const serverSeed = pf.getCurrentServerSeed();
            const clientSeed = player.clientSeed;
            const nonce = player.nonce;
            const fairResult = pf.computeFairResult(serverSeed, clientSeed, nonce);
            const win = isWild ? Math.random() < 0.49 : (fairResult < 490000 ? choice === 'heads' : choice === 'tails');

            player.nonce++;

            const pfData = { serverSeed, clientSeed, nonce: nonce, result: fairResult, win, gameId: socket.id + '-' + Date.now() };

            if (win) {
                const winnings = Math.floor(amount * 2);
                player.coins += winnings;
                player.totalWon += winnings;
                socket.emit('coinflipResult', { win: true, amount: winnings, result: isWild ? 'wild' : (choice === 'heads' ? 'heads' : 'tails') });
            } else {
                socket.emit('coinflipResult', { win: false, amount, result: isWild ? 'wild' : (choice === 'heads' ? 'tails' : 'heads') });
            }
            socket.emit('provablyFairResult', pfData);

            player.totalWagered += amount;
            player.gamesPlayed++;

            games.addRecentGame({ type: 'coinflip', winner: win ? loggedInUser : 'House', loser: win ? 'House' : loggedInUser, amount });
            io.emit('recentGamesUpdated', games.getRecentGames());

            const gameRecord = {
                serverSeedHash: pf.getServerSeedHash(), clientSeed, nonce, result: fairResult,
                outcome: win ? 'win' : 'loss', amount, timestamp: Date.now()
            };
            if (!player.gameHistory) player.gameHistory = [];
            player.gameHistory.push(gameRecord);
            if (player.gameHistory.length > 50) player.gameHistory.shift();

            db.savePlayer(loggedInUser, player);
            pf.rotateServerSeed();
            io.emit('playerListUpdate');
        });

        // ── getPlayerInfo ──
        socket.on('getPlayerInfo', (data) => {
            const player = db.getPlayer(data.username);
            socket.emit('playerInfo', {
                username: player.username, coins: player.coins, gems: player.gems,
                pet: player.pet, totalWagered: player.totalWagered || 0,
                totalWon: player.totalWon || 0, gamesPlayed: player.gamesPlayed || 0,
                clientSeed: player.clientSeed, nonce: player.nonce, registered: player.registered
            });
        });

        // ── Client Seed management ──
        socket.on('getClientSeed', () => {
            if (!loggedInUser) return;
            const player = db.getPlayer(loggedInUser);
            socket.emit('clientSeedInfo', { clientSeed: player.clientSeed, nonce: player.nonce, serverSeedHash: pf.getServerSeedHash() });
        });

        socket.on('setClientSeed', (data) => {
            if (!loggedInUser) return;
            const player = db.getPlayer(loggedInUser);
            const newSeed = data.seed;
            if (newSeed && !validateClientSeed(newSeed)) {
                socket.emit('chatMessage', { user: 'System', msg: 'Invalid client seed (4-64 chars, letters/numbers/underscores/hyphens only).', time: Date.now() });
                return;
            }
            player.clientSeed = newSeed || db.generateClientSeed();
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

        // ── Admin rotate seed ──
        socket.on('adminRotateServerSeed', () => {
            if (!loggedInUser || !db.hasRole(loggedInUser, 'admin')) return;
            const hash = pf.rotateServerSeed();
            io.emit('serverSeedRotated', { serverSeedHash: hash });
            socket.emit('chatMessage', { user: 'System', msg: 'Server seed rotated!', time: Date.now() });
        });

        // ── Profile ──
        socket.on('getProfile', (data) => {
            const username = data.username || loggedInUser;
            if (!username) return;
            const player = db.getPlayer(username);
            socket.emit('profileInfo', {
                username: player.username, coins: player.coins, gems: player.gems,
                pet: player.pet, totalWagered: player.totalWagered || 0,
                totalWon: player.totalWon || 0, gamesPlayed: player.gamesPlayed || 0,
                registered: player.registered, clientSeed: player.clientSeed,
                nonce: player.nonce, gameHistory: player.gameHistory || []
            });
        });

        // ── Tip Player (socket) ──
        socket.on('tipPlayer', (data) => {
            if (!loggedInUser) return;
            if (!checkRateLimit(`tipPlayer:${loggedInUser}`, TIP_RATE_MAX, TIP_RATE_WINDOW)) return;
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

        // ── Admin actions ──
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
                        username: data.username, coins: 0, gems: 0, registered: Date.now(),
                        totalWagered: 0, totalWon: 0, gamesPlayed: 0,
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
            const fs = require('fs');
            const path = require('path');
            try {
                const logs = JSON.parse(fs.readFileSync(path.join(context.DATA_DIR, 'logs.json'), 'utf8'));
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
            if (db.verifyAdminPasswordSync(data.password, admin.password)) {
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
            const rewards = data.rewards || [{ type: data.rewardType || 'coins', amount: parseInt(data.rewardValue) || 100 }];
            promos[data.code] = {
                code: data.code,
                rewards: rewards,
                maxUses: parseInt(data.maxUses) || 10,
                active: true,
                used: 0,
                usedBy: [],
                createdBy: loggedInUser,
                createdAt: Date.now()
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

        // ── Cancel PVP Game ──
        socket.on('cancelGame', (data) => {
            if (!loggedInUser) {
                socket.emit('gameCancelled', { success: false, error: 'Not logged in.' });
                return;
            }
            const gameId = data?.gameId;
            if (!gameId) {
                socket.emit('gameCancelled', { success: false, error: 'No game ID provided.' });
                return;
            }
            const game = games.activeGames[gameId];
            if (!game) {
                socket.emit('gameCancelled', { success: false, error: 'Game not found.' });
                return;
            }
            const creatorName = typeof game.creator === 'string' ? game.creator : (game.creator?.username || '');
            if (creatorName !== loggedInUser) {
                socket.emit('gameCancelled', { success: false, error: 'You are not the creator of this game.' });
                return;
            }
            if (game.status !== 'waiting') {
                socket.emit('gameCancelled', { success: false, error: 'Game already started or finished.' });
                return;
            }
            // Refund items or coins
            if (game.items && game.items.length > 0) {
                for (const item of game.items) {
                    db.addInventoryItem(loggedInUser, item.name, item.qty || 1, item.rap || 0);
                }
                socket.emit('gameCancelled', { success: true, items: game.items });
            } else {
                const player = db.getPlayer(loggedInUser);
                player.coins += game.amount;
                db.savePlayer(loggedInUser, player);
                socket.emit('gameCancelled', { success: true, amount: game.amount });
            }
            delete games.activeGames[gameId];
            io.emit('gamesList', Object.values(games.activeGames));
            io.emit('playerListUpdate');
        });

        // ── Coinflip z itemami: createGame ──
        socket.on('createGame', (data) => {
            if (!loggedInUser) {
                socket.emit('gameError', 'Musisz być zalogowany!');
                return;
            }
            if (!checkRateLimit(`createItemGame:${loggedInUser}`, 1, 5000)) {
                socket.emit('gameError', 'Możesz stworzyć tylko 1 grę na 5 sekund!');
                return;
            }
            const items = data.items || [];
            if (!items.length) {
                socket.emit('gameError', 'Wybierz przynajmniej 1 item do zakładu!');
                return;
            }
            const player = db.getPlayer(loggedInUser);
            const inv = db.getInventory(loggedInUser);
            // Validate items in inventory
            for (const item of items) {
                const invItem = inv.find(i => i.name === item.name);
                if (!invItem || (invItem.qty || 1) < (item.qty || 1)) {
                    socket.emit('gameError', `Nie masz wystarczająco ${item.name} w inventarzu!`);
                    return;
                }
            }
            const totalValue = items.reduce((sum, it) => sum + (it.rap || 0) * (it.qty || 1), 0);
            if (totalValue < MIN_BET) {
                socket.emit('gameError', `Minimalna wartość zakładu to ${MIN_BET}!`);
                return;
            }
            // Check hugeBet mode items
            if (data.hugeBet) {
                const allowed = items.every(it => {
                    const n = it.name.toLowerCase();
                    return n.includes('titanic') || n.includes('gargantuan') || n.startsWith('gem 💎');
                });
                if (!allowed) {
                    socket.emit('gameError', 'Tryb Huge BET wymaga tylko Titanic/Gargantuan/Gemów!');
                    return;
                }
            }
            // Remove items from creator's inventory
            for (const item of items) {
                db.removeInventoryItem(loggedInUser, item.name, item.qty || 1);
            }
            const game = {
                id: 'game_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
                creator: {
                    username: loggedInUser,
                    avatarUrl: player.avatarUrl || '',
                    side: data.side || 'heads',
                    socketId: socket.id
                },
                items: items,
                totalValue: totalValue,
                status: 'waiting',
                wildMode: data.wildMode || false,
                hugeBet: data.hugeBet || false,
                timestamp: Date.now(),
                joiner: null,
                joinerItems: [],
                joinValue: 0
            };
            games.createGame(game.id, game);
            socket.emit('gameCreated', { gameId: game.id });
            io.emit('gamesList', Object.values(games.activeGames));
            io.emit('playerListUpdate');
        });

        // ── Coinflip z itemami: joinGame ──
        socket.on('joinGame', (data) => {
            if (!loggedInUser) {
                socket.emit('gameError', 'Musisz być zalogowany!');
                return;
            }
            if (!checkRateLimit(`joinItemGame:${loggedInUser}`, 2, 5000)) {
                socket.emit('gameError', 'Zbyt szybko! Odczekaj chwilę.');
                return;
            }
            const game = games.getGame(data.gameId);
            if (!game || game.status !== 'waiting') {
                socket.emit('gameError', 'Gra nie istnieje lub już się rozpoczęła!');
                return;
            }
            if (game.creator.username === loggedInUser) {
                socket.emit('gameError', 'Nie możesz dołączyć do własnej gry!');
                return;
            }
            const items = data.items || [];
            if (!items.length) {
                socket.emit('gameError', 'Wybierz przynajmniej 1 item do zakładu!');
                return;
            }
            const player = db.getPlayer(loggedInUser);
            const inv = db.getInventory(loggedInUser);
            // Validate items in inventory
            for (const item of items) {
                const invItem = inv.find(i => i.name === item.name);
                if (!invItem || (invItem.qty || 1) < (item.qty || 1)) {
                    socket.emit('gameError', `Nie masz wystarczająco ${item.name} w inventarzu!`);
                    return;
                }
            }
            const joinValue = items.reduce((sum, it) => sum + (it.rap || 0) * (it.qty || 1), 0);
            // Check ±7.5% range
            const minVal = Math.round(game.totalValue * 0.925);
            const maxVal = Math.round(game.totalValue * 1.075);
            if (joinValue < minVal || joinValue > maxVal) {
                socket.emit('gameError', `Twój zakład musi być w zakresie ±7.5% (${db.fmt(minVal)} - ${db.fmt(maxVal)})!`);
                return;
            }
            // Check hugeBet mode
            if (game.hugeBet) {
                const allowed = items.every(it => {
                    const n = it.name.toLowerCase();
                    return n.includes('titanic') || n.includes('gargantuan') || n.startsWith('gem 💎');
                });
                if (!allowed) {
                    socket.emit('gameError', 'Ta gra wymaga tylko Titanic/Gargantuan/Gemów!');
                    return;
                }
            }
            // Remove items from joiner's inventory
            for (const item of items) {
                db.removeInventoryItem(loggedInUser, item.name, item.qty || 1);
            }
            // Update game state
            const joinerSide = game.creator.side === 'heads' ? 'tails' : 'heads';
            game.status = 'active';
            game.joiner = {
                username: loggedInUser,
                avatarUrl: player.avatarUrl || '',
                side: joinerSide,
                socketId: socket.id
            };
            game.joinerItems = items;
            game.joinValue = joinValue;
            // Provably Fair coinflip
            const serverSeed = pf.getCurrentServerSeed();
            const clientSeed = player.clientSeed;
            const nonce = player.nonce;
            const fairResult = pf.computeFairResult(serverSeed, clientSeed, nonce);
            const headsWins = fairResult < 500000;
            const winningSide = headsWins ? 'heads' : 'tails';
            const joinerWins = joinerSide === winningSide;
            // Update nonce
            player.nonce = (player.nonce || 0) + 1;
            db.savePlayer(loggedInUser, player);
            // Transfer items to winner
            // Update creator stats regardless of outcome
            const creatorPlayer = db.getPlayer(game.creator.username);
            creatorPlayer.totalWagered = (creatorPlayer.totalWagered || 0) + game.totalValue;
            if (!joinerWins) {
                creatorPlayer.totalWon = (creatorPlayer.totalWon || 0) + game.totalValue + game.joinValue;
            }
            creatorPlayer.gamesPlayed = (creatorPlayer.gamesPlayed || 0) + 1;
            db.savePlayer(game.creator.username, creatorPlayer);
            // Transfer items to winner
            if (joinerWins) {
                // Joiner wins - gets creator's items + keeps own
                for (const item of game.items) {
                    db.addInventoryItem(loggedInUser, item.name, item.qty || 1, item.rap || 0);
                }
                for (const item of game.joinerItems) {
                    db.addInventoryItem(loggedInUser, item.name, item.qty || 1, item.rap || 0);
                }
            } else {
                // Creator wins - gets joiner's items + keeps own
                for (const item of game.joinerItems) {
                    db.addInventoryItem(game.creator.username, item.name, item.qty || 1, item.rap || 0);
                }
                for (const item of game.items) {
                    db.addInventoryItem(game.creator.username, item.name, item.qty || 1, item.rap || 0);
                }
            }
            // Update joiner stats
            player.totalWagered = (player.totalWagered || 0) + game.joinValue;
            if (joinerWins) {
                player.totalWon = (player.totalWon || 0) + game.totalValue + game.joinValue;
            }
            player.gamesPlayed = (player.gamesPlayed || 0) + 1;
            db.savePlayer(loggedInUser, player);
            // Set winner
            game.winner = joinerWins ? loggedInUser : game.creator.username;
            game.winningSide = winningSide;
            // Provably fair data
            const pfData = {
                serverSeed,
                serverSeedHash: pf.getServerSeedHash(),
                clientSeed,
                nonce: nonce,
                result: fairResult,
                win: joinerWins,
                gameId: game.id,
                winningSide
            };
            // Emit flipStart to both players
            const flipData = {
                id: game.id,
                creator: { username: game.creator.username, avatarUrl: game.creator.avatarUrl, side: game.creator.side },
                joiner: { username: game.joiner.username, avatarUrl: game.joiner.avatarUrl, side: game.joiner.side },
                items: game.items,
                joinerItems: game.joinerItems,
                totalValue: game.totalValue,
                joinValue: game.joinValue,
                prize: game.totalValue + game.joinValue
            };
            io.to(game.creator.socketId).emit('flipStart', flipData);
            io.to(game.joiner.socketId).emit('flipStart', flipData);
            io.to(game.creator.socketId).emit('provablyFairResult', pfData);
            io.to(game.joiner.socketId).emit('provablyFairResult', pfData);
            // Game result after flip animation (2200ms = FLIP_MS)
            setTimeout(() => {
                const resultData = {
                    ...flipData,
                    winningSide,
                    winner: game.winner
                };
                io.to(game.creator.socketId).emit('gameResult', { ...resultData, won: !joinerWins });
                io.to(game.joiner.socketId).emit('gameResult', { ...resultData, won: joinerWins });
                // Add to recent games & history
                const winnerName = game.winner;
                const loserName = joinerWins ? game.creator.username : loggedInUser;
                games.addRecentGame({
                    type: 'coinflip',
                    winner: winnerName,
                    loser: loserName,
                    amount: game.totalValue + game.joinValue
                });
                io.emit('recentGamesUpdated', games.getRecentGames());
                // Add PVP history
                const creatorPlayer2 = db.getPlayer(game.creator.username);
                const joinerPlayer2 = db.getPlayer(loggedInUser);
                games.addPvpGame({
                    creator: { username: game.creator.username, side: game.creator.side, won: !joinerWins, avatarUrl: creatorPlayer2.avatarUrl || '' },
                    joiner: { username: game.joiner.username, side: game.joiner.side, won: joinerWins, avatarUrl: joinerPlayer2.avatarUrl || '' },
                    totalValue: game.totalValue + game.joinValue
                });
                // Save game history for players
                if (!creatorPlayer2.gameHistory) creatorPlayer2.gameHistory = [];
                creatorPlayer2.gameHistory.push({
                    serverSeedHash: pf.getServerSeedHash(),
                    clientSeed, nonce, result: fairResult,
                    outcome: joinerWins ? 'loss' : 'win',
                    amount: game.totalValue, type: 'pvp_items',
                    opponent: loggedInUser, timestamp: Date.now()
                });
                if (creatorPlayer2.gameHistory.length > 50) creatorPlayer2.gameHistory.shift();
                db.savePlayer(game.creator.username, creatorPlayer2);
                if (!joinerPlayer2.gameHistory) joinerPlayer2.gameHistory = [];
                joinerPlayer2.gameHistory.push({
                    serverSeedHash: pf.getServerSeedHash(),
                    clientSeed, nonce, result: fairResult,
                    outcome: joinerWins ? 'win' : 'loss',
                    amount: game.joinValue, type: 'pvp_items',
                    opponent: game.creator.username, timestamp: Date.now()
                });
                if (joinerPlayer2.gameHistory.length > 50) joinerPlayer2.gameHistory.shift();
                db.savePlayer(loggedInUser, joinerPlayer2);
                // Rotate server seed
                pf.rotateServerSeed();
                // Remove game
                games.removeGame(game.id);
                io.emit('gamesList', Object.values(games.activeGames));
                io.emit('playerListUpdate');
            }, 2200);
        });

        // ── Jackpot ──
        const currentJp = games.getJackpot();
        if (currentJp) {
            socket.emit('jackpotStatus', {
                active: true,
                id: currentJp.id,
                status: currentJp.status,
                totalValue: currentJp.totalValue,
                totalTickets: currentJp.totalTickets,
                participants: (currentJp.participants || []).map(p => ({
                    username: p.username, avatarUrl: p.avatarUrl, tickets: p.tickets
                })),
                timerEnd: currentJp.timerEnd,
                houseFee: currentJp.houseFee,
                winner: currentJp.winner,
                winningTicket: currentJp.winningTicket
            });
            if (currentJp.status === 'waiting') {
                socket.emit('jackpotTimerUpdate', {
                    timerEnd: currentJp.timerEnd,
                    remaining: Math.max(0, Math.floor((currentJp.timerEnd - Date.now()) / 1000))
                });
            }
        }

        socket.on('jackpotJoin', (data) => {
            if (!loggedInUser) {
                socket.emit('jackpotError', { message: 'Musisz być zalogowany!' });
                return;
            }
            if (!checkRateLimit(`jackpotJoin:${loggedInUser}`, 2, 5000)) {
                socket.emit('jackpotError', { message: 'Za szybko! Odczekaj chwilę.' });
                return;
            }

            const jp = games.getJackpot();
            if (!jp || jp.status !== 'waiting') {
                socket.emit('jackpotError', { message: 'Brak aktywnej rundy Jackpota!' });
                return;
            }

            const contribution = {
                coins: parseInt(data.coins) || 0,
                items: data.items || []
            };

            const result = games.addToJackpot(loggedInUser, contribution, db);
            if (!result) {
                socket.emit('jackpotError', { message: 'Nie możesz dołączyć. Sprawdź saldo i przedmioty.' });
                return;
            }

            jackpot.broadcastJackpotStatus(io, jp);

            socket.emit('jackpotJoined', {
                success: true,
                tickets: result.tickets,
                value: result.value,
                totalTickets: jp.totalTickets,
                totalValue: jp.totalValue
            });

            io.emit('playerListUpdate');
            console.log(`[Jackpot] ${loggedInUser} joined with ${result.value} value (${result.tickets} tickets)`);
        });

        socket.on('jackpotGetStatus', () => {
            const jp = games.getJackpot();
            if (!jp) {
                socket.emit('jackpotStatus', { active: false });
                return;
            }
            socket.emit('jackpotStatus', {
                active: true,
                id: jp.id,
                status: jp.status,
                totalValue: jp.totalValue,
                totalTickets: jp.totalTickets,
                participants: (jp.participants || []).map(p => ({
                    username: p.username, avatarUrl: p.avatarUrl, tickets: p.tickets
                })),
                timerEnd: jp.timerEnd,
                houseFee: jp.houseFee,
                winner: jp.winner,
                winningTicket: jp.winningTicket
            });
        });

        socket.on('jackpotGetHistory', () => {
            const history = games.getJackpotHistory();
            socket.emit('jackpotHistory', history.slice(0, 30));
        });

        // ── Live Feed ──
        socket.on('getRecentGames', () => {
            socket.emit('recentGamesUpdated', games.getRecentGames());
        });

        // ── PVP History ──
        socket.on('getHistory', () => {
            if (!loggedInUser) {
                console.warn('[getHistory] No loggedInUser for socket', socket.id);
                socket.emit('historyData', []);
                return;
            }
            try {
                const history = games.getPvpHistory(loggedInUser);
                socket.emit('historyData', Array.isArray(history) ? history : []);
            } catch (err) {
                console.error('[getHistory] Error for', loggedInUser, ':', err.message);
                socket.emit('historyData', []);
            }
        });

        // ── Chat History refresh ──
        socket.on('getChatHistory', async () => {
            try {
                const redisChat = await redis.getChatHistory(100);
                if (redisChat && redisChat.length > 0) {
                    socket.emit('chatHistory', redisChat.reverse().map(normalizeChatMsg));
                    return;
                }
            } catch (e) { /* fall through */ }
            socket.emit('chatHistory', chatHistory.slice(-100).map(normalizeChatMsg));
        });

        // ── Online count ──
        socket.on('countOnline', () => {
            const count = io.engine?.clientsCount || 0;
            socket.emit('onlineCount', count);
        });

        // ── Check Session ──
        socket.on('checkSession', async () => {
            const token = socket.handshake?.headers?.cookie
                ?.split('; ')
                ?.find(c => c.startsWith('bf_session='))
                ?.split('=')[1];
            if (!token) { socket.emit('sessionNone'); return; }
            const username = await redis.getSession(token);
            if (username) {
                loggedInUser = username;
                const player = db.getPlayer(username);

                const pendingDisconnect = disconnectTimeouts.get(username);
                if (pendingDisconnect) {
                    clearTimeout(pendingDisconnect.timeout);
                    disconnectTimeouts.delete(username);
                    if (pendingDisconnect.opponentSocket) {
                        const opponentSocket = io.sockets.sockets.get(pendingDisconnect.opponentSocket);
                        if (opponentSocket && opponentSocket.connected) {
                            opponentSocket.emit('chatMessage', {
                                user: 'System',
                                msg: `${username} reconnected! The game continues.`,
                                time: Date.now()
                            });
                        }
                    }
                }

                socket.emit('sessionOk', {
                    username,
                    robloxId: username,
                    avatarUrl: player.avatarUrl || '',
                    coins: player.coins || 0,
                    gems: player.gems || 0,
                    pet: player.pet || null,
                    clientSeed: player.clientSeed,
                    nonce: player.nonce || 0
                });
            } else {
                socket.emit('sessionNone');
            }
        });

        // ── Disconnect ──
        socket.on('disconnect', () => {
            console.log('Disconnected:', socket.id, loggedInUser ? '(' + loggedInUser + ')' : '');
            const timer = socketActivityTimers.get(socket.id);
            if (timer) clearTimeout(timer);
            socketActivityTimers.delete(socket.id);

            const disconnectedUser = loggedInUser;

            Object.keys(games.activeGames).forEach(id => {
                const game = games.activeGames[id];
                if (!game) return;

                const creatorSocketId = game.creatorSocket || game.creator?.socketId;
                const creatorName = typeof game.creator === 'string' ? game.creator : (game.creator?.username || '');
                const opponentSocketId = game.opponentSocket || game.joiner?.socketId;
                const opponentName = game.opponent || game.joiner?.username || '';

                if (creatorSocketId === socket.id) {
                    if (game.status === 'waiting') {
                        // Refund items or coins
                        if (game.items && game.items.length > 0) {
                            for (const item of game.items) {
                                db.addInventoryItem(creatorName, item.name, item.qty || 1, item.rap || 0);
                            }
                            console.log('  Refunded items to', creatorName, '(disconnected while waiting)');
                        } else {
                            const player = db.getPlayer(creatorName);
                            player.coins += game.amount;
                            db.savePlayer(creatorName, player);
                            console.log('  Refunded', game.amount, 'coins to', creatorName, '(disconnected while waiting)');
                        }
                        delete games.activeGames[id];
                    } else if (game.status === 'active' && opponentSocketId && disconnectedUser) {
                        console.log('  PVP game in progress, starting grace timeout for', creatorName);

                        const timeout = setTimeout(() => {
                            const opponentPlayer = db.getPlayer(opponentName);
                            if (opponentPlayer && opponentSocketId) {
                                const opponentSocket = io.sockets.sockets.get(opponentSocketId);
                                if (opponentSocket && opponentSocket.connected) {
                                    if (game.items && game.items.length > 0) {
                                        // Item game - give all items to opponent
                                        for (const item of (game.items || [])) {
                                            db.addInventoryItem(opponentName, item.name, item.qty || 1, item.rap || 0);
                                        }
                                        for (const item of (game.joinerItems || [])) {
                                            db.addInventoryItem(opponentName, item.name, item.qty || 1, item.rap || 0);
                                        }
                                        opponentSocket.emit('gameResult', {
                                            won: true,
                                            prize: game.totalValue + game.joinValue,
                                            totalValue: game.totalValue,
                                            joinValue: game.joinValue,
                                            reason: 'Opponent disconnected - you win!'
                                        });
                                    } else {
                                        const winnings = Math.floor(game.amount * 2);
                                        opponentPlayer.coins += winnings;
                                        db.savePlayer(opponentName, opponentPlayer);
                                        opponentSocket.emit('coinflipResult', {
                                            win: true, amount: winnings, result: 'opponent_disconnected',
                                            opponent: creatorName, gameOver: true,
                                            reason: 'Opponent disconnected - you win!'
                                        });
                                    }
                                    io.emit('systemMessage', opponentName + ' won by default - ' + creatorName + ' disconnected!');
                                }
                            }
                            delete games.activeGames[id];
                            io.emit('gamesList', Object.values(games.activeGames));
                            io.emit('playerListUpdate');
                            if (disconnectedUser) disconnectTimeouts.delete(disconnectedUser);
                        }, DISCONNECT_GRACE_MS);

                        disconnectTimeouts.set(disconnectedUser, {
                            gameId: id,
                            opponentSocket: opponentSocketId,
                            opponent: opponentName,
                            amount: game.amount || (game.totalValue + game.joinValue),
                            timeout: timeout
                        });

                        if (opponentSocketId) {
                            const opponentSocket = io.sockets.sockets.get(opponentSocketId);
                            if (opponentSocket && opponentSocket.connected) {
                                opponentSocket.emit('chatMessage', {
                                    user: 'System',
                                    msg: creatorName + ' disconnected! They have 30 seconds to reconnect, otherwise you win by default.',
                                    time: Date.now()
                                });
                            }
                        }
                    }
                }

                if (opponentSocketId === socket.id && game.status === 'active') {
                    console.log('  PVP opponent disconnected from game', id);
                    if (creatorSocketId) {
                        const creatorSocket = io.sockets.sockets.get(creatorSocketId);
                        if (creatorSocket && creatorSocket.connected) {
                            creatorSocket.emit('chatMessage', {
                                user: 'System',
                                msg: 'Your opponent ' + opponentName + ' disconnected! They have 30 seconds to reconnect, otherwise you win by default.',
                                time: Date.now()
                            });
                        }
                    }
                }
            });
            io.emit('gamesList', Object.values(games.activeGames));
            io.emit('playerListUpdate');
        });
    });
};
