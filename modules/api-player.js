/**
 * Player API — profile, leaderboard, inventory, deposit/withdraw, gems, promo
 */

module.exports = function setupPlayerApi(app, io, context) {
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');
    const { db, redis, DATA_DIR } = context;

    // ── Auth middleware ──
    async function requireAuth(req, res, next) {
        const token = req.cookies?.bf_session;
        if (!token) return res.status(401).json({ error: 'Unauthorized. Please log in.' });
        const username = await redis.getSession(token);
        if (!username) return res.status(401).json({ error: 'Unauthorized. Session expired.' });
        req.username = username;
        next();
    }

    // ── Public profile ──
    app.get('/api/profile/public/:userId', (req, res) => {
        const username = req.params.userId;
        if (!db.usernameExists(username)) {
            return res.status(404).json({ error: 'Player not found' });
        }
        const profile = db.getPublicProfile(username);
        res.json(profile);
    });

    // ── Tip ──
    app.post('/api/profile/:userId/tip', requireAuth, (req, res) => {
        const target = req.params.userId;
        const amount = parseInt(req.body?.amount);
        if (!amount || amount < 1) {
            return res.json({ ok: false, message: 'Invalid amount.' });
        }
        const result = db.tipPlayer(req.username, target, amount);
        if (result.ok) {
            io.emit('systemMessage', `${req.username} tipped ${amount} coins to ${target}! 💰`);
            io.emit('playerListUpdate');
        }
        res.json(result);
    });

    // ── Leaderboard ──
    app.get('/api/leaderboard', (req, res) => {
        const leaderboard = db.getLeaderboard();
        res.json({ leaderboard });
    });

    // ── Promo redeem ──
    app.post('/api/promo/redeem', requireAuth, (req, res) => {
        const { code } = req.body || {};
        if (!code) {
            return res.json({ success: false, message: 'Podaj kod promocyjny!' });
        }
        const promos = db.loadPromo();
        const promo = promos[code];
        if (!promo) {
            return res.json({ success: false, message: 'Nieprawidłowy kod promocyjny.' });
        }
        if (promo.active === false) {
            return res.json({ success: false, message: 'Ten kod został wyłączony.' });
        }
        if (promo.usedBy && promo.usedBy.includes(req.username)) {
            return res.json({ success: false, message: 'Już wykorzystałeś ten kod.' });
        }
        const result = db.applyPromoBonus(req.username, code);
        if (result && result.success) {
            io.emit('playerListUpdate');
            res.json({ success: true, message: `✅ Kod zrealizowany! Otrzymałeś ${result.value} ${result.type === 'coins' ? 'monet' : 'gemów'}!` });
        } else if (result && result.error) {
            res.json({ success: false, message: result.error });
        } else {
            res.json({ success: false, message: 'Kod wygasł lub osiągnął limit użyć.' });
        }
    });

    // ── Inventory ──
    app.get('/api/inventory', requireAuth, (req, res) => {
        const items = db.getInventory(req.username);
        res.json({ items });
    });

    app.get('/api/inventory/with-rap', requireAuth, (req, res) => {
        const items = db.getInventory(req.username);
        const itemsWithRap = db.getItemsWithRap(items);
        res.json({ items: itemsWithRap });
    });

    // ── Pets search ──
    app.get('/api/pets/search', (req, res) => {
        const q = req.query.q || '';
        const category = req.query.category || 'all';
        const limit = parseInt(req.query.limit) || 30;
        let results = db.searchPets(q, category);
        if (limit > 0) results = results.slice(0, limit);
        res.json({ results });
    });

    // ── Deposit request ──
    app.post('/api/deposit/request', requireAuth, (req, res) => {
        const { items, note } = req.body || {};
        if (!items || !items.length) {
            return res.status(400).json({ error: 'No items provided.' });
        }
        const requests = db.loadRequests();
        const request = {
            _id: crypto.randomBytes(8).toString('hex'),
            username: req.username,
            type: 'deposit',
            items: items,
            note: note || '',
            status: 'pending',
            createdAt: Date.now()
        };
        requests.push(request);
        db.saveRequests(requests);

        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }
        logs.push({ type: 'deposit-request', description: `${req.username} deposited ${items.length} items`, timestamp: Date.now() });
        fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), JSON.stringify(logs));

        res.json({ success: true, requestId: request._id });
    });

    // ── Withdraw request ──
    app.post('/api/withdraw/request', requireAuth, (req, res) => {
        const { items, note } = req.body || {};
        if (!items || !items.length) {
            return res.status(400).json({ error: 'No items provided.' });
        }

        const inventory = db.getInventory(req.username);
        for (const item of items) {
            const inv = inventory.find(i => i.name === item.name);
            if (!inv || inv.qty < item.qty) {
                return res.status(400).json({ error: `Not enough ${item.name} in inventory.` });
            }
        }

        for (const item of items) {
            db.removeInventoryItem(req.username, item.name, item.qty);
        }

        const requests = db.loadRequests();
        const request = {
            _id: crypto.randomBytes(8).toString('hex'),
            username: req.username,
            type: 'withdraw',
            items: items,
            note: note || '',
            status: 'pending',
            createdAt: Date.now()
        };
        requests.push(request);
        db.saveRequests(requests);

        res.json({ success: true, requestId: request._id });
    });

    // ── User requests list ──
    app.get('/api/requests', requireAuth, (req, res) => {
        const allRequests = db.loadRequests();
        const userRequests = allRequests.filter(r => r.username === req.username).reverse();
        res.json({ requests: userRequests });
    });

    // ── Gems merge ──
    app.post('/api/gems/merge', requireAuth, (req, res) => {
        const recipe = parseInt(req.body?.recipe);
        if (isNaN(recipe)) {
            return res.json({ ok: false, message: 'Invalid recipe index.' });
        }
        const result = db.mergeGems(req.username, recipe);
        if (result.ok) {
            io.emit('playerListUpdate');
        }
        res.json({ ok: result.ok, message: result.message });
    });
};
