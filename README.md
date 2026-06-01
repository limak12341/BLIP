# BFLIP — Coinflip Game 🪙

Gra coinflip online z logowaniem przez Roblox, systemem sesji, czatem na żywo i provably fair.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/limak12341/BLIP)

---

## Funkcje

- 🎰 **Coinflip** — solo i PVP (1v1)
- 💬 **Czat na żywo** — wiadomości, Whispers, system messages
- 🔐 **Logowanie Roblox** — weryfikacja przez bio
- 🎲 **Provably Fair** — pełna weryfikowalność wyników
- 💰 **System monet i gemów** — tipping, sklep, merge gemów
- 🏆 **Leaderboard** — ranking graczy
- 🛡️ **Admin panel** — dashboard, zarządzanie graczami, logi, promocje
- 🤖 **Bot** — automatyczne przetwarzanie depozytów (opcjonalnie)
- 📊 **Sentry** — monitoring błędów (opcjonalnie)
- ⚡ **Redis** — sesje, rate limiting, czat cache

## Stack

| Technologia | Rola |
|-------------|------|
| Node.js 22 | Runtime |
| Express | HTTP server |
| Socket.IO | Real-time communication |
| Docker | Deployment (multi-stage build) |
| Redis | Sesje, rate limiting, chat cache |
| Sentry | Error monitoring |

## Szybki start (lokalnie)

```bash
# 1. Klonuj repo
git clone https://github.com/limak12341/BLIP.git
cd BLIP

# 2. Instaluj zależności
npm install

# 3. Skonfiguruj zmienne środowiskowe
echo NODE_ENV=production > .env
echo SESSION_SECRET=$(openssl rand -hex 32) >> .env
echo ADMIN_TOKEN=$(openssl rand -hex 32) >> .env
# Lub utwórz plik .env ręcznie z powyższymi zmiennymi

# 4. Uruchom
npm start
# Serwer: http://localhost:10000
```

## Wdrożenie na Render

### Opcja 1 — Deploy Button (najszybsza)

Kliknij przycisk **Deploy to Render** na górze tego README. Render automatycznie:
1. Sklonuje repozytorium
2. Zbuduje Docker image
3. Wdroży aplikację z Redis

### Opcja 2 — Ręcznie

1. Wejdź na https://render.com → **New +** → **Web Service**
2. Połącz repozytorium GitHub
3. Ustawienia:
   - **Runtime:** Docker
   - **Instance Type:** Starter
4. Environment Variables (lub użyj `render.yaml`):
   - `NODE_ENV=production`
   - `SESSION_SECRET` → Generate
   - `ADMIN_TOKEN` → Twój sekretny token
5. **Create Web Service**

Szczegóły w [WDROZENIE-RENDER.md](WDROZENIE-RENDER.md).

## Struktura projektu

```
├── server.js            # Główny serwer Express + Socket.IO
├── bot.js               # Bot Roblox (opcjonalny)
├── instrument.js        # Sentry instrumentation
├── modules/
│   ├── db.js            # Baza danych (pliki JSON)
│   ├── games.js         # Logika gier (PVP, history)
│   ├── provablyFair.js  # Provably Fair 2.0
│   └── redis.js         # Redis wrapper z fallbackiem
├── Dockerfile           # Multi-stage Docker build
├── render.yaml          # Render Blueprint (Docker + Redis)
├── index.html           # Główna strona gry
├── admin.html           # Panel admina
├── script.js            # Frontend JavaScript
├── style.css            # Style
└── tests/               # Testy (Jest + Playwright)
```

## Środowisko

| Zmienna | Opis | Wymagana |
|---------|------|----------|
| `NODE_ENV` | production / test | Tak |
| `SESSION_SECRET` | Tajemnica sesji | Tak |
| `ADMIN_TOKEN` | Token dostępu do panelu admina | Tak |
| `PORT` | Port serwera (domyślnie 10000) | Nie |
| `REDIS_URL` | URL połączenia Redis | Nie (fallback do pamięci) |
| `ENABLE_BOT` | Włącz bota (true/false) | Nie |
| `ROBLOX_COOKIE` | Cookie konta bota | Nie |
| `SENTRY_DSN` | DSN projektu Sentry | Nie |

## Testy

```bash
npm test              # Testy jednostkowe (Jest)
npm run test:e2e      # Testy E2E (Playwright)
```

## Licencja

MIT
