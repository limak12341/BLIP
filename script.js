const socket = io();

let currentSide = 'heads';
let balance = 0;
let currentUsername = '';
let currentAvatar = '';

// ───────── ELEMENTY UI ─────────
const loginOverlay = document.getElementById('login-overlay');
const userAvatar = document.getElementById('nav-avatar-img');
const userUsername = document.getElementById('nav-username');
const userBalance = document.getElementById('balance-amount');
const navUser = document.getElementById('nav-user');
const logoutBtn = document.getElementById('logout-btn');

const gamesList = document.getElementById('games-list');
const lobbyCount = document.getElementById('lobby-count');
const historyWrap = document.getElementById('history-table-wrap');

// ───────── SESJA ─────────
socket.emit('checkSession');

socket.on('sessionOk', (data) => {
    loginOverlay.style.display = 'none';

    currentUsername = data.username;
    currentAvatar = data.avatarUrl || '';
    balance = data.balance;

    userUsername.innerText = data.username;
    userBalance.innerText = data.balance;

    navUser.style.display = 'flex';
    logoutBtn.style.display = 'inline-block';

    if (data.avatarUrl) {
        userAvatar.src = data.avatarUrl;
    }

    socket.emit('getHistory');
});

socket.on('sessionNone', () => {
    loginOverlay.style.display = 'flex';
});

socket.on('balanceUpdate', (newBalance) => {
    balance = newBalance;
    userBalance.innerText = newBalance;
});

// ───────── TWORZENIE GIER ─────────
function openCreateModal() {
    document.getElementById('create-modal').style.display = 'flex';
}

function closeCreateModal() {
    document.getElementById('create-modal').style.display = 'none';
}

function selectModalSide(side) {
    currentSide = side;

    document.getElementById('modal-heads')
        .classList.toggle('active', side === 'heads');

    document.getElementById('modal-tails')
        .classList.toggle('active', side === 'tails');
}

function setModalBet(amount) {
    document.getElementById('modal-bet').value = amount;
    updateTotal();
}

function updateTotal() {
    const bet =
        parseInt(document.getElementById('modal-bet').value) || 0;

    document.getElementById(
        'modal-total'
    ).innerText = `🪙 ${bet * 2}`;
}

function submitCreateGame() {
    const bet =
        parseInt(document.getElementById('modal-bet').value);

    if (!bet || bet < 1) {
        return alert('Podaj poprawny zakład!');
    }

    if (bet > balance) {
        return alert('Nie masz tyle monet!');
    }

    socket.emit('createGame', {
        bet,
        side: currentSide
    });

    closeCreateModal();
}

// ───────── LISTA GIER ─────────
socket.on('gamesList', (games) => {
    gamesList.innerHTML = '';

    const n = games.length;
    lobbyCount.innerText =
        n === 1 ? '1 gra' : `${n} gier`;

    if (!games.length) {
        gamesList.innerHTML = `
        <div class="empty-lobby">
            <div class="empty-icon">🪙</div>
            <p>Brak aktywnych gier</p>
        </div>
        `;
        return;
    }

    games.forEach(game => {
        const myGame =
            game.creator.username === currentUsername;

        const side =
            game.creator.side === 'heads'
                ? 'ORZEŁ'
                : 'RESZKA';

        const card = document.createElement('div');
        card.className =
            `game-card ${myGame ? 'mine' : ''}`;

        card.innerHTML = `
        <div class="card-player">
            <img class="card-avatar"
            src="${game.creator.avatarUrl}">
            
            <div class="card-info">
                <span class="card-name">
                    ${game.creator.username}
                </span>
                <span class="card-side
                ${game.creator.side === 'heads'
                    ? 'side-heads'
                    : 'side-tails'}">
                    ${side}
                </span>
            </div>
        </div>

        <div class="card-center">
            <div class="card-coin">🪙</div>
            <span class="card-bet">
                ${game.bet}
            </span>
        </div>

        <div class="card-right">
            ${
                myGame
                ? `<button class="btn-cancel"
                    onclick="cancelGame('${game.id}')">
                    cancel
                   </button>`
                : `<button class="btn-join"
                    onclick="joinGame('${game.id}')">
                    Dołącz
                   </button>`
            }
        </div>
        `;

        gamesList.appendChild(card);
    });
});

function joinGame(gameId) {
    socket.emit('joinGame', { gameId });
}

function cancelGame(gameId) {
    socket.emit('cancelGame', { gameId });
}

// ───────── HISTORIA ─────────
socket.on('historyData', (records) => {
    if (!records.length) {
        historyWrap.innerHTML = `
        <div class="empty-lobby">
            <div class="empty-icon">📜</div>
            <p>Brak historii</p>
        </div>
        `;
        return;
    }

    historyWrap.innerHTML = '';

    records.forEach(r => {
        const isCreator =
            r.creator.username === currentUsername;

        const me =
            isCreator ? r.creator : r.joiner;

        const enemy =
            isCreator ? r.joiner : r.creator;

        const win =
            me.won ? '🟢 WYGRANA' : '🔴 PRZEGRANA';

        const row = document.createElement('div');

        row.className = 'game-card';

        row.innerHTML = `
        <div class="card-player">
            <img class="card-avatar"
            src="${enemy.avatarUrl}">
            <div class="card-info">
                <span class="card-name">
                    ${enemy.username}
                </span>
                <span>${win}</span>
            </div>
        </div>

        <div class="card-center">
            <span>
                Wynik:
                ${r.winningSide === 'heads'
                ? 'ORZEŁ'
                : 'RESZKA'}
            </span>
        </div>

        <div class="card-right">
            🪙 ${r.bet * 2}
        </div>
        `;

        historyWrap.appendChild(row);
    });
});

// ───────── TABY ─────────
function showTab(tab) {
    document.getElementById('tab-lobby')
        .style.display =
            tab === 'lobby'
            ? 'block'
            : 'none';

    document.getElementById('tab-history')
        .style.display =
            tab === 'history'
            ? 'block'
            : 'none';
}

// ───────── BŁĘDY ─────────
socket.on('gameError', (msg) => {
    alert(msg);
});

socket.on('gameCreated', () => {
    socket.emit('getHistory');
});

// init
updateTotal();