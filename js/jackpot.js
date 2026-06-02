/**
 * BFLIP — Jackpot Module
 */

"use strict";

// ── Socket events ──────────────────────────────────────────
socket.on('jackpotStatus', (data) => { renderJackpot(data); });
socket.on('jackpotTimerUpdate', (data) => { updateJackpotTimer(data.remaining, data.timerEnd); });
socket.on('jackpotJoined', (data) => { console.log('[Jackpot] Joined:', data.tickets, 'tickets'); refreshBalance(); });
socket.on('jackpotError', (data) => { showJackpotError(data.message); });
socket.on('jackpotResult', (data) => { showJackpotResult(data); });
socket.on('jackpotHistory', (data) => { renderJackpotHistory(data); });

function refreshBalance() {
    apiJson('/api/profile/stats').then(s => {
        const el = document.getElementById('balance-amount');
        if (el && s.coins !== undefined) el.textContent = fmt(s.coins);
    }).catch(() => {});
}

// ── Render main jackpot UI ──
function renderJackpot(jp) {
    if (!jp || !jp.active) {
        document.getElementById('jp-status-badge').textContent = '⏳ Oczekiwanie...';
        document.getElementById('jp-pot-value').textContent = '🪙 0';
        document.getElementById('jp-tickets-value').textContent = '0';
        document.getElementById('jp-participants-count').textContent = '0';
        document.getElementById('jp-participants-list').innerHTML = '<div class="jp-participants-empty">Brak uczestników</div>';
        document.getElementById('jp-timer-text').textContent = '60s';
        document.getElementById('jp-fee-value').textContent = '10%';
        document.getElementById('jp-prize-info').style.display = 'none';
        document.getElementById('jp-winner-section').style.display = 'none';
        document.getElementById('jp-join-btn').disabled = true;
        return;
    }
    document.getElementById('jp-status-badge').textContent = jp.status === 'waiting' ? '🟢 Przyjmujemy zakłady' : '🔴 Losowanie...';
    document.getElementById('jp-pot-value').textContent = '🪙 ' + fmt(jp.totalValue || 0);
    document.getElementById('jp-tickets-value').textContent = fmt(jp.totalTickets || 0);
    document.getElementById('jp-participants-count').textContent = String((jp.participants || []).length);
    document.getElementById('jp-fee-value').textContent = Math.round((jp.houseFee || 0.1) * 100) + '%';
    document.getElementById('jp-join-btn').disabled = jp.status !== 'waiting';

    const prizeValue = Math.floor((jp.totalValue || 0) * (1 - (jp.houseFee || 0.1)));
    const prizeEl = document.getElementById('jp-prize-info');
    if (jp.status === 'waiting') {
        prizeEl.style.display = 'block';
        document.getElementById('jp-prize-value').textContent = '🪙 ' + fmt(prizeValue);
    } else {
        prizeEl.style.display = 'none';
    }

    const listEl = document.getElementById('jp-participants-list');
    listEl.innerHTML = (jp.participants || []).map(p => {
        const avatarHtml = p.avatarUrl ? `<img class="jp-part-avatar" src="${p.avatarUrl}" alt="">` : `<div class="jp-part-avatar-empty">?</div>`;
        const pct = jp.totalTickets > 0 ? ((p.tickets / jp.totalTickets) * 100).toFixed(1) : 0;
        return `<div class="jp-part-item">${avatarHtml}<span class="jp-part-name">${escapeHtml(p.username)}</span><span class="jp-part-tickets">${fmt(p.tickets)} tickets</span><span class="jp-part-pct">${pct}%</span></div>`;
    }).join('') || '<div class="jp-participants-empty">Brak uczestników. Dołącz pierwszy!</div>';

    if (jp.winner) {
        document.getElementById('jp-winner-section').style.display = 'block';
        document.getElementById('jp-winner-name').textContent = jp.winner;
        document.getElementById('jp-winner-detail').textContent = `Wygrana: 🪙 ${fmt(prizeValue)} | Bilet #${jp.winningTicket}`;
    } else {
        document.getElementById('jp-winner-section').style.display = 'none';
    }
}

function updateJackpotTimer(remaining) {
    const textEl = document.getElementById('jp-timer-text');
    const progressEl = document.getElementById('jp-timer-progress');
    if (!textEl) return;
    const s = Math.max(0, remaining);
    const min = Math.floor(s / 60);
    const sec = s % 60;
    textEl.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
    if (progressEl) {
        const pct = Math.max(0, Math.min(100, (s / 60) * 100));
        const circumference = 2 * Math.PI * 45;
        progressEl.style.strokeDasharray = `${circumference}`;
        progressEl.style.strokeDashoffset = `${circumference * (1 - pct / 100)}`;
    }
}

function showJackpotError(msg) {
    const el = document.getElementById('jp-join-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; setTimeout(() => el.style.display = 'none', 3000); }
}

function showJackpotResult(data) {
    if (!data) return;
    const prizeValue = data.prizeValue || 0;
    const winnerText = `🏆 ${escapeHtml(data.winner)} wygrywa ${fmt(prizeValue)} 🪙!`;
    document.getElementById('jp-winner-section').style.display = 'block';
    document.getElementById('jp-winner-name').textContent = data.winner || '—';
    document.getElementById('jp-winner-detail').textContent = `Wygrana: 🪙 ${fmt(prizeValue)} | Bilet #${data.winningTicket}`;
    renderJackpot(data);
}

function renderJackpotHistory(history) {
    const list = document.getElementById('jackpot-history-list');
    if (!list) return;
    if (!history || !history.length) {
        list.innerHTML = '<div class="jp-empty">Brak historii jackpota</div>';
        return;
    }
    list.innerHTML = history.map(h => {
        const timeStr = timeAgo(h.timestamp);
        return `<div class="jp-history-item">
            <span class="jp-h-time">${timeStr}</span>
            <span class="jp-h-winner">👑 ${escapeHtml(h.winner || '?')}</span>
            <span class="jp-h-prize">🪙 ${fmt(h.prizeValue || h.totalValue || 0)}</span>
            <span class="jp-h-players">${h.participantsCount || 0} players</span>
        </div>`;
    }).join('');
}

// ── Jackpot Join Modal ──
window.openJackpotJoinModal = async function() {
    try {
        const data = await apiJson('/api/inventory/with-rap');
        jackpotInventoryRAP = data.items || [];
    } catch (e) { jackpotInventoryRAP = []; }
    jackpotSelectedItems = [];
    document.getElementById('jp-join-coins').value = '';
    document.getElementById('jp-join-error').style.display = 'none';
    renderJackpotJoinItems();
    // Update pot value
    try {
        const status = await apiJson('/api/jackpot/current');
        document.getElementById('jp-join-pot-value').textContent = '🪙 ' + fmt(status.totalValue || 0);
    } catch (e) {}
    // Update balance
    try {
        const stats = await apiJson('/api/profile/stats');
        document.getElementById('jp-join-balance').textContent = '🪙 ' + fmt(stats.coins || 0);
    } catch (e) {}
    document.getElementById('jackpot-join-modal').style.display = 'flex';
};

window.closeJackpotJoinModal = function() {
    document.getElementById('jackpot-join-modal').style.display = 'none';
};

window.setJackpotCoins = function(amount) {
    document.getElementById('jp-join-coins').value = amount;
    updateJackpotJoinTotal();
};

function updateJackpotJoinTotal() {
    const coins = parseInt(document.getElementById('jp-join-coins').value) || 0;
    let itemsValue = 0;
    jackpotSelectedItems.forEach(it => itemsValue += (it.rap || 0) * (it.qty || 1));
    const total = coins + itemsValue;
    document.getElementById('jp-join-total-value').textContent = '🪙 ' + fmt(total);
    document.getElementById('jp-join-tickets-info').textContent = Math.max(1, Math.floor(total)) + ' biletów';
}

function renderJackpotJoinItems() {
    const grid = document.getElementById('jp-join-items-grid');
    const empty = document.getElementById('jp-join-items-empty');
    if (!grid) return;
    grid.innerHTML = '';
    if (!jackpotInventoryRAP.length) {
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';
    jackpotInventoryRAP.forEach(it => {
        const key = it.name.toLowerCase();
        const sel = jackpotSelectedItems.find(x => x.name.toLowerCase() === key);
        const qty = sel ? sel.qty : 0;
        const card = document.createElement('div');
        card.className = 'inv-item';
        card.innerHTML = `<div class="inv-name">${escapeHtml(it.name)}</div>
          <div class="inv-qty">🪙 ${fmt(it.rap || 0)} · Masz: ${fmt(it.qty)}</div>
          <div class="inv-actions"><button class="inv-btn" data-act="minus">−</button>
          <span class="inv-sel">${qty}</span><button class="inv-btn" data-act="plus">+</button></div>`;
        card.querySelector('[data-act="minus"]').addEventListener('click', () => {
            const cur = jackpotSelectedItems.find(x => x.name.toLowerCase() === key);
            if (!cur) return;
            if (cur.qty <= 1) jackpotSelectedItems = jackpotSelectedItems.filter(x => x.name.toLowerCase() !== key);
            else cur.qty--;
            renderJackpotJoinItems();
            updateJackpotJoinTotal();
        });
        card.querySelector('[data-act="plus"]').addEventListener('click', () => {
            const cur = jackpotSelectedItems.find(x => x.name.toLowerCase() === key);
            const curQty = cur ? cur.qty : 0;
            if (curQty >= it.qty) return;
            if (cur) cur.qty++;
            else jackpotSelectedItems.push({ name: it.name, qty: 1, rap: it.rap || 0 });
            renderJackpotJoinItems();
            updateJackpotJoinTotal();
        });
        grid.appendChild(card);
    });
}

window.submitJackpotJoin = function() {
    const coins = parseInt(document.getElementById('jp-join-coins').value) || 0;
    const items = jackpotSelectedItems.map(it => ({ name: it.name, qty: it.qty, rap: it.rap || 0 }));
    if (coins <= 0 && !items.length) {
        showJackpotError('Dodaj coiny lub itemy, aby dołączyć!');
        return;
    }
    socket.emit('jackpotJoin', { coins, items });
    closeJackpotJoinModal();
};

// ── Jackpot History Modal ──
window.openJackpotHistory = function() {
    document.getElementById('jackpot-history-modal').style.display = 'flex';
    socket.emit('jackpotGetHistory');
};
window.closeJackpotHistory = function() {
    document.getElementById('jackpot-history-modal').style.display = 'none';
};
