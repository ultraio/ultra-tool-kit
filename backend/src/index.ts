// Hono app entry — wires auth router, middleware stack, and the real
// /api/ai-chat handler (W3).
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
import { createAiChatRouter } from './routes/ai-chat.js';
import { NonceStore } from './auth/nonce-store.js';
import { type AuthContext, jwtAuth } from './middleware/auth.js';
import { createRateLimitStore, rateLimit } from './middleware/ratelimit.js';
import { logger, requestLogger } from './middleware/logging.js';
import { loadCatalog } from './pipeline/catalog.js';
import { loadEosioTypes } from './pipeline/validate.js';
import type { ChatProvider } from './llm/provider.js';
import { AnthropicProvider } from './llm/anthropic.js';
import { OllamaProvider } from './llm/ollama.js';
import { buildAllowlistFromEnv } from './pipeline/tools/host-allowlist.js';

export type AppConfig = {
    jwtSecret: string;
    allowedOrigins: string[];
    nonceTtlMs: number;
    devAuthBypass: boolean;
    llmProvider: 'anthropic' | 'ollama';
    // W4: host allowlist used by every tool that hits the chain RPC. Baseline
    // (`*.ultra.io`, `localhost`, `127.0.0.1`) is folded in by
    // buildAllowlistFromEnv — any extras are appended from ALLOWED_CHAIN_HOSTS.
    allowedChainHosts: string[];
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
    const rawProvider = (process.env.LLM_PROVIDER ?? 'ollama').toLowerCase();
    if (rawProvider !== 'anthropic' && rawProvider !== 'ollama') {
        throw new Error(
            `LLM_PROVIDER must be 'anthropic' or 'ollama' (roadmap §4 decision 3); got ${rawProvider}`
        );
    }

    const allowedChainHosts = [...buildAllowlistFromEnv(process.env)];

    return {
        jwtSecret: jwtSecret ?? crypto.randomUUID(),
        allowedOrigins,
        nonceTtlMs: nonceTtlSec * 1000,
        devAuthBypass,
        llmProvider: rawProvider,
        allowedChainHosts,
    };
}

function buildProvider(which: 'anthropic' | 'ollama'): ChatProvider {
    return which === 'anthropic' ? new AnthropicProvider() : new OllamaProvider();
}

export type CreateAppDeps = {
    provider?: ChatProvider; // tests inject a mock
};

export async function createApp(cfg: AppConfig, deps: CreateAppDeps = {}) {
    const app = new Hono<AuthContext>();

    app.use('*', requestLogger);
    app.use('*', cors({ origin: cfg.allowedOrigins, allowMethods: ['GET', 'POST', 'OPTIONS'] }));

    const nonceStore = new NonceStore(cfg.nonceTtlMs);
    const rateLimitStore = createRateLimitStore();

    app.route('/api/auth', createAuthRouter({ nonceStore, jwtSecret: cfg.jwtSecret }));

    // /api/ai-chat behind the same auth + rate-limit stack the W1.5
    // placeholder used. Catalog + eosio-types loaded ONCE at boot per
    // backend/CLAUDE.md ("no LLM in the fact path"; deterministic data
    // sourced from disk, never re-fetched per request).
    const catalog = await loadCatalog();
    const eosioTypes = await loadEosioTypes();
    const provider = deps.provider ?? buildProvider(cfg.llmProvider);

    app.use('/api/ai-chat', jwtAuth({ jwtSecret: cfg.jwtSecret, devBypass: cfg.devAuthBypass }));
    app.use('/api/ai-chat', rateLimit(rateLimitStore));
    app.route(
        '/api/ai-chat',
        createAiChatRouter({ provider, catalog, eosioTypes, allowedChainHosts: cfg.allowedChainHosts })
    );

    return app;
}

async function main() {
    const cfg = readConfig();
    const app = await createApp(cfg);
    const host = process.env.BIND_HOST ?? '127.0.0.1';
    const port = Number(process.env.BIND_PORT ?? 8787);
    serve({ fetch: app.fetch, hostname: host, port });
    logger.info({ host, port, origins: cfg.allowedOrigins, llm: cfg.llmProvider }, 'backend listening');
}

// Only run when invoked as the entry point (preserves test-time importability).
const invoked = process.argv[1];
if (invoked && import.meta.url === new URL(`file://${invoked}`).href) {
    main();
}
