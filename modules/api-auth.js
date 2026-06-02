/**
 * Auth API — weryfikacja, logowanie, sesja
 */

module.exports = function setupAuthApi(app, context) {
    const crypto = require('crypto');
    const { db, redis, pf } = context;

    // ── Weryfikacja Bio (kody logowania) ──

    // POST /verify-start
    app.post('/verify-start', async (req, res) => {
        const username = (req.body.username || '').trim();
        if (!username || username.length < 2 || username.length > 20) {
            return res.json({ message: 'Nieprawidłowy nick (2-20 znaków).' });
        }
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        await redis.setVerifyCode(username, code);
        res.json({ code });
    });

    // POST /verify-check
    app.post('/verify-check', async (req, res) => {
        const username = (req.body.username || '').trim();
        if (!username) {
            return res.json({ success: false, message: 'Brak nicku.' });
        }
        const storedCode = await redis.getVerifyCode(username);
        if (!storedCode) {
            return res.json({ success: false, message: 'Najpierw wygeneruj kod (krok 1) lub kod wygasł.' });
        }

        const ban = db.isBanned(username);
        if (ban) {
            return res.json({ success: false, message: 'Jesteś zbanowany: ' + ban.reason });
        }

        const token = crypto.randomBytes(16).toString('hex');
        await redis.setSession(token, username, 7 * 24 * 60 * 60 * 1000);

        db.getPlayer(username);
        await redis.delVerifyCode(username);

        console.log(`[Verify] ${username} logged in via bio verification`);

        res.cookie('bf_session', token, {
            maxAge: 7 * 24 * 60 * 60 * 1000,
            httpOnly: true,
            sameSite: 'lax'
        });

        res.json({ success: true, username });
    });

    // GET /api/session
    app.get('/api/session', async (req, res) => {
        const token = req.cookies?.bf_session;
        if (!token) return res.json({ authenticated: false });
        const username = await redis.getSession(token);
        if (!username) return res.json({ authenticated: false });
        const player = db.getPlayer(username);
        res.json({
            authenticated: true,
            username,
            coins: player.coins
        });
    });

    // GET /api/profile/stats
    app.get('/api/profile/stats', async (req, res) => {
        const token = req.cookies?.bf_session;
        if (!token) return res.status(401).json({ error: 'Unauthorized' });
        const username = await redis.getSession(token);
        if (!username) return res.status(401).json({ error: 'Unauthorized' });
        const stats = db.getPlayerStats(username);
        res.json(stats);
    });
};
