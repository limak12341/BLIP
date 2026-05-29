const request = require('supertest');
const path = require('path');
const fs = require('fs');

// Set test environment
process.env.NODE_ENV = 'test';

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
        expect(player.coins).toBe(500);
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

// ── TESTY GAMES MODULE ─────────────────────────────────────────

describe('games.PETS', () => {
    test('zawiera oczekiwane zwierzaki', () => {
        expect(games.PETS.common_egg).toBeTruthy();
        expect(games.PETS.rare_egg).toBeTruthy();
        expect(games.PETS.epic_egg).toBeTruthy();
        expect(games.PETS.legendary_egg).toBeTruthy();
        expect(games.PETS.baby_dragon).toBeTruthy();
        expect(games.PETS.phoenix).toBeTruthy();
    });

    test('każdy pet ma bonus > 1', () => {
        Object.values(games.PETS).forEach(pet => {
            expect(pet.bonus).toBeGreaterThan(1);
        });
    });
});

describe('games.WAGER_ITEMS', () => {
    test('zawiera 4 gemy', () => {
        expect(Object.keys(games.WAGER_ITEMS)).toHaveLength(4);
    });

    test('każdy gem ma wartość > 0', () => {
        Object.values(games.WAGER_ITEMS).forEach(gem => {
            expect(gem.value).toBeGreaterThan(0);
        });
    });
});

describe('games.getPetBonus()', () => {
    test('zwraca 1.0 dla gracza bez peta', () => {
        const name = 'NoPet_' + Date.now();
        expect(games.getPetBonus(name, db)).toBe(1.0);
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
