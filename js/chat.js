/**
 * BFLIP — Chat Module
 */

"use strict";

// ── Chat functions ──────────────────────────────────────────
window.openChat = function() {
    const chatPanel = document.getElementById('chat-panel');
    const isPanelHidden = !chatPanel || chatPanel.offsetParent === null || window.getComputedStyle(chatPanel).display === 'none';
    if (window.innerWidth <= 900 || isPanelHidden) {
        openChatOverlay();
    } else {
        const input = document.getElementById('chat-input');
        if (input) { input.focus(); scrollChatToBottom(); }
    }
};

function openChatOverlay() {
    const overlay = document.getElementById('chat-overlay');
    overlay.classList.add('open');
    renderChatMessages(document.getElementById('chat-overlay-msgs'));
    setTimeout(() => {
        const input = document.getElementById('chat-overlay-input');
        if (input) input.focus();
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

// ── Enter to send handlers ─────────────────────────────────
(function setupChatEnterHandlers() {
    document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
    });
    document.getElementById('chat-overlay-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); sendChatMessageOverlay(); }
    });
})();

// ── Socket events ──────────────────────────────────────────
socket.on('chatHistory', (messages) => {
    chatMessages = messages || [];
    const desktopMsgs = document.getElementById('chat-messages');
    if (desktopMsgs) {
        desktopMsgs.querySelector('.chat-loading')?.remove();
        renderChatMessages(desktopMsgs);
        scrollChatToBottom();
    }
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

    const desktopMsgs = document.getElementById('chat-messages');
    if (desktopMsgs) {
        desktopMsgs.querySelector('.chat-empty-msgs')?.remove();
        desktopMsgs.insertAdjacentHTML('beforeend', html);
        scrollChatToBottom();
    }
    const overlayMsgs = document.getElementById('chat-overlay-msgs');
    if (overlayMsgs && document.getElementById('chat-overlay').classList.contains('open')) {
        overlayMsgs.querySelector('.chat-empty-msgs')?.remove();
        overlayMsgs.insertAdjacentHTML('beforeend', html);
        scrollOverlayToBottom();
    }
});
