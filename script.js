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

// Opcje create game
let currentWildMode = false;
let currentHugeBet = false;

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
function timeAgo(ts, short) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (short) {
        if (s < 60) return 'teraz';
        if (s < 3600) return `${Math.floor(s/60)}min`;
        if (s < 86400) return `${Math.floor(s/3600)}h`;
        return `${Math.floor(s/86400)}d`;
    }
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

window.openProfileModal = async function(userId, username) {
    const modal = document.getElementById('profile-modal');
    const content = document.getElementById('profile-modal-content');
    modal.style.display = 'flex';
    content.innerHTML = '<div class="pm-loading">Ładowanie profilu...</div>';

    try {
        const data = await apiJson('/api/profile/public/' + encodeURIComponent(userId));
        let html = `<div class="pm-header">
            <div class="pm-avatar-wrap">
                ${data.avatarUrl ? `<img class="pm-avatar" src="${data.avatarUrl}" alt="">` : `<div class="pm-avatar pm-avatar-empty">?</div>`}
                <div class="pm-role-badge">${data.role ? roleBadgeHtml(data.role) : ''}</div>
            </div>
            <div class="pm-user-info">
                <span class="pm-username">${escapeHtml(data.username)}</span>
                <div class="pm-level-row">
                    <span class="pm-level-badge ${data.level >= 99 ? 'lvl-mega' : data.level >= 51 ? 'lvl-ultra' : data.level >= 16 ? 'lvl-pro' : data.level >= 1 ? 'lvl-enth' : ''}">
                        ⭐ Lv. ${data.level} — ${data.levelName}
                    </span>
                </div>
            </div>
        </div>`;

        // Stats grid
        const profitClass = data.profit >= 0 ? 'green' : 'red';
        const profitSign = data.profit >= 0 ? '+' : '';
        html += `<div class="pm-stats-grid">
            <div class="pm-stat">
                <span class="pm-stat-val gold">${data.total}</span>
                <span class="pm-stat-label">Gier</span>
            </div>
            <div class="pm-stat">
                <span class="pm-stat-val green">${data.wins}</span>
                <span class="pm-stat-label">Wygrane</span>
            </div>
            <div class="pm-stat">
                <span class="pm-stat-val red">${data.losses}</span>
                <span class="pm-stat-label">Przegrane</span>
            </div>
            <div class="pm-stat">
                <span class="pm-stat-val">${data.total > 0 ? Math.round((data.wins / data.total) * 100) : 0}%</span>
                <span class="pm-stat-label">Win rate</span>
            </div>
        </div>`;

        // Profit row
        html += `<div class="pm-profit-row ${profitClass}">
            <span class="pm-profit-label">Zysk / Strata</span>
            <span class="pm-profit-val">${profitSign}🪙 ${fmt(Math.abs(data.profit))}</span>
        </div>`;

        // Balance + wagered + warnings
        html += `<div class="pm-details">
            <div class="pm-detail-item">
                <span class="pm-detail-icon">💰</span>
                <span class="pm-detail-label">Saldo</span>
                <span class="pm-detail-val gold">🪙 ${fmt(data.balance)}</span>
            </div>
            <div class="pm-detail-item">
                <span class="pm-detail-icon">📊</span>
                <span class="pm-detail-label">Total Wagered</span>
                <span class="pm-detail-val">🪙 ${fmt(data.totalWagered)}</span>
            </div>
            <div class="pm-detail-item">
                <span class="pm-detail-icon">⚠️</span>
                <span class="pm-detail-label">Ostrzeżenia</span>
                <span class="pm-detail-val ${data.warnings > 0 ? 'red' : ''}">${data.warnings}</span>
            </div>
            ${data.createdAt ? `<div class="pm-detail-item">
                <span class="pm-detail-icon">📅</span>
                <span class="pm-detail-label">Gracz od</span>
                <span class="pm-detail-val">${new Date(data.createdAt).toLocaleDateString('pl-PL')}</span>
            </div>` : ''}
        </div>`;

        // Tip section - only if logged in and not yourself
        if (currentUserId && currentUserId !== userId) {
            html += `<div class="pm-tip-section">
                <div class="pm-tip-title">💸 Wyślij tip</div>
                <div class="pm-tip-input-wrap">
                    <input class="pm-tip-input" id="pm-tip-input" type="number" min="1" placeholder="Kwota 🪙" autocomplete="off">
                    <button class="pm-tip-btn" onclick="sendTip('${userId}')">📤 Wyślij</button>
                </div>
                <div id="pm-tip-message" class="pm-tip-message"></div>
            </div>`;
        }

        content.innerHTML = html;
    } catch (e) {
        content.innerHTML = `<div class="pm-error">⚠️ Błąd ładowania profilu: ${escapeHtml(e.message)}</div>`;
    }
};

window.closeProfileModal = function() {
    document.getElementById('profile-modal').style.display = 'none';
};

window.sendTip = async function(userId) {
    const input = document.getElementById('pm-tip-input');
    const msgEl = document.getElementById('pm-tip-message');
    const amount = parseInt(input.value);
    if (!amount || amount < 1) {
        msgEl.textContent = 'Podaj prawidłową kwotę!';
        msgEl.className = 'pm-tip-message error';
        return;
    }
    const btn = document.querySelector('.pm-tip-btn');
    btn.disabled = true;
    btn.textContent = 'Wysyłanie...';
    try {
        const data = await apiJson('/api/profile/' + encodeURIComponent(userId) + '/tip', {
            method: 'POST',
            body: JSON.stringify({ amount })
        });
        if (data.ok) {
            msgEl.textContent = '✅ ' + data.message;
            msgEl.className = 'pm-tip-message success';
            input.value = '';
            // Odśwież profil
            openProfileModal(userId);
        }
    } catch (e) {
        msgEl.textContent = '❌ ' + e.message;
        msgEl.className = 'pm-tip-message error';
    }
    btn.disabled = false;
    btn.textContent = '📤 Wyślij';
};

// Click handler for chat usernames - open profile
// Click handler for usernames - open profile
document.addEventListener('click', function(e) {
    // Chat usernames
    const usernameEl = e.target.closest('.chat-msg-username');
    if (usernameEl) {
        const username = usernameEl.textContent.trim();
        const msg = chatMessages.find(m => m.username === username);
        if (msg && msg.userId && msg.userId !== 'system') {
            e.preventDefault();
            openProfileModal(msg.userId, msg.username);
        }
        return;
    }
    
    // Leaderboard usernames
    const lbNameEl = e.target.closest('.lb-player-col') || e.target.closest('.lb-name');
    if (lbNameEl) {
        const lbRow = lbNameEl.closest('.lb-row');
        if (lbRow) {
            const nameEl = lbRow.querySelector('.lb-name');
            const rankEl = lbRow.querySelector('.lb-rank');
            if (nameEl) {
                const username = nameEl.textContent.trim();
                // Fetch leaderboard data to get userId
                // We need to get the robloxId from the leaderboard data
                const lbData = window._lastLeaderboard || [];
                const player = lbData.find(p => p.username === username);
                if (player && player.robloxId) {
                    e.preventDefault();
                    openProfileModal(player.robloxId, player.username);
                }
            }
        }
        return;
    }
});

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
    // Update balance display
    if (data.coins !== undefined) {
        document.getElementById('balance-amount').textContent = fmt(data.coins);
    }
    refreshProfileStats();
    refreshLevel();
    socket.emit('getHistory');
    socket.emit('getChatHistory');
    socket.emit('getRecentGames');
    showTab('dashboard');
    refreshDashboard();
    // online count
    socket.emit('countOnline');
});

// Update balance on playerListUpdate (after bets, tips, etc.)
socket.on('playerListUpdate', async () => {
    // Refresh balance from API
    try {
        const stats = await apiJson('/api/profile/stats');
        const balanceEl = document.getElementById('balance-amount');
        if (balanceEl && stats.coins !== undefined) {
            balanceEl.textContent = fmt(stats.coins);
        }
        // Also update dashboard if visible
        const dashTab = document.getElementById('tab-dashboard');
        if (dashTab && dashTab.style.display !== 'none') {
            refreshDashboard();
        }
    } catch (e) {}
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
let _lastLeaderboard = [];
window._lastLeaderboard = [];

window.fetchLeaderboard = async function() {
    const lbList = document.getElementById('lb-list');
    if (!lbList) return;
    try {
        const data = await apiJson('/api/leaderboard');
        const players = data.leaderboard || [];
        window._lastLeaderboard = players;
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

// ── SIDEBAR / CHAT COLLAPSE ───────────────────────────────────
window.toggleSidebar = function() {
    const layout = document.querySelector('.app-layout');
    if (!layout) return;
    layout.classList.toggle('sidebar-collapsed');
    const btn = document.querySelector('.sidebar-collapse-btn');
    if (btn) {
        btn.textContent = layout.classList.contains('sidebar-collapsed') ? '▶' : '◀';
        btn.title = layout.classList.contains('sidebar-collapsed') ? 'Rozwiń sidebar' : 'Zwiń sidebar';
    }
};

window.toggleChat = function() {
    const layout = document.querySelector('.app-layout');
    if (!layout) return;
    layout.classList.toggle('chat-collapsed');
    const btn = document.querySelector('.chat-collapse-btn');
    if (btn) {
        btn.textContent = layout.classList.contains('chat-collapsed') ? '◀' : '▶';
        btn.title = layout.classList.contains('chat-collapsed') ? 'Otwórz czat' : 'Zwiń czat';
    }
};

// ── DASHBOARD ────────────────────────────────────────────────
window.refreshDashboard = async function() {
    try {
        const stats = await apiJson('/api/profile/stats');
        const { total = 0, wins = 0, losses = 0, profit = 0 } = stats;
        const balanceEl = document.getElementById('balance-amount');
        document.getElementById('dash-balance').textContent = balanceEl ? (balanceEl.textContent || '—') : '—';
        document.getElementById('dash-games').textContent = total;
        document.getElementById('dash-wins').textContent = wins;
        document.getElementById('dash-losses').textContent = losses;
        const profitRow = document.getElementById('dash-profit-row');
        const profitEl = document.getElementById('dash-profit');
        const sign = profit >= 0 ? '+' : '';
        profitEl.textContent = sign + '🪙 ' + fmt(Math.abs(profit));
        profitRow.className = 'dash-profit-row ' + (profit >= 0 ? 'green' : 'red');
    } catch (e) {}
    
    // Server stats from DOM (populated by socket events)
    const onlineEl = document.getElementById('chat-online');
    if (onlineEl) {
        const el = document.getElementById('dash-online');
        if (el) el.textContent = onlineEl.textContent.replace(/[^0-9]/g, '') || '0';
    }
    const countEl = document.getElementById('lobby-count');
    if (countEl) {
        const el = document.getElementById('dash-active-games');
        if (el) el.textContent = parseInt(countEl.textContent) || '0';
    }
};

// Socket listeners for real-time dashboard server stats
socket.on('onlineCount', (count) => {
    const el = document.getElementById('chat-online');
    if (el) el.textContent = count + ' online';
    const dashEl = document.getElementById('dash-online');
    if (dashEl) dashEl.textContent = String(count);
});

socket.on('gamesList', (games) => {
    const el = document.getElementById('dash-active-games');
    if (el) el.textContent = String(games.length);
});

function updateDashFeed(games) {
    const scrollEl = document.getElementById('dash-feed-scroll');
    const countEl = document.getElementById('dash-feed-count');
    if (!scrollEl) return;
    if (countEl) countEl.textContent = games?.length || '0';
    if (!games || !games.length) {
        scrollEl.innerHTML = '<div class="dash-feed-empty">Brak ostatnich gier. Zagraj pierwszą!</div>';
        return;
    }
    let html = '';
    games.forEach(g => {
        const timeStr = timeAgo(g.timestamp, true);
        const isHouse = g.winner === 'House' || g.loser === 'House';
        html += `<div class="dash-feed-item">
            <span class="dash-feed-time">${timeStr}</span>
            <span class="dash-feed-icon">${isHouse ? '⚡' : '⚔️'}</span>
            <div class="dash-feed-players">
                <span class="dash-feed-winner">${escapeHtml(g.winner || '?')}</span>
                <span class="dash-feed-vs">vs</span>
                <span class="dash-feed-loser">${escapeHtml(g.loser || '?')}</span>
            </div>
            <span class="dash-feed-amount">🪙 ${fmt(g.amount || 0)}</span>
        </div>`;
    });
    scrollEl.innerHTML = html;
    scrollEl.scrollTop = 0;
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
    if (tab === 'dashboard') refreshDashboard();
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

window.toggleCreateOption = (opt) => {
    if (opt === 'wild') {
        currentWildMode = !currentWildMode;
        document.getElementById('opt-wild').classList.toggle('active', currentWildMode);
    } else if (opt === 'hugebet') {
        currentHugeBet = !currentHugeBet;
        document.getElementById('opt-hugebet').classList.toggle('active', currentHugeBet);
        if (currentHugeBet) {
            // Filtruj itemy — usuń wszystko co nie jest Titanic/Gargantuan/Gem
            createSelectedItems = createSelectedItems.filter(it => {
                const name = it.name.toLowerCase();
                return name.includes('titanic') || name.includes('gargantuan') || name.startsWith('gem 💎');
            });
        }
        renderCreateItemPicker();
    }
};

window.openCreateModal = async () => {
    createSelectedItems = [];
    currentWildMode = false;
    currentHugeBet = false;
    // Resetuj wizualnie przyciski
    const wildBtn = document.getElementById('opt-wild');
    const hugeBtn = document.getElementById('opt-hugebet');
    if (wildBtn) wildBtn.classList.remove('active');
    if (hugeBtn) hugeBtn.classList.remove('active');
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

    let filteredInventory = myInventoryRAP;
    if (currentHugeBet) {
        filteredInventory = myInventoryRAP.filter(it => {
            const name = it.name.toLowerCase();
            return name.includes('titanic') || name.includes('gargantuan') || name.startsWith('gem 💎');
        });
    }

    if (!filteredInventory.length) {
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

    filteredInventory.forEach(it => {
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
    socket.emit('createGame', {
        items,
        side: currentSide,
        wildMode: currentWildMode,
        hugeBet: currentHugeBet
    });
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

        // Badge dla trybów
        let modeBadges = '';
        if (g.wildMode) modeBadges += '<span class="gc-mode-badge wild">🔄 Wild</span>';
        if (g.hugeBet) modeBadges += '<span class="gc-mode-badge hugebet">🔥 Huge BET</span>';

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
            ${modeBadges ? `<div class="gc-mode-badges-row">${modeBadges}</div>` : ''}
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

    let filteredInventory = myInventoryRAP;
    if (joinGameTarget && joinGameTarget.hugeBet) {
        filteredInventory = myInventoryRAP.filter(it => {
            const name = it.name.toLowerCase();
            return name.includes('titanic') || name.includes('gargantuan') || name.startsWith('gem 💎');
        });
        // Also filter out already selected items that don't match
        joinSelectedItems = joinSelectedItems.filter(it => {
            const name = it.name.toLowerCase();
            return name.includes('titanic') || name.includes('gargantuan') || name.startsWith('gem 💎');
        });
    }

    if (!filteredInventory.length) {
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

    // Badge dla trybów
    let modeBadgeHtml = '';
    if (g.wildMode) modeBadgeHtml += '<span class="gc-mode-badge wild">🔄 Wild</span>';
    if (g.hugeBet) modeBadgeHtml += '<span class="gc-mode-badge hugebet">🔥 Huge BET</span>';
    document.getElementById('view-mode-badges').innerHTML = modeBadgeHtml;
    document.getElementById('view-mode-badges').style.display = modeBadgeHtml ? 'flex' : 'none';

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
        
        const catColors = { Huge: 'var(--gold)', Titanic: 'var(--purple)', Gargantuan: 'var(--red)', Gem: '#00e5ff' };
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
        
        const catColors = { Huge: 'var(--gold)', Titanic: 'var(--purple)', Gargantuan: 'var(--red)', Gem: '#00e5ff' };
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



function roleBadgeHtml(role) {
    const labels = { helper:'Helper', mod:'Mod', smod:'SMod', owner:'Owner' };
    const label = labels[role] || role;
    return `<span class="role-badge role-${escapeHtml(role)}">${label}</span>`;
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
        const roleBadge = msg.role ? roleBadgeHtml(msg.role) : '';
        html += `<div class="chat-msg ${isMine ? 'is-mine' : ''}">
            ${avatarHtml}
            <div class="chat-msg-body">
                <div class="chat-msg-top">
                    <span class="chat-msg-username">${escapeHtml(msg.username)}</span>
                    ${roleBadge}
                    <span class="chat-msg-time">${timeAgo(msg.timestamp, true)}</span>
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
        const roleBadge = msg.role ? roleBadgeHtml(msg.role) : '';
        html = `<div class="chat-msg ${isMine ? 'is-mine' : ''}">
            ${avatarHtml}
            <div class="chat-msg-body">
                <div class="chat-msg-top">
                    <span class="chat-msg-username">${escapeHtml(msg.username)}</span>
                    ${roleBadge}
                    <span class="chat-msg-time">${timeAgo(msg.timestamp, true)}</span>
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

// ── LIVE FEED ────────────────────────────────────────────────
function renderRecentGames(games) {
    const scrollEl = document.getElementById('live-feed-scroll');
    const countEl = document.getElementById('live-feed-count');
    if (!scrollEl) return;
    
    if (countEl) {
        countEl.textContent = games.length + ' ostatnich';
    }
    
    if (!games.length) {
        scrollEl.innerHTML = '<div class="live-feed-empty">Brak ostatnich gier. Zagraj pierwszą!</div>';
        return;
    }
    
    let html = '';
    games.forEach((g, i) => {
        const timeStr = timeAgo(g.timestamp, true);
        const isHouse = g.winner === 'House' || g.loser === 'House';
        
        html += `<div class="lf-item">
            <span class="lf-time">${timeStr}</span>
            <span class="lf-icon">${isHouse ? '⚡' : '⚔️'}</span>
            <div class="lf-players">
                <span class="lf-winner ${g.winner === 'House' ? 'lf-house' : ''}">${escapeHtml(g.winner)}</span>
                <span class="lf-vs">vs</span>
                <span class="lf-loser ${g.loser === 'House' ? 'lf-house' : ''}">${escapeHtml(g.loser)}</span>
            </div>
            <span class="lf-amount">🪙 ${fmt(g.amount)}</span>
        </div>`;
    });
    
    scrollEl.innerHTML = html;
    
    // Auto-scroll to top to show newest
    scrollEl.scrollTop = 0;
}

// Socket listener for real-time updates
socket.on('recentGamesUpdated', (games) => {
    renderRecentGames(games || []);
    // Only update dashboard feed if dashboard tab is visible
    const dashTab = document.getElementById('tab-dashboard');
    if (dashTab && dashTab.style.display !== 'none') {
        updateDashFeed(games || []);
    }
});

// ── SYSTEM MESSAGE TOAST ────────────────────────────────────────
socket.on('systemMessage', (msg) => {
    // Usuń stary toast jeśli istnieje
    const old = document.getElementById('sys-toast');
    if (old) old.remove();
    
    const toast = document.createElement('div');
    toast.id = 'sys-toast';
    toast.innerHTML = `
        <div class="sys-toast-icon">📢</div>
        <div class="sys-toast-body">
            <div class="sys-toast-title">Ogłoszenie serwera</div>
            <div class="sys-toast-text">${escapeHtml(msg.message)}</div>
        </div>
        <button class="sys-toast-close" onclick="this.parentElement.remove()">✕</button>
    `;
    document.body.appendChild(toast);
    
    // Auto-usuń po 15 sekundach
    setTimeout(() => {
        const t = document.getElementById('sys-toast');
        if (t) t.remove();
    }, 15000);
});

// ── PROVABLY FAIR ────────────────────────────────────────────
let lastProvablyFairData = null;

// Socket: odbierz dane Provably Fair po grze
socket.on('provablyFairResult', (data) => {
    lastProvablyFairData = data;
    console.log('[PF] Otrzymano dane Provably Fair dla gry', data.gameId);
});

window.openProvablyFair = async function() {
    const modal = document.getElementById('pf-modal');
    modal.style.display = 'flex';
    
    // Wczytaj status seedów
    const statusEl = document.getElementById('pf-status');
    statusEl.innerHTML = '<div class="pf-loading">Ładowanie...</div>';
    
    try {
        const data = await apiJson('/api/provably-fair/status');
        statusEl.innerHTML = `
            <div class="pf-status-item">
                <span class="pf-status-label">Server Seed Hash</span>
                <code class="pf-status-hash">${escapeHtml(data.serverSeedHash)}</code>
            </div>
            <div class="pf-status-item">
                <span class="pf-status-label">Client Seed</span>
                <code class="pf-status-hash">${escapeHtml(data.clientSeed)}</code>
            </div>
            <div class="pf-status-item">
                <span class="pf-status-label">Nonce</span>
                <span class="pf-status-val">${data.nonce}</span>
            </div>
            ${data.hasPreviousSeed ? '<div class="pf-status-item"><span class="pf-status-label">Poprzedni seed</span><span class="pf-status-val green">✅ Dostępny do weryfikacji</span></div>' : ''}
        `;
        
        // Uzupełnij client seed input
        document.getElementById('pf-client-seed-input').value = data.clientSeed;
    } catch (e) {
        statusEl.innerHTML = `<div class="pf-error">⚠️ Błąd: ${escapeHtml(e.message)}</div>`;
    }
};

window.closeProvablyFair = function() {
    document.getElementById('pf-modal').style.display = 'none';
};

window.changeClientSeed = async function() {
    const input = document.getElementById('pf-client-seed-input');
    const status = document.getElementById('pf-client-seed-status');
    const clientSeed = input.value.trim();
    
    if (!clientSeed || clientSeed.length < 4) {
        status.textContent = 'Client seed musi mieć co najmniej 4 znaki.';
        status.className = 'pf-client-status error';
        return;
    }
    
    const btn = document.querySelector('#pf-client-seed-row .pf-btn');
    if (btn) btn.disabled = true;
    
    try {
        const data = await apiJson('/api/provably-fair/client-seed', {
            method: 'POST',
            body: JSON.stringify({ clientSeed })
        });
        if (data.ok) {
            status.textContent = '✅ Client seed zmieniony! Nonce zresetowany do 0.';
            status.className = 'pf-client-status success';
            // Odśwież status
            window.openProvablyFair();
        }
    } catch (e) {
        status.textContent = '❌ ' + e.message;
        status.className = 'pf-client-status error';
    }
    
    if (btn) btn.disabled = false;
};

window.rotateServerSeed = async function() {
    const status = document.getElementById('pf-rotate-status');
    status.textContent = 'Rotacja...';
    status.className = 'pf-client-status';
    
    const btn = document.querySelector('#pf-rotate-status + .pf-btn, .pf-section .pf-btn-secondary');
    
    try {
        const data = await apiJson('/api/provably-fair/rotate', {
            method: 'POST'
        });
        if (data.ok) {
            status.innerHTML = `✅ Server seed wyrotowany!<br><small>Nowy hash: <code>${escapeHtml(data.serverSeedHash.slice(0, 20))}...</code></small>`;
            status.className = 'pf-client-status success';
            // Odśwież status
            window.openProvablyFair();
        }
    } catch (e) {
        status.textContent = '❌ ' + e.message;
        status.className = 'pf-client-status error';
    }
};

window.verifyProvablyFair = async function() {
    const serverSeed = document.getElementById('pf-verify-server-seed').value.trim();
    const clientSeed = document.getElementById('pf-verify-client-seed').value.trim();
    const nonce = parseInt(document.getElementById('pf-verify-nonce').value) || 0;
    const expectedResult = document.getElementById('pf-verify-result').value;
    const resultEl = document.getElementById('pf-verify-result-container') || document.getElementById('pf-verify-result');
    
    if (!serverSeed || !clientSeed) {
        resultEl.innerHTML = '<div class="pf-verify-msg error">⚠️ Wpisz Server Seed i Client Seed.</div>';
        return;
    }
    
    resultEl.innerHTML = '<div class="pf-verify-msg">Weryfikacja...</div>';
    
    try {
        const body = { previousServerSeed: serverSeed, clientSeed, nonce };
        if (expectedResult) body.expectedResult = expectedResult;
        
        const data = await apiJson('/api/provably-fair/verify', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        
        if (data.verified) {
            resultEl.innerHTML = `
                <div class="pf-verify-msg success">
                    <strong>✅ Zweryfikowano!</strong><br>
                    Wynik: <strong>${data.result === 'heads' ? 'ORZEŁ' : 'RESZKA'}</strong><br>
                    HMAC: <code>${escapeHtml(data.hmac.slice(0, 20))}...</code>
                </div>`;
        } else {
            resultEl.innerHTML = `
                <div class="pf-verify-msg error">
                    <strong>❌ Nie zgadza się!</strong><br>
                    Otrzymano: ${data.result === 'heads' ? 'ORZEŁ' : 'RESZKA'}<br>
                    ${data.expectedResult ? `Oczekiwano: ${data.expectedResult === 'heads' ? 'ORZEŁ' : 'RESZKA'}` : ''}<br>
                    ${data.message || ''}
                </div>`;
        }
    } catch (e) {
        resultEl.innerHTML = `<div class="pf-verify-msg error">❌ ${escapeHtml(e.message)}</div>`;
    }
};

window.autoVerifyLastGame = async function() {
    const resultEl = document.getElementById('pf-verify-result');
    
    if (!lastProvablyFairData) {
        resultEl.innerHTML = '<div class="pf-verify-msg error">⚠️ Brak danych z ostatniej gry. Zagraj najpierw w coinflip.</div>';
        return;
    }
    
    // Uzupełnij formularz danymi z ostatniej gry
    document.getElementById('pf-verify-server-seed').value = lastProvablyFairData.serverSeed || '';
    document.getElementById('pf-verify-client-seed').value = lastProvablyFairData.clientSeed || '';
    document.getElementById('pf-verify-nonce').value = lastProvablyFairData.nonce || 0;
    document.getElementById('pf-verify-result').value = lastProvablyFairData.result || '';
    
    // Automatycznie kliknij weryfikację
    resultEl.innerHTML = '<div class="pf-verify-msg">Auto-weryfikacja...</div>';
    
    try {
        const body = {
            previousServerSeed: lastProvablyFairData.serverSeed,
            clientSeed: lastProvablyFairData.clientSeed,
            nonce: lastProvablyFairData.nonce
        };
        if (lastProvablyFairData.result) body.expectedResult = lastProvablyFairData.result;
        
        const data = await apiJson('/api/provably-fair/verify', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        
        // Najpierw sprawdź hash server seeda lokalnie
        const serverSeedHash = await sha256Local(lastProvablyFairData.serverSeed);
        const hashMatch = serverSeedHash === lastProvablyFairData.serverSeedHash;
        
        if (data.verified && hashMatch) {
            resultEl.innerHTML = `
                <div class="pf-verify-msg success">
                    <strong>✅ Gra w pełni zweryfikowana!</strong><br>
                    • Hash server seeda się zgadza ✅<br>
                    • Wynik: <strong>${data.result === 'heads' ? 'ORZEŁ' : 'RESZKA'}</strong> — zgodny z seedami ✅<br>
                    • Nonce: ${data.nonce}<br>
                    • HMAC: <code>${escapeHtml(data.hmac.slice(0, 24))}...</code>
                </div>`;
        } else if (data.verified && !hashMatch) {
            resultEl.innerHTML = `
                <div class="pf-verify-msg warning">
                    ⚠️ Wynik się zgadza, ale hash server seeda NIE pasuje do zapisanego!<br>
                    Oczekiwany hash: <code>${escapeHtml(lastProvablyFairData.serverSeedHash)}</code><br>
                    Obliczony hash: <code>${escapeHtml(serverSeedHash)}</code><br>
                    To może oznaczać manipulację seedem!
                </div>`;
        } else {
            resultEl.innerHTML = `
                <div class="pf-verify-msg error">
                    <strong>❌ Nie zgadza się!</strong><br>
                    Otrzymano: ${data.result === 'heads' ? 'ORZEŁ' : 'RESZKA'}<br>
                    ${data.message || ''}
                </div>`;
        }
    } catch (e) {
        resultEl.innerHTML = `<div class="pf-verify-msg error">❌ ${escapeHtml(e.message)}</div>`;
    }
};

// Lokalne SHA-256 do weryfikacji hasha po stronie klienta
async function sha256Local(data) {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── MERGE GEMÓW ──────────────────────────────────────────────
window.openMergeModal = async function() {
    const modal = document.getElementById('merge-modal');
    const content = document.getElementById('merge-content');
    modal.style.display = 'flex';
    content.innerHTML = '<div class="merge-loading">Ładowanie inventarza...</div>';
    try {
        const data = await apiJson('/api/inventory', { method: 'GET' });
        const items = data.items || [];
        const gems = items.filter(it => it.name.startsWith('Gem 💎'));
        
        if (!gems.length) {
            content.innerHTML = '<div class="merge-empty"><div class="empty-icon">💎</div><p>Nie masz żadnych gemów w inventarzu!</p><p class="empty-sub">Poproś admina o dodanie gemów.</p></div>';
            return;
        }
        
        // Recipe list
        const recipes = [
            { in: 'Gem 💎 1M', inQty: 10, out: 'Gem 💎 10M', outQty: 1, idx: 0 },
            { in: 'Gem 💎 10M', inQty: 5, out: 'Gem 💎 25M', outQty: 2, idx: 1 },
            { in: 'Gem 💎 25M', inQty: 2, out: 'Gem 💎 50M', outQty: 1, idx: 2 },
            { in: 'Gem 💎 50M', inQty: 2, out: 'Gem 💎 100M', outQty: 1, idx: 3 },
            { in: 'Gem 💎 100M', inQty: 5, out: 'Gem 💎 500M', outQty: 1, idx: 4 },
        ];
        
        let html = '<div class="merge-gems-list">';
        html += '<div class="merge-intro">Połącz niższe gemy w wyższe:</div>';
        
        recipes.forEach(r => {
            const have = gems.find(g => g.name === r.in);
            const haveQty = have ? have.qty : 0;
            const canAfford = haveQty >= r.inQty;
            html += `<div class="merge-recipe ${canAfford ? 'can-merge' : ''}">
                <div class="merge-recipe-info">
                    <div class="merge-recipe-input">
                        <span class="merge-qty">${r.inQty}x</span>
                        <span class="merge-name">${r.in}</span>
                        <span class="merge-have ${canAfford ? 'have-enough' : 'have-not'}">(Masz: ${haveQty})</span>
                    </div>
                    <div class="merge-arrow">→</div>
                    <div class="merge-recipe-output">
                        <span class="merge-qty">${r.outQty}x</span>
                        <span class="merge-name">${r.out}</span>
                    </div>
                </div>
                <button class="merge-btn" ${canAfford ? `onclick="doMerge(${r.idx})"` : 'disabled'}>${canAfford ? 'Połącz' : '❌'}</button>
            </div>`;
        });
        
        html += '</div>';
        html += '<div id="merge-message" class="merge-message"></div>';
        content.innerHTML = html;
    } catch (e) {
        content.innerHTML = `<div class="merge-empty"><div class="empty-icon">⚠️</div><p>Błąd: ${escapeHtml(e.message)}</p></div>`;
    }
};

window.closeMergeModal = function() {
    document.getElementById('merge-modal').style.display = 'none';
};

window.doMerge = async function(recipeIdx) {
    const msgEl = document.getElementById('merge-message');
    if (!msgEl) return;
    msgEl.textContent = 'Łączenie...';
    msgEl.className = 'merge-message';
    try {
        const data = await apiJson('/api/gems/merge', {
            method: 'POST',
            body: JSON.stringify({ recipe: recipeIdx })
        });
        if (data.ok) {
            msgEl.textContent = '✅ ' + data.message;
            msgEl.className = 'merge-message success';
            // Odśwież
            setTimeout(() => openMergeModal(), 1200);
        }
    } catch (e) {
        msgEl.textContent = '❌ ' + e.message;
        msgEl.className = 'merge-message error';
    }
};

// Add merge button to deposit tab
function renderInventory() {
    if (!inventoryListEl) return;
    inventoryListEl.innerHTML = '';
    const items = myInventory || [];
    inventoryEmptyEl.style.display = items.length ? 'none' : 'block';
    items.forEach(it => {
        const isGem = it.name.startsWith('Gem 💎');
        const el = document.createElement('div');
        el.className = 'inv-item' + (isGem ? ' inv-item-gem' : '');
        el.innerHTML = `
          <div class="inv-name">${escapeHtml(it.name)}</div>
          <div class="inv-qty">x ${fmt(it.qty)}</div>
        `;
        inventoryListEl.appendChild(el);
    });
    
    // Add merge button if user has gems (only once)
    if (items.some(it => it.name.startsWith('Gem 💎'))) {
        if (!inventoryListEl.parentElement.querySelector('.merge-inv-btn')) {
            const mergeBtn = document.createElement('button');
            mergeBtn.className = 'merge-inv-btn';
            mergeBtn.innerHTML = '💎 Merge gemów';
            mergeBtn.onclick = openMergeModal;
            inventoryListEl.parentElement.appendChild(mergeBtn);
        }
    }
}

// ── CLOSE MODALS ON BACKGROUND CLICK ───────────────────────────
['create-modal','view-modal','result-modal','deposit-modal','withdraw-modal','join-modal','game-info-modal','rules-modal','profile-modal','merge-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', function(e) {
        if (e.target === this) this.style.display = 'none';
    });
});
