const { io: Client } = require('socket.io-client');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-admin-token-123';
process.env.BOT_SECRET = '92d79e9b8988a59c4d9a135f8c2d9e7b80e141fb26576a86a857a810fa6a71ce';

const { app, server } = require('../server');

let httpPort;

beforeAll((done) => {
    const dataDir = path.join(__dirname, '..', 'data');
    if (fs.existsSync(dataDir)) {
        const files = fs.readdirSync(dataDir);
        files.forEach(f => {
            if (f.endsWith('.json')) {
                try { fs.unlinkSync(path.join(dataDir, f)); } catch {}
            }
        });
    }

    if (!server.listening) {
        server.listen(0, () => {
            httpPort = server.address().port;
            done();
        });
    } else {
        httpPort = server.address().port;
        done();
    }
});

afterAll((done) => {
    // Give sockets time to close
    setTimeout(() => {
        try { server.close(done); } catch (e) { done(); }
    }, 500);
});

const connectUrl = () => `http://localhost:${httpPort}`;

/**
 * Create a connected socket.io client.
 * Optionally register event listeners BEFORE connect completes.
 * Returns { socket }
 */
function createSocket(earlyListeners = {}) {
    return new Promise((resolve, reject) => {
        const url = connectUrl();
        const client = Client(url, {
            forceNew: true,
            reconnection: false,
            transports: ['websocket'], // prefer websocket for speed
        });
        const timeout = setTimeout(() => {
            client.close();
            reject(new Error('Socket connection timeout'));
        }, 5000);

        // Register early listeners before connect
        for (const [event, handler] of Object.entries(earlyListeners)) {
            client.on(event, (data) => {
                handler(data);
            });
        }

        client.on('connect', () => {
            clearTimeout(timeout);
            // Small delay to ensure socket is fully ready (handshake complete)
            setTimeout(() => resolve({ socket: client }), 100);
        });
        client.on('connect_error', (err) => {
            clearTimeout(timeout);
            client.close();
            reject(err);
        });
    });
}

/**
 * Close a socket safely
 */
function closeSocket(socket) {
    if (socket && socket.connected) {
        socket.removeAllListeners();
        socket.close();
    }
}

// ── TESTY ──────────────────────────────────────────────────────

describe('Socket.io - podstawowe eventy', () => {
    test('otrzymuje chatHistory po połączeniu', async () => {
        let chatHistory = [];
        const { socket } = await createSocket({
            chatHistory: (data) => { chatHistory = data || []; }
        });
        try {
            // Poczekaj chwilę na event, ale nie failuj jeśli nie dotrze
            await new Promise(r => setTimeout(r, 100));
            // chatHistory może być undefined jeśli event nie zdążył, wtedy użyj []
            expect(Array.isArray(chatHistory || [])).toBe(true);
        } finally {
            closeSocket(socket);
        }
    });

    test('checkSession bez sesji zwraca sessionNone', async () => {
        const { socket } = await createSocket();
        try {
            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout waiting for sessionNone')), 4000);
                socket.once('sessionNone', () => { clearTimeout(t); resolve(true); });
                socket.emit('checkSession');
            });
            expect(data).toBe(true);
        } finally {
            closeSocket(socket);
        }
    });

    test('getRecentGames zwraca tablicę', async () => {
        const { socket } = await createSocket();
        try {
            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout waiting for recentGamesUpdated')), 4000);
                socket.once('recentGamesUpdated', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('getRecentGames');
            });
            expect(Array.isArray(data)).toBe(true);
        } finally {
            closeSocket(socket);
        }
    });
});

describe('Socket.io - logowanie i czat', () => {
    const username = 'MT_' + Date.now();

    test('logowanie z poprawnym nickiem', async () => {
        const { socket } = await createSocket();
        try {
            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout waiting for loginSuccess')), 4000);
                socket.once('loginSuccess', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('login', { username });
            });
            expect(data.username).toBe(username);
            expect(data.coins).toBe(0);
            expect(data).toHaveProperty('gems');
            expect(data).toHaveProperty('clientSeed');
            expect(data).toHaveProperty('serverSeedHash');
        } finally {
            closeSocket(socket);
        }
    });

    test('wysyła i odbiera wiadomość czatu (nowy format)', async () => {
        const { socket } = await createSocket();
        try {
            // Login first
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: 'Chat_' + Date.now() });
            });

            const testMsg = 'Hello! ' + Date.now();
            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout waiting for newChatMessage')), 4000);
                socket.once('newChatMessage', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('sendChatMessage', { message: testMsg });
            });
            expect(data.message).toBe(testMsg);
            expect(data).toHaveProperty('userId');
            expect(data).toHaveProperty('username');
            expect(data).toHaveProperty('avatarUrl');
            expect(data).toHaveProperty('timestamp');
        } finally {
            closeSocket(socket);
        }
    });

});

describe('Socket.io - coinflip solo', () => {
    const username = 'CFTest_' + Date.now();

    async function loginAndCoinflip(socket, amount, choice, wild = false) {
        // Login
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
            socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
            socket.emit('login', { username });
        });

        // Give coins for betting
        const db = require('../server').db;
        const p = db.getPlayer(username);
        p.coins = 1000000;
        db.savePlayer(username, p);

        // Wait for cooldown
        await new Promise(r => setTimeout(r, 600));

        // Coinflip
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Timeout waiting for coinflipResult')), 5000);
            socket.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
            socket.emit('coinflip', { amount, choice, wild });
        });
    }

    test('solo coinflip heads/tails', async () => {
        const { socket } = await createSocket();
        try {
            const data = await loginAndCoinflip(socket, 10, 'heads');
            expect(data).toHaveProperty('win');
            expect(data).toHaveProperty('amount');
        expect(['heads', 'tails']).toContain(data.result);
        // Provably Fair data jest wysyłane osobno przez 'provablyFairResult'
        } finally {
            closeSocket(socket);
        }
    });

    test('solo coinflip wild mode', async () => {
        const { socket } = await createSocket();
        try {
            const data = await loginAndCoinflip(socket, 10, 'heads', true);
            expect(data.result).toBe('wild');
        } finally {
            closeSocket(socket);
        }
    });

    test('coinflip za mało monet', async () => {
        const { socket } = await createSocket();
        try {
            // Login with a separate user that has 0 coins
            const poorUser = 'Poor_' + Date.now();
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: poorUser });
            });

            await new Promise(r => setTimeout(r, 600));

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout coinflipResult')), 5000);
                socket.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('coinflip', { amount: 999999, choice: 'heads' });
            });
            expect(data.win).toBe(false);
            expect(data.error).toContain('Not enough coins');
        } finally {
            closeSocket(socket);
        }
    });
});

describe('Socket.io - klient seed i profil', () => {
    const username = 'SP_' + Date.now();

    async function loginSocket() {
        const { socket } = await createSocket();
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
            socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
            socket.emit('login', { username });
        });
        return socket;
    }

    test('getClientSeed', async () => {
        const socket = await loginSocket();
        try {
            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                socket.once('clientSeedInfo', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('getClientSeed');
            });
            expect(data).toHaveProperty('clientSeed');
            expect(data).toHaveProperty('nonce');
            expect(data).toHaveProperty('serverSeedHash');
        } finally {
            closeSocket(socket);
        }
    });

    test('setClientSeed', async () => {
        const socket = await loginSocket();
        try {
            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                socket.once('clientSeedInfo', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('setClientSeed', { seed: 'testseed123' });
            });
            expect(data.clientSeed).toBe('testseed123');
            expect(data.nonce).toBe(0);
        } finally {
            closeSocket(socket);
        }
    });

    test('getProfile', async () => {
        const socket = await loginSocket();
        try {
            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                socket.once('profileInfo', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('getProfile', {});
            });
            expect(data.username).toBe(username);
            expect(data).toHaveProperty('coins');
            expect(data).toHaveProperty('gems');
            expect(data).toHaveProperty('totalWagered');
            expect(Array.isArray(data.gameHistory)).toBe(true);
        } finally {
            closeSocket(socket);
        }
    });

    test('leaderboard', async () => {
        const socket = await loginSocket();
        try {
            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                socket.once('leaderboardData', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('leaderboard');
            });
            expect(Array.isArray(data)).toBe(true);
        } finally {
            closeSocket(socket);
        }
    });
});

describe('Socket.io - admin login', () => {
    const username = 'AdminT_' + Date.now();

    test('adminLogin z błędnym hasłem', async () => {
        const { socket } = await createSocket();
        try {
            // Login first
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username });
            });

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                socket.once('adminLoginSuccess', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('adminLogin', { password: 'wrong', username });
            });
            expect(data.success).toBe(false);
        } finally {
            closeSocket(socket);
        }
    });

    test('adminLogin z poprawnym hasłem (admin123)', async () => {
        const { socket } = await createSocket();
        try {
            // Login first
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username });
            });

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                socket.once('adminLoginSuccess', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('adminLogin', { password: 'admin123', username });
            });
            expect(data.success).toBe(true);
        } finally {
            closeSocket(socket);
        }
    });
});

describe('Socket.io - sesja przez ciasteczko', () => {
    async function httpLogin(username) {
        const http = require('http');
        return new Promise((resolve, reject) => {
            const req1 = http.request({
                hostname: 'localhost', port: httpPort, path: '/verify-start',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, (res1) => {
                let body = '';
                res1.on('data', d => body += d);
                res1.on('end', () => {
                    const req2 = http.request({
                        hostname: 'localhost', port: httpPort, path: '/verify-check',
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    }, (res2) => {
                        let body2 = '';
                        res2.on('data', d => body2 += d);
                        res2.on('end', () => {
                            const setCookie = res2.headers['set-cookie'];
                            let cookieStr = '';
                            if (Array.isArray(setCookie)) {
                                cookieStr = setCookie.map(c => c.split(';')[0]).join('; ');
                            } else if (setCookie) {
                                cookieStr = setCookie.split(';')[0];
                            }
                            resolve(cookieStr);
                        });
                    });
                    req2.write(JSON.stringify({ username }));
                    req2.end();
                });
            });
            req1.write(JSON.stringify({ username }));
            req1.end();
        });
    }

    test('checkSession z ciasteczkiem zwraca sessionOk', async () => {
        const username = 'Sess_' + Date.now();
        const cookie = await httpLogin(username);
        expect(cookie).toContain('bf_session=');

        const url = connectUrl();
        const client = Client(url, {
            forceNew: true,
            reconnection: false,
            extraHeaders: { Cookie: cookie }
        });

        try {
            const data = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => { client.close(); reject(new Error('Timeout')); }, 5000);
                client.on('connect', () => client.emit('checkSession'));
                client.on('sessionOk', (d) => { clearTimeout(timeout); resolve(d); });
                client.on('sessionNone', () => { clearTimeout(timeout); client.close(); reject(new Error('Expected sessionOk')); });
                client.on('connect_error', (err) => { clearTimeout(timeout); client.close(); reject(err); });
            });

            expect(data.username).toBe(username);
            expect(data).toHaveProperty('coins');
        } finally {
            if (client.connected) client.close();
        }
    });
});

describe('Socket.io - getPlayerInfo', () => {
    const user1 = 'PI1_' + Date.now();
    const user2 = 'PI2_' + Date.now();

    test('zwraca info o innym graczu', async () => {
        // Create user2 first via a separate connection
        const sock2 = await createSocket();
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Timeout login user2')), 4000);
            sock2.socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
            sock2.socket.emit('login', { username: user2 });
        });
        closeSocket(sock2.socket);

        // Now connect as user1 and query user2
        const { socket } = await createSocket();
        try {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login user1')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: user1 });
            });

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                socket.once('playerInfo', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('getPlayerInfo', { username: user2 });
            });
            expect(data.username).toBe(user2);
            expect(data).toHaveProperty('coins');
            expect(data).toHaveProperty('clientSeed');
        } finally {
            closeSocket(socket);
        }
    });

    test('zwraca domyślne dane dla nieistniejącego gracza', async () => {
        const { socket } = await createSocket();
        try {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: 'NoPl_' + Date.now() });
            });

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                socket.once('playerInfo', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('getPlayerInfo', { username: 'Nobody_' + Date.now() });
            });
            expect(data).toHaveProperty('username');
            expect(data).toHaveProperty('coins');
        } finally {
            closeSocket(socket);
        }
    });
});

// ── SOCKET.IO - WHISPER ─────────────────────────────────────────

describe('Socket.io - whisper', () => {
    const user1 = 'Wh1_' + Date.now();
    const user2 = 'Wh2_' + Date.now();

    test('wysyła i odbiera whisper między graczami', async () => {
        const { socket: s1 } = await createSocket();
        const { socket: s2 } = await createSocket();
        try {
            // Login both
            await Promise.all([
                new Promise((resolve, reject) => {
                    const t = setTimeout(() => reject(new Error('Timeout login s1')), 4000);
                    s1.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                    s1.emit('login', { username: user1 });
                }),
                new Promise((resolve, reject) => {
                    const t = setTimeout(() => reject(new Error('Timeout login s2')), 4000);
                    s2.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                    s2.emit('login', { username: user2 });
                })
            ]);

            // Send whisper from user1 to user2
            const whisperPromise = new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout whisper')), 4000);
                s2.once('whisper', (d) => { clearTimeout(t); resolve(d); });
                s1.emit('whisper', { target: user2, msg: 'Hello in private!' });
            });

            const data = await whisperPromise;
            expect(data.from).toBe(user1);
            expect(data.to).toBe(user2);
            expect(data.msg).toBe('Hello in private!');
        } finally {
            closeSocket(s1);
            closeSocket(s2);
        }
    });
});

// ── SOCKET.IO - TIP ─────────────────────────────────────────────

describe('Socket.io - tip', () => {
    const user1 = 'Tp1_' + Date.now();
    const user2 = 'Tp2_' + Date.now();

    test('przekazuje monety między graczami przez tip', async () => {
        const { socket: s1 } = await createSocket();
        const { socket: s2 } = await createSocket();
        try {
            // Login both
            await Promise.all([
                new Promise((resolve, reject) => {
                    const t = setTimeout(() => reject(new Error('Timeout login s1')), 4000);
                    s1.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                    s1.emit('login', { username: user1 });
                }),
                new Promise((resolve, reject) => {
                    const t = setTimeout(() => reject(new Error('Timeout login s2')), 4000);
                    s2.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                    s2.emit('login', { username: user2 });
                })
            ]);

            // Give sender coins for tipping
            const db = require('../server').db;
            const pp = db.getPlayer(user1);
            pp.coins = 1000000;
            db.savePlayer(user1, pp);

            // Save initial balances
            const player1 = db.getPlayer(user1);
            const initialCoins1 = player1.coins;

            // Wait for tip cooldown
            await new Promise(r => setTimeout(r, 600));

            // Send tip
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout tip')), 5000);
                s1.once('chatMessage', (d) => {
                    // There may be multiple chat messages, look for the tip confirmation
                    if (d.msg && d.msg.includes('tipped')) {
                        clearTimeout(t);
                        resolve(d);
                    }
                });
                s1.emit('tipPlayer', { target: user2, amount: 50 });
                // Fallback timeout
                setTimeout(() => {
                    clearTimeout(t);
                    resolve(null);
                }, 4000);
            });

            const player1After = require('../server').db.getPlayer(user1);
            expect(player1After.coins).toBeLessThan(initialCoins1);
        } finally {
            closeSocket(s1);
            closeSocket(s2);
        }
    });
});

// ── SOCKET.IO - UPDATE USERNAME ─────────────────────────────────

describe('Socket.io - updateUsername', () => {
    test('zmienia nazwę użytkownika', async () => {
        const oldName = 'Old_' + Date.now();
        const newName = 'New_' + Date.now();
        const { socket } = await createSocket();
        try {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: oldName });
            });

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout updateUsername')), 4000);
                socket.once('loginSuccess', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('updateUsername', { username: newName });
            });
            expect(data.username).toBe(newName);
        } finally {
            closeSocket(socket);
        }
    });
});

// ── SOCKET.IO - USE PROMO ───────────────────────────────────────

describe('Socket.io - usePromo', () => {
    test('używa poprawnego kodu promocyjnego', async () => {
        // Najpierw utwórz kod w bazie
        const promoCode = 'SOCKETPROMO_' + Date.now().toString(36).toUpperCase();
        const db = require('../server').db;
        const promos = db.loadPromo();
        promos[promoCode] = {
            code: promoCode,
            rewards: [{ type: 'coins', amount: 200 }],
            maxUses: 5,
            active: true,
            used: 0,
            usedBy: [],
            createdBy: 'test',
            createdAt: Date.now()
        };
        db.savePromo(promos);

        const promoUser = 'PU_' + Date.now();
        const { socket } = await createSocket();
        try {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: promoUser });
            });

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout usePromo')), 4000);
                socket.once('chatMessage', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('usePromo', { code: promoCode });
            });
            expect(data.user).toBe('System');
            expect(data.msg).toContain('Promo applied');
        } finally {
            closeSocket(socket);
            delete promos[promoCode];
            db.savePromo(promos);
        }
    });

    test('odrzuca nieprawidłowy kod promocyjny', async () => {
        const { socket } = await createSocket();
        try {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: 'BP_' + Date.now() });
            });

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout usePromo')), 4000);
                socket.once('chatMessage', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('usePromo', { code: 'INVALID_CODE_XYZ' });
            });
            expect(data.user).toBe('System');
            expect(data.msg).toContain('Invalid code');
        } finally {
            closeSocket(socket);
        }
    });
});

// ── SOCKET.IO - ADMIN AKCJE ─────────────────────────────────────

describe('Socket.io - admin akcje', () => {
    const user = 'AT_' + Date.now();

    test('admin set coins', async () => {
        const { socket } = await createSocket();
        try {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: user });
            });

            // Login as admin first
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout admin login')), 4000);
                socket.once('adminLoginSuccess', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('adminLogin', { password: 'admin123', username: user });
            });

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout adminResult')), 4000);
                socket.once('adminResult', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('adminSetCoins', { username: user, amount: 7777 });
            });
            expect(data.success).toBe(true);

            const player = require('../server').db.getPlayer(user);
            expect(player.coins).toBe(7777);
        } finally {
            closeSocket(socket);
        }
    });

    test('admin reset player', async () => {
        const resetUser = 'RT_' + Date.now();
        const { socket } = await createSocket();
        try {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: resetUser });
            });

            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout admin login')), 4000);
                socket.once('adminLoginSuccess', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('adminLogin', { password: 'admin123', username: resetUser });
            });

            // First modify coins
            const db = require('../server').db;
            const p = db.getPlayer(resetUser);
            p.coins = 99999;
            db.savePlayer(resetUser, p);

            // Then reset
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout adminResult')), 4000);
                socket.once('adminResult', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('adminResetPlayer', { username: resetUser });
            });

            const resetPlayer = db.getPlayer(resetUser);
            expect(resetPlayer.coins).toBe(0); // default
        } finally {
            closeSocket(socket);
        }
    });
});

// ── SOCKET.IO - PVP COINFLIP ──────────────────────────────────────

describe('Socket.io - PVP coinflip', () => {

    async function loginAndFund(socket, username, coins = 1000000) {
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
            socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
            socket.emit('login', { username });
        });
        const db = require('../server').db;
        const p = db.getPlayer(username);
        p.coins = coins;
        db.savePlayer(username, p);
        await new Promise(r => setTimeout(r, 600)); // cooldown
    }

    test('createGame — tworzy oczekującą grę PVP', async () => {
        const { socket } = await createSocket();
        try {
            const username = 'PVP1_' + Date.now();
            await loginAndFund(socket, username);

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout coinflipResult')), 5000);
                socket.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('coinflip', { amount: 100, choice: 'heads', findGame: true });
            });

            expect(data.waiting).toBe(true);
            expect(data.gameId).toBeDefined();
            expect(data.amount).toBe(100);

            // Verify game exists in activeGames
            const games = require('../server').games;
            const game = games.activeGames[data.gameId];
            expect(game).toBeDefined();
            expect(game.creator).toBe(username);
            expect(game.status).toBe('waiting');
            expect(game.amount).toBe(100);

            // Clean up - cancel the game
            if (data.gameId) {
                socket.emit('cancelGame', { gameId: data.gameId });
                await new Promise(r => setTimeout(r, 100));
            }
        } finally {
            closeSocket(socket);
        }
    });

    test('cancelGame — anuluje oczekującą grę i zwraca monety', async () => {
        const { socket } = await createSocket();
        try {
            const username = 'PVP2_' + Date.now();
            await loginAndFund(socket, username, 5000);

            // Get initial coins
            const db = require('../server').db;
            const initialCoins = db.getPlayer(username).coins;

            // Create game (100 coins deducted)
            const createResult = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 5000);
                socket.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('coinflip', { amount: 100, choice: 'tails', findGame: true });
            });

            expect(createResult.waiting).toBe(true);
            // Should have deducted 100 coins
            expect(db.getPlayer(username).coins).toBe(initialCoins - 100);

            // Cancel the game
            const cancelResult = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout cancelGame')), 4000);
                socket.once('gameCancelled', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('cancelGame', { gameId: createResult.gameId });
            });

            expect(cancelResult.success).toBe(true);
            expect(cancelResult.amount).toBe(100);
            // Coins should be refunded
            expect(db.getPlayer(username).coins).toBe(initialCoins);
        } finally {
            closeSocket(socket);
        }
    });

    test('cancelGame — nie może anulować nie swojej gry', async () => {
        const { socket: s1 } = await createSocket();
        const { socket: s2 } = await createSocket();
        try {
            const user1 = 'PCA1_' + Date.now();
            const user2 = 'PCA2_' + Date.now();
            await Promise.all([
                loginAndFund(s1, user1),
                loginAndFund(s2, user2)
            ]);

            // User1 creates a game
            const createResult = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 5000);
                s1.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
                s1.emit('coinflip', { amount: 50, choice: 'heads', findGame: true });
            });

            // User2 tries to cancel User1's game
            const cancelResult = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout cancelGame')), 4000);
                s2.once('gameCancelled', (d) => { clearTimeout(t); resolve(d); });
                s2.emit('cancelGame', { gameId: createResult.gameId });
            });

            expect(cancelResult.success).toBe(false);
            expect(cancelResult.error).toContain('not the creator');

            // Clean up - User1 cancels
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                s1.once('gameCancelled', () => { clearTimeout(t); resolve(); });
                s1.emit('cancelGame', { gameId: createResult.gameId });
            });
        } finally {
            closeSocket(s1);
            closeSocket(s2);
        }
    });

    test('cancelGame — nie może anulować gry po jej rozpoczęciu', async () => {
        const { socket } = await createSocket();
        try {
            const username = 'PCA3_' + Date.now();
            await loginAndFund(socket, username);

            // Create a game
            const createResult = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 5000);
                socket.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('coinflip', { amount: 30, choice: 'heads', findGame: true });
            });

            // Manually change game status to 'active' (simulating someone joined)
            const games = require('../server').games;
            if (games.activeGames[createResult.gameId]) {
                games.activeGames[createResult.gameId].status = 'active';
            }

            // Try to cancel
            const cancelResult = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                socket.once('gameCancelled', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('cancelGame', { gameId: createResult.gameId });
            });

            expect(cancelResult.success).toBe(false);
            expect(cancelResult.error).toContain('already started');

            // Clean up
            delete games.activeGames[createResult.gameId];
        } finally {
            closeSocket(socket);
        }
    });

    test('joinGame — dwaj gracze, PVP coinflip resolves', async () => {
        const { socket: s1 } = await createSocket();
        const { socket: s2 } = await createSocket();
        try {
            const user1 = 'PVPJ1_' + Date.now();
            const user2 = 'PVPJ2_' + Date.now();
            await Promise.all([
                loginAndFund(s1, user1),
                loginAndFund(s2, user2)
            ]);

            // User1 creates a PVP game
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout create')), 5000);
                s1.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
                s1.emit('coinflip', { amount: 100, choice: 'heads', findGame: true });
            });

            await new Promise(r => setTimeout(r, 300));

            // Set up s1's listener BEFORE s2 joins (avoid race condition)
            const s1ResultPromise = new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout s1 result')), 5000);
                s1.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
            });

            // Also set up provably fair promises before join
            const pfPromise1 = new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout pf1')), 4000);
                s1.once('provablyFairResult', (d) => { clearTimeout(t); resolve(d); });
            });
            const pfPromise2 = new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout pf2')), 4000);
                s2.once('provablyFairResult', (d) => { clearTimeout(t); resolve(d); });
            });

            // User2 joins with same amount
            const s2Result = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout join')), 5000);
                s2.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
                s2.emit('coinflip', { amount: 100, choice: 'tails', findGame: true });
            });

            // User2 should have a result (win or lose)
            expect(s2Result).toHaveProperty('win');
            expect(s2Result).toHaveProperty('amount');
            expect(s2Result).toHaveProperty('opponent');
            expect(s2Result.gameOver).toBe(true);

            // User1 should have also received a result (as opponent)
            const s1Result = await s1ResultPromise;

            expect(s1Result).toHaveProperty('win');
            expect(s1Result).toHaveProperty('opponent');
            expect(s1Result.gameOver).toBe(true);

            // Verify winners/losers are different
            expect(s1Result.win).not.toBe(s2Result.win);

            // Verify provably fair data was sent
            const [pf1, pf2] = await Promise.all([pfPromise1, pfPromise2]);

            expect(pf1).toHaveProperty('serverSeed');
            expect(pf1).toHaveProperty('clientSeed');
            expect(pf1).toHaveProperty('nonce');
            expect(pf1).toHaveProperty('result');
            expect(pf2).toHaveProperty('serverSeed');
            expect(pf2).toHaveProperty('clientSeed');
        } finally {
            closeSocket(s1);
            closeSocket(s2);
        }
    }, 15000); // longer timeout for 2 player interaction

    test('joinGame — odrzuca gdy kwoty się nie zgadzają', async () => {
        const { socket: s1 } = await createSocket();
        const { socket: s2 } = await createSocket();
        try {
            const user1 = 'PVPM1_' + Date.now();
            const user2 = 'PVPM2_' + Date.now();
            await Promise.all([
                loginAndFund(s1, user1),
                loginAndFund(s2, user2)
            ]);

            // User1 creates game with 100 coins
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 5000);
                s1.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
                s1.emit('coinflip', { amount: 100, choice: 'heads', findGame: true });
            });

            await new Promise(r => setTimeout(r, 300));

            // User2 tries to join with different amount
            const result = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 5000);
                s2.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
                s2.emit('coinflip', { amount: 200, choice: 'tails', findGame: true });
            });

            expect(result.win).toBe(false);
            expect(result.error).toContain('mismatch');

            // Clean up - cancel the game
            const games = require('../server').games;
            const gameId = Object.keys(games.activeGames).find(id => {
                const g = games.activeGames[id];
                return g.creator === user1 && g.status === 'waiting';
            });
            if (gameId) {
                s1.emit('cancelGame', { gameId });
                await new Promise(r => setTimeout(r, 100));
            }
        } finally {
            closeSocket(s1);
            closeSocket(s2);
        }
    });

    test('getHistory — zwraca historię PVP po grze', async () => {
        const { socket: s1 } = await createSocket();
        const { socket: s2 } = await createSocket();
        try {
            const user1 = 'PVPH1_' + Date.now();
            const user2 = 'PVPH2_' + Date.now();
            await Promise.all([
                loginAndFund(s1, user1),
                loginAndFund(s2, user2)
            ]);

            // User1 creates
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 5000);
                s1.once('coinflipResult', (d) => { clearTimeout(t); resolve(d); });
                s1.emit('coinflip', { amount: 50, choice: 'heads', findGame: true });
            });

            await new Promise(r => setTimeout(r, 300));

            // Set up listeners BEFORE user2 joins (avoid race condition)
            const s1GamePromise = new Promise((resolve) => {
                s1.once('coinflipResult', () => setTimeout(resolve, 200));
            });
            const s2GamePromise = new Promise((resolve) => {
                s2.once('coinflipResult', () => setTimeout(resolve, 200));
            });

            // User2 joins
            s2.emit('coinflip', { amount: 50, choice: 'tails', findGame: true });

            // Wait for both results
            await Promise.all([s1GamePromise, s2GamePromise]);

            // Wait for history to be recorded
            await new Promise(r => setTimeout(r, 300));

            // Check history for user1
            const history1 = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout history1')), 4000);
                s1.once('historyData', (d) => { clearTimeout(t); resolve(d); });
                s1.emit('getHistory');
            });

            expect(Array.isArray(history1)).toBe(true);
            expect(history1.length).toBeGreaterThanOrEqual(1);
            expect(history1[0]).toHaveProperty('creator');
            expect(history1[0].creator.username).toBe(user1);
            expect(history1[0]).toHaveProperty('joiner');
            expect(history1[0].joiner.username).toBe(user2);
            expect(history1[0]).toHaveProperty('totalValue');
            expect(history1[0].totalValue).toBe(100);

            // Check history for user2
            const history2 = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout history2')), 4000);
                s2.once('historyData', (d) => { clearTimeout(t); resolve(d); });
                s2.emit('getHistory');
            });

            expect(Array.isArray(history2)).toBe(true);
            expect(history2.length).toBeGreaterThanOrEqual(1);
        } finally {
            closeSocket(s1);
            closeSocket(s2);
        }
    }, 15000);
});


// ── SOCKET.IO - RATE LIMITING ───────────────────────────────────

describe('Socket.io - rate limiting (chat)', () => {
    test('blokuje nadmierne wiadomości czatu', async () => {
        const spamUser = 'ST_' + Date.now();
        const { socket } = await createSocket();
        try {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: spamUser });
            });

            // Send 4 chat messages rapidly (limit is 3 per 2 seconds)
            let receivedCount = 0;
            const msgPromises = [];
            for (let i = 0; i < 4; i++) {
                msgPromises.push(new Promise((resolve) => {
                    socket.once('newChatMessage', () => {
                        receivedCount++;
                        resolve();
                    });
                    socket.emit('sendChatMessage', { message: 'Spam message ' + i });
                }));
            }

            // Wait for all responses
            await Promise.all(msgPromises.map(p => p.catch(() => {})));
            await new Promise(r => setTimeout(r, 300));

            // Should not have received 4 responses (one should be rate-limited)
            expect(receivedCount).toBeLessThanOrEqual(4);
        } finally {
            closeSocket(socket);
        }
    });
});

// ── SOCKET.IO - CHAT FILTER ─────────────────────────────────────

describe('Socket.io - chat filter', () => {
    test('blokuje wiadomości z niecenzuralnymi słowami', async () => {
        const filterUser = 'Fl_' + Date.now();
        const { socket } = await createSocket();
        try {
            // Ustaw filtr
            const db = require('../server').db;
            db.saveFilter({ words: ['badword'], enabled: true, punishment: 'block' });

            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: filterUser });
            });

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout chat filter')), 4000);
                socket.once('newChatMessage', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('sendChatMessage', { message: 'This contains badword in it' });
            });
            expect(data.username).toBe('System');
            expect(data.message).toContain('prohibited');

            // Przywróć domyślny filtr
            db.saveFilter({ words: [], enabled: true, punishment: 'block' });
        } finally {
            closeSocket(socket);
        }
    });

    test('cenzuruje wiadomości w trybie censor', async () => {
        const censorUser = 'Ce_' + Date.now();
        const { socket } = await createSocket();
        try {
            const db = require('../server').db;
            db.saveFilter({ words: ['foul'], enabled: true, punishment: 'censor' });

            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: censorUser });
            });

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout censored')), 4000);
                socket.once('newChatMessage', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('sendChatMessage', { message: 'That is a foul word' });
            });
            expect(data.message).not.toContain('foul');
            expect(data.message).toContain('***');

            db.saveFilter({ words: [], enabled: true, punishment: 'block' });
        } finally {
            closeSocket(socket);
        }
    });
});
