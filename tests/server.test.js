const request = require('supertest');
const path = require('path');
const fs = require('fs');

// Ustaw NODE_ENV na 'test' przed załadowaniem serwera
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-token-123';
process.env.SESSION_SECRET = 'test-secret-xyz';

const { app, normalizeUsername, fmt, guessCategory, newId, sanitizeItems, GEMS, GEM_MERGE_RECIPES } = require('../server');

// Usuń tymczasowe bazy danych po testach
afterAll(() => {
    const dbFiles = [
        'baza_graczy.db', 'baza_historii.db', 'baza_lobby.db',
        'baza_inventory.db', 'baza_requests.db', 'baza_chat.db',
        'baza_logow.db', 'baza_ostrzezen.db', 'baza_escrow.db',
        'promocodes.db'
    ];
    dbFiles.forEach(f => {
        const p = path.join(__dirname, '..', f);
        if (fs.existsSync(p)) {
            try { fs.unlinkSync(p); } catch {}
        }
    });
});

// ── TESTY FUNKCJI POMOCNICZYCH ──────────────────────────────────

describe('normalizeUsername()', () => {
    test('zwraca pusty string dla undefined/null', () => {
        expect(normalizeUsername(undefined)).toBe('');
        expect(normalizeUsername(null)).toBe('');
    });

    test('trimuje i konwertuje na string', () => {
        expect(normalizeUsername('  Hello  ')).toBe('Hello');
        expect(normalizeUsername('Test')).toBe('Test');
    });

    test('obsługuje liczby', () => {
        expect(normalizeUsername(123)).toBe('123');
    });
});

describe('fmt()', () => {
    test('formatuje małe liczby', () => {
        expect(fmt(0)).toBe('0');
        expect(fmt(500)).toBe('500');
        expect(fmt(999)).toBe('999');
    });

    test('formatuje tysiące (K)', () => {
        expect(fmt(1000)).toBe('1.0K');
        expect(fmt(1500)).toBe('1.5K');
        expect(fmt(10000)).toBe('10K');
        expect(fmt(999999)).toBe('1000K');
    });

    test('formatuje miliony (M)', () => {
        expect(fmt(1_000_000)).toBe('1.0M');
        expect(fmt(2_500_000)).toBe('2.5M');
        expect(fmt(10_000_000)).toBe('10M');
    });

    test('formatuje miliardy (B)', () => {
        expect(fmt(1_000_000_000)).toBe('1.0B');
        expect(fmt(50_000_000_000)).toBe('50B');
    });
});

describe('guessCategory()', () => {
    test('rozpoznaje gemy', () => {
        expect(guessCategory('Gem 💎 1M')).toBe('Gem');
        expect(guessCategory('Gem 💎 500M')).toBe('Gem');
    });

    test('rozpoznaje Titanic', () => {
        expect(guessCategory('Titanic Dragon')).toBe('Titanic');
    });

    test('rozpoznaje Gargantuan', () => {
        expect(guessCategory('Gargantuan Cat')).toBe('Gargantuan');
    });

    test('rozpoznaje Huge', () => {
        expect(guessCategory('Huge Dog')).toBe('Huge');
    });

    test('zwraca Unknown dla nieznanych', () => {
        expect(guessCategory('Something Random')).toBe('Unknown');
        expect(guessCategory('')).toBe('Unknown');
        expect(guessCategory(null)).toBe('Unknown');
    });
});

describe('newId()', () => {
    test('generuje ID z prefiksem', () => {
        const id = newId('test');
        expect(id).toMatch(/^test_\d+_[a-z0-9]{6}$/);
    });

    test('generuje unikalne ID', () => {
        const ids = new Set();
        for (let i = 0; i < 100; i++) {
            ids.add(newId('u'));
        }
        expect(ids.size).toBe(100);
    });
});

describe('sanitizeItems()', () => {
    test('zwraca pustą tablicę dla nie-array', () => {
        expect(sanitizeItems(null)).toEqual([]);
        expect(sanitizeItems(undefined)).toEqual([]);
        expect(sanitizeItems('test')).toEqual([]);
    });

    test('sanitizuje itemy', () => {
        const items = [
            { name: '  Test Item  ', qty: '5', rap: '1000' },
            { name: 'Gem 💎 1M', qty: 2, rap: 1_000_000 }
        ];
        const result = sanitizeItems(items);
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('Test Item');
        expect(result[0].qty).toBe(5);
        expect(result[0].rap).toBe(1000);
        expect(result[1].category).toBe('Gem');
    });

    test('filtruje puste nazwy', () => {
        const items = [
            { name: '', qty: 1 },
            { name: 'Valid', qty: 1 }
        ];
        expect(sanitizeItems(items)).toHaveLength(1);
    });

    test('obcina zbyt długie nazwy', () => {
        const items = [{ name: 'A'.repeat(100), qty: 1 }];
        expect(sanitizeItems(items)[0].name.length).toBe(80);
    });

    test('ogranicza qty do zakresu 1-9999', () => {
        expect(sanitizeItems([{ name: 'Test', qty: 0 }])[0].qty).toBe(1);
        expect(sanitizeItems([{ name: 'Test', qty: 99999, rap: 0 }])[0].qty).toBe(9999);
    });
});

// ── TESTY KONFIGURACJI ──────────────────────────────────────────

describe('GEMS', () => {
    test('zawiera 6 gemów', () => {
        expect(GEMS).toHaveLength(6);
    });

    test('każdy gem ma nazwę i wartość', () => {
        GEMS.forEach(gem => {
            expect(gem.name).toBeTruthy();
            expect(gem.value).toBeGreaterThan(0);
        });
    });

    test('gemy są posortowane rosnąco po wartości', () => {
        for (let i = 1; i < GEMS.length; i++) {
            expect(GEMS[i].value).toBeGreaterThan(GEMS[i - 1].value);
        }
    });
});

describe('GEM_MERGE_RECIPES', () => {
    test('zawiera 5 przepisów', () => {
        expect(GEM_MERGE_RECIPES).toHaveLength(5);
    });

    test('każdy przepis ma pola in/inQty/out/outQty', () => {
        GEM_MERGE_RECIPES.forEach(r => {
            expect(r.in).toBeTruthy();
            expect(r.inQty).toBeGreaterThan(0);
            expect(r.out).toBeTruthy();
            expect(r.outQty).toBeGreaterThan(0);
        });
    });
});

// ── TESTY ENDPOINTÓW (podstawowe) ───────────────────────────────

describe('GET /', () => {
    test('zwraca stronę główną (HTML)', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toContain('<!DOCTYPE html>');
    });
});

describe('GET /admin', () => {
    test('zwraca panel admina (HTML)', async () => {
        const res = await request(app).get('/admin');
        expect(res.status).toBe(200);
        expect(res.text).toContain('BFLIP Admin');
    });
});

describe('POST /admin/login', () => {
    test('odrzuca bez tokena', async () => {
        const res = await request(app)
            .post('/admin/login')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Podaj token.');
    });

    test('odrzuca z błędnym tokenem', async () => {
        const res = await request(app)
            .post('/admin/login')
            .send({ token: 'zly-token' });
        expect(res.status).toBe(401);
        expect(res.body.message).toBe('Zły token.');
    });

    test('akceptuje poprawny token', async () => {
        const res = await request(app)
            .post('/admin/login')
            .send({ token: 'test-token-123' });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });
});

describe('GET /api/leaderboard', () => {
    test('zwraca leaderboard', async () => {
        const res = await request(app).get('/api/leaderboard');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.leaderboard)).toBe(true);
    });
});

describe('GET /api/admin/players (bez auth)', () => {
    test('odrzuca bez sesji admina', async () => {
        const res = await request(app).get('/api/admin/players');
        expect(res.status).toBe(401);
    });
});

describe('GET /api/admin/players (z auth)', () => {
    test('zwraca paginację', async () => {
        // Najpierw zaloguj jako admin
        const agent = request.agent(app);
        await agent.post('/admin/login').send({ token: 'test-token-123' });

        const res = await agent.get('/api/admin/players');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.players)).toBe(true);
        expect(res.body).toHaveProperty('total');
        expect(res.body).toHaveProperty('page');
        expect(res.body).toHaveProperty('pages');
        expect(res.body).toHaveProperty('limit');
        expect(typeof res.body.total).toBe('number');
    });

    test('akceptuje parametry page i limit', async () => {
        const agent = request.agent(app);
        await agent.post('/admin/login').send({ token: 'test-token-123' });

        const res = await agent.get('/api/admin/players?page=1&limit=10');
        expect(res.status).toBe(200);
        expect(res.body.page).toBe(1);
        expect(res.body.limit).toBe(10);
    });

    test('ogranicza limit do max 100', async () => {
        const agent = request.agent(app);
        await agent.post('/admin/login').send({ token: 'test-token-123' });

        const res = await agent.get('/api/admin/players?limit=999');
        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(100);
    });
});

describe('POST /verify-start', () => {
    test('odrzuca bez username', async () => {
        const res = await request(app)
            .post('/verify-start')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Podaj nick!');
    });

    test('zwraca kod weryfikacyjny', async () => {
        const res = await request(app)
            .post('/verify-start')
            .send({ username: 'TestPlayer' });
        expect(res.status).toBe(200);
        expect(res.body.code).toMatch(/^blox[A-Z0-9]{4}$/);
    });
});

describe('GET /api/pets/categories', () => {
    test('zwraca listę kategorii', async () => {
        const res = await request(app).get('/api/pets/categories');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.categories)).toBe(true);
        expect(res.body.categories).toContain('Gem');
    });
});
