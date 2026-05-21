# BFLIP — wdrożenie na Render (za darmo)

Link będzie działał z Polski, USA, Grecji itd. (np. `https://bflip.onrender.com`).

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

## Krok 2 — Render (hosting)

1. Wejdź na https://render.com → **Get Started** (możesz zalogować się przez GitHub).
2. **New +** → **Web Service**.
3. Połącz repozytorium **bflip** z listy.
4. Ustawienia:
   - **Name:** `bflip` (będzie w URL — np. https://bflip.onrender.com).
   - **Region:** Frankfurt (najbliżej Polski) lub dowolny.
   - **Branch:** `main`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** **Free**
5. **Environment Variables** (opcjonalnie — Render może sam z `render.yaml`):
   - `NODE_ENV` = `production`
   - `SESSION_SECRET` → **Generate** (losowy klucz)
   - `ADMIN_TOKEN` → ustaw swój token admina (np. długi losowy ciąg)
6. **Create Web Service** — czekaj 3–8 minut na pierwszy deploy.

---

## Krok 3 — Gotowy link

Góra panelu Render: **URL** typu:

`https://bflip.onrender.com`

Ten link wysyłasz znajomym (Polska, USA, Grecja).

**Uwaga:** plan Free „śpi” po ~15 min bez wejść — pierwsze otwarcie może trwać **30–60 sekund**. Na lekcję otwórz stronę minutę wcześniej.

---

## Aktualizacja gry po zmianach w kodzie

```powershell
cd "c:\Users\PC\Desktop\projekt html"
git add .
git commit -m "opis zmian"
git push
```

Render sam przebuduje stronę (2–5 min).

