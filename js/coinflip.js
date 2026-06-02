/**
 * BFLIP — Coinflip Module
 * Lobby, create/join game, view/result modals, history, deposit/withdraw, inventory, gems merge, pet search
 */

"use strict";

// ── ITEM PICKER (create game) ────────────────────────────────
async function loadInventoryRAP() {
    try { const data = await apiJson('/api/inventory/with-rap'); myInventoryRAP = data.items || []; }
    catch (e) { myInventoryRAP = []; }
}

window.toggleCreateOption = (opt) => {
    if (opt === 'wild') {
        currentWildMode = !currentWildMode;
        document.getElementById('opt-wild').classList.toggle('active', currentWildMode);
    } else if (opt === 'hugebet') {
        currentHugeBet = !currentHugeBet;
        document.getElementById('opt-hugebet').classList.toggle('active', currentHugeBet);
        if (currentHugeBet) {
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
    document.getElementById('opt-wild')?.classList.remove('active');
    document.getElementById('opt-hugebet')?.classList.remove('active');
    await loadInventoryRAP();
    renderCreateItemPicker();
    document.getElementById('create-modal').style.display = 'flex';
};

window.closeCreateModal = () => { document.getElementById('create-modal').style.display = 'none'; };

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
        empty.style.display = 'block'; total.textContent = '🪙 0'; count.textContent = '';
        return;
    }
    empty.style.display = 'none';
    let totalValue = 0, itemCount = 0;
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
        card.innerHTML = `<div class="inv-name">${escapeHtml(it.name)}</div>
          <div class="inv-qty">🪙 ${fmt(it.rap || 0)} · Masz: ${fmt(it.qty)}</div>
          <div class="inv-actions"><button class="inv-btn" data-act="minus" data-key="${escapeHtml(key)}">−</button>
          <span class="inv-sel" id="sel-${escapeHtml(key)}">${qty}</span>
          <button class="inv-btn" data-act="plus" data-key="${escapeHtml(key)}">+</button></div>`;
        card.querySelector('[data-act="minus"]').addEventListener('click', () => {
            const cur = createSelectedItems.find(x => x.name.toLowerCase() === key);
            if (!cur) return;
            if (cur.qty <= 1) createSelectedItems = createSelectedItems.filter(x => x.name.toLowerCase() !== key);
            else cur.qty--;
            renderCreateItemPicker();
        });
        card.querySelector('[data-act="plus"]').addEventListener('click', () => {
            const cur = createSelectedItems.find(x => x.name.toLowerCase() === key);
            const curQty = cur ? cur.qty : 0;
            if (curQty >= it.qty) return;
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
    const items = createSelectedItems.map(it => ({ name: it.name, qty: it.qty, rap: it.rap || 0 }));
    if (!items.length) return alert('Wybierz przynajmniej 1 item do zakładu!');
    socket.emit('createGame', { items, side: currentSide, wildMode: currentWildMode, hugeBet: currentHugeBet });
    closeCreateModal();
};

// ── GAME INFO MODAL ────────────────────────────────────────
function buildGameInfoPlayerSection(player, items, totalValue) {
    const avatarHtml = player && player.avatarUrl
        ? `<img class="gi-avatar" src="${player.avatarUrl}" alt="">`
        : `<div class="gi-avatar gi-avatar-empty">?</div>`;
    const nameHtml = player ? escapeHtml(player.username || '—') : '<span class="gi-muted-text">—</span>';
    const sideHtml = player && player.side
        ? `<span class="gi-side gi-side-${player.side}">${player.side === 'heads' ? 'ORZEŁ' : 'RESZKA'}</span>` : '';
    let itemsHtml = '';
    if (items && items.length) {
        items.forEach(it => {
            const itemTotal = (it.rap || 0) * (it.qty || 1);
            itemsHtml += `<div class="gi-item"><div class="gi-item-top"><span class="gi-item-name">${escapeHtml(it.name)}</span><span class="gi-item-qty">x${it.qty || 1}</span></div>
                <div class="gi-item-bottom">${it.rap ? `<span class="gi-item-rap">🪙 ${fmt(it.rap)} each</span>` : ''}${it.rap ? `<span class="gi-item-subtotal">= 🪙 ${fmt(itemTotal)}</span>` : ''}</div></div>`;
        });
    }
    return `<div class="gi-player-header">${avatarHtml}<div class="gi-player-info"><div class="gi-player-name">${nameHtml}</div>${sideHtml}</div></div>
        <div class="gi-items-wrap">${itemsHtml || '<div class="gi-no-items">Brak itemów</div>'}</div>
        <div class="gi-total-row"><span class="gi-total-label">Łączna wartość:</span><span class="gi-total-value">🪙 ${fmt(totalValue || 0)}</span></div>`;
}

window.showGameInfo = function(gameId) {
    const game = lobbyGames.find(x => x.id === gameId);
    if (!game) return;
    document.getElementById('gi-game-id').textContent = `# ${game.id}`;
    const content = document.getElementById('gi-content');
    const creatorHtml = buildGameInfoPlayerSection(game.creator, game.items || [], game.totalValue || 0);
    let joinerHtml;
    if (game.status === 'waiting') {
        joinerHtml = `<div class="gi-waiting"><div class="gi-waiting-icon">⏳</div><div class="gi-waiting-text">Oczekiwanie na przeciwnika</div><div class="gi-waiting-sub">Nikt jeszcze nie dołączył do tej gry</div></div>`;
    } else {
        joinerHtml = buildGameInfoPlayerSection(game.joiner || null, [], 0);
    }
    content.innerHTML = `<div class="gi-players"><div class="gi-player-col gi-col-creator"><div class="gi-col-header"><span class="gi-col-badge creator-badge">Twórca</span>${game.creator.username === currentUsername ? '<span class="gi-col-you">(Ty)</span>' : ''}</div>${creatorHtml}</div><div class="gi-vs-col"><div class="gi-vs-circle">⚔️</div></div><div class="gi-player-col gi-col-opponent"><div class="gi-col-header"><span class="gi-col-badge opp-badge">${game.status === 'waiting' ? 'Oczekiwanie' : 'Przeciwnik'}</span></div>${joinerHtml}</div></div>`;
    document.getElementById('game-info-modal').style.display = 'flex';
};

window.closeGameInfo = function() { document.getElementById('game-info-modal').style.display = 'none'; };

// ── GAME LIST ──────────────────────────────────────────────
socket.on('gamesList', (games) => {
    lobbyGames = games;
    const n = games.length;
    lobbyCount.textContent = n === 1 ? '1 gra' : `${n} gier`;
    gamesList.innerHTML = '';
    if (!n) {
        gamesList.innerHTML = `<div class="empty-lobby"><div class="empty-icon">🪙</div><p>Brak aktywnych gier</p><p class="empty-sub">Stwórz nową grę i poczekaj na przeciwnika</p></div>`;
        return;
    }
    games.forEach(g => {
        const isMe = g.creator.username === currentUsername;
        const card = document.createElement('div');
        card.className = `game-card ${isMe ? 'mine' : ''}`;
        const avatarHtml = g.creator.avatarUrl ? `<img class="gc-avatar" src="${g.creator.avatarUrl}" alt="">` : `<div class="gc-avatar-empty">?</div>`;
        const badgeClass = g.creator.side === 'heads' ? 'heads' : 'tails';
        const badgeLetter = g.creator.side === 'heads' ? 'H' : 'T';
        let modeBadges = '';
        if (g.wildMode) modeBadges += '<span class="gc-mode-badge wild">🔄 Wild</span>';
        if (g.hugeBet) modeBadges += '<span class="gc-mode-badge hugebet">🔥 Huge BET</span>';
        const itemsHtml = (g.items || []).slice(0, 3).map(it => `<span class="gc-item-chip">${escapeHtml(it.name)}${it.qty > 1 ? ' x' + it.qty : ''}</span>`).join('');
        const moreHtml = (g.items || []).length > 3 ? `<span class="gc-item-chip muted">+${(g.items||[]).length - 3}</span>` : '';
        const rightHtml = isMe
            ? `<div class="gc-actions"><div class="gc-waiting-label"><div class="dot-pulse"></div>Czekam...</div><button class="btn-info" onclick="showGameInfo('${g.id}')">📋 Info</button><button class="btn-cancel" onclick="cancelGame('${g.id}')">Anuluj</button></div>`
            : `<div class="gc-actions"><button class="btn-join" onclick="openJoinGameModal('${g.id}')">Join</button><button class="btn-view" onclick="openViewModal('${g.id}')">View</button><button class="btn-info-sm" onclick="showGameInfo('${g.id}')">📋 Info</button></div>`;
        card.innerHTML = `<div class="gc-player"><div class="gc-avatar-wrap">${avatarHtml}<div class="gc-side-badge ${badgeClass}">${badgeLetter}</div></div><span class="gc-username">${g.creator.username}</span></div>
          <div class="gc-center"><span class="gc-vs">Vs</span><span class="gc-gameid"># ${g.id}</span><span class="gc-bet">🪙 ${fmt(g.totalValue)}</span>
            <div class="gc-items-row">${itemsHtml}${moreHtml}</div>${modeBadges ? `<div class="gc-mode-badges-row">${modeBadges}</div>` : ''}
            <div class="gc-bar-wrap"><div class="gc-bar-fill"></div></div></div>
          <div class="gc-player"><div class="gc-avatar-wrap"><div class="gc-avatar-empty">?</div></div><span class="gc-waiting">Waiting...</span></div>
          ${rightHtml}`;
        gamesList.appendChild(card);
    });
});

window.cancelGame = (id) => socket.emit('cancelGame', { gameId: id });

// ── JOIN GAME MODAL ────────────────────────────────────────
let joinGameTarget = null;

window.openJoinGameModal = async (gameId) => {
    joinGameTarget = lobbyGames.find(x => x.id === gameId);
    if (!joinGameTarget) return;
    joinSelectedItems = [];
    await loadInventoryRAP();
    renderJoinItemPicker();
    document.getElementById('join-modal').style.display = 'flex';
};

window.closeJoinModal = () => { document.getElementById('join-modal').style.display = 'none'; joinGameTarget = null; };

function renderJoinItemPicker() {
    const grid = document.getElementById('join-items-grid');
    const empty = document.getElementById('join-items-empty');
    const total = document.getElementById('join-total');
    const minVal = joinGameTarget ? Math.round(joinGameTarget.totalValue * 0.925) : 0;
    const maxVal = joinGameTarget ? Math.round(joinGameTarget.totalValue * 1.075) : 0;
    grid.innerHTML = '';
    let filteredInventory = myInventoryRAP;
    if (joinGameTarget && joinGameTarget.hugeBet) {
        filteredInventory = myInventoryRAP.filter(it => { const n = it.name.toLowerCase(); return n.includes('titanic') || n.includes('gargantuan') || n.startsWith('gem 💎'); });
        joinSelectedItems = joinSelectedItems.filter(it => { const n = it.name.toLowerCase(); return n.includes('titanic') || n.includes('gargantuan') || n.startsWith('gem 💎'); });
    }
    if (!filteredInventory.length) { empty.style.display = 'block'; total.textContent = '🪙 0'; return; }
    empty.style.display = 'none';
    let totalValue = 0;
    const selectedMap = new Map();
    joinSelectedItems.forEach(it => selectedMap.set(it.name.toLowerCase(), it));
    document.getElementById('join-min-info').innerHTML = `<div class="modal-info" style="margin-top:0;margin-bottom:12px;font-size:.82rem">Twój zakład musi mieć wartość <b>🪙 ${fmt(minVal)} – ${fmt(maxVal)}</b><br><span style="color:var(--muted);font-size:.78rem">±7.5% od 🪙 ${fmt(joinGameTarget.totalValue)} (zakład twórcy)</span></div>`;
    myInventoryRAP.forEach(it => {
        const key = it.name.toLowerCase();
        const sel = selectedMap.get(key);
        const qty = sel ? sel.qty : 0;
        totalValue += (it.rap || 0) * qty;
        const card = document.createElement('div');
        card.className = 'inv-item';
        card.innerHTML = `<div class="inv-name">${escapeHtml(it.name)}</div><div class="inv-qty">🪙 ${fmt(it.rap || 0)} · Masz: ${fmt(it.qty)}</div>
          <div class="inv-actions"><button class="inv-btn" data-act="minus" data-key="${escapeHtml(key)}">−</button>
          <span class="inv-sel" id="jsel-${escapeHtml(key)}">${qty}</span><button class="inv-btn" data-act="plus" data-key="${escapeHtml(key)}">+</button></div>`;
        card.querySelector('[data-act="minus"]').addEventListener('click', () => {
            const cur = joinSelectedItems.find(x => x.name.toLowerCase() === key);
            if (!cur) return;
            if (cur.qty <= 1) joinSelectedItems = joinSelectedItems.filter(x => x.name.toLowerCase() !== key);
            else cur.qty--;
            renderJoinItemPicker();
        });
        card.querySelector('[data-act="plus"]').addEventListener('click', () => {
            const cur = joinSelectedItems.find(x => x.name.toLowerCase() === key);
            const curQty = cur ? cur.qty : 0;
            if (curQty >= it.qty) return;
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
    const items = joinSelectedItems.map(it => ({ name: it.name, qty: it.qty, rap: it.rap || 0 }));
    if (!items.length) return alert('Wybierz przynajmniej 1 item do zakładu!');
    socket.emit('joinGame', { gameId: joinGameTarget.id, items });
    closeJoinModal();
};

// ── VIEW MODAL ─────────────────────────────────────────────
window.openViewModal = function(gameId) {
    const g = lobbyGames.find(x => x.id === gameId);
    if (!g) return;
    viewingGameId = gameId;
    document.getElementById('view-creator-img').src = g.creator.avatarUrl || '';
    document.getElementById('view-creator-img').style.display = g.creator.avatarUrl ? 'block' : 'none';
    document.getElementById('view-creator-name').textContent = g.creator.username;
    const badge = document.getElementById('view-creator-badge');
    badge.textContent = g.creator.side === 'heads' ? 'H' : 'T';
    badge.style.background = g.creator.side === 'heads' ? 'var(--gold)' : 'var(--blue)';
    document.getElementById('view-joiner-name').textContent = 'Waiting...';
    document.getElementById('view-gameid').textContent = `# ${g.id}`;
    document.getElementById('view-creator-coins').textContent = `🪙 ${fmt(g.totalValue)}`;
    document.getElementById('view-joiner-coins').textContent = '🪙 0';
    document.getElementById('view-creator-items').innerHTML = (g.items || []).map(it => {
        const itemTotal = (it.rap || 0) * (it.qty || 1);
        return `<div class="vi-item-row"><span class="vi-item-name">${escapeHtml(it.name)}</span><span class="vi-item-qty">x${it.qty || 1}</span>${it.rap ? `<span class="vi-item-rap">🪙 ${fmt(it.rap)}</span>` : ''}${it.rap ? `<span class="vi-item-total">= 🪙 ${fmt(itemTotal)}</span>` : ''}</div>`;
    }).join('') || '<div class="vi-empty">—</div>';
    document.getElementById('view-creator-items').style.display = 'block';
    document.getElementById('view-pot-info').innerHTML = `<strong>🪙 ${fmt(g.totalValue)}</strong> łączna wartość zakładu`;
    document.getElementById('view-pot-info').style.display = 'block';
    let modeBadgeHtml = '';
    if (g.wildMode) modeBadgeHtml += '<span class="gc-mode-badge wild">🔄 Wild</span>';
    if (g.hugeBet) modeBadgeHtml += '<span class="gc-mode-badge hugebet">🔥 Huge BET</span>';
    document.getElementById('view-mode-badges').innerHTML = modeBadgeHtml;
    document.getElementById('view-mode-badges').style.display = modeBadgeHtml ? 'flex' : 'none';
    document.getElementById('view-joiner-items-row').style.display = 'none';
    document.getElementById('view-bar-fill').style.width = '100%';
    const joinBtn = document.getElementById('view-join-btn');
    joinBtn.disabled = g.creator.username === currentUsername;
    joinBtn.textContent = g.creator.username === currentUsername ? 'Twoja gra' : 'Join';
    document.getElementById('view-modal').style.display = 'flex';
};

window.closeViewModal = () => { document.getElementById('view-modal').style.display = 'none'; viewingGameId = null; };

window.joinFromView = () => { if (!viewingGameId) return; openJoinGameModal(viewingGameId); closeViewModal(); };

// ── RESULT MODAL ────────────────────────────────────────────
function buildItemsListHtml(items) {
    if (!items || !items.length) return '<div class="ri-empty">Brak itemów</div>';
    return items.map(it => {
        const itemTotal = (it.rap || 0) * (it.qty || 1);
        return `<div class="ri-item"><div class="ri-item-name">${escapeHtml(it.name)}</div><div class="ri-item-meta"><span class="ri-item-qty">x${it.qty || 1}</span>${it.rap ? `<span class="ri-item-rap">🪙 ${fmt(it.rap)}</span>` : ''}${it.rap ? `<span class="ri-item-total">= 🪙 ${fmt(itemTotal)}</span>` : ''}</div></div>`;
    }).join('');
}

function showResultItems(data) {
    const section = document.getElementById('res-items-section');
    if (!section) return;
    section.style.display = 'flex';
    const youAreCreator = data.creator.username === currentUsername;
    document.getElementById('res-my-items').innerHTML = buildItemsListHtml(youAreCreator ? (data.items || []) : (data.joinerItems || []));
    document.getElementById('res-opp-items').innerHTML = buildItemsListHtml(youAreCreator ? (data.joinerItems || []) : (data.items || []));
    document.getElementById('res-my-total').innerHTML = '🪙 ' + fmt(youAreCreator ? (data.totalValue || 0) : (data.joinValue || 0));
    document.getElementById('res-opp-total').innerHTML = '🪙 ' + fmt(youAreCreator ? (data.joinValue || 0) : (data.totalValue || 0));
}

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
    const wrap = document.getElementById('big-coin-wrap');
    coin.classList.remove('spinning');
    if (wrap) wrap.classList.remove('spinning');
    coin.style.transform = '';
};

function fillResultPlayers(creator, joiner, youAreCreator) {
    const you = youAreCreator ? creator : joiner;
    const opp = youAreCreator ? joiner : creator;
    document.getElementById('res-you-img').src = you.avatarUrl || '';
    document.getElementById('res-you-name').textContent = you.username || 'Ty';
    document.getElementById('res-you-side').textContent = sideLabel(you.side);
    document.getElementById('res-opp-img').src = opp.avatarUrl || '';
    document.getElementById('res-opp-name').textContent = opp.username || 'Przeciwnik';
    document.getElementById('res-opp-side').textContent = sideLabel(opp.side);
}

function spinCoinTo(side) {
    const coin = document.getElementById('big-coin');
    const wrap = document.getElementById('big-coin-wrap');
    const deg = side === 'heads' ? 1800 : 1980;
    coin.style.setProperty('--spin-to-deg', `${deg}deg`);
    coin.style.setProperty('--spin-dur', `${FLIP_MS}ms`);
    coin.style.transform = '';
    coin.classList.remove('spinning');
    if (wrap) wrap.classList.remove('spinning');
    void coin.offsetWidth;
    coin.classList.add('spinning');
    if (wrap) wrap.classList.add('spinning');
}

function setCoinFinal(side) {
    const coin = document.getElementById('big-coin');
    const wrap = document.getElementById('big-coin-wrap');
    coin.classList.remove('spinning');
    if (wrap) wrap.classList.remove('spinning');
    coin.style.transform = side === 'heads' ? 'rotateY(0deg)' : 'rotateY(180deg)';
}

function showFlipBanner(text, type) {
    const banner = document.getElementById('res-banner');
    banner.className = `res-banner ${type}`;
    banner.textContent = text;
    document.getElementById('res-close-btn').style.display = 'block';
}

// Socket events
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
        showFlipBanner(data.won ? `🏆 Wygrałeś! +${fmt(prizeVal)} 🪙` : `💸 Przegrałeś! -${fmt(data.totalValue || prizeVal)} 🪙`, data.won ? 'win' : 'lose');
    }, FLIP_MS);
    socket.emit('getHistory');
});

socket.on('gameCreated', () => { socket.emit('getHistory'); });

// ── HISTORY ────────────────────────────────────────────────
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
        else { losses++; profit -= (r.totalValue || 0); }
    });
    const sign = profit >= 0 ? '+' : '';
    historySummary.innerHTML = `<div class="hs-item"><span class="hs-label">Gier</span><span class="hs-val gold">${records.length}</span></div>
        <div class="hs-item"><span class="hs-label">Wygrane</span><span class="hs-val green">${wins}</span></div>
        <div class="hs-item"><span class="hs-label">Przegrane</span><span class="hs-val red">${losses}</span></div>
        <div class="hs-item"><span class="hs-label">Zysk</span><span class="hs-val ${profit>=0?'green':'red'}">${sign}${fmt(profit)} 🪙</span></div>`;
    historyWrap.innerHTML = `<div class="history-table"><div class="ht-head"><span>#</span><span>Przeciwnik</span><span>Strony</span><span>Zakład</span><span>Wynik</span></div>
        ${records.map((r, i) => {
            const me = r.creator.username === currentUsername ? r.creator : r.joiner;
            const opp = r.creator.username === currentUsername ? r.joiner : r.creator;
            const won = me.won;
            const oppAvatar = opp.avatarUrl ? `<img class="ht-opp-avatar" src="${opp.avatarUrl}" alt="">` : `<div class="ht-opp-avatar" style="background:var(--surf3);display:flex;align-items:center;justify-content:center;color:var(--muted)">?</div>`;
            return `<div class="ht-row ${won?'won':'lost'}"><span class="ht-num">#${records.length-i}</span><div class="ht-opp">${oppAvatar}<span class="ht-opp-name">${opp.username}</span></div>
                <div style="display:flex;gap:6px;align-items:center"><span class="${me.side==='heads'?'side-heads':'side-tails'}">${sideLabel(me.side)}</span><span style="color:var(--muted);font-size:.7rem">vs</span><span class="${opp.side==='heads'?'side-heads':'side-tails'}">${sideLabel(opp.side)}</span></div>
                <span class="ht-bet">🪙 ${fmt(r.totalValue || 0)}</span><span class="ht-result ${won?'won':'lost'}">${won?'🏆 Wygrana':'💸 Przegrana'}</span></div>`;
        }).join('')}</div>`;
    refreshProfileStats();
    refreshLevel();
});

// ── DEPOSIT / WITHDRAW / INVENTORY ─────────────────────────
async function refreshDepositTab() {
    try { await Promise.all([loadInventory(), loadRequests()]); renderInventory(); renderRequests(); }
    catch (e) { console.warn(e.message); }
}

// Deposit
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
window.closeDepositModal = () => { document.getElementById('deposit-modal').style.display = 'none'; document.getElementById('pet-search-results').classList.remove('open'); };

async function searchPets(q, category) {
    try {
        const params = new URLSearchParams({ q, limit: '30' });
        if (category && category !== 'all') params.set('category', category);
        const data = await apiJson('/api/pets/search?' + params.toString());
        petSearchCache = data.results || [];
        renderPetResults(petSearchCache);
    } catch (e) { console.warn('Pet search error:', e.message); }
}

function renderPetResults(pets) {
    const el = document.getElementById('pet-search-results');
    el.innerHTML = '';
    if (!pets.length) { el.innerHTML = '<div class="pet-empty">Brak wyników. Spróbuj innej nazwy.</div>'; el.classList.add('open'); return; }
    el.classList.add('open');
    pets.forEach(p => {
        const alreadyAdded = selectedDepositItems.find(x => x.name === p.name);
        const card = document.createElement('div');
        card.className = 'pet-result-item';
        const catColors = { Huge: 'var(--gold)', Titanic: 'var(--purple)', Gargantuan: 'var(--red)', Gem: '#00e5ff' };
        const catColor = catColors[p.category] || 'var(--muted)';
        card.innerHTML = `<div class="pet-result-info"><div class="pet-result-name">${escapeHtml(p.name)}</div>
            <div class="pet-result-meta"><span class="pet-cat-badge" style="background:${catColor}22;color:${catColor};border-color:${catColor}44">${p.category}</span><span class="pet-rap">🪙 ${fmt(p.rap || 0)}</span></div></div>
            <button class="pet-add-btn" ${alreadyAdded ? 'disabled' : ''}>${alreadyAdded ? '✓ Added' : '+ Add'}</button>`;
        card.querySelector('.pet-add-btn').addEventListener('click', () => { if (alreadyAdded) return; addDepositItem(p.name, p.category, p.rap || 0); });
        el.appendChild(card);
    });
    const doneWrap = document.createElement('div');
    doneWrap.className = 'pet-results-done';
    doneWrap.innerHTML = `<button class="pet-done-btn" onclick="closePetResults()">✓ Done</button>`;
    el.appendChild(doneWrap);
}

window.closePetResults = function() { document.getElementById('pet-search-results').classList.remove('open'); };

function addDepositItem(name, category, rap) {
    const existing = selectedDepositItems.find(x => x.name === name);
    if (existing) existing.qty = Math.min(existing.qty + 1, 99);
    else selectedDepositItems.push({ name, category, rap, qty: 1 });
    renderDepositItems();
    renderPetResults(petSearchCache);
}

function renderDepositItems() {
    const list = document.getElementById('deposit-items-list');
    const empty = document.getElementById('deposit-items-empty');
    const totalEl = document.getElementById('deposit-total');
    const totalVal = document.getElementById('deposit-total-value');
    list.innerHTML = '';
    if (!selectedDepositItems.length) { empty.style.display = 'block'; totalEl.style.display = 'none'; return; }
    empty.style.display = 'none'; totalEl.style.display = 'flex';
    let total = 0;
    selectedDepositItems.forEach((it, i) => {
        total += it.rap * it.qty;
        const el = document.createElement('div');
        el.className = 'dep-item-row';
        const catColors = { Huge: 'var(--gold)', Titanic: 'var(--purple)', Gargantuan: 'var(--red)', Gem: '#00e5ff' };
        const catColor = catColors[it.category] || 'var(--muted)';
        el.innerHTML = `<div class="dep-item-info"><span class="dep-item-name">${escapeHtml(it.name)}</span><span class="dep-item-cat" style="color:${catColor}">${it.category}</span><span class="dep-item-rap">🪙 ${fmt(it.rap)} each</span></div>
          <div class="dep-item-qty-wrap"><button class="dep-qty-btn" data-act="minus">−</button><span class="dep-qty-val">${it.qty}</span><button class="dep-qty-btn" data-act="plus">+</button></div>
          <button class="dep-item-del" title="Usuń">✕</button>`;
        el.querySelector('[data-act="minus"]').addEventListener('click', () => { if (it.qty <= 1) selectedDepositItems.splice(i, 1); else it.qty--; renderDepositItems(); renderPetResults(petSearchCache); });
        el.querySelector('[data-act="plus"]').addEventListener('click', () => { if (it.qty < 99) it.qty++; renderDepositItems(); });
        el.querySelector('.dep-item-del').addEventListener('click', () => { selectedDepositItems.splice(i, 1); renderDepositItems(); renderPetResults(petSearchCache); });
        list.appendChild(el);
    });
    totalVal.textContent = '🪙 ' + fmt(total);
}

// Pet search DOM handlers
(function setupPetSearch() {
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
    searchInput.addEventListener('focus', () => { if (petSearchCache.length) document.getElementById('pet-search-results').classList.add('open'); });
    document.addEventListener('click', (e) => { const wrap = document.querySelector('.pet-search-wrap'); if (wrap && !wrap.contains(e.target)) document.getElementById('pet-search-results').classList.remove('open'); });
    document.querySelectorAll('.pet-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.pet-filter').forEach(x => x.classList.remove('active'));
            btn.classList.add('active');
            searchPets(searchInput.value.trim(), btn.getAttribute('data-cat'));
        });
    });
})();

window.submitDepositRequest = async () => {
    try {
        const items = selectedDepositItems.map(it => ({ name: it.name, qty: it.qty }));
        const note = document.getElementById('dep-note').value.trim();
        if (!items.length) return alert('Dodaj przynajmniej 1 item.');
        await apiJson('/api/deposit/request', { method: 'POST', body: JSON.stringify({ items, note }) });
        closeDepositModal();
        await refreshDepositTab();
        alert('✅ Zgłoszenie depozytu wysłane! Bot wyceni, admin potwierdzi.');
    } catch (e) { alert(e.message); }
};

// Withdraw
window.openWithdrawModal = async () => {
    withdrawSelection = new Map();
    try {
        await loadInventory();
        renderWithdrawPicker();
        document.getElementById('wd-note').value = '';
        document.getElementById('withdraw-modal').style.display = 'flex';
    } catch (e) { alert(e.message); }
};
window.closeWithdrawModal = () => { document.getElementById('withdraw-modal').style.display = 'none'; };

function renderWithdrawPicker() {
    const box = document.getElementById('withdraw-items');
    box.innerHTML = '';
    if (!myInventory.length) { box.innerHTML = '<div class="empty-mini" style="grid-column:1/-1">Brak itemów na stronie.</div>'; return; }
    myInventory.forEach(it => {
        const key = it.name.toLowerCase();
        const card = document.createElement('div');
        card.className = 'inv-item';
        card.innerHTML = `<div class="inv-name">${escapeHtml(it.name)}</div><div class="inv-qty">Masz: ${fmt(it.qty)}</div>
          <div class="inv-actions"><button class="inv-btn" data-act="minus">−</button><span class="inv-sel" data-sel>0</span><button class="inv-btn" data-act="plus">+</button></div>`;
        const selEl = card.querySelector('[data-sel]');
        const updateSel = () => { selEl.textContent = String(withdrawSelection.get(key) || 0); };
        card.querySelector('[data-act="minus"]').addEventListener('click', () => {
            const cur = withdrawSelection.get(key) || 0; if (cur <= 0) return;
            if (cur - 1 === 0) withdrawSelection.delete(key); else withdrawSelection.set(key, cur - 1);
            updateSel();
        });
        card.querySelector('[data-act="plus"]').addEventListener('click', () => {
            const cur = withdrawSelection.get(key) || 0; if (cur >= it.qty) return;
            withdrawSelection.set(key, cur + 1); updateSel();
        });
        updateSel();
        box.appendChild(card);
    });
}

window.submitWithdrawRequest = async () => {
    try {
        const note = document.getElementById('wd-note').value.trim();
        const items = [];
        withdrawSelection.forEach((qty, key) => { if (qty > 0) { const original = myInventory.find(x => x.name.toLowerCase() === key); if (original) items.push({ name: original.name, qty }); } });
        if (!items.length) return alert('Wybierz itemy do wypłaty.');
        await apiJson('/api/withdraw/request', { method: 'POST', body: JSON.stringify({ items, note }) });
        closeWithdrawModal();
        await refreshDepositTab();
        alert('Zgłoszenie wypłaty wysłane (pending).');
    } catch (e) { alert(e.message); }
};

async function loadInventory() { const data = await apiJson('/api/inventory'); myInventory = data.items || []; }
async function loadRequests() { const data = await apiJson('/api/requests'); myRequests = data.requests || []; }

function renderRequests() {
    if (!requestsListEl) return;
    requestsListEl.innerHTML = '';
    const reqs = myRequests || [];
    requestsEmptyEl.style.display = reqs.length ? 'none' : 'block';
    reqs.forEach(r => {
        const items = (r.items || []).map(it => `${escapeHtml(it.name)} x${fmt(it.qty)}`).join(', ');
        const el = document.createElement('div');
        el.className = 'req-item';
        el.innerHTML = `<div class="req-top"><div class="req-title">${typeLabel(r.type)} ${statusBadge(r)}</div><div class="req-time">${timeAgo(r.createdAt || Date.now())}</div></div>
          <div class="req-body">${items || '—'}</div>${r.note ? `<div class="req-note">Notatka: ${escapeHtml(r.note)}</div>` : ''}${r.adminNote ? `<div class="req-note">Admin: ${escapeHtml(r.adminNote)}</div>` : ''}`;
        requestsListEl.appendChild(el);
    });
}

function renderInventory() {
    if (!inventoryListEl) return;
    inventoryListEl.innerHTML = '';
    const items = myInventory || [];
    inventoryEmptyEl.style.display = items.length ? 'none' : 'block';
    items.forEach(it => {
        const el = document.createElement('div');
        el.className = 'inv-item' + (it.name.startsWith('Gem 💎') ? ' inv-item-gem' : '');
        el.innerHTML = `<div class="inv-name">${escapeHtml(it.name)}</div><div class="inv-qty">x ${fmt(it.qty)}</div>`;
        inventoryListEl.appendChild(el);
    });
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

// ── GEMS ──────────────────────────────────────────────────
window.openMergeModal = async function() {
    const modal = document.getElementById('merge-modal');
    const content = document.getElementById('merge-content');
    modal.style.display = 'flex';
    content.innerHTML = '<div class="merge-loading">Ładowanie inventarza...</div>';
    try {
        const data = await apiJson('/api/inventory');
        const items = data.items || [];
        const gems = items.filter(it => it.name.startsWith('Gem 💎'));
        if (!gems.length) { content.innerHTML = '<div class="merge-empty"><div class="empty-icon">💎</div><p>Nie masz żadnych gemów w inventarzu!</p><p class="empty-sub">Poproś admina o dodanie gemów.</p></div>'; return; }
        const recipes = [
            { in: 'Gem 💎 1M', inQty: 10, out: 'Gem 💎 10M', outQty: 1, idx: 0 },
            { in: 'Gem 💎 10M', inQty: 5, out: 'Gem 💎 25M', outQty: 2, idx: 1 },
            { in: 'Gem 💎 25M', inQty: 2, out: 'Gem 💎 50M', outQty: 1, idx: 2 },
            { in: 'Gem 💎 50M', inQty: 2, out: 'Gem 💎 100M', outQty: 1, idx: 3 },
            { in: 'Gem 💎 100M', inQty: 5, out: 'Gem 💎 500M', outQty: 1, idx: 4 },
        ];
        let html = '<div class="merge-gems-list"><div class="merge-intro">Połącz niższe gemy w wyższe:</div>';
        recipes.forEach(r => {
            const have = gems.find(g => g.name === r.in);
            const haveQty = have ? have.qty : 0;
            const canAfford = haveQty >= r.inQty;
            html += `<div class="merge-recipe ${canAfford ? 'can-merge' : ''}"><div class="merge-recipe-info"><div class="merge-recipe-input"><span class="merge-qty">${r.inQty}x</span><span class="merge-name">${r.in}</span><span class="merge-have ${canAfford ? 'have-enough' : 'have-not'}">(Masz: ${haveQty})</span></div><div class="merge-arrow">→</div><div class="merge-recipe-output"><span class="merge-qty">${r.outQty}x</span><span class="merge-name">${r.out}</span></div></div><button class="merge-btn" ${canAfford ? `onclick="doMerge(${r.idx})"` : 'disabled'}>${canAfford ? 'Połącz' : '❌'}</button></div>`;
        });
        html += '</div><div id="merge-message" class="merge-message"></div>';
        content.innerHTML = html;
    } catch (e) { content.innerHTML = `<div class="merge-empty"><div class="empty-icon">⚠️</div><p>Błąd: ${escapeHtml(e.message)}</p></div>`; }
};

window.closeMergeModal = function() { document.getElementById('merge-modal').style.display = 'none'; };

window.doMerge = async function(recipeIdx) {
    const msgEl = document.getElementById('merge-message');
    if (!msgEl) return;
    msgEl.textContent = 'Łączenie...';
    msgEl.className = 'merge-message';
    try {
        const data = await apiJson('/api/gems/merge', { method: 'POST', body: JSON.stringify({ recipe: recipeIdx }) });
        if (data.ok) { msgEl.textContent = '✅ ' + data.message; msgEl.className = 'merge-message success'; setTimeout(() => openMergeModal(), 1200); }
    } catch (e) { msgEl.textContent = '❌ ' + e.message; msgEl.className = 'merge-message error'; }
};
