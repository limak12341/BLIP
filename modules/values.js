const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── Persistent cache ──
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'valuesCache.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const CACHE_TTL_MS = 30 * 60 * 1000;    // 30 min — uznajemy cache za świeży
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h między pobraniami

let valueCache = {};       // name -> { value, category, trend, updatedAt }
let lastFetchTime = 0;
let refreshTimer = null;
let fetchInProgress = false;

// ── Known item categories (wykrywane z nazwy) ──
function detectCategory(name) {
    const lower = name.toLowerCase();
    if (lower.includes('titanic')) return 'Titanic';
    if (lower.includes('gargantuan')) return 'Gargantuan';
    if (lower.includes('huge')) return 'Huge';
    if (lower.startsWith('gem 💎') || lower.startsWith('gem')) return 'Gem';
    if (lower.includes('exclusive')) return 'Exclusive';
    if (lower.includes('shiny')) return 'Shiny';
    if (lower.includes('rainbow')) return 'Rainbow';
    if (lower.includes('golden')) return 'Golden';
    return 'Misc';
}

// ── Parsowanie liczby z suffixem (17.5B, 875M, 999T) ──
function parseValue(str) {
    if (!str || typeof str !== 'string') return 0;
    const cleaned = str.replace(/[^0-9.,BTMbtm]/g, '').trim();
    if (!cleaned) return 0;
    const match = cleaned.match(/^([0-9,.]+)\s*([BTMbtm])?$/);
    if (!match) return 0;
    let num = parseFloat(match[1].replace(/,/g, ''));
    if (isNaN(num)) return 0;
    const suffix = (match[2] || '').toUpperCase();
    if (suffix === 'T') num *= 1_000_000_000_000;
    else if (suffix === 'B') num *= 1_000_000_000;
    else if (suffix === 'M') num *= 1_000_000;
    return Math.floor(num);
}

// ── Formatowanie liczby na czytelny string (dla API) ──
function formatValue(num) {
    const raw = Number(num);
    const v = raw / 1000; // scale down by 1000
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

// ── Load / Save cache ──
function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            valueCache = data.cache || {};
            lastFetchTime = data.lastFetchTime || 0;
            return true;
        }
    } catch (e) {
        // ignore
    }
    return false;
}

function saveCache() {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({
            cache: valueCache,
            lastFetchTime,
            updatedAt: Date.now()
        }, null, 2));
    } catch (e) {
        console.error('[Values] Save cache error:', e.message);
    }
}

// ── Fetch strony z User-Agent ──
function fetchPage(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://petsimulatorvalues.com/'
            },
            timeout: 20000
        }, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, url).toString();
                return fetchPage(redirectUrl).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ── Parsowanie tekstu z petsimulatorvalues.com ──
// Format (z read_url):
//   HUGE CAT
//   Variant
//   Normal
//   Value
//   ▼ 500M | 17.5B
//   Demand
//   7/10
//   RAP: 31.96B
//   EXIST: 388
function parseValuesText(text) {
    const items = {};
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    
    let currentName = null;
    let currentData = {};
    let inItem = false;
    let expectingValue = false;
    let afterValueArrow = false;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip headers/footers
        if (line.includes('Cosmic Values') || line.includes('Copyright') || 
            line.includes('Toggle') || line.includes('Privacy Policy') ||
            line.includes('Our Team') || line.includes('Your Inventory') ||
            line.includes('Total Value') || line.includes('Items:')) {
            continue;
        }
        
        // Skip site navigation lines
        if (line.length > 80 || line.startsWith('http')) continue;
        
        // Item names are in ALL CAPS and are 2-5 words
        // Detect new item: line is uppercase, not a field name, and has reasonable length
        const isUppercase = line === line.toUpperCase() && /[A-Z]{3,}/.test(line);
        const isFieldName = ['VARIANT', 'NORMAL', 'GOLDEN', 'RAINBOW', 'VALUE', 'DEMAND', 'RAP:', 'EXIST:', 'LAST UPDATED:'].includes(line.toUpperCase());
        const isVariant = ['Normal', 'Golden', 'Rainbow', 'Shiny'].includes(line);
        
        if (isUppercase && !isFieldName && line.length > 2 && line.length < 50) {
            // Save previous item
            if (currentName && (currentData.value || currentData.rap)) {
                const name = currentName;
                const value = Math.max(currentData.value || 0, currentData.rap || 0);
                const category = detectCategory(name);
                if (value > 0 && !items[name]) {
                    items[name] = {
                        name,
                        category,
                        value,
                        rap: currentData.rap || 0,
                        trend: currentData.trend || 'neutral',
                        variant: currentData.variant || 'Normal',
                        updatedAt: Date.now()
                    };
                }
            }
            
            // Start new item
            currentName = line;
            currentData = {};
            inItem = true;
            expectingValue = false;
            afterValueArrow = false;
            continue;
        }
        
        if (!inItem || !currentName) continue;
        
        // Track variant
        if (isVariant) {
            currentData.variant = line;
            continue;
        }
        
        // "Value" field - next significant line has the value
        if (line === 'Value') {
            expectingValue = true;
            afterValueArrow = false;
            continue;
        }
        
        // Lines with trend arrows: ▲ 500M | 17.5B
        if (expectingValue || afterValueArrow) {
            const trendMatch = line.match(/^[▲▼]\s*([0-9,.]+[BTMbtm]?)\s*\|\s*([0-9,.]+[BTMbtm])/);
            if (trendMatch) {
                currentData.value = parseValue(trendMatch[2]);
                currentData.trend = line.startsWith('▲') ? 'up' : 'down';
                expectingValue = false;
                afterValueArrow = false;
                continue;
            }
            
            // Value without arrow: just "17.5B"
            const valMatch = line.match(/^([0-9,.]+[BTMbtm])(?:\s|$)/);
            if (valMatch && !line.startsWith('RAP:') && !line.startsWith('EXIST:')) {
                currentData.value = parseValue(valMatch[1]);
                expectingValue = false;
                afterValueArrow = false;
                continue;
            }
            
            // If we hit a field name, stop expecting value
            if (line === 'Demand' || line.startsWith('RAP:') || line.startsWith('EXIST:')) {
                expectingValue = false;
                afterValueArrow = false;
            }
        }
        
        // Handle arrow+value in same line (when Variant line was skipped)
        if (line.startsWith('▲') || line.startsWith('▼')) {
            afterValueArrow = true;
            const trendMatch = line.match(/^[▲▼]\s*([0-9,.]+[BTMbtm]?)\s*\|\s*([0-9,.]+[BTMbtm])/);
            if (trendMatch) {
                currentData.value = parseValue(trendMatch[2]);
                currentData.trend = line.startsWith('▲') ? 'up' : 'down';
                afterValueArrow = false;
            } else {
                // Might be just the arrow line, value on next
                const arrowOnly = line.match(/^[▲▼]/);
                if (arrowOnly) {
                    const valOnSame = line.match(/[0-9,.]+[BTMbtm]/);
                    if (valOnSame) {
                        currentData.value = parseValue(valOnSame[0]);
                        currentData.trend = line.startsWith('▲') ? 'up' : 'down';
                        afterValueArrow = false;
                    }
                }
            }
            continue;
        }
        
        // "|" divider line (value on its own)
        if (line === '|' || line === '|' || line === '—' || line === '–') {
            continue;
        }
        
        // "999T" etc - standalone value
        if (/^[0-9,.]+[BTMbtm]$/.test(line) && !line.startsWith('RAP:') && !line.startsWith('EXIST:')) {
            if (expectingValue || afterValueArrow) {
                currentData.value = parseValue(line);
                expectingValue = false;
                afterValueArrow = false;
            }
            continue;
        }
        
        // RAP: 18.25B
        if (line.startsWith('RAP:')) {
            currentData.rap = parseValue(line.replace('RAP:', '').trim());
            continue;
        }
        
        // Demand: 7/10
        if (line.startsWith('Demand') || line === 'Demand') {
            continue;
        }
        
        // EXIST: 3850
        if (line.startsWith('EXIST:')) {
            continue;
        }
        
        // Last updated: ...
        if (line.toLowerCase().includes('last updated')) {
            continue;
        }
    }
    
    // Save last item
    if (currentName && (currentData.value || currentData.rap)) {
        const name = currentName;
        const value = Math.max(currentData.value || 0, currentData.rap || 0);
        const category = detectCategory(name);
        if (value > 0 && !items[name]) {
            items[name] = {
                name,
                category,
                value,
                rap: currentData.rap || 0,
                trend: currentData.trend || 'neutral',
                variant: currentData.variant || 'Normal',
                updatedAt: Date.now()
            };
        }
    }
    
    return items;
}

// ── Parsowanie HTML (wyciąga tekst i parsuje) ──
function parseValuesPage(html) {
    // Extract visible text from HTML (similar to what read_url does)
    // Remove scripts, styles, navigation
    let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, '\n') // Replace tags with newlines
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    
    return parseValuesText(text);
}

// ── Aktualizacja cache ──
async function refreshValues() {
    if (fetchInProgress) return;
    fetchInProgress = true;
    
    try {
        console.log('[Values] Fetching from petsimulatorvalues.com...');
        const html = await fetchPage('https://petsimulatorvalues.com/values.php?category=all');
        
        // Try parsing full HTML first
        let parsed = parseValuesPage(html);
        
        // If HTML parsing gave few results, try parsing the raw text
        if (Object.keys(parsed).length < 5) {
            // Strip HTML tags to get plain text, then parse
            const text = html.replace(/<[^>]+>/g, '\n').replace(/&[^;]+;/g, ' ');
            parsed = parseValuesText(text);
        }
        
        const count = Object.keys(parsed).length;
        console.log(`[Values] Parsed ${count} items from source`);
        
        if (count > 10) {
            // Merge - keep existing items if they have better data
            for (const [name, data] of Object.entries(parsed)) {
                const existing = valueCache[name];
                if (!existing || data.updatedAt > (existing.updatedAt || 0)) {
                    valueCache[name] = data;
                }
            }
            // Add items from this fetch that aren't in cache
            lastFetchTime = Date.now();
            saveCache();
            console.log(`[Values] Updated cache: ${Object.keys(valueCache).length} total items`);
        } else if (count > 0) {
            // Partial results - keep what we got but note it
            for (const [name, data] of Object.entries(parsed)) {
                valueCache[name] = data;
            }
            saveCache();
            console.warn(`[Values] Only ${count} items parsed, cache may be incomplete`);
        } else {
            console.warn('[Values] No items parsed, keeping existing cache');
            // If cache is completely empty, try force-populating from fallback
            if (Object.keys(valueCache).length === 0) {
                console.log('[Values] Cache empty, populating with fallback values');
                populateFallback();
            }
        }
    } catch (e) {
        console.error('[Values] Fetch error:', e.message);
        // If cache is empty, populate with fallback
        if (Object.keys(valueCache).length === 0) {
            console.log('[Values] Using fallback values');
            populateFallback();
        }
    } finally {
        fetchInProgress = false;
    }
}

// ── Fallback values (gdy scraper nie działa) ──
function populateFallback() {
    const fallbackItems = [
        { name: 'Huge Cat', value: 17500000000, category: 'Huge' },
        { name: 'Rainbow Huge Cat', value: 35000000000, category: 'Huge' },
        { name: 'Golden Huge Cat', value: 88000000000, category: 'Huge' },
        { name: 'Huge Dog', value: 875000000, category: 'Huge' },
        { name: 'Golden Huge Dog', value: 1200000000, category: 'Huge' },
        { name: 'Rainbow Huge Dog', value: 5400000000, category: 'Huge' },
        { name: 'Huge Dragon', value: 750000000, category: 'Huge' },
        { name: 'Golden Huge Dragon', value: 575000000, category: 'Huge' },
        { name: 'Rainbow Huge Dragon', value: 4450000000, category: 'Huge' },
        { name: 'Huge Storm Agony', value: 4500000000, category: 'Huge' },
        { name: 'Golden Huge Storm Agony', value: 3750000000, category: 'Huge' },
        { name: 'Rainbow Huge Storm Agony', value: 5100000000, category: 'Huge' },
        { name: 'Huge Santa Paws', value: 2350000000, category: 'Huge' },
        { name: 'Golden Huge Santa Paws', value: 1975000000, category: 'Huge' },
        { name: 'Rainbow Huge Santa Paws', value: 7600000000, category: 'Huge' },
        { name: 'Huge Forest Wyvern', value: 2000000000, category: 'Huge' },
        { name: 'Golden Huge Forest Wyvern', value: 1450000000, category: 'Huge' },
        { name: 'Rainbow Huge Forest Wyvern', value: 3550000000, category: 'Huge' },
        { name: 'Huge Hacked Cat', value: 725000000, category: 'Huge' },
        { name: 'Golden Huge Hacked Cat', value: 315000000, category: 'Huge' },
        { name: 'Rainbow Huge Hacked Cat', value: 1550000000, category: 'Huge' },
        { name: 'Huge Pixel Cat', value: 325000000, category: 'Huge' },
        { name: 'Golden Huge Pixel Cat', value: 175000000, category: 'Huge' },
        { name: 'Rainbow Huge Pixel Cat', value: 1500000000, category: 'Huge' },
        { name: 'Huge Pumpkin Cat', value: 750000000, category: 'Huge' },
        { name: 'Huge Lucky Cat', value: 2350000000, category: 'Huge' },
        { name: 'Golden Huge Lucky Cat', value: 2250000000, category: 'Huge' },
        { name: 'Rainbow Huge Lucky Cat', value: 4350000000, category: 'Huge' },
        { name: 'Huge Easter Cat', value: 2300000000, category: 'Huge' },
        { name: 'Golden Huge Easter Cat', value: 1200000000, category: 'Huge' },
        { name: 'Rainbow Huge Easter Cat', value: 3450000000, category: 'Huge' },
        { name: 'Huge Super Corgi', value: 710000000, category: 'Huge' },
        { name: 'Golden Huge Super Corgi', value: 985000000, category: 'Huge' },
        { name: 'Rainbow Huge Super Corgi', value: 2100000000, category: 'Huge' },
        { name: 'Huge Cupcake', value: 390000000, category: 'Huge' },
        { name: 'Golden Huge Cupcake', value: 165000000, category: 'Huge' },
        { name: 'Rainbow Huge Cupcake', value: 1750000000, category: 'Huge' },
        { name: 'Huge Pony', value: 735000000, category: 'Huge' },
        { name: 'Golden Huge Pony', value: 1350000000, category: 'Huge' },
        { name: 'Rainbow Huge Pony', value: 2850000000, category: 'Huge' },
        { name: 'Huge Festive Cat', value: 600000000, category: 'Huge' },
        { name: 'Huge Gargoyle Dragon', value: 1350000000, category: 'Huge' },
        { name: 'Golden Huge Gargoyle Dragon', value: 1250000000, category: 'Huge' },
        { name: 'Rainbow Huge Gargoyle Dragon', value: 3150000000, category: 'Huge' },
        { name: 'Huge Rainbow Unicorn', value: 635000000, category: 'Huge' },
        { name: 'Golden Huge Rainbow Unicorn', value: 675000000, category: 'Huge' },
        { name: 'Rainbow Huge Rainbow Unicorn', value: 2200000000, category: 'Huge' },
        { name: 'Titanic Cat', value: 999000000000000, category: 'Titanic' },
        { name: 'Titanic Dog', value: 500000000000000, category: 'Titanic' },
        { name: 'Titanic Dragon', value: 800000000000000, category: 'Titanic' },
        { name: 'Gargantuan Cat', value: 5000000000000, category: 'Gargantuan' },
        { name: 'Gargantuan Dog', value: 4500000000000, category: 'Gargantuan' },
        { name: 'Gem 💎 1M', value: 1000000, category: 'Gem' },
        { name: 'Gem 💎 10M', value: 10000000, category: 'Gem' },
        { name: 'Gem 💎 25M', value: 25000000, category: 'Gem' },
        { name: 'Gem 💎 50M', value: 50000000, category: 'Gem' },
        { name: 'Gem 💎 100M', value: 100000000, category: 'Gem' },
        { name: 'Gem 💎 500M', value: 500000000, category: 'Gem' },
    ];
    
    for (const item of fallbackItems) {
        if (!valueCache[item.name]) {
            valueCache[item.name] = {
                name: item.name,
                category: item.category,
                value: item.value,
                rap: item.value,
                trend: 'neutral',
                variant: 'Normal',
                updatedAt: Date.now()
            };
        }
    }
    lastFetchTime = Date.now();
    saveCache();
    console.log(`[Values] Populated ${fallbackItems.length} fallback items`);
}

// ── Inicjalizacja ──
function init() {
    const loaded = loadCache();
    
    if (loaded && Object.keys(valueCache).length > 0) {
        const cacheAge = Date.now() - lastFetchTime;
        console.log(`[Values] Cache loaded: ${Object.keys(valueCache).length} items, ${Math.floor(cacheAge / 60000)}min old`);
        
        // Odśwież jeśli cache stary
        if (cacheAge > CACHE_TTL_MS) {
            refreshValues();
        }
    } else {
        // Cache pusty — natychmiast populate fallback i fetch
        console.log('[Values] No cache found, populating fallback...');
        populateFallback();
        refreshValues();
    }
    
    // Okresowe odświeżanie co 6h
    refreshTimer = setInterval(refreshValues, REFRESH_INTERVAL_MS);
    
    return this;
}

// ── Stop (dla testów) ──
function stop() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

// ── Publiczne API ──

function getValue(itemName) {
    if (!itemName) return 0;
    const entry = valueCache[itemName];
    if (entry) return entry.value || entry.rap || 0;
    // Case-insensitive fallback
    const lower = itemName.toLowerCase();
    for (const [name, data] of Object.entries(valueCache)) {
        if (name.toLowerCase() === lower) return data.value || data.rap || 0;
    }
    return 0;
}

function getItems(category) {
    let items = Object.values(valueCache);
    if (category && category !== 'all') {
        const cat = category.toLowerCase();
        items = items.filter(i => i.category.toLowerCase() === cat);
    }
    return items.sort((a, b) => (b.value || 0) - (a.value || 0));
}

function getItemsWithRap(items) {
    return items.map(item => ({
        ...item,
        rap: getValue(item.name) || item.rap || 0
    }));
}

function searchItems(query, category, limit = 30) {
    let results = Object.values(valueCache);
    if (query) {
        const q = query.toLowerCase();
        results = results.filter(i => i.name.toLowerCase().includes(q));
    }
    if (category && category !== 'all') {
        results = results.filter(i => i.category.toLowerCase() === category.toLowerCase());
    }
    results.sort((a, b) => (b.value || 0) - (a.value || 0));
    if (limit > 0) results = results.slice(0, limit);
    return results;
}

function getStats() {
    const categories = {};
    for (const item of Object.values(valueCache)) {
        const cat = item.category || 'Unknown';
        categories[cat] = (categories[cat] || 0) + 1;
    }
    return {
        totalItems: Object.keys(valueCache).length,
        categories,
        lastFetchTime,
        cacheAge: Date.now() - lastFetchTime,
        isStale: lastFetchTime > 0 && (Date.now() - lastFetchTime) > CACHE_TTL_MS,
        hasCache: lastFetchTime > 0
    };
}

async function forceRefresh() {
    await refreshValues();
    return getStats();
}

// ── Eksport ──
module.exports = {
    init, stop, getValue, getItems, getItemsWithRap,
    searchItems, getStats, forceRefresh,
    formatValue, parseValue, refreshValues
};
