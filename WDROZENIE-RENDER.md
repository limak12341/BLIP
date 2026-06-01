# BFLIP — wdrożenie na Render (Docker)

Link będzie działał z Polski, USA, Grecji itd. (np. `https://bflip.onrender.com`).

> **Metoda deploymentu:** Docker (multi-stage build)
> Obraz: Node 22-alpine · non-root user · health check · .dockerignore

---

## Krok 1 — GitHub (jednorazowo)

1. Załóż konto: https://github.com (jeśli nie masz).
2. Na GitHubie: **New repository** → nazwa np. `bflip` → **Create** (bez README).
3. Na swoim PC otwórz PowerShell w folderze projektu:

```powershell
cd "c:\Users\PC\Desktop\projekt html"
git init
git add .
git commit -m "BloxyFlip - wersja pod hosting"
```

4. Podłącz repozytorium (zamień `TWOJ_NICK` na swój login GitHub):

```powershell
git branch -M main
git remote add origin https://github.com/TWOJ_NICK/bflip.git
git push -u origin main
```

GitHub poprosi o login — użyj konta lub [Personal Access Token](https://github.com/settings/tokens) zamiast hasła.

---

## Krok 2 — Render (hosting z Docker)

1. Wejdź na https://render.com → **Get Started** (możesz zalogować się przez GitHub).
2. **New +** → **Web Service**.
3. Połącz repozytorium **bflip** z listy.
4. Ustawienia:
   - **Name:** `bflip` (będzie w URL — np. https://bflip.onrender.com).
   - **Region:** Frankfurt (najbliżej Polski) lub dowolny.
   - **Branch:** `main`
   - **Runtime:** Docker
   - **Dockerfile Path:** `./Dockerfile` (domyślnie auto-wykrywany)
   - **Instance Type:** Starter (od $7/mies.)
5. **Environment Variables** (Render może je pobrać z `render.yaml`):
   - `NODE_ENV` = `production`
   - `SESSION_SECRET` → **Generate** (losowy klucz)
   - `ADMIN_TOKEN` → ustaw swój token admina (np. długi losowy ciąg)
   - `ENABLE_BOT` = `true` (jeśli chcesz bota)
   - `ROBLOX_COOKIE` → wklej cookie konta bota
   - `SENTRY_DSN` → (opcjonalnie) monitoring błędów
6. **Create Web Service** — czekaj 3–8 minut na pierwszy build.

> **Dlaczego Docker?** Pełna kontrola nad środowiskiem, lżejszy obraz (~120MB vs ~300MB), szybszy start, powtarzalne builds.

---

## Krok 3 — Redis (wymagany)

Redis jest **wymagany** do sesji, czatu i rate limiting-u. Render automatycznie podłącza Redis przez `render.yaml`.

1. W panelu Render: **New +** → **Redis**.
2. Nazwa: `redis-bflip`, plan: Starter.
3. Skonfigurowany jest już w `render.yaml` — Render sam doda zmienną `REDIS_URL`.

---

## Krok 4 — Gotowy link

Góra panelu Render: **URL** typu:

`https://bflip.onrender.com`

Ten link wysyłasz znajomym (Polska, USA, Grecja).

---

## Dockerfile — co zawiera

```
Dockerfile
├── BUILD STAGE (node:22-alpine)
│   ├── npm ci --ignore-scripts
│   ├── Kopiowanie kodu
│   └── Usuwanie plików testowych
└── PRODUCTION STAGE (node:22-alpine)
    ├── Non-root user (appuser:1001)
    ├── npm prune --production (lekki obraz)
    ├── HEALTHCHECK (co 30s, port z $PORT)
    └── CMD: node server.js
```

---

## Aktualizacja gry po zmianach w kodzie

```powershell
cd "c:\Users\PC\Desktop\projekt html"
git add .
git commit -m "opis zmian"
git push
```

Render sam przebuduje Docker image (2–5 min).

---

## Diagnostyka

### Health check
```bash
curl https://bflip.onrender.com/health
# → {"status":"ok","uptime":123.456,"timestamp":...,"connections":5}
```

### Logi
W panelu Render → zakładka **Logs** — zobaczyć logi z buildu i serwera.

### Debugowanie
- Brak logów? Sprawdź czy `NODE_ENV=production` jest ustawione.
- Sesje nie działają? Upewnij się, że Redis jest podłączony (zmienna `REDIS_URL`).
- Bot nie startuje? Sprawdź `ENABLE_BOT=true` i `ROBLOX_COOKIE`.

---

## Koszty

| Usługa | Plan | Cena |
|--------|------|------|
| Web Service (bflip) | Starter | ~$7/mies. |
| Redis | Starter | ~$7/mies. |
| **Razem** | | **~$14/mies.** |

> Plan Free nie jest zalecany — aplikacja "śpi" po 15 min bez wejść (cold start 30–60s).
