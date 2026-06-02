/**
 * Jackpot System — REST API, timer, losowanie, broadcast
 */

module.exports = {
    /**
     * Ustawia REST API endpointy jackpota
     */
    setupJackpotApi(app, context) {
        const { db, pf, games } = context;

        app.get('/api/jackpot/status', (req, res) => {
            const jp = games.getJackpot();
            if (!jp) return res.json({ active: false });
            res.json({
                active: true,
                id: jp.id,
                status: jp.status,
                totalValue: jp.totalValue,
                totalTickets: jp.totalTickets,
                participants: jp.participants.map(p => ({
                    username: p.username,
                    avatarUrl: p.avatarUrl,
                    tickets: p.tickets
                })),
                timerEnd: jp.timerEnd,
                houseFee: jp.houseFee,
                winner: jp.winner,
                winningTicket: jp.winningTicket,
                fairResult: jp.fairResult,
                serverSeed: jp.status === 'completed' ? jp.serverSeed : null,
                nonce: jp.nonce
            });
        });

        app.get('/api/jackpot/history', (req, res) => {
            const history = games.getJackpotHistory();
            res.json({ history: history.slice(0, 50) });
        });

        app.get('/api/jackpot/current', (req, res) => {
            const jp = games.getJackpot();
            if (!jp) return res.json({ active: false, message: 'No active jackpot round' });
            res.json({
                active: true,
                id: jp.id,
                status: jp.status,
                totalValue: jp.totalValue,
                totalTickets: jp.totalTickets,
                participantsCount: jp.participants.length,
                participants: jp.participants.map(p => ({
                    username: p.username,
                    avatarUrl: p.avatarUrl,
                    tickets: p.tickets
                })),
                timerEnd: jp.timerEnd,
                houseFee: jp.houseFee
            });
        });

    },

    /**
     * Timer i logika jackpota — wymaga io, games, pf, db
     */
    jackpotTickInterval: null,
    jackpotAutoStartTimer: null,

    startJackpotTimer(io, context) {
        const { games, pf, db } = context;
        if (this.jackpotTickInterval) clearInterval(this.jackpotTickInterval);
        this.jackpotTickInterval = setInterval(() => this.tickJackpot(io, context), 1000);
    },

    stopJackpotTimer() {
        if (this.jackpotTickInterval) {
            clearInterval(this.jackpotTickInterval);
            this.jackpotTickInterval = null;
        }
        if (this.jackpotAutoStartTimer) {
            clearTimeout(this.jackpotAutoStartTimer);
            this.jackpotAutoStartTimer = null;
        }
    },

    tickJackpot(io, context) {
        const { games, pf, db } = context;
        const jp = games.getJackpot();
        if (!jp) return;

        const now = Date.now();

        if (jp.status === 'waiting' && now >= jp.timerEnd) {
            console.log('[Jackpot] Timer ended, drawing winner...');
            const result = games.drawJackpotWinner(pf);
            if (result && result.winner) {
                const prize = games.distributeJackpotPrize(db);
                console.log('[Jackpot] Winner:', result.winner, 'Prize:', prize?.prizeValue);

                games.addJackpotGame({
                    id: jp.id,
                    winner: result.winner,
                    totalValue: jp.totalValue,
                    prizeValue: prize?.prizeValue || 0,
                    houseFee: prize?.houseFee || 0,
                    participants: jp.participants.map(p => p.username),
                    participantsCount: jp.participants.length,
                    winningTicket: result.winningTicket,
                    fairResult: result.fairResult,
                    serverSeed: result.serverSeed
                });

                pf.rotateServerSeed();

                io.emit('jackpotResult', {
                    id: jp.id,
                    winner: result.winner,
                    totalValue: jp.totalValue,
                    prizeValue: prize?.prizeValue || 0,
                    participants: jp.participants.map(p => ({
                        username: p.username,
                        avatarUrl: p.avatarUrl,
                        tickets: p.tickets
                    })),
                    totalTickets: jp.totalTickets,
                    winningTicket: result.winningTicket,
                    fairResult: result.fairResult,
                    serverSeed: result.serverSeed
                });

                games.addRecentGame({
                    type: 'jackpot',
                    winner: result.winner,
                    loser: '-',
                    amount: jp.totalValue
                });
                io.emit('recentGamesUpdated', games.getRecentGames());
                io.emit('playerListUpdate');

                if (this.jackpotAutoStartTimer) clearTimeout(this.jackpotAutoStartTimer);
                this.jackpotAutoStartTimer = setTimeout(() => {
                    const newJp = games.startJackpotRound();
                    console.log('[Jackpot] New round started:', newJp.id);
                    this.broadcastJackpotStatus(io, newJp);
                }, games.JACKPOT_DISPLAY_MS || 8000);
            } else {
                const newJp = games.startJackpotRound();
                console.log('[Jackpot] No participants, new round:', newJp.id);
                this.broadcastJackpotStatus(io, newJp);
            }
            this.broadcastJackpotStatus(io, result || jp);
        }

        if (jp.status === 'waiting') {
            io.emit('jackpotTimerUpdate', {
                timerEnd: jp.timerEnd,
                remaining: Math.max(0, Math.floor((jp.timerEnd - Date.now()) / 1000))
            });
        }
    },

    broadcastJackpotStatus(io, jp) {
        if (!jp) {
            io.emit('jackpotStatus', { active: false });
            return;
        }
        io.emit('jackpotStatus', {
            active: true,
            id: jp.id,
            status: jp.status,
            totalValue: jp.totalValue,
            totalTickets: jp.totalTickets,
            participants: (jp.participants || []).map(p => ({
                username: p.username,
                avatarUrl: p.avatarUrl,
                tickets: p.tickets
            })),
            timerEnd: jp.timerEnd,
            houseFee: jp.houseFee,
            winner: jp.winner,
            winningTicket: jp.winningTicket
        });
    }
};
