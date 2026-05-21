"use strict";
const socket = io();

let balance         = 0;
let currentUsername = '';
let currentAvatar   = '';
let currentSide     = 'heads';
let lobbyGames      = [];
let viewingGameId   = null;
const FLIP_MS       = 2200;

// Depozyty / inventarz
let myInventory = [];
let myRequests  = [];
let withdrawSelection = new Map(); // nameLower -> qty

// ── DOM ───────────────────────────────────────────────────────
const loginOverlay   = document.getElementById('login-overlay');
const navAvatarImg   = document.getElementById('nav-avatar-img');
const navUsername    = document.getElementById('nav-username');
const balanceEl      = document.getElementById('balance-amount');
const navUser        = document.getElementById('nav-user');
const logoutBtn      = document.getElementById('logout-btn');
const gamesList      = document.getElementById('games-list');
const lobbyCount     = document.getElementById('lobby-count');
const historyWrap    = document.getElementById('history-table-wrap');
const historySummary = document.getElementById('history-summary');

const inventoryListEl  = document.getElementById('inventory-list');
const inventoryEmptyEl = document.getElementById('inventory-empty');
const requestsListEl   = document.getElementById('requests-list');
const requestsEmptyEl  = document.getElementById('requests-empty');

function fmt(n) { return Number(n).toLocaleString('pl-PL'); }
function sideLabel(s) { return s === 'heads' ? 'ORZEŁ' : 'RESZKA'; }
function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s temu`;
    if (s < 3600) return `${Math.floor(s/60)}min temu`;
    return `${Math.floor(s/3600)}h temu`;
}

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

async function apiJson(url, opts) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...(opts || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Błąd API');
    return data;
}

// ── SESJA ─────────────────────────────────────────────────────
socket.emit('checkSession');

socket.on('sessionOk', (data) => {
    loginOverlay.style.display = 'none';
    currentUsername = data.username;
    currentAvatar   = data.avatarUrl || '';
    balance = data.balance;
    balanceEl.textContent = fmt(balance);
    navUsername.textContent = data.username;
    navUser.style.display = 'flex';
    logoutBtn.style.display = 'inline-block';
    if (data.avatarUrl) navAvatarImg.src = data.avatarUrl;
    socket.emit('getHistory');
});

socket.on('sessionNone', () => { loginOverlay.style.display = 'flex'; });
socket.on('balanceUpdate', (v) => { balance = v; balanceEl.textContent = fmt(v); });
socket.on('gameError', (msg) => alert(msg));

// ── TABS ──────────────────────────────────────────────────────
window.showTab = function(tab) {
    document.getElementById('tab-lobby').style.display   = tab === 'lobby'   ? 'block' : 'none';
    document.getElementById('tab-history').style.display = tab === 'history' ? 'block' : 'none';
    document.getElementById('tab-deposit').style.display = tab === 'deposit' ? 'block' : 'none';

    document.querySelectorAll('.nav-tab').forEach((el) => {
        const t = el.getAttribute('data-tab');
        el.classList.toggle('active', t === tab);
    });

    if (tab === 'history') socket.emit('getHistory');
    if (tab === 'deposit') refreshDepositTab();
};

async function refreshDepositTab() {
    try {
        await Promise.all([loadInventory(), loadRequests()]);
        renderInventory();
        renderRequests();
    } catch (e) {
        // jeśli user nie jest zalogowany, backend zwróci 401
        console.warn(e.message);
    }
}

// ── MODAL: STWÓRZ GRĘ ────────────────────────────────────────
window.openCreateModal  = () => { document.getElementById('modal-bet').value = Math.min(50, balance); updateTotal(); document.getElementById('create-modal').style.display = 'flex'; };
window.closeCreateModal = () => { document.getElementById('create-modal').style.display = 'none'; };
window.selectModalSide  = (side) => {
    currentSide = side;
    document.getElementById('modal-heads').classList.toggle('active', side==='heads');
    document.getElementById('modal-tails').classList.toggle('active', side==='tails');
};
window.setModalBet = (v) => { document.getElementById('modal-bet').value = Math.min(v, balance); updateTotal(); };
window.updateTotal = () => {
    const bet = parseInt(document.getElementById('modal-bet').value) || 0;
    document.getElementById('modal-total').textContent = `🪙 ${fmt(bet * 2)}`;
};
window.submitCreateGame = () => {
    const bet = parseInt(document.getElementById('modal-bet').value);
    if (!bet || bet < 1) return alert('Podaj poprawny zakład!');
    if (bet > balance)   return alert('Nie masz tyle monet!');
    socket.emit('createGame', { bet, side: currentSide });
    closeCreateModal();
};

socket.on('gameCreated', () => { socket.emit('getHistory'); });

// ── LISTA GIER ────────────────────────────────────────────────
socket.on('gamesList', (games) => {
    lobbyGames = games;
    const n = games.length;
    lobbyCount.textContent = n === 1 ? '1 gra' : `${n} gier`;

    gamesList.innerHTML = '';

    if (!n) {
        gamesList.innerHTML = `
          <div class="empty-lobby">
            <div class="empty-icon">🪙</div>
            <p>Brak aktywnych gier</p>
            <p class="empty-sub">Stwórz nową grę i poczekaj na przeciwnika</p>
          </div>`;
        return;
    }

    games.forEach(g => {
        const isMe = g.creator.username === currentUsername;
        const card = document.createElement('div');
        card.className = `game-card ${isMe ? 'mine' : ''}`;

        const avatarHtml = g.creator.avatarUrl
            ? `<img class="gc-avatar" src="${g.creator.avatarUrl}" alt="">`
            : `<div class="gc-avatar-empty">?</div>`;

        const badgeClass = g.creator.side === 'heads' ? 'heads' : 'tails';
        const badgeLetter = g.creator.side === 'heads' ? 'H' : 'T';

        const rightHtml = isMe
            ? `<div class="gc-actions">
                <div class="gc-waiting-label"><div class="dot-pulse"></div>Czekam...</div>
                <button class="btn-cancel" onclick="cancelGame('${g.id}')">Anuluj</button>
               </div>`
            : `<div class="gc-actions">
                <button class="btn-join" onclick="joinGame('${g.id}')">Join</button>
                <button class="btn-view" onclick="openViewModal('${g.id}')">View</button>
               </div>`;

        card.innerHTML = `
          <!-- CREATOR -->
          <div class="gc-player">
            <div class="gc-avatar-wrap">
              ${avatarHtml}
              <div class="gc-side-badge ${badgeClass}">${badgeLetter}</div>
            </div>
            <span class="gc-username">${g.creator.username}</span>
          </div>

          <!-- CENTER -->
          <div class="gc-center">
            <span class="gc-vs">Vs</span>
            <span class="gc-gameid"># ${g.id}</span>
            <span class="gc-bet">🪙 ${fmt(g.bet)}</span>
            <div class="gc-bar-wrap"><div class="gc-bar-fill"></div></div>
          </div>

          <!-- JOINER (waiting) -->
          <div class="gc-player">
            <div class="gc-avatar-wrap">
              <div class="gc-avatar-empty">?</div>
            </div>
            <span class="gc-waiting">Waiting...</span>
          </div>

          ${rightHtml}`;

        gamesList.appendChild(card);
    });
});

window.joinGame   = (id) => socket.emit('joinGame', { gameId: id });
window.cancelGame = (id) => socket.emit('cancelGame', { gameId: id });

// ── VIEW MODAL (bloxypot style) ───────────────────────────────
window.openViewModal = function(gameId) {
    const g = lobbyGames.find(x => x.id === gameId);
    if (!g) return;
    viewingGameId = gameId;

    // Creator
    const cImg = document.getElementById('view-creator-img');
    cImg.src = g.creator.avatarUrl || '';
    cImg.style.display = g.creator.avatarUrl ? 'block' : 'none';
    document.getElementById('view-creator-name').textContent = g.creator.username;
    const badge = document.getElementById('view-creator-badge');
    badge.textContent = g.creator.side === 'heads' ? 'H' : 'T';
    badge.style.background = g.creator.side === 'heads' ? 'var(--gold)' : 'var(--blue)';

    // Joiner (waiting)
    document.getElementById('view-joiner-name').textContent = 'Waiting...';

    // Game ID & bet
    document.getElementById('view-gameid').textContent = `# ${g.id}`;
    document.getElementById('view-creator-coins').textContent = `🪙 ${fmt(g.bet)}`;
    document.getElementById('view-joiner-coins').textContent  = `🪙 0`;
    document.getElementById('view-creator-pct').textContent   = '100.00%';
    document.getElementById('view-joiner-pct').textContent    = '0.00%';
    document.getElementById('view-bar-fill').style.width = '100%';
    document.getElementById('view-item-val').textContent = `🪙 ${fmt(g.bet)}`;

    // Join button
    const joinBtn = document.getElementById('view-join-btn');
    const isMe = g.creator.username === currentUsername;
    joinBtn.disabled = isMe;
    joinBtn.textContent = isMe ? 'Twoja gra' : 'Join';

    document.getElementById('view-modal').style.display = 'flex';
};

window.closeViewModal = () => {
    document.getElementById('view-modal').style.display = 'none';
    viewingGameId = null;
};

window.joinFromView = () => {
    if (!viewingGameId) return;
    socket.emit('joinGame', { gameId: viewingGameId });
    closeViewModal();
};

// ── WYNIK GRY ────────────────────────────────────────────────
socket.on('flipStart', (data) => {
    const youAreCreator = data.creator.username === currentUsername;
    openResultModal();
    fillResultPlayers(data.creator, data.joiner, youAreCreator);
    spinCoinTo('heads');
});

socket.on('gameResult', (data) => {
    const youAreCreator = data.creator.username === currentUsername;
    fillResultPlayers(data.creator, data.joiner, youAreCreator);
    setTimeout(() => {
        setCoinFinal(data.winningSide);
        showFlipBanner(
            data.won ? `🏆 Wygrałeś! +${fmt(data.prize)} monet!` : `💸 Przegrałeś! -${fmt(data.bet)} monet`,
            data.won ? 'win' : 'lose'
        );
    }, FLIP_MS);
    socket.emit('getHistory');
});

function openResultModal() {
    document.getElementById('result-modal').style.display = 'flex';
    document.getElementById('res-close-btn').style.display = 'none';
    document.getElementById('res-banner').className = 'res-banner';
    document.getElementById('res-banner').textContent = 'Rzut monetą...';
}
window.closeResultModal = () => {
    document.getElementById('result-modal').style.display = 'none';
    const coin = document.getElementById('big-coin');
    coin.classList.remove('spinning');
    coin.style.transform = '';
};

function fillResultPlayers(creator, joiner, youAreCreator) {
    const you = youAreCreator ? creator : joiner;
    const opp = youAreCreator ? joiner  : creator;
    document.getElementById('res-you-img').src    = you.avatarUrl || '';
    document.getElementById('res-you-name').textContent = you.username || 'Ty';
    document.getElementById('res-you-side').textContent = sideLabel(you.side);
    document.getElementById('res-opp-img').src    = opp.avatarUrl || '';
    document.getElementById('res-opp-name').textContent = opp.username || 'Przeciwnik';
    document.getElementById('res-opp-side').textContent = sideLabel(opp.side);
}

function spinCoinTo(side) {
    const coin = document.getElementById('big-coin');
    const deg  = side === 'heads' ? 1800 : 1980;
    coin.style.setProperty('--spin-to-deg', `${deg}deg`);
    coin.style.setProperty('--spin-dur', `${FLIP_MS}ms`);
    coin.style.transform = '';
    coin.classList.remove('spinning');
    void coin.offsetWidth;
    coin.classList.add('spinning');
}

function setCoinFinal(side) {
    const coin = document.getElementById('big-coin');
    coin.classList.remove('spinning');
    coin.style.transform = side === 'heads' ? 'rotateY(0deg)' : 'rotateY(180deg)';
}

function showFlipBanner(text, type) {
    const banner = document.getElementById('res-banner');
    banner.className = `res-banner ${type}`;
    banner.textContent = text;
    document.getElementById('res-close-btn').style.display = 'block';
}

// ── HISTORIA ─────────────────────────────────────────────────
socket.on('historyData', (records) => {
    if (!records.length) {
        historyWrap.innerHTML = `<div class="empty-lobby"><div class="empty-icon">📜</div><p>Brak historii</p><p class="empty-sub">Zagraj pierwszą grę PVP!</p></div>`;
        historySummary.innerHTML = '';
        return;
    }

    let wins=0, losses=0, profit=0;
    records.forEach(r => {
        const me = r.creator.username === currentUsername ? r.creator : r.joiner;
        if (me.won) { wins++; profit += r.bet; }
        else         { losses++; profit -= r.bet; }
    });
    const sign = profit >= 0 ? '+' : '';
    historySummary.innerHTML = `
        <div class="hs-item"><span class="hs-label">Gier</span><span class="hs-val gold">${records.length}</span></div>
        <div class="hs-item"><span class="hs-label">Wygrane</span><span class="hs-val green">${wins}</span></div>
        <div class="hs-item"><span class="hs-label">Przegrane</span><span class="hs-val red">${losses}</span></div>
        <div class="hs-item"><span class="hs-label">Zysk</span><span class="hs-val ${profit>=0?'green':'red'}">${sign}${fmt(profit)} 🪙</span></div>`;

    const rows = records.map((r, i) => {
        const me  = r.creator.username === currentUsername ? r.creator : r.joiner;
        const opp = r.creator.username === currentUsername ? r.joiner  : r.creator;
        const won = me.won;
        const oppAvatar = opp.avatarUrl ? `<img class="ht-opp-avatar" src="${opp.avatarUrl}" alt="">` : `<div class="ht-opp-avatar" style="background:var(--surf3);display:flex;align-items:center;justify-content:center;color:var(--muted)">?</div>`;
        return `<div class="ht-row ${won?'won':'lost'}">
            <span class="ht-num">#${records.length-i}</span>
            <div class="ht-opp">${oppAvatar}<span class="ht-opp-name">${opp.username}</span></div>
            <div style="display:flex;gap:6px;align-items:center">
              <span class="${me.side==='heads'?'side-heads':'side-tails'}">${sideLabel(me.side)}</span>
              <span style="color:var(--muted);font-size:.7rem">vs</span>
              <span class="${opp.side==='heads'?'side-heads':'side-tails'}">${sideLabel(opp.side)}</span>
            </div>
            <span class="ht-bet">🪙 ${fmt(r.bet)}</span>
            <span class="ht-result ${won?'won':'lost'}">${won?'🏆 Wygrana':'💸 Przegrana'}</span>
        </div>`;
    }).join('');

    historyWrap.innerHTML = `
        <div class="history-table">
          <div class="ht-head"><span>#</span><span>Przeciwnik</span><span>Strony</span><span>Zakład</span><span>Wynik</span></div>
          ${rows}
        </div>`;
});

// ── DEPOZYT / INVENTARZ ───────────────────────────────────────
window.openDepositModal = () => {
    document.getElementById('dep-search').value = '';
    document.getElementById('dep-note').value = '';
    document.getElementById('deposit-rows').innerHTML = '';
    setDepositHint();
    addDepositRow('');
    document.getElementById('deposit-modal').style.display = 'flex';
};
window.closeDepositModal = () => { document.getElementById('deposit-modal').style.display = 'none'; };

function setDepositHint() {
    const hint = document.getElementById('deposit-hint');
    hint.innerHTML = `
      1) Zrób trade w PS99 i wyślij itemy do konta/bota.<br>
      2) Tutaj wpisz co wysłałeś i kliknij <b>Zgłoś depozyt</b>.<br>
      3) Admin potwierdzi i itemy pojawią się w Twoim inventarzu na stronie.`;
}

function addDepositRow(prefillName) {
    const wrap = document.getElementById('deposit-rows');
    const row = document.createElement('div');
    row.className = 'dep-row';
    row.innerHTML = `
      <input class="dep-name" placeholder="Nazwa itemu" value="${escapeHtml(prefillName || '')}">
      <input class="dep-qty" type="number" min="1" value="1">
      <button class="dep-del" title="Usuń">✕</button>
    `;
    row.querySelector('.dep-del').addEventListener('click', () => row.remove());
    wrap.appendChild(row);
}

window.addDepositRowFromSearch = () => {
    const name = document.getElementById('dep-search').value.trim();
    addDepositRow(name);
    document.getElementById('dep-search').value = '';
};

window.submitDepositRequest = async () => {
    try {
        const rows = [...document.querySelectorAll('#deposit-rows .dep-row')];
        const items = rows.map(r => ({
            name: r.querySelector('.dep-name').value.trim(),
            qty: parseInt(r.querySelector('.dep-qty').value || '1', 10) || 1
        })).filter(x => x.name);
        const note = document.getElementById('dep-note').value.trim();
        if (!items.length) return alert('Dodaj przynajmniej 1 item.');
        await apiJson('/api/deposit/request', { method: 'POST', body: JSON.stringify({ items, note }) });
        closeDepositModal();
        await refreshDepositTab();
        alert('Zgłoszenie depozytu wysłane (pending).');
    } catch (e) {
        alert(e.message);
    }
};

window.openWithdrawModal = async () => {
    withdrawSelection = new Map();
    try {
        await loadInventory();
        renderWithdrawPicker();
        document.getElementById('wd-note').value = '';
        document.getElementById('withdraw-modal').style.display = 'flex';
    } catch (e) {
        alert(e.message);
    }
};
window.closeWithdrawModal = () => { document.getElementById('withdraw-modal').style.display = 'none'; };

function renderWithdrawPicker() {
    const box = document.getElementById('withdraw-items');
    box.innerHTML = '';
    if (!myInventory.length) {
        box.innerHTML = `<div class="empty-mini" style="grid-column:1/-1">Brak itemów na stronie.</div>`;
        return;
    }
    myInventory.forEach(it => {
        const key = it.name.toLowerCase();
        const card = document.createElement('div');
        card.className = 'inv-item';
        card.innerHTML = `
          <div class="inv-name">${escapeHtml(it.name)}</div>
          <div class="inv-qty">Masz: ${fmt(it.qty)}</div>
          <div class="inv-actions">
            <button class="inv-btn" data-act="minus">−</button>
            <span class="inv-sel" data-sel>0</span>
            <button class="inv-btn" data-act="plus">+</button>
          </div>
        `;
        const selEl = card.querySelector('[data-sel]');
        const updateSel = () => {
            const v = withdrawSelection.get(key) || 0;
            selEl.textContent = String(v);
        };
        card.querySelector('[data-act="minus"]').addEventListener('click', () => {
            const cur = withdrawSelection.get(key) || 0;
            if (cur <= 0) return;
            const next = cur - 1;
            if (next === 0) withdrawSelection.delete(key);
            else withdrawSelection.set(key, next);
            updateSel();
        });
        card.querySelector('[data-act="plus"]').addEventListener('click', () => {
            const cur = withdrawSelection.get(key) || 0;
            if (cur >= it.qty) return;
            withdrawSelection.set(key, cur + 1);
            updateSel();
        });
        updateSel();
        box.appendChild(card);
    });
}

window.submitWithdrawRequest = async () => {
    try {
        const note = document.getElementById('wd-note').value.trim();
        const items = [];
        withdrawSelection.forEach((qty, key) => {
            if (qty > 0) {
                const original = myInventory.find(x => x.name.toLowerCase() === key);
                if (original) items.push({ name: original.name, qty });
            }
        });
        if (!items.length) return alert('Wybierz itemy do wypłaty.');
        await apiJson('/api/withdraw/request', { method: 'POST', body: JSON.stringify({ items, note }) });
        closeWithdrawModal();
        await refreshDepositTab();
        alert('Zgłoszenie wypłaty wysłane (pending).');
    } catch (e) {
        alert(e.message);
    }
};

async function loadInventory() {
    const data = await apiJson('/api/inventory', { method: 'GET' });
    myInventory = data.items || [];
}

async function loadRequests() {
    const data = await apiJson('/api/requests', { method: 'GET' });
    myRequests = data.requests || [];
}

function renderInventory() {
    if (!inventoryListEl) return;
    inventoryListEl.innerHTML = '';
    const items = myInventory || [];
    inventoryEmptyEl.style.display = items.length ? 'none' : 'block';
    items.forEach(it => {
        const el = document.createElement('div');
        el.className = 'inv-item';
        el.innerHTML = `
          <div class="inv-name">${escapeHtml(it.name)}</div>
          <div class="inv-qty">x ${fmt(it.qty)}</div>
        `;
        inventoryListEl.appendChild(el);
    });
}

function statusBadge(r) {
    const s = r.status;
    if (s === 'pending') return `<span class="badge pending">PENDING</span>`;
    if (s === 'approved') return `<span class="badge approved">APPROVED</span>`;
    if (s === 'rejected') return `<span class="badge rejected">REJECTED</span>`;
    if (s === 'sent') return `<span class="badge sent">SENT</span>`;
    return `<span class="badge">${escapeHtml(s)}</span>`;
}

function typeLabel(t) {
    return t === 'deposit' ? 'Deposit' : (t === 'withdraw' ? 'Withdraw' : t);
}

function renderRequests() {
    if (!requestsListEl) return;
    requestsListEl.innerHTML = '';
    const reqs = myRequests || [];
    requestsEmptyEl.style.display = reqs.length ? 'none' : 'block';

    reqs.forEach(r => {
        const items = (r.items || []).map(it => `${escapeHtml(it.name)} x${fmt(it.qty)}`).join(', ');
        const el = document.createElement('div');
        el.className = 'req-item';
        el.innerHTML = `
          <div class="req-top">
            <div class="req-title">${typeLabel(r.type)} ${statusBadge(r)}</div>
            <div class="req-time">${timeAgo(r.createdAt || Date.now())}</div>
          </div>
          <div class="req-body">${items || '—'}</div>
          ${r.note ? `<div class="req-note">Notatka: ${escapeHtml(r.note)}</div>` : ''}
          ${r.adminNote ? `<div class="req-note">Admin: ${escapeHtml(r.adminNote)}</div>` : ''}
        `;
        requestsListEl.appendChild(el);
    });
}

// zamknij modale klikając tło
['create-modal','view-modal','result-modal','deposit-modal','withdraw-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', function(e) {
        if (e.target === this) this.style.display = 'none';
    });
});

