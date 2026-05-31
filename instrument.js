// ── Sentry initialization ──────────────────────────────────────
// Must be required BEFORE any other module in server.js
// Uses SENTRY_DSN environment variable (optional - no crash if not set)

const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        integrations: [
            nodeProfilingIntegration(),
        ],
        // Performance tracing: 1.0 = 100% of requests (reduce to ~0.1 in heavy prod)
        tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.5'),
        // Profile sampling: 1.0 = 100% of sampled traces get profiling
        profilesSampleRate: parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE || '0.5'),
        // Environment
        environment: process.env.NODE_ENV || 'development',
        // Release version from package.json or git commit
        release: process.env.npm_package_version || undefined,
    });

    console.log('[Sentry] Initialized with DSN:', process.env.SENTRY_DSN.substring(0, 20) + '...');
} else {
    console.log('[Sentry] Skipped — SENTRY_DSN not set. Set it in .env or Render env vars to enable error tracking.');
}

module.exports = Sentry;
