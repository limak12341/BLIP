# ── BUILD STAGE ──────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Najpierw kopiuj package*.json dla lepszego cache'owania warstw
COPY package*.json ./

# Instaluj wszystkie zależności (w tym devDependencies dla testów)
RUN npm ci --ignore-scripts && npm cache clean --force

# Kopiuj resztę kodu
COPY . .

# Usuń pliki testowe i tymczasowe z obrazu produkcyjnego
RUN rm -rf tests/ test-results/ playwright.config.js

# ── PRODUCTION STAGE ─────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Zabezpieczenia: nie uruchamiaj jako root
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# Kopiuj tylko to, co niezbędne z build stage
COPY --from=builder /app /app

# Usuń devDependencies (produkcja = lekki obraz)
RUN npm prune --production --ignore-scripts && \
    npm cache clean --force && \
    rm -rf /root/.npm /tmp/*

# Stwórz katalog na dane z odpowiednimi uprawnieniami
RUN mkdir -p /app/data && chown -R appuser:appgroup /app/data

# Health check — Render używa go do monitorowania
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 10000) + '/', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))"

EXPOSE ${PORT:-10000}

USER appuser

ENV NODE_ENV=production

CMD ["node", "server.js"]
