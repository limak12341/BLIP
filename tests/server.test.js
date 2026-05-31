const request = require('supertest');
const path = require('path');
const fs = require('fs');

// Set test environment — override env vars that may conflict
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-admin-token-123';
process.env.BOT_SECRET = '92d79e9b8988a59c4d9a135f8c2d9e7b80e141fb26576a86a857a810fa6a71ce';

const { app, db, pf, games } = require('../server');

// ── TESTY FUNKCJI POMOCNICZYCH (db) ────────────────────────────

describe('db.fmt()', () => {
    test('formatuje małe liczby', () => {
        expect(db.fmt(0)).toBe('0');
        expect(db.fmt(500)).toBe('500');
        expect(db.fmt(999)).toBe('999');
    });

    test('formatuje tysiące (K)', () => {
        expect(db.fmt(1000)).toBe('1.0K');
        expect(db.fmt(1500)).toBe('1.5K');
        expect(db.fmt(10000)).toBe('10K');
    });

    test('formatuje miliony (M)', () => {
        expect(db.fmt(1_000_000)).toBe('1.0M');
        expect(db.fmt(2_500_000)).toBe('2.5M');
    });

    test('formatuje miliardy (B)', () => {
        expect(db.fmt(1_000_000_000)).toBe('1.0B');
    });
});

describe('db.escapeHtml()', () => {
    test('escapeuje HTML special chars', () => {
        expect(db.escapeHtml('<script>alert("xss")</script>'))
            .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
        expect(db.escapeHtml("it's & nice")).toBe('it&#39;s &amp; nice');
    });

    test('zwraca pusty string dla null/undefined', () => {
        expect(db.escapeHtml(null)).toBe('');
        expect(db.escapeHtml(undefined)).toBe('');
    });

    test('zwraca niezmieniony tekst bez znaków specialnych', () => {
        expect(db.escapeHtml('Hello World')).toBe('Hello World');
    });
});

describe('db.generateClientSeed()', () => {
    test('generuje 32-znakowy hex string', () => {
        const seed = db.generateClientSeed();
        expect(seed).toMatch(/^[a-f0-9]{32}$/);
    });

    test('generuje unikalne seed-y', () => {
        const seeds = new Set();
        for (let i = 0; i < 100; i++) {
            seeds.add(db.generateClientSeed());
        }
        expect(seeds.size).toBe(100);
    });
});

describe('db.getPlayer()', () => {
    test('tworzy nowego gracza z domyślnymi wartościami', () => {
        const player = db.getPlayer('TestPlayer_' + Date.now());
        expect(player.coins).toBe(0);
        expect(player.gems).toBe(0);
        expect(player.username).toBeTruthy();
        expect(player.clientSeed).toMatch(/^[a-f0-9]{32}$/);
        expect(player.nonce).toBe(0);
        expect(Array.isArray(player.roles)).toBe(true);
    });
});

describe('db.hasRole()', () => {
    test('zwraca false dla gracza bez roli', () => {
        const name = 'RoleTest_' + Date.now();
        expect(db.hasRole(name, 'admin')).toBe(false);
    });
});

describe('db.isBanned()', () => {
    test('zwraca null dla niebanowanego gracza', () => {
        expect(db.isBanned('NonexistentUser_' + Date.now())).toBeNull();
    });
});

// ── TESTY PROVIDABLY FAIR ──────────────────────────────────────

describe('pf.computeFairResult()', () => {
    test('zwraca spójny wynik dla tych samych parametrów', () => {
        const r1 = pf.computeFairResult('seed123', 'client456', 1);
        const r2 = pf.computeFairResult('seed123', 'client456', 1);
        expect(r1).toBe(r2);
    });

    test('zwraca różny wynik dla różnych nonce', () => {
        const r1 = pf.computeFairResult('seed', 'client', 1);
        const r2 = pf.computeFairResult('seed', 'client', 2);
        expect(r1).not.toBe(r2);
    });

    test('wynik jest w zakresie 0-999999', () => {
        const r = pf.computeFairResult('seed', 'client', 1);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(999999);
    });

    test('wynik to liczba całkowita', () => {
        const r = pf.computeFairResult('seed', 'client', 1);
        expect(Number.isInteger(r)).toBe(true);
    });
});

describe('pf.getServerSeedHash()', () => {
    test('zwraca hash SHA-256', () => {
        const hash = pf.getServerSeedHash();
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
});

// ── TESTY ENDPOINTÓW HTTP ──────────────────────────────────────

describe('GET /', () => {
    test('zwraca stronę główną', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toContain('<!DOCTYPE html>');
        expect(res.text).toContain('BFLIP');
    });
});

describe('GET /admin', () => {
    test('zwraca panel admina', async () => {
        const res = await request(app).get('/admin');
        expect(res.status).toBe(200);
        expect(res.text).toContain('<!DOCTYPE html>');
    });
});

describe('GET /api/session', () => {
    test('zwraca { authenticated: false } bez ciasteczka', async () => {
        const res = await request(app).get('/api/session');
        expect(res.status).toBe(200);
        expect(res.body.authenticated).toBe(false);
    });
});

describe('POST /verify-start', () => {
    test('generuje kod weryfikacyjny', async () => {
        const res = await request(app)
            .post('/verify-start')
            .send({ username: 'TUser_' + Date.now() });
        expect(res.status).toBe(200);
        expect(res.body.code).toMatch(/^[A-Z0-9]{6}$/);
    });

    test('odrzuca pusty nick', async () => {
        const res = await request(app)
            .post('/verify-start')
            .send({ username: '' });
        expect(res.status).toBe(200);
        expect(res.body.message).toContain('Nieprawidłowy nick');
    });

    test('odrzuca zbyt krótki nick', async () => {
        const res = await request(app)
            .post('/verify-start')
            .send({ username: 'A' });
        expect(res.status).toBe(200);
        expect(res.body.message).toContain('Nieprawidłowy nick');
    });
});

describe('POST /verify-check', () => {
    test('odrzuca bez wcześniejszego kodu', async () => {
        const res = await request(app)
            .post('/verify-check')
            .send({ username: 'NoCode_' + Date.now() });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
    });

    test('odrzuca pusty nick', async () => {
        const res = await request(app)
            .post('/verify-check')
            .send({ username: '' });
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Brak nicku.');
    });
});

describe('POST /verify-start → /verify-check (full flow)', () => {
    test('generuje kod i loguje użytkownika', async () => {
        const username = 'Flow_' + Date.now();

        // Step 1: generate code
        const startRes = await request(app)
            .post('/verify-start')
            .send({ username });
        expect(startRes.status).toBe(200);
        expect(startRes.body.code).toMatch(/^[A-Z0-9]{6}$/);

        // Step 2: verify (code is not actually needed for check, just username)
        const checkRes = await request(app)
            .post('/verify-check')
            .send({ username });
        expect(checkRes.status).toBe(200);
        expect(checkRes.body.success).toBe(true);
        expect(checkRes.body.username).toBe(username);
    });
});

// ── TESTY ENDPOINTÓW PROVIDABLY FAIR ───────────────────────────

describe('GET /api/provably-fair/seed-hash', () => {
    test('zwraca hash server seeda', async () => {
        const res = await request(app).get('/api/provably-fair/seed-hash');
        expect(res.status).toBe(200);
        expect(res.body.hash).toMatch(/^[a-f0-9]{64}$/);
    });
});

describe('GET /api/provably-fair/seed-info', () => {
    test('zwraca informacje o seedach i algorytmie', async () => {
        const res = await request(app).get('/api/provably-fair/seed-info');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('serverSeedHash');
        expect(res.body).toHaveProperty('algorithm');
        expect(res.body.serverSeedHash).toMatch(/^[a-f0-9]{64}$/);
        expect(res.body.algorithm).toContain('SHA-256');
    });
});

describe('GET /api/provably-fair/revealed-seeds', () => {
    test('zwraca listę ujawnionych seedów', async () => {
        const res = await request(app).get('/api/provably-fair/revealed-seeds');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('seeds');
        expect(Array.isArray(res.body.seeds)).toBe(true);
    });
});

describe('POST /api/provably-fair/verify', () => {
    test('odrzuca żądanie bez parametrów (400)', async () => {
        const res = await request(app)
            .post('/api/provably-fair/verify')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('Brak wymaganych pól');
    });

    test('weryfikuje wynik fair z poprawnymi parametrami', async () => {
        const res = await request(app)
            .post('/api/provably-fair/verify')
            .send({ serverSeed: 'testseed', clientSeed: 'testclient', nonce: 0 });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body).toHaveProperty('serverSeedHash');
        expect(res.body).toHaveProperty('computedResult');
        expect(typeof res.body.computedResult).toBe('number');
        expect(res.body.computedResult).toBeGreaterThanOrEqual(0);
    });
});

// ── TESTY BAZY DANYCH ─────────────────────────────────────────

describe('Database - CRUD graczy', () => {
    test('zapis i odczyt gracza', () => {
        const name = 'CRUD_' + Date.now();
        const player = db.getPlayer(name);
        player.coins = 9999;
        db.savePlayer(name, player);

        const loaded = db.getPlayer(name);
        expect(loaded.coins).toBe(9999);
    });

    test('getAllPlayers zwraca obiekt', () => {
        const all = db.getAllPlayers();
        expect(typeof all).toBe('object');
    });

    test('usernameExists sprawdza istnienie', () => {
        const name = 'Exists_' + Date.now();
        expect(db.usernameExists(name)).toBe(false);
        db.getPlayer(name);
        expect(db.usernameExists(name)).toBe(true);
    });

    test('getPlayerCount zwraca liczbę', () => {
        const count = db.getPlayerCount();
        expect(typeof count).toBe('number');
        expect(count).toBeGreaterThanOrEqual(0);
    });
});

describe('Database - czat', () => {
    test('loadChat zwraca tablicę', () => {
        const chat = db.loadChat();
        expect(Array.isArray(chat)).toBe(true);
    });

    test('saveChat/loadChat roundtrip', () => {
        const testMsg = [{ user: 'test', msg: 'hello', time: Date.now() }];
        db.saveChat(testMsg);
        const loaded = db.loadChat();
        expect(loaded).toEqual(testMsg);
        // Cleanup
        db.saveChat([]);
    });
});

describe('Database - promo kody', () => {
    test('loadPromo zwraca obiekt', () => {
        const promos = db.loadPromo();
        expect(typeof promos).toBe('object');
    });

    test('savePromo/loadPromo roundtrip', () => {
        const testPromo = { 'TEST123': { code: 'TEST123', rewardType: 'coins', rewardValue: 100, maxUses: 10, used: 0 } };
        db.savePromo(testPromo);
        const loaded = db.loadPromo();
        expect(loaded.TEST123).toBeTruthy();
        expect(loaded.TEST123.rewardValue).toBe(100);
        // Cleanup
        db.savePromo({});
    });
});

describe('Database - admin', () => {
    test('loadAdmin zwraca obiekt z password', () => {
        const admin = db.loadAdmin();
        expect(admin).toHaveProperty('password');
    });
});

describe('Database - bany', () => {
    test('loadBans zwraca obiekt', () => {
        const bans = db.loadBans();
        expect(typeof bans).toBe('object');
    });
});

describe('Database - ostrzeżenia', () => {
    test('loadWarnings zwraca obiekt', () => {
        const warnings = db.loadWarnings();
        expect(typeof warnings).toBe('object');
    });
});

// ── TESTY GAMES - RECENT GAMES ─────────────────────────────────

describe('games.addRecentGame() / getRecentGames()', () => {
    test('dodaje i zwraca ostatnie gry', () => {
        const countBefore = games.getRecentGames().length;
        games.addRecentGame({ type: 'coinflip', winner: 'test', loser: 'house', amount: 100 });
        const gamesList = games.getRecentGames();
        expect(gamesList.length).toBe(countBefore + 1);
        expect(gamesList[0].type).toBe('coinflip');
    });
});

// ── TESTY DB - APPLY PROMO BONUS ───────────────────────────────

describe('db.applyPromoBonus()', () => {
    const promoUser = 'PromoUser_' + Date.now();
    const promoCode = 'PROMO_' + Date.now();

    beforeEach(() => {
        const promos = db.loadPromo();
        promos[promoCode] = {
            code: promoCode,
            rewards: [{ type: 'coins', amount: 500 }],
            maxUses: 3,
            active: true,
            used: 0,
            usedBy: [],
            createdBy: 'test',
            createdAt: Date.now()
        };
        db.savePromo(promos);
    });

    afterEach(() => {
        const promos = db.loadPromo();
        delete promos[promoCode];
        db.savePromo(promos);
    });

    test('przyznaje coins za poprawny kod', () => {
        const result = db.applyPromoBonus(promoUser, promoCode);
        expect(result.success).toBe(true);
        expect(result.type).toBe('coins');
        expect(result.value).toBe(500);
        const player = db.getPlayer(promoUser);
        expect(player.coins).toBeGreaterThanOrEqual(500);
    });

    test('odrzuca kod już użyty przez gracza', () => {
        db.applyPromoBonus(promoUser, promoCode);
        const result = db.applyPromoBonus(promoUser, promoCode);
        expect(result).not.toBeNull();
        if (result && 'error' in result) {
            expect(result.error).toContain('already used');
        }
    });

    test('odrzuca nieistniejący kod', () => {
        const result = db.applyPromoBonus(promoUser, 'NONEXISTENT');
        expect(result).toBeNull();
    });

    test('odrzuca kod po wykorzystaniu maxUses', () => {
        const users = ['UserA_', 'UserB_', 'UserC_'].map(s => s + Date.now());
        users.forEach(u => db.applyPromoBonus(u, promoCode));
        const result = db.applyPromoBonus('UserD_' + Date.now(), promoCode);
        expect(result).toBeNull();
    });

    test('akceptuje kod z nagrodą gems', () => {
        const gemCode = 'GEM_' + Date.now();
        const promos = db.loadPromo();
        promos[gemCode] = {
            code: gemCode,
            rewards: [{ type: 'gems', amount: 3, qty: 3 }],
            maxUses: 5,
            active: true,
            used: 0,
            usedBy: [],
            createdBy: 'test',
            createdAt: Date.now()
        };
        db.savePromo(promos);
        const gemUser = 'GemUser_' + Date.now();
        const result = db.applyPromoBonus(gemUser, gemCode);
        expect(result.success).toBe(true);
        expect(result.type).toBe('gems');
        const player = db.getPlayer(gemUser);
        expect(player.gems).toBeGreaterThanOrEqual(3);
        delete promos[gemCode];
        db.savePromo(promos);
    });

    test('akceptuje kod z wieloma nagrodami (rewards array)', () => {
        const multiCode = 'MULTI_' + Date.now();
        const promos = db.loadPromo();
        promos[multiCode] = {
            code: multiCode,
            rewards: [
                { type: 'coins', amount: 1000 },
                { type: 'gems', amount: 2, qty: 2 }
            ],
            maxUses: 5,
            active: true,
            used: 0,
            usedBy: [],
            createdBy: 'test',
            createdAt: Date.now()
        };
        db.savePromo(promos);
        const multiUser = 'MultiUser_' + Date.now();
        const result = db.applyPromoBonus(multiUser, multiCode);
        expect(result.success).toBe(true);
        const player = db.getPlayer(multiUser);
        expect(player.coins).toBeGreaterThanOrEqual(1000);
        expect(player.gems).toBeGreaterThanOrEqual(2);
        delete promos[multiCode];
        db.savePromo(promos);
    });
});

// ── TESTY DB - IS BANNED ───────────────────────────────────────

describe('db.isBanned() - zaawansowane', () => {
    test('zwraca null po wygaśnięciu bana', () => {
        const banUser = 'ExpiredBan_' + Date.now();
        const bans = db.loadBans();
        bans[banUser] = { reason: 'Test ban', by: 'test', time: Date.now(), expires: Date.now() - 1000 };
        db.saveBans(bans);
        const result = db.isBanned(banUser);
        expect(result).toBeNull();
        const bansAfter = db.loadBans();
        expect(bansAfter[banUser]).toBeUndefined();
    });

    test('zwraca obiekt bana dla aktywnego bana', () => {
        const activeBanUser = 'ActiveBan_' + Date.now();
        const bans = db.loadBans();
        bans[activeBanUser] = { reason: 'Active test ban', by: 'test', time: Date.now(), expires: null };
        db.saveBans(bans);
        const result = db.isBanned(activeBanUser);
        expect(result).not.toBeNull();
        expect(result.reason).toBe('Active test ban');
        delete bans[activeBanUser];
        db.saveBans(bans);
    });
});

// ── TESTY DB - FILTER ──────────────────────────────────────────

describe('db.loadFilter() / db.saveFilter()', () => {
    test('zwraca domyślny filtr', () => {
        const filter = db.loadFilter();
        expect(Array.isArray(filter.words)).toBe(true);
        expect(typeof filter.enabled).toBe('boolean');
        expect(typeof filter.punishment).toBe('string');
    });

    test('zapisuje i odczytuje własne słowa', () => {
        const testFilter = { words: ['badword', 'spam'], enabled: true, punishment: 'censor' };
        db.saveFilter(testFilter);
        const loaded = db.loadFilter();
        expect(loaded.words).toEqual(['badword', 'spam']);
        expect(loaded.punishment).toBe('censor');
        // Przywróć domyślny
        db.saveFilter({ words: [], enabled: true, punishment: 'block' });
    });
});

// ── TESTY DB - SEED RECORDS ─────────────────────────────────────

describe('db - seed records', () => {
    test('saveSeedRecord i getActiveServerSeed', () => {
        // Odsłoń istniejący aktywny seed (utworzony przez pf.init) żeby nasz był aktywny
        const existing = db.getActiveServerSeed();
        if (existing) {
            db.revealSeedRecord(existing.seed);
        }
        const testSeed = 'a'.repeat(64);
        db.saveSeedRecord({ seed: testSeed, hash: 'hash123', revealed: false, createdAt: Date.now(), gamesPlayed: 0 });
        const active = db.getActiveServerSeed();
        expect(active).not.toBeNull();
        expect(active.seed).toBe(testSeed);
    });

    test('revealSeedRecord i getRevealedSeeds', () => {
        const seed2 = 'b'.repeat(64);
        db.saveSeedRecord({ seed: seed2, hash: 'hash456', revealed: false, createdAt: Date.now(), gamesPlayed: 0 });
        db.revealSeedRecord(seed2);
        const revealed = db.getRevealedSeeds();
        const found = revealed.find(r => r.seed === seed2);
        // getRevealedSeeds zwraca pełne obiekty z bazy (seed, hash, revealed, ...)
        expect(found).toBeTruthy();
        expect(found.revealed).toBe(true);
    });
});

// ── TESTY GAMES - AKTYWNE GRY ──────────────────────────────────

describe('games - active games management', () => {
    test('createGame, getGame, removeGame', () => {
        const gameId = 'test_game_' + Date.now();
        const gameData = { creator: 'test', amount: 100, status: 'waiting', timestamp: Date.now() };
        games.createGame(gameId, gameData);
        const retrieved = games.getGame(gameId);
        expect(retrieved).toEqual(gameData);
        games.removeGame(gameId);
        expect(games.getGame(gameId)).toBeUndefined();
    });

    test('getActiveGamesList zwraca tablicę', () => {
        const list = games.getActiveGamesList();
        expect(Array.isArray(list)).toBe(true);
    });
});

// ── TESTY GAMES - CLEAR STALE GAMES ────────────────────────────

describe('games.clearStaleGames()', () => {
    test('czyści stare oczekujące gry i zwraca monetę', () => {
        const staleUser = 'StaleUser_' + Date.now();
        const player = db.getPlayer(staleUser);
        const initialCoins = player.coins;
        
        const staleGameId = 'stale_' + Date.now();
        games.createGame(staleGameId, {
            creator: staleUser,
            amount: 100,
            status: 'waiting',
            timestamp: Date.now() - 600000 // > 5 min temu
        });
        
        games.clearStaleGames(db);
        expect(games.getGame(staleGameId)).toBeUndefined();
        const refreshedPlayer = db.getPlayer(staleUser);
        expect(refreshedPlayer.coins).toBe(initialCoins + 100);
    });

    test('nie czyści świeżych gier', () => {
        const freshGameId = 'fresh_' + Date.now();
        games.createGame(freshGameId, {
            creator: 'fresh_test',
            amount: 100,
            status: 'waiting',
            timestamp: Date.now()
        });
        games.clearStaleGames(db);
        expect(games.getGame(freshGameId)).toBeTruthy();
        games.removeGame(freshGameId);
    });
});

// ── TESTY PROVIDABLY FAIR - SEED ROTATION ───────────────────────

describe('pf.rotateServerSeed()', () => {
    test('zwraca stary seed po rotacji', () => {
        const oldSeed = pf.getCurrentServerSeed();
        const returned = pf.rotateServerSeed();
        expect(returned).toBe(oldSeed);
    });

    test('generuje nowy hash po rotacji', () => {
        const hashBefore = pf.getServerSeedHash();
        pf.rotateServerSeed();
        const hashAfter = pf.getServerSeedHash();
        expect(hashAfter).not.toBe(hashBefore);
    });

    test('wielokrotna rotacja daje różne hashe', () => {
        const hashes = new Set();
        for (let i = 0; i < 5; i++) {
            pf.rotateServerSeed();
            hashes.add(pf.getServerSeedHash());
        }
        expect(hashes.size).toBe(5);
    });
});

// ── TESTY ADMIN REST API ────────────────────────────────────────

describe('Admin REST API', () => {
    let adminCookie = '';

    beforeAll(async () => {
        // Zaloguj jako admin
        const res = await request(app)
            .post('/admin/login')
            .send({ token: 'test-admin-token-123' });
        expect(res.status).toBe(200);
        // Pobierz ciasteczko z odpowiedzi
        const setCookie = res.headers['set-cookie'];
        if (Array.isArray(setCookie)) {
            adminCookie = setCookie.map(c => c.split(';')[0]).join('; ');
        } else if (setCookie) {
            adminCookie = setCookie.split(';')[0];
        }
        expect(adminCookie).toContain('bf_admin=');
    });

    // ── Admin Dashboard API ──
    test('GET /api/admin/dashboard wymaga autoryzacji', async () => {
        const res = await request(app).get('/api/admin/dashboard');
        expect(res.status).toBe(401);
    });

    test('GET /api/admin/dashboard zwraca dane dashboardu', async () => {
        const res = await request(app)
            .get('/api/admin/dashboard')
            .set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('totalPlayers');
        expect(res.body).toHaveProperty('onlinePlayers');
        expect(res.body).toHaveProperty('gamesByDay');
        expect(res.body).toHaveProperty('logsByType');
    });

    // ── Admin Players API ──
    test('GET /api/admin/players wymaga autoryzacji', async () => {
        const res = await request(app).get('/api/admin/players');
        expect(res.status).toBe(401);
    });

    test('GET /api/admin/players zwraca listę graczy', async () => {
        // Stwórz gracza
        const testPlayer = 'AdminListTest_' + Date.now();
        db.getPlayer(testPlayer);
        
        const res = await request(app)
            .get('/api/admin/players')
            .set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('players');
        expect(res.body).toHaveProperty('total');
        expect(res.body).toHaveProperty('pages');
        expect(Array.isArray(res.body.players)).toBe(true);
    });

    test('GET /api/admin/players?q=... filtruje po nazwie', async () => {
        const res = await request(app)
            .get('/api/admin/players?q=' + encodeURIComponent('nonexistent_player_xyz'))
            .set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body.players.length).toBe(0);
    });

    // ── Admin Logs API ──
    test('GET /api/admin/logs wymaga autoryzacji', async () => {
        const res = await request(app).get('/api/admin/logs');
        expect(res.status).toBe(401);
    });

    test('GET /api/admin/logs zwraca logi', async () => {
        const res = await request(app)
            .get('/api/admin/logs')
            .set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('logs');
        expect(res.body).toHaveProperty('total');
        expect(res.body).toHaveProperty('pages');
    });

    // ── Admin Requests API ──
    test('GET /api/admin/requests wymaga autoryzacji', async () => {
        const res = await request(app).get('/api/admin/requests');
        expect(res.status).toBe(401);
    });

    test('GET /api/admin/requests zwraca requesty', async () => {
        const res = await request(app)
            .get('/api/admin/requests')
            .set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('requests');
    });

    // ── Admin Promo Codes API ──
    test('GET /api/admin/promo-codes wymaga autoryzacji', async () => {
        const res = await request(app).get('/api/admin/promo-codes');
        expect(res.status).toBe(401);
    });

    test('GET /api/admin/promo-codes zwraca kody', async () => {
        const res = await request(app)
            .get('/api/admin/promo-codes')
            .set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('codes');
        expect(res.body).toHaveProperty('total');
    });

    test('POST /api/admin/promo-codes tworzy nowy kod', async () => {
        const testCode = 'TESTCODE_' + Date.now().toString(36).toUpperCase();
        const res = await request(app)
            .post('/api/admin/promo-codes')
            .set('Cookie', adminCookie)
            .send({ code: testCode, rewards: [{ type: 'coins', amount: 100 }], maxUses: 5 });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // Posprzątaj
        const promos = db.loadPromo();
        delete promos[testCode];
        db.savePromo(promos);
    });

    test('POST /api/admin/promo-codes odrzuca brak kodu', async () => {
        const res = await request(app)
            .post('/api/admin/promo-codes')
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('Podaj nazwę');
    });

    test('POST /api/admin/promo-codes/:id/toggle przełącza status', async () => {
        const toggleCode = 'TOGGLE_' + Date.now().toString(36).toUpperCase();
        // Najpierw utwórz kod
        const promos = db.loadPromo();
        promos[toggleCode] = { code: toggleCode, rewards: [{ type: 'coins', amount: 100 }], maxUses: 5, active: true, used: 0, usedBy: [], createdBy: 'test', createdAt: Date.now() };
        db.savePromo(promos);
        
        // Przełącz
        const res = await request(app)
            .post(`/api/admin/promo-codes/${toggleCode}/toggle`)
            .set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
        
        const updatedPromos = db.loadPromo();
        expect(updatedPromos[toggleCode].active).toBe(false);
        delete updatedPromos[toggleCode];
        db.savePromo(updatedPromos);
    });

    // ── Admin Chat Filter API ──
    test('GET /api/admin/chat-filter wymaga autoryzacji', async () => {
        const res = await request(app).get('/api/admin/chat-filter');
        expect(res.status).toBe(401);
    });

    test('GET /api/admin/chat-filter zwraca filtr', async () => {
        const res = await request(app)
            .get('/api/admin/chat-filter')
            .set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('words');
    });

    test('POST /api/admin/chat-filter/save zapisuje filtr', async () => {
        const res = await request(app)
            .post('/api/admin/chat-filter/save')
            .set('Cookie', adminCookie)
            .send({ words: ['badword'], enabled: true, punishment: 'block' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    // ── Admin System Message API ──
    test('POST /api/admin/system-message wymaga autoryzacji', async () => {
        const res = await request(app).post('/api/admin/system-message').send({ message: 'test' });
        expect(res.status).toBe(401);
    });

    test('POST /api/admin/system-message odrzuca pustą wiadomość', async () => {
        const res = await request(app)
            .post('/api/admin/system-message')
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(400);
    });

    // ── Admin Player Actions API ──
    test('POST /api/admin/players/:id/warn wymaga powodu', async () => {
        const warnUser = 'WarnUser_' + Date.now();
        const res = await request(app)
            .post(`/api/admin/players/${warnUser}/warn`)
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(400);
    });

    test('POST /api/admin/players/:id/role ustawia rolę', async () => {
        const roleUser = 'RoleUser_' + Date.now();
        db.getPlayer(roleUser);
        const res = await request(app)
            .post(`/api/admin/players/${roleUser}/role`)
            .set('Cookie', adminCookie)
            .send({ role: 'mod' });
        expect(res.status).toBe(200);
        const player = db.getPlayer(roleUser);
        expect(player.roles).toContain('mod');
    });

    test('POST /api/admin/players/:id/ban banuje gracza', async () => {
        const banUser = 'BanUser_' + Date.now();
        db.getPlayer(banUser);
        const res = await request(app)
            .post(`/api/admin/players/${banUser}/ban`)
            .set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(db.isBanned(banUser)).not.toBeNull();
        // Odbanuj
        const bans = db.loadBans();
        delete bans[banUser];
        db.saveBans(bans);
    });

    test('POST /api/admin/players/:id/unban odbanowuje gracza', async () => {
        const unbanUser = 'UnbanUser_' + Date.now();
        const bans = db.loadBans();
        bans[unbanUser] = { reason: 'test', by: 'test', time: Date.now(), expires: null };
        db.saveBans(bans);
        const res = await request(app)
            .post(`/api/admin/players/${unbanUser}/unban`)
            .set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(db.isBanned(unbanUser)).toBeNull();
    });

    test('POST /api/admin/players/:id/balance ustawia saldo', async () => {
        const balanceUser = 'BalanceUser_' + Date.now();
        db.getPlayer(balanceUser);
        const res = await request(app)
            .post(`/api/admin/players/${balanceUser}/balance`)
            .set('Cookie', adminCookie)
            .send({ amount: 9999 });
        expect(res.status).toBe(200);
        const player = db.getPlayer(balanceUser);
        expect(player.coins).toBe(9999);
    });

    // ── Admin Logout ──
    test('POST /admin/logout wylogowuje admina', async () => {
        const res = await request(app).post('/admin/logout');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // Kolejne żądanie bez ciasteczka nie powinno działać
        const dashboardRes = await request(app).get('/api/admin/dashboard');
        expect(dashboardRes.status).toBe(401);
    });
});

// ── TESTY BOT API ───────────────────────────────────────────────

describe('Bot API', () => {
    test('GET /api/bot/pending-deposits odrzuca bez sekretu', async () => {
        const res = await request(app).get('/api/bot/pending-deposits');
        expect(res.status).toBe(403);
    });

    test('GET /api/bot/pending-deposits odrzuca zły sekret', async () => {
        const res = await request(app)
            .get('/api/bot/pending-deposits')
            .set('x-bot-secret', 'wrong-secret');
        expect(res.status).toBe(403);
    });

    test('GET /api/bot/pending-deposits z poprawnym sekretem', async () => {
        const res = await request(app)
            .get('/api/bot/pending-deposits')
            .set('x-bot-secret', process.env.BOT_SECRET || '92d79e9b8988a59c4d9a135f8c2d9e7b80e141fb26576a86a857a810fa6a71ce');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('requests');
    });

    test('POST /api/bot/update-deposit odrzuca bez sekretu', async () => {
        const res = await request(app)
            .post('/api/bot/update-deposit')
            .send({ requestId: 'test', status: 'valued' });
        expect(res.status).toBe(403);
    });

    test('POST /api/bot/update-deposit odrzuca brak pól', async () => {
        const res = await request(app)
            .post('/api/bot/update-deposit')
            .set('x-bot-secret', process.env.BOT_SECRET || '92d79e9b8988a59c4d9a135f8c2d9e7b80e141fb26576a86a857a810fa6a71ce')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Missing');
    });

    test('POST /api/bot/update-deposit nie znajduje requestu', async () => {
        const res = await request(app)
            .post('/api/bot/update-deposit')
            .set('x-bot-secret', process.env.BOT_SECRET || '92d79e9b8988a59c4d9a135f8c2d9e7b80e141fb26576a86a857a810fa6a71ce')
            .send({ requestId: 'nonexistent_request_id', status: 'valued' });
        expect(res.status).toBe(404);
    });
});

// ── TESTY EDGE CASE'ÓW VALIDACJI ───────────────────────────────

describe('Username validation endpoint', () => {
    test('POST /verify-start odrzuca za długi nick', async () => {
        const res = await request(app)
            .post('/verify-start')
            .send({ username: 'a'.repeat(21) });
        expect(res.body.message).toContain('Nieprawidłowy nick');
    });

    test('POST /verify-start odrzuca nick z niedozwolonymi znakami', async () => {
        const res = await request(app)
            .post('/verify-start')
            .send({ username: '<script>alert(1)</script>' });
        expect(res.body.message).toContain('Nieprawidłowy nick');
    });
});

// ── TESTY PROVIDABLY FAIR ENDPOINTÓW - EDGE CASE ───────────────

describe('GET /api/provably-fair/seed-history', () => {
    test('zwraca paginowaną historię', async () => {
        const res = await request(app).get('/api/provably-fair/seed-history?page=1&limit=5');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('seeds');
        expect(res.body).toHaveProperty('page');
        expect(res.body).toHaveProperty('pages');
        expect(res.body).toHaveProperty('total');
        expect(Array.isArray(res.body.seeds)).toBe(true);
    });

    test('każdy seed ma hash SHA-256', async () => {
        const res = await request(app).get('/api/provably-fair/seed-history');
        if (res.body.seeds.length > 0) {
            res.body.seeds.forEach(s => {
                expect(s.hash).toMatch(/^[a-f0-9]{64}$/);
                expect(s).toHaveProperty('revealed');
                expect(s).toHaveProperty('createdAt');
            });
        }
    });
});

// ── TESTY PLAYER REST API (profile, leaderboard, deposit, inventory, promo) ──

describe('Player REST API', () => {
    let sessionCookie = '';
    const testUser = 'REST_' + Date.now().toString(36).toUpperCase();

    beforeAll(async () => {
        // Zaloguj użytkownika przez verify flow
        await request(app)
            .post('/verify-start')
            .send({ username: testUser });

        const checkRes = await request(app)
            .post('/verify-check')
            .send({ username: testUser });
        expect(checkRes.status).toBe(200);
        expect(checkRes.body.success).toBe(true);

        const setCookie = checkRes.headers['set-cookie'];
        if (Array.isArray(setCookie)) {
            sessionCookie = setCookie.map(c => c.split(';')[0]).join('; ');
        } else if (setCookie) {
            sessionCookie = setCookie.split(';')[0];
        }
        expect(sessionCookie).toContain('bf_session=');

        // Daj graczowi trochę monet dla testów
        const player = db.getPlayer(testUser);
        player.coins = 10000;
        db.savePlayer(testUser, player);
    });

    // ── GET /api/profile/stats ──
    describe('GET /api/profile/stats', () => {
        test('odrzuca bez autoryzacji', async () => {
            const res = await request(app).get('/api/profile/stats');
            expect(res.status).toBe(401);
        });

        test('zwraca statystyki profilu', async () => {
            const res = await request(app)
                .get('/api/profile/stats')
                .set('Cookie', sessionCookie);
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('total');
            expect(res.body).toHaveProperty('wins');
            expect(res.body).toHaveProperty('losses');
            expect(res.body).toHaveProperty('profit');
            expect(res.body).toHaveProperty('level');
            expect(res.body).toHaveProperty('levelName');
            expect(res.body).toHaveProperty('coins');
            expect(res.body).toHaveProperty('gems');
        });
    });

    // ── GET /api/profile/public/:userId ──
    describe('GET /api/profile/public/:userId', () => {
        test('zwraca 404 dla nieistniejącego gracza', async () => {
            const res = await request(app)
                .get('/api/profile/public/NonexistentUser_' + Date.now());
            expect(res.status).toBe(404);
            expect(res.body.error).toContain('Player not found');
        });

        test('zwraca publiczny profil istniejącego gracza', async () => {
            const res = await request(app)
                .get('/api/profile/public/' + testUser);
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('username');
            expect(res.body).toHaveProperty('total');
            expect(res.body).toHaveProperty('wins');
            expect(res.body).toHaveProperty('losses');
            expect(res.body).toHaveProperty('profit');
            expect(res.body).toHaveProperty('balance');
            expect(res.body).toHaveProperty('gems');
            expect(res.body).toHaveProperty('level');
            expect(res.body).toHaveProperty('levelName');
            expect(res.body.username).toBe(testUser);
        });
    });

    // ── POST /api/profile/:userId/tip ──
    describe('POST /api/profile/:userId/tip', () => {
        const tipTarget = 'TipTarget_' + Date.now();

        beforeAll(() => {
            db.getPlayer(tipTarget); // ensure exists
        });

        test('odrzuca bez autoryzacji', async () => {
            const res = await request(app)
                .post('/api/profile/' + tipTarget + '/tip')
                .send({ amount: 100 });
            expect(res.status).toBe(401);
        });

        test('odrzuca nieprawidłową kwotę', async () => {
            const res = await request(app)
                .post('/api/profile/' + tipTarget + '/tip')
                .set('Cookie', sessionCookie)
                .send({ amount: 0 });
            expect(res.body.ok).toBe(false);
        });

        test('wysyła tip', async () => {
            const senderBefore = db.getPlayer(testUser);
            const targetBefore = db.getPlayer(tipTarget);

            const res = await request(app)
                .post('/api/profile/' + tipTarget + '/tip')
                .set('Cookie', sessionCookie)
                .send({ amount: 500 });
            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);

            const senderAfter = db.getPlayer(testUser);
            const targetAfter = db.getPlayer(tipTarget);
            expect(senderAfter.coins).toBe(senderBefore.coins - 500);
            expect(targetAfter.coins).toBe(targetBefore.coins + 500);
        });
    });

    // ── GET /api/leaderboard ──
    describe('GET /api/leaderboard', () => {
        test('zwraca ranking graczy', async () => {
            const res = await request(app).get('/api/leaderboard');
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('leaderboard');
            expect(Array.isArray(res.body.leaderboard)).toBe(true);
        });

        test('leaderboard zawiera poprawne pola', async () => {
            const res = await request(app).get('/api/leaderboard');
            if (res.body.leaderboard.length > 0) {
                const entry = res.body.leaderboard[0];
                expect(entry).toHaveProperty('username');
                expect(entry).toHaveProperty('wins');
                expect(entry).toHaveProperty('losses');
                expect(entry).toHaveProperty('profit');
            }
        });
    });

    // ── POST /api/promo/redeem ──
    describe('POST /api/promo/redeem', () => {
        const promoCode = 'REDEEMTEST_' + Date.now().toString(36).toUpperCase();

        beforeAll(() => {
            const promos = db.loadPromo();
            promos[promoCode] = {
                code: promoCode,
                rewards: [{ type: 'coins', amount: 1000 }],
                maxUses: 5,
                active: true,
                used: 0,
                usedBy: [],
                createdBy: 'test',
                createdAt: Date.now()
            };
            db.savePromo(promos);
        });

        afterAll(() => {
            const promos = db.loadPromo();
            delete promos[promoCode];
            db.savePromo(promos);
        });

        test('odrzuca bez autoryzacji', async () => {
            const res = await request(app)
                .post('/api/promo/redeem')
                .send({ code: promoCode });
            expect(res.status).toBe(401);
        });

        test('odrzuca brak kodu', async () => {
            const res = await request(app)
                .post('/api/promo/redeem')
                .set('Cookie', sessionCookie)
                .send({});
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('Podaj kod');
        });

        test('odrzuca nieistniejący kod', async () => {
            const res = await request(app)
                .post('/api/promo/redeem')
                .set('Cookie', sessionCookie)
                .send({ code: 'NONEXISTENT' });
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('Nieprawidłowy');
        });

        test('realizuje poprawny kod promocyjny', async () => {
            const coinsBefore = db.getPlayer(testUser).coins;

            const res = await request(app)
                .post('/api/promo/redeem')
                .set('Cookie', sessionCookie)
                .send({ code: promoCode });
            expect(res.body.success).toBe(true);

            const coinsAfter = db.getPlayer(testUser).coins;
            expect(coinsAfter).toBe(coinsBefore + 1000);
        });

        test('odrzuca już użyty kod', async () => {
            const res = await request(app)
                .post('/api/promo/redeem')
                .set('Cookie', sessionCookie)
                .send({ code: promoCode });
            expect(res.body.success).toBe(false);
        });
    });

    // ── GET /api/inventory ──
    describe('GET /api/inventory', () => {
        test('odrzuca bez autoryzacji', async () => {
            const res = await request(app).get('/api/inventory');
            expect(res.status).toBe(401);
        });

        test('zwraca pusty inventory', async () => {
            const res = await request(app)
                .get('/api/inventory')
                .set('Cookie', sessionCookie);
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('items');
            expect(Array.isArray(res.body.items)).toBe(true);
        });

        test('zwraca inventory z przedmiotami', async () => {
            db.addInventoryItem(testUser, 'Huge Cat', 2, 50000);
            const res = await request(app)
                .get('/api/inventory')
                .set('Cookie', sessionCookie);
            expect(res.status).toBe(200);
            const cat = res.body.items.find(i => i.name === 'Huge Cat');
            expect(cat).toBeTruthy();
            expect(cat.qty).toBe(2);
        });
    });

    // ── GET /api/inventory/with-rap ──
    describe('GET /api/inventory/with-rap', () => {
        test('zwraca inventory z RAP', async () => {
            const res = await request(app)
                .get('/api/inventory/with-rap')
                .set('Cookie', sessionCookie);
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('items');
            expect(Array.isArray(res.body.items)).toBe(true);
            if (res.body.items.length > 0) {
                expect(res.body.items[0]).toHaveProperty('rap');
            }
        });
    });

    // ── GET /api/pets/search ──
    describe('GET /api/pets/search', () => {
        test('zwraca wszystkie pety bez query', async () => {
            const res = await request(app).get('/api/pets/search');
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('results');
            expect(Array.isArray(res.body.results)).toBe(true);
            expect(res.body.results.length).toBeGreaterThan(0);
        });

        test('filtruje po nazwie', async () => {
            const res = await request(app).get('/api/pets/search?q=Huge');
            expect(res.status).toBe(200);
            expect(res.body.results.every(p => p.name.toLowerCase().includes('huge'))).toBe(true);
        });

        test('filtruje po kategorii', async () => {
            const res = await request(app).get('/api/pets/search?category=Gem');
            expect(res.status).toBe(200);
            expect(res.body.results.every(p => p.category === 'Gem')).toBe(true);
        });

        test('ogranicza wyniki', async () => {
            const res = await request(app).get('/api/pets/search?q=Cat&limit=1');
            expect(res.status).toBe(200);
            expect(res.body.results.length).toBeLessThanOrEqual(1);
        });

        test('zwraca pety z RAP', async () => {
            const res = await request(app).get('/api/pets/search?q=Huge+Cat');
            expect(res.status).toBe(200);
            if (res.body.results.length > 0) {
                expect(res.body.results[0]).toHaveProperty('rap');
                expect(typeof res.body.results[0].rap).toBe('number');
            }
        });
    });

    // ── POST /api/deposit/request ──
    describe('POST /api/deposit/request', () => {
        test('odrzuca bez autoryzacji', async () => {
            const res = await request(app)
                .post('/api/deposit/request')
                .send({ items: [{ name: 'Huge Cat', qty: 1 }] });
            expect(res.status).toBe(401);
        });

        test('odrzuca brak itemów', async () => {
            const res = await request(app)
                .post('/api/deposit/request')
                .set('Cookie', sessionCookie)
                .send({});
            expect(res.status).toBe(400);
            expect(res.body.error).toContain('No items');
        });

        test('tworzy request depozytu', async () => {
            const res = await request(app)
                .post('/api/deposit/request')
                .set('Cookie', sessionCookie)
                .send({ items: [{ name: 'Huge Cat', qty: 1 }], note: 'Test deposit' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body).toHaveProperty('requestId');

            // Sprawdź czy request został zapisany
            const requests = db.loadRequests();
            const found = requests.find(r => r._id === res.body.requestId);
            expect(found).toBeTruthy();
            expect(found.username).toBe(testUser);
            expect(found.type).toBe('deposit');
        });
    });

    // ── POST /api/withdraw/request ──
    describe('POST /api/withdraw/request', () => {
        test('odrzuca bez autoryzacji', async () => {
            const res = await request(app)
                .post('/api/withdraw/request')
                .send({ items: [{ name: 'Huge Cat', qty: 1 }] });
            expect(res.status).toBe(401);
        });

        test('odrzuca brak itemów', async () => {
            const res = await request(app)
                .post('/api/withdraw/request')
                .set('Cookie', sessionCookie)
                .send({});
            expect(res.status).toBe(400);
            expect(res.body.error).toContain('No items');
        });

        test('odrzuca gdy brak itemów w inventarzu', async () => {
            const res = await request(app)
                .post('/api/withdraw/request')
                .set('Cookie', sessionCookie)
                .send({ items: [{ name: 'Nonexistent Item', qty: 1 }] });
            expect(res.status).toBe(400);
            expect(res.body.error).toContain('Not enough');
        });

        test('tworzy request wypłaty i usuwa itemy z inventarza', async () => {
            // Najpierw dodaj item do inventarza
            db.addInventoryItem(testUser, 'Huge Dog', 3, 45000);

            const res = await request(app)
                .post('/api/withdraw/request')
                .set('Cookie', sessionCookie)
                .send({ items: [{ name: 'Huge Dog', qty: 2 }], note: 'Test withdraw' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body).toHaveProperty('requestId');

            // Sprawdź czy item został usunięty z inventarza
            const inv = db.getInventory(testUser);
            const dog = inv.find(i => i.name === 'Huge Dog');
            expect(dog.qty).toBe(1); // 3 - 2 = 1

            // Sprawdź czy request został zapisany
            const requests = db.loadRequests();
            const found = requests.find(r => r._id === res.body.requestId);
            expect(found).toBeTruthy();
            expect(found.username).toBe(testUser);
            expect(found.type).toBe('withdraw');
        });
    });

    // ── GET /api/requests ──
    describe('GET /api/requests', () => {
        test('odrzuca bez autoryzacji', async () => {
            const res = await request(app).get('/api/requests');
            expect(res.status).toBe(401);
        });

        test('zwraca requesty użytkownika', async () => {
            const res = await request(app)
                .get('/api/requests')
                .set('Cookie', sessionCookie);
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('requests');
            expect(Array.isArray(res.body.requests)).toBe(true);
            expect(res.body.requests.length).toBeGreaterThanOrEqual(2); // deposit + withdraw

            // Wszystkie requesty należą do testUser
            res.body.requests.forEach(r => {
                expect(r.username).toBe(testUser);
            });
        });
    });

    // ── POST /api/gems/merge ──
    describe('POST /api/gems/merge', () => {
        test('odrzuca bez autoryzacji', async () => {
            const res = await request(app)
                .post('/api/gems/merge')
                .send({ recipe: 0 });
            expect(res.status).toBe(401);
        });

        test('odrzuca nieprawidłowy recipe index', async () => {
            const res = await request(app)
                .post('/api/gems/merge')
                .set('Cookie', sessionCookie)
                .send({});
            expect(res.body.ok).toBe(false);
        });

        test('odrzuca gdy brak gemów do mergowania', async () => {
            const res = await request(app)
                .post('/api/gems/merge')
                .set('Cookie', sessionCookie)
                .send({ recipe: 0 }); // potrzebuje 10x Gem 💎 1M
            expect(res.body.ok).toBe(false);
            expect(res.body.message).toContain('Need');
        });

        test('merguje gemy gdy są dostępne', async () => {
            // Dodaj 10x Gem 💎 1M do inventarza
            for (let i = 0; i < 10; i++) {
                db.addInventoryItem(testUser, 'Gem 💎 1M', 1, 1000000);
            }

            // Sprawdź czy mamy 10 przed merge
            let inv = db.getInventory(testUser);
            const gem1m = inv.find(i => i.name === 'Gem 💎 1M');
            expect(gem1m.qty).toBeGreaterThanOrEqual(10);

            const res = await request(app)
                .post('/api/gems/merge')
                .set('Cookie', sessionCookie)
                .send({ recipe: 0 }); // 10x Gem 💎 1M → 1x Gem 💎 10M
            expect(res.body.ok).toBe(true);

            // Sprawdź czy gemy się zmieniły
            inv = db.getInventory(testUser);
            const gem10m = inv.find(i => i.name === 'Gem 💎 10M');
            expect(gem10m).toBeTruthy();
            expect(gem10m.qty).toBeGreaterThanOrEqual(1);
        });
    });
});

// ── CLEANUP ─────────────────────────────────────────────────────

afterAll(() => {
    // Cleanup test data
    const dataDir = path.join(__dirname, '..', 'data');
    if (fs.existsSync(dataDir)) {
        const files = fs.readdirSync(dataDir);
        files.forEach(f => {
            if (f.endsWith('.json')) {
                try { fs.unlinkSync(path.join(dataDir, f)); } catch {}
            }
        });
    }
});

// Cleanup open handles i serwer
const server = require('../server').server;
afterAll(() => {
    try { server.close(); } catch (e) {}
});
