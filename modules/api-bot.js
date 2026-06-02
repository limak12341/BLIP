/**
 * Bot API — endpoints dla bota Roblox
 * Pobieranie pending depositów i aktualizacja statusu
 */

module.exports = function setupBotApi(app, context) {
    const fs = require('fs');
    const path = require('path');
    const { DATA_DIR, BOT_SECRET } = context;

    function requireBot(req, res, next) {
        const secret = req.headers['x-bot-secret'];
        if (!secret || secret !== BOT_SECRET) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        next();
    }

    // GET /api/bot/pending-deposits
    app.get('/api/bot/pending-deposits', requireBot, (req, res) => {
        let requests = [];
        try {
            requests = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'requests.json'), 'utf8'));
        } catch (e) {
            requests = [];
        }
        const pending = requests.filter(r => r.status === 'pending' || !r.status);
        res.json({ requests: pending });
    });

    // POST /api/bot/update-deposit
    app.post('/api/bot/update-deposit', requireBot, (req, res) => {
        const { requestId, status, totalValue, adminNote } = req.body || {};
        if (!requestId || !status) {
            return res.status(400).json({ error: 'Missing requestId or status' });
        }
        let requests = [];
        try {
            requests = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'requests.json'), 'utf8'));
        } catch (e) {
            requests = [];
        }
        const idx = requests.findIndex(r => r._id === requestId || r.id === requestId);
        if (idx === -1) {
            return res.status(404).json({ error: 'Request not found' });
        }
        requests[idx].status = status;
        if (totalValue !== undefined) requests[idx].totalValue = totalValue;
        if (adminNote) requests[idx].adminNote = adminNote;
        requests[idx].updatedAt = Date.now();
        fs.writeFileSync(path.join(DATA_DIR, 'requests.json'), JSON.stringify(requests, null, 2));

        // Log it
        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) { logs = []; }
        logs.push({
            type: 'bot-deposit',
            description: `Bot: ${status} deposit ${requestId}${totalValue ? ', value: ' + totalValue : ''}`,
            timestamp: Date.now()
        });
        fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), JSON.stringify(logs));

        res.json({ success: true, status });
    });
};
