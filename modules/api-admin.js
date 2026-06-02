/**
 * Admin API — panel administracyjny REST
 */

module.exports = function setupAdminApi(app, io, context) {
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');
    const { db, redis, DATA_DIR } = context;

    const adminConfig = db.loadAdmin();

    // ── Admin auth middleware ──
    async function requireAdmin(req, res, next) {
        const sessionToken = req.cookies?.bf_admin;
        if (!sessionToken) return res.status(401).json({ success: false, message: 'Unauthorized' });
        const sessionUser = await redis.getSession('admin:' + sessionToken);
        if (sessionUser !== '__admin__') return res.status(401).json({ success: false, message: 'Unauthorized' });
        next();
    }

    // ── Login ──
    app.post('/admin/login', async (req, res) => {
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        const allowed = await redis.checkRateLimit('admin_login:' + ip, 5, 60000);
        if (!allowed) {
            return res.status(429).json({ success: false, message: 'Too many attempts. Try again later.' });
        }

        const { token } = req.body || {};
        const adminToken = adminConfig.token || process.env.ADMIN_TOKEN;
        if (!adminToken) {
            return res.status(500).json({ success: false, message: 'ADMIN_TOKEN not configured. Set ADMIN_TOKEN in .env file.' });
        }
        if (token === adminToken) {
            const sessionToken = crypto.randomBytes(16).toString('hex');
            await redis.setSession('admin:' + sessionToken, '__admin__', 24 * 60 * 60 * 1000);
            res.cookie('bf_admin', sessionToken, {
                maxAge: 24 * 60 * 60 * 1000,
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production'
            });
            return res.json({ success: true });
        }
        return res.status(401).json({ success: false, message: 'Nieprawidłowy token.' });
    });

    // ── Logout ──
    app.post('/admin/logout', async (req, res) => {
        const token = req.cookies?.bf_admin;
        if (token) await redis.delSession('admin:' + token);
        res.clearCookie('bf_admin');
        return res.json({ success: true });
    });

    // ── Dashboard ──
    app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
        const players = db.getAllPlayers();
        const playerArray = Object.values(players);
        const totalPlayers = playerArray.length;
        const onlinePlayers = 0; // filled from socket.io if available

        let totalGames = 0;
        playerArray.forEach(p => { totalGames += p.gamesPlayed || 0; });

        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }
        const totalLogs = logs.length;

        const gamesByDay = {};
        const registrationsByDay = {};
        for (let i = 6; i >= 0; i--) {
            const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
            const key = d.toISOString().split('T')[0];
            gamesByDay[key] = 0;
            registrationsByDay[key] = 0;
        }

        playerArray.forEach(p => {
            const regDate = new Date(p.registered).toISOString().split('T')[0];
            if (registrationsByDay[regDate] !== undefined) registrationsByDay[regDate]++;
            if (p.gameHistory) {
                p.gameHistory.forEach(game => {
                    const gameDate = new Date(game.timestamp).toISOString().split('T')[0];
                    if (gamesByDay[gameDate] !== undefined) gamesByDay[gameDate]++;
                });
            }
        });

        const gamesByHour = {};
        for (let i = 0; i < 24; i++) gamesByHour[i] = 0;
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        playerArray.forEach(p => {
            if (p.gameHistory) {
                p.gameHistory.forEach(game => {
                    if (game.timestamp >= dayAgo) {
                        const hour = new Date(game.timestamp).getHours();
                        gamesByHour[hour]++;
                    }
                });
            }
        });

        const logsByType = {};
        logs.slice(-500).forEach(log => {
            const type = log.type || 'other';
            if (!logsByType[type]) logsByType[type] = 0;
            logsByType[type]++;
        });

        // Try to get online count from io
        let onlineCount = 0;
        try { if (io && io.engine) onlineCount = io.engine.clientsCount || 0; } catch (e) {}

        res.json({
            totalGames,
            onlinePlayers: onlineCount,
            totalPlayers,
            totalLogs,
            gamesByDay: Object.entries(gamesByDay).map(([date, count]) => ({ date, count })),
            registrationsByDay: Object.entries(registrationsByDay).map(([date, count]) => ({ date, count })),
            gamesByHour: Object.entries(gamesByHour).map(([hour, count]) => ({ hour: parseInt(hour), count })),
            logsByType: Object.entries(logsByType).map(([type, count]) => ({ type, count }))
        });
    });

    // ── Players list ──
    app.get('/api/admin/players', requireAdmin, (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = (req.query.q || '').toLowerCase();

        const all = db.getAllPlayers();
        let list = Object.entries(all).map(([id, p]) => ({
            _id: id,
            username: p.username || id,
            coins: p.coins || 0,
            gemsCount: p.gems || 0,
            balance: p.coins || 0,
            role: (p.roles && p.roles.length > 0) ? p.roles[0] : '',
            banned: !!db.isBanned(id),
            avatarUrl: p.avatarUrl || '',
            gamesPlayed: p.gamesPlayed || 0,
            registered: p.registered || 0
        }));

        if (search) {
            list = list.filter(p => p.username.toLowerCase().includes(search) || p._id.toLowerCase().includes(search));
        }

        const total = list.length;
        const pages = Math.ceil(total / limit) || 1;
        const paginated = list.slice((page - 1) * limit, page * limit);

        res.json({ players: paginated, total, pages, page });
    });

    // ── Logs ──
    app.get('/api/admin/logs', requireAdmin, (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const typeFilter = req.query.type || '';

        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }

        if (typeFilter) logs = logs.filter(l => l.type === typeFilter);
        logs.reverse();

        const total = logs.length;
        const pages = Math.ceil(total / limit) || 1;
        const paginated = logs.slice((page - 1) * limit, page * limit);

        res.json({ logs: paginated, total, pages, page });
    });

    // ── Requests ──
    app.get('/api/admin/requests', requireAdmin, (req, res) => {
        const statusFilter = req.query.status || '';
        const typeFilter = req.query.type || '';
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        let requests = [];
        try { requests = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'requests.json'), 'utf8')); } catch (e) { requests = []; }

        if (statusFilter) requests = requests.filter(r => r.status === statusFilter);
        if (typeFilter) requests = requests.filter(r => r.type === typeFilter);
        requests.reverse();

        const total = requests.length;
        const pages = Math.ceil(total / limit) || 1;
        const paginated = requests.slice((page - 1) * limit, page * limit);

        res.json({ requests: paginated, total, pages, page });
    });

    // ── Approve request ──
    app.post('/api/admin/requests/:id/approve', requireAdmin, (req, res) => {
        const { adminNote } = req.body || {};
        let requests = [];
        try { requests = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'requests.json'), 'utf8')); } catch (e) { requests = []; }
        const idx = requests.findIndex(r => r._id === req.params.id);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Request not found' });
        if (requests[idx].status === 'approved' || requests[idx].status === 'rejected' || requests[idx].status === 'sent') {
            return res.json({ success: true, alreadyProcessed: true });
        }

        requests[idx].status = 'approved';
        if (adminNote) requests[idx].adminNote = adminNote;
        requests[idx].updatedAt = Date.now();
        fs.writeFileSync(path.join(DATA_DIR, 'requests.json'), JSON.stringify(requests, null, 2));

        if (requests[idx].type === 'deposit' && requests[idx].totalValue) {
            const player = db.getPlayer(requests[idx].username);
            player.coins += requests[idx].totalValue;
            db.savePlayer(requests[idx].username, player);
        }

        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }
        logs.push({
            type: 'approve',
            description: `Approved ${requests[idx].type} from ${requests[idx].username} (${requests[idx].items?.length || 0} items)`,
            adminUsername: 'admin',
            timestamp: Date.now()
        });
        fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), JSON.stringify(logs));

        res.json({ success: true });
    });

    // ── Reject request ──
    app.post('/api/admin/requests/:id/reject', requireAdmin, (req, res) => {
        const { adminNote } = req.body || {};
        let requests = [];
        try { requests = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'requests.json'), 'utf8')); } catch (e) { requests = []; }
        const idx = requests.findIndex(r => r._id === req.params.id);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Request not found' });
        if (requests[idx].status === 'approved' || requests[idx].status === 'rejected' || requests[idx].status === 'sent') {
            return res.json({ success: true, alreadyProcessed: true });
        }

        if (requests[idx].type === 'withdraw' && requests[idx].items) {
            const player = db.getPlayer(requests[idx].username);
            for (const item of requests[idx].items) {
                player.inventory = player.inventory || [];
                const existing = player.inventory.find(i => i.name === item.name);
                if (existing) {
                    existing.qty = (existing.qty || 0) + (item.qty || 1);
                } else {
                    player.inventory.push({ name: item.name, qty: item.qty || 1, rap: item.rap || 0 });
                }
            }
            db.savePlayer(requests[idx].username, player);
        }

        requests[idx].status = 'rejected';
        if (adminNote) requests[idx].adminNote = adminNote;
        requests[idx].updatedAt = Date.now();
        fs.writeFileSync(path.join(DATA_DIR, 'requests.json'), JSON.stringify(requests, null, 2));

        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }
        logs.push({
            type: 'reject',
            description: `Rejected ${requests[idx].type} from ${requests[idx].username} (${requests[idx].items?.length || 0} items)`,
            adminUsername: 'admin',
            timestamp: Date.now()
        });
        fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), JSON.stringify(logs));

        res.json({ success: true });
    });

    // ── Promo Codes ──
    app.get('/api/admin/promo-codes', requireAdmin, (req, res) => {
        const promos = db.loadPromo();
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const codes = Object.entries(promos).map(([code, data]) => ({
            _id: code,
            code: data.code,
            rewards: data.rewards || [{ type: data.rewardType || 'coins', amount: data.rewardValue || 0 }],
            active: data.active !== false,
            usedCount: data.used || 0,
            maxUses: data.maxUses || 0,
            createdBy: data.createdBy || 'admin',
            createdAt: data.createdAt || Date.now()
        }));
        const total = codes.length;
        const pages = Math.ceil(total / limit) || 1;
        const paginated = codes.slice((page - 1) * limit, page * limit);
        res.json({ codes: paginated, total, pages, page });
    });

    app.post('/api/admin/promo-codes', requireAdmin, (req, res) => {
        const { code, rewards, maxUses } = req.body || {};
        if (!code) return res.status(400).json({ success: false, message: 'Podaj nazwę kodu!' });

        const promos = db.loadPromo();
        if (promos[code]) return res.status(400).json({ success: false, message: 'Kod już istnieje!' });

        promos[code] = {
            code,
            rewards: rewards || [{ type: 'coins', amount: 100 }],
            maxUses: parseInt(maxUses) || 0,
            active: true,
            used: 0,
            usedBy: [],
            createdBy: 'admin',
            createdAt: Date.now()
        };
        db.savePromo(promos);
        res.json({ success: true });
    });

    app.post('/api/admin/promo-codes/:id/toggle', requireAdmin, (req, res) => {
        const promos = db.loadPromo();
        const code = req.params.id;
        if (!promos[code]) return res.status(404).json({ success: false, message: 'Kod nie znaleziony' });
        promos[code].active = promos[code].active === false ? true : false;
        db.savePromo(promos);
        res.json({ success: true, active: promos[code].active });
    });

    app.post('/api/admin/promo-codes/:id/delete', requireAdmin, (req, res) => {
        const promos = db.loadPromo();
        const code = req.params.id;
        if (!promos[code]) return res.status(404).json({ success: false, message: 'Kod nie znaleziony' });
        delete promos[code];
        db.savePromo(promos);
        res.json({ success: true });
    });

    // ── Chat Filter ──
    app.get('/api/admin/chat-filter', requireAdmin, (req, res) => {
        const filter = db.loadFilter();
        res.json(filter);
    });

    app.post('/api/admin/chat-filter/save', requireAdmin, (req, res) => {
        const { words, enabled, punishment } = req.body || {};
        const filter = db.loadFilter();
        if (Array.isArray(words)) filter.words = words;
        if (typeof enabled === 'boolean') filter.enabled = enabled;
        if (punishment) filter.punishment = punishment;
        db.saveFilter(filter);
        res.json({ success: true });
    });

    // ── System Message ──
    app.post('/api/admin/system-message', requireAdmin, (req, res) => {
        const { message } = req.body || {};
        if (!message) return res.status(400).json({ success: false, message: 'Brak treści wiadomości' });
        io.emit('systemMessage', message);

        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }
        logs.push({ type: 'system-message', description: `Wysłano: "${message}"`, adminUsername: 'admin', timestamp: Date.now() });
        fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), JSON.stringify(logs));
        res.json({ success: true });
    });

    // ── Player Actions ──
    app.post('/api/admin/players/:id/warn', requireAdmin, (req, res) => {
        const { reason } = req.body || {};
        if (!reason) return res.status(400).json({ success: false, message: 'Podaj powód' });
        const warnings = db.loadWarnings();
        const username = req.params.id;
        if (!warnings[username]) warnings[username] = [];
        warnings[username].push({ reason, by: 'admin', time: Date.now() });
        db.saveWarnings(warnings);

        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }
        logs.push({ type: 'warn', description: `${username} warned: ${reason}`, adminUsername: 'admin', timestamp: Date.now() });
        fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), JSON.stringify(logs));

        res.json({ success: true });
    });

    app.post('/api/admin/players/:id/role', requireAdmin, (req, res) => {
        const { role } = req.body || {};
        const username = req.params.id;
        const player = db.getPlayer(username);
        if (!player.roles) player.roles = [];
        if (role) {
            if (!player.roles.includes(role)) player.roles.push(role);
        } else {
            player.roles = [];
        }
        db.savePlayer(username, player);
        res.json({ success: true });
    });

    app.post('/api/admin/players/:id/ban', requireAdmin, (req, res) => {
        const username = req.params.id;
        const bans = db.loadBans();
        bans[username] = { reason: 'Banned by admin', by: 'admin', time: Date.now(), expires: null };
        db.saveBans(bans);
        res.json({ success: true });
    });

    app.post('/api/admin/players/:id/unban', requireAdmin, (req, res) => {
        const username = req.params.id;
        const bans = db.loadBans();
        delete bans[username];
        db.saveBans(bans);
        res.json({ success: true });
    });

    app.post('/api/admin/players/:id/balance', requireAdmin, (req, res) => {
        const { amount } = req.body || {};
        const username = req.params.id;
        const player = db.getPlayer(username);
        player.coins = parseInt(amount) || 0;
        db.savePlayer(username, player);
        res.json({ success: true });
    });

    app.post('/api/admin/players/:id/gems', requireAdmin, (req, res) => {
        const { item } = req.body || {};
        if (!item) return res.status(400).json({ success: false, message: 'Brak przedmiotu' });
        const username = req.params.id;
        const player = db.getPlayer(username);
        const qty = parseInt(item.qty) || 1;
        player.gems = (player.gems || 0) + qty;
        db.savePlayer(username, player);
        res.json({ success: true });
    });
};
