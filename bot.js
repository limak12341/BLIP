/**
 * BFLIP BOT — noblox.js + BigGames API
 * 
 * CO ROBI:
 * 1. Loguje się na konto bota przez cookie Roblox
 * 2. Co 30 sekund sprawdza pending requesty depositu
 * 3. Automatycznie pobiera wartość itemów z BigGames API
 * 4. Wysyła użytkownikowi wiadomość na Roblox z potwierdzeniem
 * 5. Po Twojej akceptacji w adminie → auto kredytuje saldo
 *
 * JAK URUCHOMIĆ:
 * 1. npm install noblox.js
 * 2. Ustaw zmienne środowiskowe (patrz niżej)
 * 3. node bot.js  (osobny terminal obok node server.js)
 *
 * ZMIENNE ŚRODOWISKOWE (w .env lub bezpośrednio):
 *   ROBLOX_COOKIE   = .ROBLOSECURITY cookie z przeglądarki
 *   BOT_SECRET      = dowolny losowy ciąg, ten sam co w server.js
 *   SERVER_URL      = http://localhost:5000  (lub URL Render)
 */

"use strict";
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

const noblox = require('noblox.js');
const axios  = require('axios');

// ── KONFIGURACJA ──────────────────────────────────────────────
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE || '';
const BOT_SECRET    = process.env.BOT_SECRET    || 'super-tajny-klucz-bota-123';
const SERVER_URL    = process.env.SERVER_URL    || 'http://localhost:5000';
const POLL_MS       = 30_000; // co 30 sekund sprawdzamy

// Białe listy petów PS99 (możesz rozszerzyć)
const ALLOWED_PET_TIERS = ['huge', 'titanic', 'gargantuan'];

// ── WARTOŚCI PETÓW (BigGames RAP API) ────────────────────────
let rapCache = {};   // { 'Huge Cat': 1500000, ... }
let rapFetchedAt = 0;

async function fetchRap() {
    if (Date.now() - rapFetchedAt < 5 * 60_000) return; // cache 5 min
    try {
        const res = await axios.get('https://ps99.biggamesapi.io/api/rap', { timeout: 8000 });
        const data = res.data?.data || [];
        rapCache = {};
        data.forEach(item => {
            if (item?.configData?.id) {
                const baseId = item.configData.id;
                const pt = item.configData.pt;
                const sh = item.configData.sh;
                let suffix = '';
                if (sh && pt === 1) suffix = ' [Shiny Golden]';
                else if (sh && pt === 2) suffix = ' [Shiny Rainbow]';
                else if (sh) suffix = ' [Shiny]';
                else if (pt === 1) suffix = ' [Golden]';
                else if (pt === 2) suffix = ' [Rainbow]';
                rapCache[baseId + suffix] = item.value || 0;
            }
        });
        rapFetchedAt = Date.now();
        console.log(`[RAP] Pobrano ${Object.keys(rapCache).length} itemów`);
    } catch (e) {
        console.error('[RAP] Błąd pobierania wartości:', e.message);
    }
}

// Pobierz wartość peta po nazwie (np. "Huge Cat", "Titanic Corgi")
function getPetValue(petName) {
    if (!petName) return 0;
    // 1. Dokładne dopasowanie nazwy
    if (rapCache[petName]) return rapCache[petName];
    // 2. Bez spacji (configData.id z API)
    const stripped = petName.replace(/\s+/g, '');
    if (rapCache[stripped]) return rapCache[stripped];
    // 3. Warianty: 'Huge Cat [Golden]' → szukaj 'HugeCat [Golden]'
    const sfx = petName.match(/\s+(\[.*?])$/);
    if (sfx) {
        const base = petName.slice(0, sfx.index).replace(/\s+/g, '');
        if (rapCache[base + ' ' + sfx[1]]) return rapCache[base + ' ' + sfx[1]];
    }
    return 0;
}

// Przelicz itemy na łączną wartość
function calcItemsValue(items) {
    return items.reduce((sum, it) => {
        const val = getPetValue(it.name);
        return sum + val * (it.qty || 1);
    }, 0);
}

// Sprawdź czy pet jest z dozwolonego tieru
function isAllowedPet(name) {
    const lower = (name || '').toLowerCase();
    return ALLOWED_PET_TIERS.some(tier => lower.includes(tier));
}

// ── KOMUNIKACJA Z SERWEREM ────────────────────────────────────
async function getServerApi(path) {
    const res = await axios.get(SERVER_URL + path, {
        headers: { 'x-bot-secret': BOT_SECRET },
        timeout: 8000,
    });
    return res.data;
}

async function postServerApi(path, body) {
    const res = await axios.post(SERVER_URL + path, body, {
        headers: { 'x-bot-secret': BOT_SECRET, 'Content-Type': 'application/json' },
        timeout: 8000,
    });
    return res.data;
}

// ── WIADOMOŚCI ROBLOX ─────────────────────────────────────────
async function sendRobloxMessage(userId, subject, body) {
    try {
        await noblox.message(userId, subject, body);
        console.log(`[MSG] Wysłano wiadomość do userId ${userId}`);
    } catch (e) {
        console.warn(`[MSG] Błąd wysyłki wiadomości: ${e.message}`);
    }
}

// ── GŁÓWNA PĘTLA BOTA ─────────────────────────────────────────
async function processPendingDeposits() {
    await fetchRap();
    let pending;
    try {
        const data = await getServerApi('/api/bot/pending-deposits');
        pending = data.requests || [];
    } catch (e) {
        console.error('[BOT] Błąd pobierania pendingów:', e.message);
        return;
    }

    console.log(`[BOT] Pending depositów: ${pending.length}`);

    for (const req of pending) {
        try {
            // Sprawdź czy itemy są dozwolone
            const invalidItems = (req.items || []).filter(it => !isAllowedPet(it.name));
            if (invalidItems.length > 0) {
                console.log(`[BOT] Odrzucam ${req._id} — niedozwolone itemy:`, invalidItems.map(i => i.name));
                await postServerApi('/api/bot/update-deposit', {
                    requestId: req._id,
                    status:    'rejected',
                    adminNote: `Bot: niedozwolone itemy: ${invalidItems.map(i => i.name).join(', ')}`,
                });
                continue;
            }

            // Oblicz wartość
            const totalValue = calcItemsValue(req.items || []);
            console.log(`[BOT] Request ${req._id}: ${req.username} → ${totalValue} monet`);

            // Zaktualizuj request o obliczoną wartość (do zatwierdzenia przez admina)
            await postServerApi('/api/bot/update-deposit', {
                requestId:  req._id,
                status:     'valued',  // czeka na admina
                totalValue,                    adminNote:  `Bot: łączna wartość RAP = 🪙 ${fmtNumber(totalValue)}`,
            });

            // Wyślij wiadomość użytkownikowi na Roblox (opcjonalne)
            if (req.robloxUserId) {
                await sendRobloxMessage(
                    req.robloxUserId,
                    'BFLIP — Depozyt otrzymany',
                    `Cześć ${req.username}!\n\nTwój depozyt został zarejestrowany.\n` +
                    `Wycena RAP: ${fmtNumber(totalValue)} monet.\n\n` +
                    `Admin musi potwierdzić otrzymanie trade'a — saldo zostanie dodane po akceptacji.\n\n` +
                    `Bot BFLIP`
                );
            }

        } catch (e) {
            console.error(`[BOT] Błąd przy ${req._id}:`, e.message);
        }
    }
}

function fmtNumber(n) {
    const v = Number(n);
    if (v < 1000) return String(v);
    if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0) + 'K';
    if (v < 1_000_000_000) return (v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0) + 'M';
    return (v / 1_000_000_000).toFixed(v < 10_000_000_000 ? 1 : 0) + 'B';
}

// ── START ─────────────────────────────────────────────────────
async function startBot() {
    if (!ROBLOX_COOKIE) {
        console.warn('[BOT] Pomijam — brak ROBLOX_COOKIE. Ustaw zmienną środowiskową.');
        return;
    }
    console.log('[BOT] Uruchamianie...');

    // Zaloguj się przez cookie
    try {
        await noblox.setCookie(ROBLOX_COOKIE);
        const me = await noblox.getCurrentUser();
        console.log(`[BOT] Zalogowano jako: ${me.UserName} (${me.UserID})`);
    } catch (e) {
        console.error('[BOT] BŁĄD LOGOWANIA:', e.message);
        console.error('[BOT] Sprawdź ROBLOX_COOKIE w .env');
        return; // nie wychodź z procesu — server ma dalej działać
    }

    // Uruchom pętlę
    console.log(`[BOT] Pętla co ${POLL_MS / 1000}s`);
    processPendingDeposits();
    setInterval(processPendingDeposits, POLL_MS);
}

// Gdy uruchomiony bezpośrednio: node bot.js
if (require.main === module) {
    startBot();
}

// Gdy zaimportowany: const { startBot } = require('./bot.js')
module.exports = { startBot };