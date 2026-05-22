// Hono app entry — wires auth router, middleware stack, and the placeholder
// /api/ai-chat route W3 will swap for the real handler.
//
// Network posture (guidelines §4.6): binds 127.0.0.1 only (BIND_HOST env
// override is documented but defaults loopback); CORS allowlist parsed from
// ALLOWED_ORIGINS — never `*`. JWT_SECRET is required in non-dev; refusing
// to start without it is the hard failure mode the doc demands.

import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';

import { createAuthRouter } from './routes/auth.js';
import { NonceStore } from './auth/nonce-store.js';
import { type AuthContext, jwtAuth } from './middleware/auth.js';
import { createRateLimitStore, rateLimit } from './middleware/ratelimit.js';
import { logger, requestLogger } from './middleware/logging.js';

export type AppConfig = {
    jwtSecret: string;
    allowedOrigins: string[];
    nonceTtlMs: number;
    devAuthBypass: boolean;
};

function readConfig(): AppConfig {
    const isProd = process.env.NODE_ENV === 'production';
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        if (isProd) {
            throw new Error('JWT_SECRET is required in non-dev environments (guidelines §3.2).');
        }
        // Dev fallback: random per-process secret. Forces a fresh login each
        // restart in local dev, which is the correct UX for a missing secret.
        logger.warn('JWT_SECRET not set; using a per-process random fallback (dev only).');
    }

    const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5172')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (allowedOrigins.includes('*')) {
        // Guidelines §4.6: "no `*`". Treat as a startup configuration error.
        throw new Error('ALLOWED_ORIGINS must not contain `*` (guidelines §4.6).');
    }

    const nonceTtlSec = Number(process.env.NONCE_TTL_SECONDS ?? 300);
    const devAuthBypass = process.env.DEV_AUTH_BYPASS === 'true';

    return {
        jwtSecret: jwtSecret ?? crypto.randomUUID(),
        allowedOrigins,
        nonceTtlMs: nonceTtlSec * 1000,
        devAuthBypass,
    };
}

export function createApp(cfg: AppConfig) {
    const app = new Hono<AuthContext>();

    app.use('*', requestLogger);
    app.use('*', cors({ origin: cfg.allowedOrigins, allowMethods: ['GET', 'POST', 'OPTIONS'] }));

    const nonceStore = new NonceStore(cfg.nonceTtlMs);
    const rateLimitStore = createRateLimitStore();

    app.route('/api/auth', createAuthRouter({ nonceStore, jwtSecret: cfg.jwtSecret }));

    // Placeholder /api/ai-chat behind the auth + rate-limit stack. W3 swaps
    // this for the real pipeline handler. 405 says "you're authed but the
    // real handler isn't wired yet" — distinct from the auth middleware's
    // 401 and from the rate-limit middleware's 200/refuse.
    app.use('/api/ai-chat', jwtAuth({ jwtSecret: cfg.jwtSecret, devBypass: cfg.devAuthBypass }));
    app.use('/api/ai-chat', rateLimit(rateLimitStore));
    app.post('/api/ai-chat', (c) =>
        c.json({ kind: 'refuse', reason: 'not-implemented', wave: 'W3' }, 405)
    );

    return app;
}

function main() {
    const cfg = readConfig();
    const app = createApp(cfg);
    const host = process.env.BIND_HOST ?? '127.0.0.1';
    const port = Number(process.env.BIND_PORT ?? 8787);
    serve({ fetch: app.fetch, hostname: host, port });
    logger.info({ host, port, origins: cfg.allowedOrigins }, 'backend listening');
}

// Only run when invoked as the entry point (preserves test-time importability).
const invoked = process.argv[1];
if (invoked && import.meta.url === new URL(`file://${invoked}`).href) {
    main();
}
