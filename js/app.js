/**
 * BFLIP — Core App
 * Socket connection, session management, tabs, dashboard, sidebar, theme, stats/level
 */

"use strict";

// ── Socket ──────────────────────────────────────────────────
const socket = io();

// ── Global state ────────────────────────────────────────────
let currentUsername = '';
let currentAvatar   = '';
let currentRobloxId = '';
let currentUserId   = '';
let currentSide     = 'heads';
let lobbyGames      = [];
let viewingGameId   = null;
const FLIP_MS       = 2200;

let myInventory = [];
let myRequests  = [];
let withdrawSelection = new Map();
let myInventoryRAP = [];
let createSelectedItems = [];
let currentWildMode = false;
let currentHugeBet = false;
let joinSelectedItems = [];
let lastFlipData = null;
let lastResultData = null;
let chatMessages = [];
let petSearchCache = [];
let petSearchTimer = null;
let selectedDepositItems = [];
let jackpotSelectedItems = [];
let jackpotInventoryRAP = [];
let lastProvablyFairData = null;
let _lastLeaderboard = [];
window._lastLeaderboard = [];
let currentSidebarTab = 'leaderboard';
let currentSubtab = 'lobby';

// ── DOM refs ────────────────────────────────────────────────
const loginOverlay    = document.getElementById('login-overlay');
const sidebarAvatar   = document.getElementById('sidebar-avatar');
const sidebarUsername = document.getElementById('sidebar-username');
const sidebarUser     = document.getElementById('sidebar-user');
const logoutBtn       = document.getElementById('logout-btn');
const gamesList       = document.getElementById('games-list');
const lobbyCount      = document.getElementById('lobby-count');
const historyWrap     = document.getElementById('history-table-wrap');
const historySummary  = document.getElementById('history-summary');
const inventoryListEl  = document.getElementById('inventory-list');
const inventoryEmptyEl = document.getElementById('inventory-empty');
const requestsListEl   = document.getElementById('requests-list');
const requestsEmptyEl  = document.getElementById('requests-empty');

// ── Session check ──────────────────────────────────────────
socket.emit('checkSession');

// ── Profile Modal ──────────────────────────────────────────
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
                    <span class="pm-level-badge ${data.level >= 99 ? 'lvl-mega' : data.level >= 50 ? 'lvl-ultra' : data.level >= 11 ? 'lvl-pro' : data.level >= 1 ? 'lvl-enth' : ''}">
                        ⭐ Lv. ${data.level} — ${data.levelName}
                    </span>
                </div>
            </div>
        </div>`;
        const profitClass = data.profit >= 0 ? 'green' : 'red';
        const profitSign = data.profit >= 0 ? '+' : '';
        html += `<div class="pm-stats-grid">
            <div class="pm-stat"><span class="pm-stat-val gold">${data.total}</span><span class="pm-stat-label">Gier</span></div>
            <div class="pm-stat"><span class="pm-stat-val green">${data.wins}</span><span class="pm-stat-label">Wygrane</span></div>
            <div class="pm-stat"><span class="pm-stat-val red">${data.losses}</span><span class="pm-stat-label">Przegrane</span></div>
            <div class="pm-stat"><span class="pm-stat-val">${data.total > 0 ? Math.round((data.wins / data.total) * 100) : 0}%</span><span class="pm-stat-label">Win rate</span></div>
        </div>`;
        html += `<div class="pm-profit-row ${profitClass}"><span class="pm-profit-label">Zysk / Strata</span><span class="pm-profit-val">${profitSign}🪙 ${fmt(Math.abs(data.profit))}</span></div>`;
        html += `<div class="pm-details">
            <div class="pm-detail-item"><span class="pm-detail-icon">💰</span><span class="pm-detail-label">Saldo</span><span class="pm-detail-val gold">🪙 ${fmt(data.balance)}</span></div>
            <div class="pm-detail-item"><span class="pm-detail-icon">📊</span><span class="pm-detail-label">Total Wagered</span><span class="pm-detail-val">🪙 ${fmt(data.totalWagered)}</span></div>
            <div class="pm-detail-item"><span class="pm-detail-icon">⚠️</span><span class="pm-detail-label">Ostrzeżenia</span><span class="pm-detail-val ${data.warnings > 0 ? 'red' : ''}">${data.warnings}</span></div>
            ${data.createdAt ? `<div class="pm-detail-item"><span class="pm-detail-icon">📅</span><span class="pm-detail-label">Gracz od</span><span class="pm-detail-val">${new Date(data.createdAt).toLocaleDateString('pl-PL')}</span></div>` : ''}
        </div>`;
        if (currentUserId && currentUserId !== userId) {
            html += `<div class="pm-tip-section"><div class="pm-tip-title">💸 Wyślij tip</div>
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
    if (!amount || amount < 1) { msgEl.textContent = 'Podaj prawidłową kwotę!'; msgEl.className = 'pm-tip-message error'; return; }
    const btn = document.querySelector('.pm-tip-btn');
    btn.disabled = true;
    btn.textContent = 'Wysyłanie...';
    try {
        const data = await apiJson('/api/profile/' + encodeURIComponent(userId) + '/tip', { method: 'POST', body: JSON.stringify({ amount }) });
        if (data.ok) { msgEl.textContent = '✅ ' + data.message; msgEl.className = 'pm-tip-message success'; input.value = ''; openProfileModal(userId); }
    } catch (e) { msgEl.textContent = '❌ ' + e.message; msgEl.className = 'pm-tip-message error'; }
    btn.disabled = false;
    btn.textContent = '📤 Wyślij';
};

// ── Leaderboard ──────────────────────────────────────────
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
            const medalEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
            html += `<div class="lb-row ${isMe ? 'lb-me' : ''}">
                <span class="lb-rank">${medalEmoji || rank}</span>
                <div class="lb-player-col">${avatarHtml}<span class="lb-name">${escapeHtml(p.username)}</span></div>
                <span class="lb-stat">${p.wins + p.losses}</span>
                <span class="lb-stat green">${p.wins}</span>
                <span class="lb-stat red">${p.losses}</span>
                <span class="lb-stat ${p.profit >= 0 ? 'profit-plus' : 'profit-minus'}">${p.profit >= 0 ? '+' : ''}🪙 ${fmt(Math.abs(p.profit))}</span>
            </div>`;
        });
        html += '</div>';
        lbList.innerHTML = html;
    } catch (e) {
        lbList.innerHTML = '<div class="empty-lobby"><div class="empty-icon">⚠️</div><p>Błąd ładowania leaderboardu</p></div>';
    }
};

// ── Profile/Stats ──────────────────────────────────────────
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
        badge.className = 'level-badge';
        if (level >= 99) badge.classList.add('lvl-mega');
        else if (level >= 50) badge.classList.add('lvl-ultra');
        else if (level >= 11) badge.classList.add('lvl-pro');
        else if (level >= 1) badge.classList.add('lvl-enth');
    } catch (e) { /* cicho */ }
};

// ── Tab system ─────────────────────────────────────────────
window.showTab = function(tab) {
    currentSidebarTab = tab;
    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
    document.getElementById('tab-' + tab).style.display = 'block';
    document.querySelectorAll('.sidebar-tab').forEach((el) => {
        const t = el.getAttribute('data-tab');
        el.classList.toggle('active', t === tab);
    });
    const subtabs = document.getElementById('coinflip-subtabs');
    if (tab === 'coinflip') {
        subtabs.style.display = 'flex';
        showCoinflipSubtab(currentSubtab);
    } else {
        subtabs.style.display = 'none';
    }
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

// ── Dashboard ──────────────────────────────────────────────
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
    } catch (e) { console.warn('Dashboard refresh error:', e.message); }
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

// ── Live Feed (recent games) ────────────────────────────────
function renderRecentGames(games) {
    const scrollEl = document.getElementById('live-feed-scroll');
    const countEl = document.getElementById('live-feed-count');
    if (!scrollEl) return;
    if (countEl) countEl.textContent = games.length + ' ostatnich';
    if (!games.length) {
        scrollEl.innerHTML = '<div class="live-feed-empty">Brak ostatnich gier. Zagraj pierwszą!</div>';
        return;
    }
    let html = '';
    games.forEach((g) => {
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
    scrollEl.scrollTop = 0;
}

// ── Sidebar / Chat collapse ────────────────────────────────
window.toggleSidebar = function() {
    if (window.innerWidth <= 900) {
        const overlay = document.getElementById('sidebar-overlay');
        const sidebar = document.getElementById('sidebar');
        if (overlay) {
            const isOpen = overlay.classList.contains('open');
            overlay.classList.toggle('open');
            if (sidebar) sidebar.classList.toggle('mobile-open');
            document.body.classList.toggle('sidebar-mobile-open');
            const btn = document.querySelector('.sidebar-collapse-btn');
            if (btn) {
                btn.textContent = isOpen ? '◀' : '✕';
                btn.title = isOpen ? 'Zwiń sidebar' : 'Zamknij';
            }
        }
        return;
    }
    const layout = document.querySelector('.app-layout');
    if (!layout) return;
    layout.classList.toggle('sidebar-collapsed');
    const btn = document.querySelector('.sidebar-collapse-btn');
    if (btn) {
        btn.textContent = layout.classList.contains('sidebar-collapsed') ? '▶' : '◀';
        btn.title = layout.classList.contains('sidebar-collapsed') ? 'Rozwiń sidebar' : 'Zwiń sidebar';
    }
    localStorage.setItem('bflip-sidebar-collapsed', layout.classList.contains('sidebar-collapsed') ? 'true' : 'false');
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

window.closeMobileSidebar = function() {
    const overlay = document.getElementById('sidebar-overlay');
    if (overlay) overlay.classList.remove('open');
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('mobile-open');
    document.body.classList.remove('sidebar-mobile-open');
};

// ── Theme ──────────────────────────────────────────────────
const THEMES = ['purple','white','black','red','blue','green','yellow'];
const ACCENT_THEMES = ['red','blue','green','yellow'];

(function loadSavedTheme() {
    const saved = localStorage.getItem('bflip-theme');
    if (saved === 'random') {
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
    document.getElementById('theme-menu').classList.toggle('open');
};

function closeThemeMenu() {
    document.getElementById('theme-menu').classList.remove('open');
}

function markActiveTheme(theme) {
    document.querySelectorAll('.theme-opt').forEach(btn => {
        const t = btn.getAttribute('data-theme');
        if (theme === 'random' && !t) {
            btn.classList.add('active');
        } else {
            btn.classList.toggle('active', t === theme);
        }
    });
}

// ── Rules / Promo ──────────────────────────────────────────
window.openRules = function() { document.getElementById('rules-modal').style.display = 'flex'; };
window.closeRules = function() { document.getElementById('rules-modal').style.display = 'none'; };

window.openPromoCode = function() {
    document.getElementById('promo-input').value = '';
    document.getElementById('promo-message').style.display = 'none';
    document.getElementById('promo-message').className = 'promo-message';
    document.getElementById('promo-modal').style.display = 'flex';
};
window.closePromoCode = function() { document.getElementById('promo-modal').style.display = 'none'; };

window.redeemPromoCode = async function() {
    const input = document.getElementById('promo-input');
    const code = input.value.trim();
    if (!code) { showPromoMessage('Wpisz kod promocyjny!', 'error'); return; }
    const btn = document.querySelector('.promo-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Sprawdzanie...';
    try {
        const data = await apiJson('/api/promo/redeem', { method: 'POST', body: JSON.stringify({ code }) });
        if (data.success) { showPromoMessage(data.message || '✅ Kod zrealizowany!', 'success'); input.value = ''; }
    } catch (e) { showPromoMessage(e.message || 'Błąd realizacji kodu', 'error'); }
    btn.disabled = false;
    btn.textContent = 'Zrealizuj';
};

function showPromoMessage(text, type) {
    const el = document.getElementById('promo-message');
    el.textContent = text;
    el.className = 'promo-message ' + type;
    el.style.display = 'block';
}

// ── Session / Socket events ────────────────────────────────
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
    socket.emit('countOnline');
});

socket.on('sessionNone', () => { loginOverlay.style.display = 'flex'; });
socket.on('gameError', (msg) => alert(msg));

socket.on('playerListUpdate', async () => {
    try {
        const stats = await apiJson('/api/profile/stats');
        const balanceEl = document.getElementById('balance-amount');
        if (balanceEl && stats.coins !== undefined) {
            balanceEl.textContent = fmt(stats.coins);
        }
        const dashTab = document.getElementById('tab-dashboard');
        if (dashTab && dashTab.style.display !== 'none') refreshDashboard();
    } catch (e) { console.warn('Balance refresh error:', e.message); }
});

socket.on('onlineCount', (count) => {
    const el = document.getElementById('chat-online');
    if (el) el.textContent = count + ' online';
    const dashEl = document.getElementById('dash-online');
    if (dashEl) dashEl.textContent = String(count);
});

socket.on('recentGamesUpdated', (games) => {
    renderRecentGames(games || []);
    const dashTab = document.getElementById('tab-dashboard');
    if (dashTab && dashTab.style.display !== 'none') updateDashFeed(games || []);
});

socket.on('systemMessage', (msg) => {
    const text = (typeof msg === "string" || typeof msg === "number") ? String(msg) : (msg?.message || "");
    if (!text) return;
    const old = document.getElementById('sys-toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.id = 'sys-toast';
    toast.innerHTML = `
        <div class="sys-toast-icon">📢</div>
        <div class="sys-toast-body">
            <div class="sys-toast-title">Ogłoszenie serwera</div>
            <div class="sys-toast-text">${escapeHtml(text)}</div>
        </div>
        <button class="sys-toast-close" onclick="this.parentElement.remove()">✕</button>`;
    document.body.appendChild(toast);
    setTimeout(() => { const t = document.getElementById('sys-toast'); if (t) t.remove(); }, 15000);
});

// ── Click outside handlers ─────────────────────────────────
document.addEventListener('click', function(e) {
    const panel = document.getElementById('profile-stats-panel');
    const userWrap = document.querySelector('.sidebar-user');
    if (panel && panel.classList.contains('open')) {
        if (!panel.contains(e.target) && !userWrap.contains(e.target)) panel.classList.remove('open');
    }
});

document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.theme-toggle-wrap');
    if (wrap && !wrap.contains(e.target)) closeThemeMenu();
});

// ── Sidebar resize handler ─────────────────────────────────
function handleSidebarResize() {
    const overlay = document.getElementById('sidebar-overlay');
    if (!overlay) return;
    if (window.innerWidth > 900) {
        overlay.classList.remove('open');
        document.getElementById('sidebar')?.classList.remove('mobile-open');
        document.body.classList.remove('sidebar-mobile-open');
        const btn = document.querySelector('.sidebar-collapse-btn');
        if (btn) { btn.textContent = '◀'; btn.title = 'Zwiń sidebar'; }
    } else if (window.innerWidth <= 768) {
        const layout = document.querySelector('.app-layout');
        if (layout && !layout.classList.contains('sidebar-collapsed')) layout.classList.add('sidebar-collapsed');
    }
}
let sidebarResizeTimer = null;
window.addEventListener('resize', function() {
    clearTimeout(sidebarResizeTimer);
    sidebarResizeTimer = setTimeout(handleSidebarResize, 100);
});

document.addEventListener('click', function(e) {
    if (window.innerWidth > 768 && window.innerWidth <= 900) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (sidebar && overlay && overlay.classList.contains('open') && !sidebar.contains(e.target)) {
            closeMobileSidebar();
        }
    }
});

// ── Restore sidebar state ──────────────────────────────────
(function restoreSidebarState() {
    const saved = localStorage.getItem('bflip-sidebar-collapsed');
    if (saved === 'true') {
        const layout = document.querySelector('.app-layout');
        if (layout) {
            layout.classList.add('sidebar-collapsed');
            const btn = document.querySelector('.sidebar-collapse-btn');
            if (btn) { btn.textContent = '▶'; btn.title = 'Rozwiń sidebar'; }
        }
    }
})();

// ── Click on usernames (profile) ────────────────────────────
document.addEventListener('click', function(e) {
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
    const lbNameEl = e.target.closest('.lb-player-col') || e.target.closest('.lb-name');
    if (lbNameEl) {
        const lbRow = lbNameEl.closest('.lb-row');
        if (lbRow) {
            const nameEl = lbRow.querySelector('.lb-name');
            if (nameEl) {
                const username = nameEl.textContent.trim();
                const lbData = window._lastLeaderboard || [];
                const player = lbData.find(p => p.username === username);
                if (player && player.robloxId) {
                    e.preventDefault();
                    openProfileModal(player.robloxId, player.username);
                }
            }
        }
    }
});
