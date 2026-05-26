"use strict";
const socket = io();

let currentUsername = '';
let currentAvatar   = '';
let currentRobloxId = '';
let currentSide     = 'heads';
let lobbyGames      = [];
let viewingGameId   = null;
const FLIP_MS       = 2200;

// Depozyty / inventarz
let myInventory = [];
let myRequests  = [];
let withdrawSelection = new Map();

// Inventory z RAP (do create/join game)
let myInventoryRAP = [];

// Wybrane itemy do create game
let createSelectedItems = [];

// Wybrane itemy do join game (przez view modal)
let joinSelectedItems = [];

// Store last flip data for result modal items
let lastFlipData = null;
let lastResultData = null;

// ── DOM ───────────────────────────────────────────────────────
const loginOverlay    = document.getElementById('login-overlay');
const sidebarAvatar   = document.getElementById('sidebar-avatar');
const sidebarUsername = document.getElementById('sidebar-username');
const sidebarUser     = document.getElementById('sidebar-user');
const logoutBtn       = document.getElementById('logout-btn');
const gamesList       = document.getElementById('games-list');
const lobbyCount      = document.getElementById('lobby-count');
const historyWrap     = document.getElementById('history-table-wrap');
const historySummary  = document.getElementById('history-summary');

let currentSidebarTab = 'leaderboard';
let currentSubtab     = 'lobby';

const inventoryListEl  = document.getElementById('inventory-list');
const inventoryEmptyEl = document.getElementById('inventory-empty');
const requestsListEl   = document.getElementById('requests-list');
const requestsEmptyEl  = document.getElementById('requests-empty');

function fmt(n) {
    const v = Number(n);
    if (v < 1000) return String(v);
    if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0) + 'K';
    if (v < 1_000_000_000) return (v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0) + 'M';
    return (v / 1_000_000_000).toFixed(v < 10_000_000_000 ? 1 : 0) + 'B';
}
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
    currentRobloxId = data.robloxId || '';
    currentUserId   = data.robloxId || '';
    sidebarUsername.textContent = data.username;
    sidebarUser.style.display = 'flex';
    logoutBtn.style.display = 'inline-block';
    if (data.avatarUrl) {
        sidebarAvatar.src = data.avatarUrl;
        document.getElementById('ps-avatar').src = data.avatarUrl;
    }
    document.getElementById('ps-username').textContent = data.username;
    refreshProfileStats();
    refreshLevel();
    socket.emit('getHistory');
    socket.emit('getChatHistory');
    showTab('leaderboard');
    // online count
    socket.emit('countOnline');
});

socket.on('sessionNone', () => { loginOverlay.style.display = 'flex'; });
socket.on('gameError', (msg) => alert(msg));

// ── STATYSTYKI PROFILU ───────────────────────────────────────
window.toggleProfileStats = async function() {
    const panel = document.getElementById('profile-stats-panel');
    const isOpen = panel.classList.contains('open');
    if (!isOpen) {
        await refreshProfileStats();
        panel.classList.add('open');
    } else {
        panel.classList.remove('open');
    }
};

window.refreshProfileStats = async function() {
    try {
        const stats = await apiJson('/api/profile/stats');
        const { total = 0, wins = 0, losses = 0, profit = 0 } = stats;
        document.getElementById('ps-total').textContent = total;
        document.getElementById('ps-wins').textContent = wins;
        document.getElementById('ps-losses').textContent = losses;
        const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
        document.getElementById('ps-wr').textContent = wr + '%';
        const sign = profit >= 0 ? '+' : '';
        const profitEl = document.getElementById('ps-profit');
        profitEl.textContent = `${sign}🪙 ${fmt(profit)}`;
        profitEl.className = 'ps-profit-val ' + (profit >= 0 ? 'green' : 'red');
        return stats;
    } catch (e) {
        return { total: 0, wins: 0, losses: 0, profit: 0 };
    }
};

// ── LEVEL SYSTEM ──────────────────────────────────────────────
window.refreshLevel = async function() {
    const badge = document.getElementById('level-badge');
    if (!badge) return;
    try {
        const stats = await apiJson('/api/profile/stats');
        const { level = 0, levelName = 'Basic', xpInLevel = 0, nextLevelXp = 10000 } = stats;
        document.getElementById('level-name').textContent = levelName;
        document.getElementById('level-num').textContent = `Lv. ${level}`;
        const pct = nextLevelXp > 0 ? Math.min(100, (xpInLevel / nextLevelXp) * 100) : 100;
        document.getElementById('level-bar-fill').style.width = pct + '%';
        // Ustaw kolor level badge w zależności od tieru
        badge.className = 'level-badge';
        if (level >= 99) badge.classList.add('lvl-mega');
        else if (level >= 51) badge.classList.add('lvl-ultra');
        else if (level >= 16) badge.classList.add('lvl-pro');
        else if (level >= 1) badge.classList.add('lvl-enth');
    } catch (e) {
        // cicho
    }
};

// Close panel when clicking outside
document.addEventListener('click', function(e) {
    const panel = document.getElementById('profile-stats-panel');
    const userWrap = document.querySelector('.sidebar-user');
    if (panel && panel.classList.contains('open')) {
        if (!panel.contains(e.target) && !userWrap.contains(e.target)) {
            panel.classList.remove('open');
        }
    }
});

// ── LEADERBOARD ────────────────────────────────────────────────
window.fetchLeaderboard = async function() {
    const lbList = document.getElementById('lb-list');
    if (!lbList) return;
    try {
        const data = await apiJson('/api/leaderboard');
        const players = data.leaderboard || [];
        if (!players.length) {
            lbList.innerHTML = '<div class="empty-lobby"><div class="empty-icon">🏆</div><p>Brak danych</p><p class="empty-sub">Zagraj pierwszą grę, aby pojawić się na liście!</p></div>';
            return;
        }
        let html = '<div class="lb-table"><div class="lb-head"><span>#</span><span>Gracz</span><span>Gier</span><span>Wygrane</span><span>Przegrane</span><span>Zysk</span></div>';
        players.forEach((p, i) => {
            const rank = i + 1;
            const isMe = p.robloxId === currentRobloxId;
            const avatarHtml = p.avatarUrl ? `<img class="lb-avatar" src="${p.avatarUrl}" alt="">` : `<div class="lb-avatar-empty">?</div>`;
            const profitClass = p.profit >= 0 ? 'profit-plus' : 'profit-minus';
            const profitSign = p.profit >= 0 ? '+' : '';
            const medalEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
            html += `<div class="lb-row ${isMe ? 'lb-me' : ''}">
                <span class="lb-rank">${medalEmoji || rank}</span>
                <div class="lb-player-col">${avatarHtml}<span class="lb-name">${escapeHtml(p.username)}</span></div>
                <span class="lb-stat">${p.wins + p.losses}</span>
                <span class="lb-stat green">${p.wins}</span>
                <span class="lb-stat red">${p.losses}</span>
                <span class="lb-stat ${profitClass}">${profitSign}🪙 ${fmt(Math.abs(p.profit))}</span>
            </div>`;
        });
        html += '</div>';
        lbList.innerHTML = html;
    } catch (e) {
        lbList.innerHTML = '<div class="empty-lobby"><div class="empty-icon">⚠️</div><p>Błąd ładowania leaderboardu</p></div>';
    }
};

// ── RULES MODAL ────────────────────────────────────────────────
window.openRules = function() {
    document.getElementById('rules-modal').style.display = 'flex';
};
window.closeRules = function() {
    document.getElementById('rules-modal').style.display = 'none';
};

// ── PROMO CODE ────────────────────────────────────────────────
window.openPromoCode = function() {
    document.getElementById('promo-input').value = '';
    document.getElementById('promo-message').style.display = 'none';
    document.getElementById('promo-message').className = 'promo-message';
    document.getElementById('promo-modal').style.display = 'flex';
};
window.closePromoCode = function() {
    document.getElementById('promo-modal').style.display = 'none';
};

window.redeemPromoCode = async function() {
    const input = document.getElementById('promo-input');
    const code = input.value.trim();
    if (!code) {
        showPromoMessage('Wpisz kod promocyjny!', 'error');
        return;
    }
    const btn = document.querySelector('.promo-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Sprawdzanie...';
    try {
        const data = await apiJson('/api/promo/redeem', {
            method: 'POST',
            body: JSON.stringify({ code })
        });
        if (data.success) {
            showPromoMessage(data.message || '✅ Kod zrealizowany!', 'success');
            input.value = '';
        }
    } catch (e) {
        showPromoMessage(e.message || 'Błąd realizacji kodu', 'error');
    }
    btn.disabled = false;
    btn.textContent = 'Zrealizuj';
};

function showPromoMessage(text, type) {
    const el = document.getElementById('promo-message');
    el.textContent = text;
    el.className = 'promo-message ' + type;
    el.style.display = 'block';
}

// ── TABS ──────────────────────────────────────────────────────
window.showTab = function(tab) {
    currentSidebarTab = tab;

    // Hide all sidebar tab contents
    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');

    // Show selected tab
    document.getElementById('tab-' + tab).style.display = 'block';

    // Update sidebar tabs
    document.querySelectorAll('.sidebar-tab').forEach((el) => {
        const t = el.getAttribute('data-tab');
        el.classList.toggle('active', t === tab);
    });

    // Show/hide subtabs in top bar
    const subtabs = document.getElementById('coinflip-subtabs');
    if (tab === 'coinflip') {
        subtabs.style.display = 'flex';
        showCoinflipSubtab(currentSubtab);
    } else {
        subtabs.style.display = 'none';
    }

    // Load data for specific tabs
    if (tab === 'coinflip' && currentSubtab === 'history') socket.emit('getHistory');
    if (tab === 'coinflip' && currentSubtab === 'deposit') refreshDepositTab();
    if (tab === 'leaderboard') fetchLeaderboard();
};

window.showCoinflipSubtab = function(subtab) {
    currentSubtab = subtab;
    document.querySelectorAll('.coinflip-subtab-content').forEach(el => el.style.display = 'none');
    document.getElementById('tab-' + subtab).style.display = 'block';
    document.querySelectorAll('.top-subtab').forEach((el) => {
        const t = el.getAttribute('data-subtab');
        el.classList.toggle('active', t === subtab);
    });
    if (subtab === 'history') socket.emit('getHistory');
    if (subtab === 'deposit') refreshDepositTab();
};

async function refreshDepositTab() {
    try {
        await Promise.all([loadInventory(), loadRequests()]);
        renderInventory();
        renderRequests();
    } catch (e) {
        console.warn(e.message);
    }
}

// ── ITEM PICKER (create game) ────────────────────────────────
async function loadInventoryRAP() {
    try {
        const data = await apiJson('/api/inventory/with-rap');
        myInventoryRAP = data.items || [];
    } catch (e) {
        myInventoryRAP = [];
    }
}

window.openCreateModal = async () => {
    createSelectedItems = [];
    await loadInventoryRAP();
    renderCreateItemPicker();
    document.getElementById('create-modal').style.display = 'flex';
};

window.closeCreateModal = () => {
    document.getElementById('create-modal').style.display = 'none';
};

window.selectModalSide = (side) => {
    currentSide = side;
    document.getElementById('modal-heads').classList.toggle('active', side==='heads');
    document.getElementById('modal-tails').classList.toggle('active', side==='tails');
};

function renderCreateItemPicker() {
    const grid = document.getElementById('create-items-grid');
    const empty = document.getElementById('create-items-empty');
    const total = document.getElementById('create-total');
    const count = document.getElementById('create-item-count');

    grid.innerHTML = '';

    if (!myInventoryRAP.length) {
        empty.style.display = 'block';
        total.textContent = '🪙 0';
        count.textContent = '';
        return;
    }

    empty.style.display = 'none';

    let totalValue = 0;
    let itemCount = 0;
    const selectedMap = new Map();
    createSelectedItems.forEach(it => selectedMap.set(it.name.toLowerCase(), it));

    myInventoryRAP.forEach(it => {
        const key = it.name.toLowerCase();
        const sel = selectedMap.get(key);
        const qty = sel ? sel.qty : 0;
        totalValue += (it.rap || 0) * qty;
        itemCount += qty;

        const card = document.createElement('div');
        card.className = 'inv-item';
        card.innerHTML = `
          <div class="inv-name">${escapeHtml(it.name)}</div>
          <div class="inv-qty">🪙 ${fmt(it.rap || 0)} · Masz: ${fmt(it.qty)}</div>
          <div class="inv-actions">
            <button class="inv-btn" data-act="minus" data-key="${escapeHtml(key)}">−</button>
            <span class="inv-sel" id="sel-${escapeHtml(key)}">${qty}</span>
            <button class="inv-btn" data-act="plus" data-key="${escapeHtml(key)}">+</button>
          </div>
        `;

        card.querySelector('[data-act="minus"]').addEventListener('click', () => {
            const cur = createSelectedItems.find(x => x.name.toLowerCase() === key);
            if (!cur) return;
            if (cur.qty <= 1) {
                createSelectedItems = createSelectedItems.filter(x => x.name.toLowerCase() !== key);
            } else {
                cur.qty--;
            }
            renderCreateItemPicker();
        });

        card.querySelector('[data-act="plus"]').addEventListener('click', () => {
            const avail = it.qty;
            const cur = createSelectedItems.find(x => x.name.toLowerCase() === key);
            const curQty = cur ? cur.qty : 0;
            if (curQty >= avail) return;
            if (cur) cur.qty++;
            else createSelectedItems.push({ name: it.name, qty: 1, rap: it.rap || 0 });
            renderCreateItemPicker();
        });

        grid.appendChild(card);
    });

    total.textContent = '🪙 ' + fmt(totalValue);
    count.textContent = `(${itemCount} szt.)`;
}

window.submitCreateGame = () => {
    const items = createSelectedItems.map(it => ({
        name: it.name,
        qty: it.qty,
        rap: it.rap || 0
    }));
    if (!items.length) return alert('Wybierz przynajmniej 1 item do zakładu!');
    socket.emit('createGame', { items, side: currentSide });
    closeCreateModal();
};

socket.on('gameCreated', () => { socket.emit('getHistory'); });

// ── GAME INFO MODAL ────────────────────────────────────────
function buildGameInfoPlayerSection(player, items, totalValue) {
    const avatarHtml = player && player.avatarUrl
        ? `<img class="gi-avatar" src="${player.avatarUrl}" alt="">`
        : `<div class="gi-avatar gi-avatar-empty">?</div>`;
    
    const nameHtml = player ? escapeHtml(player.username || '—') : '<span class="gi-muted-text">—</span>';
    const sideHtml = player && player.side
        ? `<span class="gi-side gi-side-${player.side}">${player.side === 'heads' ? 'ORZEŁ' : 'RESZKA'}</span>`
        : '';

    let itemsHtml = '';
    if (items && items.length) {
        items.forEach(it => {
            const itemTotal = (it.rap || 0) * (it.qty || 1);
            itemsHtml += `
                <div class="gi-item">
                    <div class="gi-item-top">
                        <span class="gi-item-name">${escapeHtml(it.name)}</span>
                        <span class="gi-item-qty">x${it.qty || 1}</span>
                    </div>
                    <div class="gi-item-bottom">
                        ${it.rap ? `<span class="gi-item-rap">🪙 ${fmt(it.rap)} each</span>` : ''}
                        ${it.rap ? `<span class="gi-item-subtotal">= 🪙 ${fmt(itemTotal)}</span>` : ''}
                    </div>
                </div>`;
        });
    }
    
    return `
        <div class="gi-player-header">
            ${avatarHtml}
            <div class="gi-player-info">
                <div class="gi-player-name">${nameHtml}</div>
                ${sideHtml}
            </div>
        </div>
        <div class="gi-items-wrap">
            ${itemsHtml || '<div class="gi-no-items">Brak itemów</div>'}
        </div>
        <div class="gi-total-row">
            <span class="gi-total-label">Łączna wartość:</span>
            <span class="gi-total-value">🪙 ${fmt(totalValue || 0)}</span>
        </div>`;
}

window.showGameInfo = function(gameId) {
    const game = lobbyGames.find(x => x.id === gameId);
    if (!game) return;
    
    document.getElementById('gi-game-id').textContent = `# ${game.id}`;
    const content = document.getElementById('gi-content');
    
    // Creator
    const creatorHtml = buildGameInfoPlayerSection(game.creator, game.items || [], game.totalValue || 0);
    
    // Joiner or waiting
    let joinerHtml;
    if (game.status === 'waiting') {
        joinerHtml = `
            <div class="gi-waiting">
                <div class="gi-waiting-icon">⏳</div>
                <div class="gi-waiting-text">Oczekiwanie na przeciwnika</div>
                <div class="gi-waiting-sub">Nikt jeszcze nie dołączył do tej gry</div>
            </div>`;
    } else {
        joinerHtml = buildGameInfoPlayerSection(game.joiner || null, [], 0);
    }
    
    content.innerHTML = `
        <div class="gi-players">
            <div class="gi-player-col gi-col-creator">
                <div class="gi-col-header">
                    <span class="gi-col-badge creator-badge">Twórca</span>
                    ${game.creator.username === currentUsername ? '<span class="gi-col-you">(Ty)</span>' : ''}
                </div>
                ${creatorHtml}
            </div>
            <div class="gi-vs-col">
                <div class="gi-vs-circle">⚔️</div>
            </div>
            <div class="gi-player-col gi-col-opponent">
                <div class="gi-col-header">
                    <span class="gi-col-badge opp-badge">${game.status === 'waiting' ? 'Oczekiwanie' : 'Przeciwnik'}</span>
                </div>
                ${joinerHtml}
            </div>
        </div>`;
    
    document.getElementById('game-info-modal').style.display = 'flex';
};

window.closeGameInfo = function() {
    document.getElementById('game-info-modal').style.display = 'none';
};

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

        // Generuj podgląd itemów
        const itemsHtml = (g.items || []).slice(0, 3).map(it =>
            `<span class="gc-item-chip">${escapeHtml(it.name)}${it.qty > 1 ? ' x' + it.qty : ''}</span>`
        ).join('');
        const moreHtml = (g.items || []).length > 3 ? `<span class="gc-item-chip muted">+${(g.items||[]).length - 3}</span>` : '';

        const rightHtml = isMe
            ? `<div class="gc-actions">
                <div class="gc-waiting-label"><div class="dot-pulse"></div>Czekam...</div>
                <button class="btn-info" onclick="showGameInfo('${g.id}')">📋 Info</button>
                <button class="btn-cancel" onclick="cancelGame('${g.id}')">Anuluj</button>
               </div>`
            : `<div class="gc-actions">
                <button class="btn-join" onclick="openJoinGameModal('${g.id}')">Join</button>
                <button class="btn-view" onclick="openViewModal('${g.id}')">View</button>
                <button class="btn-info-sm" onclick="showGameInfo('${g.id}')">📋 Info</button>
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
            <span class="gc-bet">🪙 ${fmt(g.totalValue)}</span>
            <div class="gc-items-row">${itemsHtml}${moreHtml}</div>
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

window.cancelGame = (id) => socket.emit('cancelGame', { gameId: id });

// ── JOIN GAME MODAL (item picker) ────────────────────────────
let joinGameTarget = null;

window.openJoinGameModal = async (gameId) => {
    joinGameTarget = lobbyGames.find(x => x.id === gameId);
    if (!joinGameTarget) return;
    joinSelectedItems = [];
    await loadInventoryRAP();
    renderJoinItemPicker();
    document.getElementById('join-modal').style.display = 'flex';
};

window.closeJoinModal = () => {
    document.getElementById('join-modal').style.display = 'none';
    joinGameTarget = null;
};

function renderJoinItemPicker() {
    const grid = document.getElementById('join-items-grid');
    const empty = document.getElementById('join-items-empty');
    const total = document.getElementById('join-total');
    const minVal = joinGameTarget ? Math.round(joinGameTarget.totalValue * 0.925) : 0;
    const maxVal = joinGameTarget ? Math.round(joinGameTarget.totalValue * 1.075) : 0;

    grid.innerHTML = '';

    if (!myInventoryRAP.length) {
        empty.style.display = 'block';
        total.textContent = '🪙 0';
        return;
    }

    empty.style.display = 'none';

    let totalValue = 0;
    const selectedMap = new Map();
    joinSelectedItems.forEach(it => selectedMap.set(it.name.toLowerCase(), it));

    const gameValueHtml = `<div class="modal-info" style="margin-top:0;margin-bottom:12px;font-size:.82rem">
      Twój zakład musi mieć wartość <b>🪙 ${fmt(minVal)} – ${fmt(maxVal)}</b><br>
      <span style="color:var(--muted);font-size:.78rem">±7.5% od 🪙 ${fmt(joinGameTarget.totalValue)} (zakład twórcy)</span>
    </div>`;
    document.getElementById('join-min-info').innerHTML = gameValueHtml;

    myInventoryRAP.forEach(it => {
        const key = it.name.toLowerCase();
        const sel = selectedMap.get(key);
        const qty = sel ? sel.qty : 0;
        totalValue += (it.rap || 0) * qty;

        const card = document.createElement('div');
        card.className = 'inv-item';
        card.innerHTML = `
          <div class="inv-name">${escapeHtml(it.name)}</div>
          <div class="inv-qty">🪙 ${fmt(it.rap || 0)} · Masz: ${fmt(it.qty)}</div>
          <div class="inv-actions">
            <button class="inv-btn" data-act="minus" data-key="${escapeHtml(key)}">−</button>
            <span class="inv-sel" id="jsel-${escapeHtml(key)}">${qty}</span>
            <button class="inv-btn" data-act="plus" data-key="${escapeHtml(key)}">+</button>
          </div>
        `;

        card.querySelector('[data-act="minus"]').addEventListener('click', () => {
            const cur = joinSelectedItems.find(x => x.name.toLowerCase() === key);
            if (!cur) return;
            if (cur.qty <= 1) {
                joinSelectedItems = joinSelectedItems.filter(x => x.name.toLowerCase() !== key);
            } else {
                cur.qty--;
            }
            renderJoinItemPicker();
        });

        card.querySelector('[data-act="plus"]').addEventListener('click', () => {
            const avail = it.qty;
            const cur = joinSelectedItems.find(x => x.name.toLowerCase() === key);
            const curQty = cur ? cur.qty : 0;
            if (curQty >= avail) return;
            if (cur) cur.qty++;
            else joinSelectedItems.push({ name: it.name, qty: 1, rap: it.rap || 0 });
            renderJoinItemPicker();
        });

        grid.appendChild(card);
    });

    total.textContent = '🪙 ' + fmt(totalValue);
}

window.submitJoinGame = () => {
    if (!joinGameTarget) return;
    const items = joinSelectedItems.map(it => ({
        name: it.name,
        qty: it.qty,
        rap: it.rap || 0
    }));
    if (!items.length) return alert('Wybierz przynajmniej 1 item do zakładu!');
    socket.emit('joinGame', { gameId: joinGameTarget.id, items });
    closeJoinModal();
};

// ── VIEW MODAL ───────────────────────────────────────────────
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

    // Game ID & value
    document.getElementById('view-gameid').textContent = `# ${g.id}`;
    document.getElementById('view-creator-coins').textContent = `🪙 ${fmt(g.totalValue)}`;
    document.getElementById('view-joiner-coins').textContent  = `🪙 0`;

    // Items of creator - full list with RAP
    const creatorItemsEl = document.getElementById('view-creator-items');
    creatorItemsEl.innerHTML = (g.items || []).map(it => {
        const itemTotal = (it.rap || 0) * (it.qty || 1);
        return `<div class="vi-item-row">
            <span class="vi-item-name">${escapeHtml(it.name)}</span>
            <span class="vi-item-qty">x${it.qty || 1}</span>
            ${it.rap ? `<span class="vi-item-rap">🪙 ${fmt(it.rap)}</span>` : ''}
            ${it.rap ? `<span class="vi-item-total">= 🪙 ${fmt(itemTotal)}</span>` : ''}
        </div>`;
    }).join('') || '<div class="vi-empty">—</div>';

    // Show all creator items in detail
    document.getElementById('view-creator-items').style.display = 'block';
    document.getElementById('view-pot-info').innerHTML = `<strong>🪙 ${fmt(g.totalValue)}</strong> łączna wartość zakładu`;
    document.getElementById('view-pot-info').style.display = 'block';

    // Hide joiner items (none yet)
    document.getElementById('view-joiner-items-row').style.display = 'none';

    // Progress bar
    document.getElementById('view-bar-fill').style.width = '100%';

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
    // Zamiast bezpośredniego join, otwórz join modal
    openJoinGameModal(viewingGameId);
    closeViewModal();
};

// ── WYNIK GRY ────────────────────────────────────────────────
function buildItemsListHtml(items) {
    if (!items || !items.length) return '<div class="ri-empty">Brak itemów</div>';
    return items.map(it => {
        const itemTotal = (it.rap || 0) * (it.qty || 1);
        return `
            <div class="ri-item">
                <div class="ri-item-name">${escapeHtml(it.name)}</div>
                <div class="ri-item-meta">
                    <span class="ri-item-qty">x${it.qty || 1}</span>
                    ${it.rap ? `<span class="ri-item-rap">🪙 ${fmt(it.rap)}</span>` : ''}
                    ${it.rap ? `<span class="ri-item-total">= 🪙 ${fmt(itemTotal)}</span>` : ''}
                </div>
            </div>`;
    }).join('');
}

function showResultItems(data) {
    const section = document.getElementById('res-items-section');
    if (!section) return;
    section.style.display = 'flex';
    
    const youAreCreator = data.creator.username === currentUsername;
    const myItems = youAreCreator ? (data.items || []) : (data.joinerItems || []);
    const oppItems = youAreCreator ? (data.joinerItems || []) : (data.items || []);
    const myTotal = youAreCreator ? (data.totalValue || 0) : (data.joinValue || 0);
    const oppTotal = youAreCreator ? (data.joinValue || 0) : (data.totalValue || 0);
    
    document.getElementById('res-my-items').innerHTML = buildItemsListHtml(myItems);
    document.getElementById('res-opp-items').innerHTML = buildItemsListHtml(oppItems);
    document.getElementById('res-my-total').innerHTML = '🪙 ' + fmt(myTotal);
    document.getElementById('res-opp-total').innerHTML = '🪙 ' + fmt(oppTotal);
}

socket.on('flipStart', (data) => {
    const youAreCreator = data.creator.username === currentUsername;
    lastFlipData = data;
    openResultModal();
    fillResultPlayers(data.creator, data.joiner, youAreCreator);
    showResultItems(data);
    spinCoinTo('heads');
});

socket.on('gameResult', (data) => {
    const youAreCreator = data.creator.username === currentUsername;
    lastResultData = data;
    fillResultPlayers(data.creator, data.joiner, youAreCreator);
    showResultItems(data);
    setTimeout(() => {
        setCoinFinal(data.winningSide);
        const prizeVal = data.prize || 0;
        showFlipBanner(
            data.won ? `🏆 Wygrałeś! +${fmt(prizeVal)} 🪙` : `💸 Przegrałeś! -${fmt(data.totalValue || prizeVal)} 🪙`,
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
    document.getElementById('res-items-section').style.display = 'none';
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
        if (me.won) { wins++; profit += (r.totalValue || 0); }
        else         { losses++; profit -= (r.totalValue || 0); }
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
            <span class="ht-bet">🪙 ${fmt(r.totalValue || 0)}</span>
            <span class="ht-result ${won?'won':'lost'}">${won?'🏆 Wygrana':'💸 Przegrana'}</span>
        </div>`;
    }).join('');

    historyWrap.innerHTML = `
        <div class="history-table">
          <div class="ht-head"><span>#</span><span>Przeciwnik</span><span>Strony</span><span>Zakład</span><span>Wynik</span></div>
          ${rows}
        </div>`;
    refreshProfileStats();
    refreshLevel();
});

// ── DEPOZYT / INVENTARZ ───────────────────────────────────────
// ── DEPOZYT: PET SEARCH ──────────────────────────────────────
let petSearchCache = [];
let petSearchTimer = null;
let selectedDepositItems = [];

window.openDepositModal = () => {
    document.getElementById('pet-search').value = '';
    document.getElementById('dep-note').value = '';
    selectedDepositItems = [];
    renderDepositItems();
    document.getElementById('pet-search-results').innerHTML = '';
    document.getElementById('pet-search-results').classList.remove('open');
    document.getElementById('deposit-modal').style.display = 'flex';
    searchPets('', 'all');
};

window.closeDepositModal = () => {
    document.getElementById('deposit-modal').style.display = 'none';
    document.getElementById('pet-search-results').classList.remove('open');
};

async function searchPets(q, category) {
    try {
        const params = new URLSearchParams({ q, limit: '30' });
        if (category && category !== 'all') params.set('category', category);
        const data = await apiJson('/api/pets/search?' + params.toString());
        petSearchCache = data.results || [];
        renderPetResults(petSearchCache);
    } catch (e) {
        console.warn('Pet search error:', e.message);
    }
}

function renderPetResults(pets) {
    const el = document.getElementById('pet-search-results');
    el.innerHTML = '';
    
    if (!pets.length) {
        el.innerHTML = '<div class="pet-empty">Brak wyników. Spróbuj innej nazwy.</div>';
        el.classList.add('open');
        return;
    }
    
    el.classList.add('open');
    
    pets.forEach(p => {
        const alreadyAdded = selectedDepositItems.find(x => x.name === p.name);
        const card = document.createElement('div');
        card.className = 'pet-result-item';
        
        const catColors = { Huge: 'var(--gold)', Titanic: 'var(--purple)', Gargantuan: 'var(--red)' };
        const catColor = catColors[p.category] || 'var(--muted)';
        
        card.innerHTML = `
          <div class="pet-result-info">
            <div class="pet-result-name">${escapeHtml(p.name)}</div>
            <div class="pet-result-meta">
              <span class="pet-cat-badge" style="background:${catColor}22;color:${catColor};border-color:${catColor}44">
                ${p.category}
              </span>
              <span class="pet-rap">🪙 ${fmt(p.rap || 0)}</span>
            </div>
          </div>
          <button class="pet-add-btn" ${alreadyAdded ? 'disabled' : ''}>
            ${alreadyAdded ? '✓ Added' : '+ Add'}
          </button>
        `;
        
        card.querySelector('.pet-add-btn').addEventListener('click', () => {
            if (alreadyAdded) return;
            addDepositItem(p.name, p.category, p.rap || 0);
        });
        
        el.appendChild(card);
    });
    
    // Przycisk "Gotowe" na dole wyników
    const doneWrap = document.createElement('div');
    doneWrap.className = 'pet-results-done';
    doneWrap.innerHTML = `<button class="pet-done-btn" onclick="closePetResults()">✓ Done</button>`;
    el.appendChild(doneWrap);
}

window.closePetResults = function() {
    document.getElementById('pet-search-results').classList.remove('open');
};

function addDepositItem(name, category, rap) {
    const existing = selectedDepositItems.find(x => x.name === name);
    if (existing) {
        existing.qty = Math.min(existing.qty + 1, 99);
    } else {
        selectedDepositItems.push({ name, category, rap, qty: 1 });
    }
    renderDepositItems();
    renderPetResults(petSearchCache);
}

function renderDepositItems() {
    const list = document.getElementById('deposit-items-list');
    const empty = document.getElementById('deposit-items-empty');
    const totalEl = document.getElementById('deposit-total');
    const totalVal = document.getElementById('deposit-total-value');
    
    list.innerHTML = '';
    
    if (!selectedDepositItems.length) {
        empty.style.display = 'block';
        totalEl.style.display = 'none';
        return;
    }
    
    empty.style.display = 'none';
    totalEl.style.display = 'flex';
    
    let total = 0;
    
    selectedDepositItems.forEach((it, i) => {
        total += it.rap * it.qty;
        const el = document.createElement('div');
        el.className = 'dep-item-row';
        
        const catColors = { Huge: 'var(--gold)', Titanic: 'var(--purple)', Gargantuan: 'var(--red)' };
        const catColor = catColors[it.category] || 'var(--muted)';
        
        el.innerHTML = `
          <div class="dep-item-info">
            <span class="dep-item-name">${escapeHtml(it.name)}</span>
            <span class="dep-item-cat" style="color:${catColor}">${it.category}</span>
            <span class="dep-item-rap">🪙 ${fmt(it.rap)} each</span>
          </div>
          <div class="dep-item-qty-wrap">
            <button class="dep-qty-btn" data-act="minus">−</button>
            <span class="dep-qty-val">${it.qty}</span>
            <button class="dep-qty-btn" data-act="plus">+</button>
          </div>
          <button class="dep-item-del" title="Usuń">✕</button>
        `;
        
        el.querySelector('[data-act="minus"]').addEventListener('click', () => {
            if (it.qty <= 1) {
                selectedDepositItems.splice(i, 1);
            } else {
                it.qty--;
            }
            renderDepositItems();
            renderPetResults(petSearchCache);
        });
        
        el.querySelector('[data-act="plus"]').addEventListener('click', () => {
            if (it.qty < 99) it.qty++;
            renderDepositItems();
        });
        
        el.querySelector('.dep-item-del').addEventListener('click', () => {
            selectedDepositItems.splice(i, 1);
            renderDepositItems();
            renderPetResults(petSearchCache);
        });
        
        list.appendChild(el);
    });
    
    totalVal.textContent = '🪙 ' + fmt(total);
}

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('pet-search');
    if (!searchInput) return;
    
    searchInput.addEventListener('input', () => {
        clearTimeout(petSearchTimer);
        petSearchTimer = setTimeout(() => {
            const q = searchInput.value.trim();
            const activeCat = document.querySelector('.pet-filter.active');
            const cat = activeCat ? activeCat.getAttribute('data-cat') : 'all';
            searchPets(q, cat);
        }, 200);
    });
    
    searchInput.addEventListener('focus', () => {
        if (petSearchCache.length) {
            document.getElementById('pet-search-results').classList.add('open');
        }
    });
    
    // Zamykanie wyników po kliknięciu poza polem wyszukiwania
    document.addEventListener('click', (e) => {
        const wrap = document.querySelector('.pet-search-wrap');
        if (wrap && !wrap.contains(e.target)) {
            document.getElementById('pet-search-results').classList.remove('open');
        }
    });
    
    document.querySelectorAll('.pet-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.pet-filter').forEach(x => x.classList.remove('active'));
            btn.classList.add('active');
            const q = searchInput.value.trim();
            const cat = btn.getAttribute('data-cat');
            searchPets(q, cat);
        });
    });
});

window.submitDepositRequest = async () => {
    try {
        const items = selectedDepositItems.map(it => ({
            name: it.name,
            qty: it.qty
        }));
        const note = document.getElementById('dep-note').value.trim();
        if (!items.length) return alert('Dodaj przynajmniej 1 item.');
        await apiJson('/api/deposit/request', { method: 'POST', body: JSON.stringify({ items, note }) });
        closeDepositModal();
        await refreshDepositTab();
        alert('✅ Zgłoszenie depozytu wysłane! Bot wyceni, admin potwierdzi.');
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

// ── THEME SWITCHER ────────────────────────────────────────────
const THEMES = ['purple','white','black','red','blue','green','yellow'];
const ACCENT_THEMES = ['red','blue','green','yellow'];

// Wczytaj zapisany theme na starcie
(function loadSavedTheme() {
    const saved = localStorage.getItem('bflip-theme');
    if (saved === 'random') {
        // Dla 'random' wylosuj jeden z akcentów przy każdym ładowaniu
        const pick = ACCENT_THEMES[Math.floor(Math.random() * ACCENT_THEMES.length)];
        document.documentElement.setAttribute('data-theme', pick);
        markActiveTheme('random');
    } else if (saved && THEMES.includes(saved)) {
        document.documentElement.setAttribute('data-theme', saved);
        markActiveTheme(saved);
    }
})();

window.setTheme = function(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('bflip-theme', theme);
    markActiveTheme(theme);
    closeThemeMenu();
};

window.randomTheme = function() {
    const pick = ACCENT_THEMES[Math.floor(Math.random() * ACCENT_THEMES.length)];
    document.documentElement.setAttribute('data-theme', pick);
    localStorage.setItem('bflip-theme', 'random');
    markActiveTheme('random');
    closeThemeMenu();
};

window.toggleThemeMenu = function() {
    const menu = document.getElementById('theme-menu');
    menu.classList.toggle('open');
};

function closeThemeMenu() {
    document.getElementById('theme-menu').classList.remove('open');
}

function markActiveTheme(theme) {
    document.querySelectorAll('.theme-opt').forEach(btn => {
        const t = btn.getAttribute('data-theme');
        // Random button nie ma data-theme — sprawdzamy czy theme === 'random'
        if (theme === 'random' && !t) {
            btn.classList.add('active');
        } else {
            btn.classList.toggle('active', t === theme);
        }
    });
}

// Zamykanie theme menu po kliknięciu poza
document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.theme-toggle-wrap');
    if (wrap && !wrap.contains(e.target)) {
        closeThemeMenu();
    }
});

// ── CHAT ────────────────────────────────────────────────────────
let chatMessages = [];
let currentUserId = '';

window.openChat = function() {
    const chatPanel = document.getElementById('chat-panel');
    const isPanelHidden = !chatPanel || chatPanel.offsetParent === null || window.getComputedStyle(chatPanel).display === 'none';
    if (window.innerWidth <= 900 || isPanelHidden) {
        openChatOverlay();
    } else {
        // Desktop: focus input and scroll to bottom
        const input = document.getElementById('chat-input');
        if (input) {
            input.focus();
            scrollChatToBottom();
        }
    }
};

function openChatOverlay() {
    const overlay = document.getElementById('chat-overlay');
    overlay.classList.add('open');
    renderChatMessages(document.getElementById('chat-overlay-msgs'));
    setTimeout(() => {
        const input = document.getElementById('chat-overlay-input');
        if (input) { input.focus(); }
        scrollOverlayToBottom();
    }, 100);
}

window.closeChatOverlay = function() {
    document.getElementById('chat-overlay').classList.remove('open');
};

function scrollChatToBottom() {
    const el = document.getElementById('chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
}

function scrollOverlayToBottom() {
    const el = document.getElementById('chat-overlay-msgs');
    if (el) el.scrollTop = el.scrollHeight;
}

function timeAgoShort(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'teraz';
    if (s < 3600) return `${Math.floor(s/60)}min`;
    if (s < 86400) return `${Math.floor(s/3600)}h`;
    return `${Math.floor(s/86400)}d`;
}

function renderChatMessages(container) {
    if (!container) return;
    if (!chatMessages.length) {
        container.innerHTML = '<div class="chat-empty-msgs"><div class="empty-icon">💬</div><p>Brak wiadomości</p><p>Napisz coś jako pierwszy!</p></div>';
        return;
    }
    let html = '';
    chatMessages.forEach(msg => {
        const isSystem = msg.userId === 'system';
        if (isSystem) {
            html += `<div class="chat-msg"><div class="chat-msg-body"><div class="chat-msg-text system">${escapeHtml(msg.message)}</div></div></div>`;
            return;
        }
        const isMine = msg.userId === currentUserId;
        const avatarHtml = msg.avatarUrl
            ? `<img class="chat-msg-avatar" src="${msg.avatarUrl}" alt="">`
            : `<div class="chat-msg-avatar-empty">?</div>`;
        html += `<div class="chat-msg ${isMine ? 'is-mine' : ''}">
            ${avatarHtml}
            <div class="chat-msg-body">
                <div class="chat-msg-top">
                    <span class="chat-msg-username">${escapeHtml(msg.username)}</span>
                    <span class="chat-msg-time">${timeAgoShort(msg.timestamp)}</span>
                </div>
                <div class="chat-msg-text">${escapeHtml(msg.message)}</div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

function emitChatMessage(text) {
    socket.emit('sendChatMessage', { message: text });
}

window.sendChatMessage = function() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    emitChatMessage(text);
    input.value = '';
};

window.sendChatMessageOverlay = function() {
    const input = document.getElementById('chat-overlay-input');
    const text = input.value.trim();
    if (!text) return;
    emitChatMessage(text);
    input.value = '';
};

// Enter to send
function setupChatEnterHandlers() {
    const input = document.getElementById('chat-input');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
        });
    }
    const overlayInput = document.getElementById('chat-overlay-input');
    if (overlayInput) {
        overlayInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); sendChatMessageOverlay(); }
        });
    }
}
document.addEventListener('DOMContentLoaded', setupChatEnterHandlers);

// Socket handlers
socket.on('chatHistory', (messages) => {
    chatMessages = messages || [];
    
    // Desktop panel
    const desktopMsgs = document.getElementById('chat-messages');
    if (desktopMsgs) {
        desktopMsgs.querySelector('.chat-loading')?.remove();
        renderChatMessages(desktopMsgs);
        scrollChatToBottom();
    }
    
    // Mobile overlay
    const overlayMsgs = document.getElementById('chat-overlay-msgs');
    if (overlayMsgs && document.getElementById('chat-overlay').classList.contains('open')) {
        overlayMsgs.querySelector('.chat-loading')?.remove();
        renderChatMessages(overlayMsgs);
        scrollOverlayToBottom();
    }
});

socket.on('onlineCount', (count) => {
    const el = document.getElementById('chat-online');
    if (el) el.textContent = count + ' online';
});

socket.on('newChatMessage', (msg) => {
    chatMessages.push(msg);
    if (chatMessages.length > 100) chatMessages.shift();
    
    // Build message HTML (used for both desktop and overlay)
    const isSystem = msg.userId === 'system';
    let html;
    if (isSystem) {
        html = `<div class="chat-msg"><div class="chat-msg-body"><div class="chat-msg-text system">${escapeHtml(msg.message)}</div></div></div>`;
    } else {
        const isMine = msg.userId === currentUserId;
        const avatarHtml = msg.avatarUrl
            ? `<img class="chat-msg-avatar" src="${msg.avatarUrl}" alt="">`
            : `<div class="chat-msg-avatar-empty">?</div>`;
        html = `<div class="chat-msg ${isMine ? 'is-mine' : ''}">
            ${avatarHtml}
            <div class="chat-msg-body">
                <div class="chat-msg-top">
                    <span class="chat-msg-username">${escapeHtml(msg.username)}</span>
                    <span class="chat-msg-time">${timeAgoShort(msg.timestamp)}</span>
                </div>
                <div class="chat-msg-text">${escapeHtml(msg.message)}</div>
            </div>
        </div>`;
    }
    
    // Desktop panel
    const desktopMsgs = document.getElementById('chat-messages');
    if (desktopMsgs) {
        desktopMsgs.querySelector('.chat-empty-msgs')?.remove();
        desktopMsgs.insertAdjacentHTML('beforeend', html);
        scrollChatToBottom();
    }
    
    // Mobile overlay
    const overlayMsgs = document.getElementById('chat-overlay-msgs');
    if (overlayMsgs && document.getElementById('chat-overlay').classList.contains('open')) {
        overlayMsgs.querySelector('.chat-empty-msgs')?.remove();
        overlayMsgs.insertAdjacentHTML('beforeend', html);
        scrollOverlayToBottom();
    }
});

// ── CLOSE MODALS ON BACKGROUND CLICK ───────────────────────────
['create-modal','view-modal','result-modal','deposit-modal','withdraw-modal','join-modal','game-info-modal','rules-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', function(e) {
        if (e.target === this) this.style.display = 'none';
    });
});
