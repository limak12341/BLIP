/**
 * BFLIP — Provably Fair Module
 */

"use strict";

// ── Socket event ────────────────────────────────────────────
socket.on('provablyFairResult', (data) => {
    lastProvablyFairData = data;
    console.log('[PF] Otrzymano dane Provably Fair dla gry', data.gameId);
});

// ── Open modal ─────────────────────────────────────────────
window.openProvablyFair = async function() {
    const modal = document.getElementById('pf-modal');
    modal.style.display = 'flex';
    const statusEl = document.getElementById('pf-status');
    statusEl.innerHTML = '<div class="pf-loading">Ładowanie...</div>';
    try {
        const data = await apiJson('/api/provably-fair/status');
        statusEl.innerHTML = `
            <div class="pf-status-item"><span class="pf-status-label">Server Seed Hash</span><code class="pf-status-hash">${escapeHtml(data.serverSeedHash)}</code></div>
            <div class="pf-status-item"><span class="pf-status-label">Client Seed</span><code class="pf-status-hash">${escapeHtml(data.clientSeed)}</code></div>
            <div class="pf-status-item"><span class="pf-status-label">Nonce</span><span class="pf-status-val">${data.nonce}</span></div>
            ${data.hasPreviousSeed ? '<div class="pf-status-item"><span class="pf-status-label">Poprzedni seed</span><span class="pf-status-val green">✅ Dostępny do weryfikacji</span></div>' : ''}`;
        document.getElementById('pf-client-seed-input').value = data.clientSeed;
        updateNonceBar(data.nonce, data.maxNonce || 10000);
        loadSeedHistory();
    } catch (e) {
        statusEl.innerHTML = `<div class="pf-error">⚠️ Błąd: ${escapeHtml(e.message)}</div>`;
    }
};

// ── Nonce Progress Bar ──
function updateNonceBar(nonce, maxNonce) {
    const numEl = document.getElementById('pf-nonce-bar-num');
    const fillEl = document.getElementById('pf-nonce-fill');
    const trackEl = document.getElementById('pf-nonce-track');
    if (!numEl || !fillEl) return;
    numEl.textContent = nonce || 0;
    const pct = maxNonce > 0 ? Math.min(100, ((nonce || 0) / maxNonce) * 100) : 0;
    fillEl.style.width = pct + '%';
    if (trackEl) trackEl.classList.toggle('high', pct > 50);
}

// ── Seed History ──
async function loadSeedHistory() {
    const section = document.getElementById('pf-seed-history');
    const list = document.getElementById('pf-seed-list');
    if (!section || !list) return;
    try {
        const data = await apiJson('/api/provably-fair/seed-history');
        const seeds = data.seeds || [];
        if (!seeds.length) { section.style.display = 'none'; return; }
        section.style.display = 'block';
        list.innerHTML = seeds.map((s, i) => {
            const statusClass = s.isActive ? 'active' : s.isRevealed ? 'revealed' : 'used';
            const statusLabel = s.isActive ? 'Aktualny' : s.isRevealed ? 'Ujawniony' : 'Zużyty';
            const hashDisplay = s.serverSeedHash ? s.serverSeedHash.slice(0, 16) + '...' : '—';
            return `<div class="pf-seed-item"><span class="pf-seed-index">#${seeds.length - i}</span><span class="pf-seed-hash">${escapeHtml(hashDisplay)}</span><span class="pf-seed-status ${statusClass}">${statusLabel}</span></div>`;
        }).join('');
    } catch (e) { section.style.display = 'none'; }
}

window.closeProvablyFair = function() { document.getElementById('pf-modal').style.display = 'none'; };

// ── Change Client Seed ──
window.changeClientSeed = async function() {
    const input = document.getElementById('pf-client-seed-input');
    const status = document.getElementById('pf-client-seed-status');
    const clientSeed = input.value.trim();
    if (!clientSeed || clientSeed.length < 4) {
        status.textContent = 'Client seed musi mieć co najmniej 4 znaki.';
        status.className = 'pf-client-status error';
        return;
    }
    try {
        const data = await apiJson('/api/provably-fair/client-seed', { method: 'POST', body: JSON.stringify({ clientSeed }) });
        if (data.ok) {
            status.textContent = '✅ Client seed zmieniony! Nonce zresetowany do 0.';
            status.className = 'pf-client-status success';
            window.openProvablyFair();
        }
    } catch (e) {
        status.textContent = '❌ ' + e.message;
        status.className = 'pf-client-status error';
    }
};

// ── Rotate Server Seed ──
window.rotateServerSeed = async function() {
    const status = document.getElementById('pf-rotate-status');
    status.textContent = 'Rotacja...';
    status.className = 'pf-client-status';
    try {
        const data = await apiJson('/api/provably-fair/rotate', { method: 'POST' });
        if (data.ok) {
            status.innerHTML = `✅ Server seed wyrotowany!<br><small>Nowy hash: <code>${escapeHtml(data.serverSeedHash.slice(0, 20))}...</code></small>`;
            status.className = 'pf-client-status success';
            window.openProvablyFair();
        }
    } catch (e) {
        status.textContent = '❌ ' + e.message;
        status.className = 'pf-client-status error';
    }
};

// ── Verify ──
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
        const data = await apiJson('/api/provably-fair/verify', { method: 'POST', body: JSON.stringify(body) });
        if (data.verified) {
            resultEl.innerHTML = `<div class="pf-verify-msg success"><strong>✅ Zweryfikowano!</strong><br>Wynik: <strong>${data.result === 'heads' ? 'ORZEŁ' : 'RESZKA'}</strong><br>HMAC: <code>${escapeHtml(data.hmac.slice(0, 20))}...</code></div>`;
        } else {
            resultEl.innerHTML = `<div class="pf-verify-msg error"><strong>❌ Nie zgadza się!</strong><br>Otrzymano: ${data.result === 'heads' ? 'ORZEŁ' : 'RESZKA'}<br>${data.expectedResult ? `Oczekiwano: ${data.expectedResult === 'heads' ? 'ORZEŁ' : 'RESZKA'}` : ''}<br>${data.message || ''}</div>`;
        }
    } catch (e) { resultEl.innerHTML = `<div class="pf-verify-msg error">❌ ${escapeHtml(e.message)}</div>`; }
};

window.autoVerifyLastGame = async function() {
    const resultEl = document.getElementById('pf-verify-result');
    if (!lastProvablyFairData) {
        resultEl.innerHTML = '<div class="pf-verify-msg error">⚠️ Brak danych z ostatniej gry. Zagraj najpierw w coinflip.</div>';
        return;
    }
    document.getElementById('pf-verify-server-seed').value = lastProvablyFairData.serverSeed || '';
    document.getElementById('pf-verify-client-seed').value = lastProvablyFairData.clientSeed || '';
    document.getElementById('pf-verify-nonce').value = lastProvablyFairData.nonce || 0;
    document.getElementById('pf-verify-result').value = lastProvablyFairData.result || '';
    resultEl.innerHTML = '<div class="pf-verify-msg">Auto-weryfikacja...</div>';
    try {
        const body = { previousServerSeed: lastProvablyFairData.serverSeed, clientSeed: lastProvablyFairData.clientSeed, nonce: lastProvablyFairData.nonce };
        if (lastProvablyFairData.result) body.expectedResult = lastProvablyFairData.result;
        const data = await apiJson('/api/provably-fair/verify', { method: 'POST', body: JSON.stringify(body) });
        const serverSeedHash = await sha256Local(lastProvablyFairData.serverSeed);
        const hashMatch = serverSeedHash === lastProvablyFairData.serverSeedHash;
        if (data.verified && hashMatch) {
            resultEl.innerHTML = `<div class="pf-verify-msg success"><strong>✅ Gra w pełni zweryfikowana!</strong><br>• Hash server seeda się zgadza ✅<br>• Wynik: <strong>${data.result === 'heads' ? 'ORZEŁ' : 'RESZKA'}</strong> — zgodny z seedami ✅<br>• Nonce: ${data.nonce}<br>• HMAC: <code>${escapeHtml(data.hmac.slice(0, 24))}...</code></div>`;
        } else if (data.verified && !hashMatch) {
            resultEl.innerHTML = `<div class="pf-verify-msg warning">⚠️ Wynik się zgadza, ale hash server seeda NIE pasuje do zapisanego!<br>Oczekiwany hash: <code>${escapeHtml(lastProvablyFairData.serverSeedHash)}</code><br>Obliczony hash: <code>${escapeHtml(serverSeedHash)}</code><br>To może oznaczać manipulację seedem!</div>`;
        } else {
            resultEl.innerHTML = `<div class="pf-verify-msg error"><strong>❌ Nie zgadza się!</strong><br>Otrzymano: ${data.result === 'heads' ? 'ORZEŁ' : 'RESZKA'}<br>${data.message || ''}</div>`;
        }
    } catch (e) { resultEl.innerHTML = `<div class="pf-verify-msg error">❌ ${escapeHtml(e.message)}</div>`; }
};
