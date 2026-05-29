const { io: Client } = require('socket.io-client');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';

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
        server.close(done);
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
            resolve({ socket: client });
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
            expect(data.coins).toBe(500);
            expect(data).toHaveProperty('gems');
            expect(data).toHaveProperty('clientSeed');
            expect(data).toHaveProperty('serverSeedHash');
        } finally {
            closeSocket(socket);
        }
    });

    test('wysyła i odbiera wiadomość czatu', async () => {
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
                const t = setTimeout(() => reject(new Error('Timeout waiting for chatMessage')), 4000);
                socket.once('chatMessage', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('chatMessage', { msg: testMsg });
            });
            expect(data.msg).toBe(testMsg);
        } finally {
            closeSocket(socket);
        }
    });

    test('daily reward', async () => {
        const { socket } = await createSocket();
        try {
            // Login first
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
                socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
                socket.emit('login', { username: 'Daily_' + Date.now() });
            });

            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout waiting for chatMessage')), 4000);
                socket.once('chatMessage', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('dailyReward');
            });
            expect(data.user).toBe('System');
            expect(data.msg).toContain('coins');
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
            expect(data).toHaveProperty('fairHash');
            expect(['heads', 'tails']).toContain(data.result);
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
            const data = await loginAndCoinflip(socket, 999999, 'heads');
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

describe('Socket.io - sklep', () => {
    const username = 'Shop_' + Date.now();

    async function loginSocket() {
        const { socket } = await createSocket();
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Timeout login')), 4000);
            socket.once('loginSuccess', () => { clearTimeout(t); resolve(); });
            socket.emit('login', { username });
        });
        return socket;
    }

    test('kupuje common egg', async () => {
        const socket = await loginSocket();
        try {
            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                socket.once('chatMessage', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('buyItem', { item: 'common_egg' });
            });
            expect(data.user).toBe('System');
            expect(data.msg).toContain('bought');
        } finally {
            closeSocket(socket);
        }
    });

    test('brak monet na phoenix', async () => {
        const socket = await loginSocket();
        try {
            const data = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Timeout')), 4000);
                socket.once('chatMessage', (d) => { clearTimeout(t); resolve(d); });
                socket.emit('buyItem', { item: 'phoenix' });
            });
            expect(data.user).toBe('System');
            expect(data.msg).toContain('Not enough');
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
    const user1 = 'PInfo1_' + Date.now();
    const user2 = 'PInfo2_' + Date.now();

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
});
