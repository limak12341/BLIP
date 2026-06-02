/** 
 * BFLIP — Utility functions
 * Czyste funkcje pomocnicze, brak zależności od socket/stanu aplikacji
 */

"use strict";

function fmt(n) {
    const raw = Number(n);
    const v = raw / 1000; // scale down by 1000 (750M → 750K)
    if (v < 1) return String(raw);
    if (v < 1_000) {
        if (v < 10) return v.toFixed(1) + 'K';
        return Math.round(v) + 'K';
    }
    if (v < 1_000_000) {
        const m = v / 1_000;
        if (m < 10) return m.toFixed(1) + 'M';
        return Math.round(m) + 'M';
    }
    const b = v / 1_000_000;
    if (b < 10) return b.toFixed(1) + 'B';
    return Math.round(b) + 'B';
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

function roleBadgeHtml(role) {
    const labels = { helper:'Helper', mod:'Mod', smod:'SMod', owner:'Owner' };
    const label = labels[role] || role;
    return `<span class="role-badge role-${escapeHtml(role)}">${label}</span>`;
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

async function sha256Local(data) {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
