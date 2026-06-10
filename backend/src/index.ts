// Hono app entry — wires the middleware stack and the /api/ai-chat handler.
//
// Network posture (docs/00 §4.6): binds 127.0.0.1 only; CORS allowlist
// parsed from ALLOWED_ORIGINS — never `*`. Backend is anonymous (docs/00
// §3.1) — no JWT layer; per-IP rate limit + monthly cost cap (docs/00 §3.2)
// are the binding defenses.

// Load .env with override so a stale or empty shell-exported var doesn't
// silently mask the file's value. Common foot-gun: a parent terminal /
// editor exports `ANTHROPIC_API_KEY=` for sandboxing; dotenv's default
// "preserve existing" behavior would keep the empty string and the provider
// would throw `ANTHROPIC_API_KEY is not set` on every chat — surfacing only
// as `kind: 'refuse', reason: 'retries-exhausted'` from the harness.
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';

import { createAiChatRouter } from './routes/ai-chat.js';
import { createAiUsageRouter } from './routes/ai-usage.js';
import { createRateLimitStore, rateLimit } from './middleware/ratelimit.js';
import { logger, requestLogger } from './middleware/logging.js';
import { isKnownModelTag, usageLog } from './middleware/usage-log.js';
import { attestation } from './middleware/attestation.js';
import { balanceGate } from './middleware/balance-gate.js';
import { quotaGate } from './middleware/quota-gate.js';
import { createAiQuotaRouter } from './routes/ai-quota.js';
import { InMemoryUsageStore } from './usage/store.js';
import type { UsageStore } from './usage/store.js';
import { StakeReader } from './usage/stake.js';
import { PriceSource } from './usage/price.js';
import { readQuotaConfig } from './usage/quota-config.js';
import { loadCatalog } from './pipeline/catalog.js';
import { loadEosioTypes } from './pipeline/validate.js';
import type { ChatProvider } from './llm/provider.js';
import { AnthropicProvider } from './llm/anthropic.js';
import { OllamaProvider } from './llm/ollama.js';
import { buildAllowlistFromEnv } from './pipeline/tools/host-allowlist.js';

export type AppConfig = {
    allowedOrigins: string[];
    devRatelimitBypass: boolean;
    llmProvider: 'anthropic' | 'ollama';
    // W4: host allowlist used by every tool that hits the chain RPC. Baseline
    // (`*.ultra.io`, `localhost`, `127.0.0.1`) is folded in by
    // buildAllowlistFromEnv — any extras are appended from ALLOWED_CHAIN_HOSTS.
    allowedChainHosts: string[];
    // W9 (docs/00 §3.7). Attested callers only.
    balanceThresholdUos?: number; // min summed UOS across signableAccounts; createApp defaults to 1.0
    attestationChainId?: string; // when set, attestations must match this chainId
};

function readConfig(): AppConfig {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5172')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (allowedOrigins.includes('*')) {
        // Guidelines §4.6: "no `*`". Treat as a startup configuration error.
        throw new Error('ALLOWED_ORIGINS must not contain `*` (guidelines §4.6).');
    }

    const devRatelimitBypass = process.env.DEV_RATELIMIT_BYPASS === 'true';
    const rawProvider = (process.env.LLM_PROVIDER ?? 'ollama').toLowerCase();
    if (rawProvider !== 'anthropic' && rawProvider !== 'ollama') {
        throw new Error(`LLM_PROVIDER must be 'anthropic' or 'ollama' (roadmap §4 decision 3); got ${rawProvider}`);
    }

    const allowedChainHosts = [...buildAllowlistFromEnv(process.env)];

    const rawThreshold = process.env.BALANCE_THRESHOLD_UOS;
    const balanceThresholdUos =
        rawThreshold && rawThreshold.trim() !== '' && Number.isFinite(Number(rawThreshold))
            ? Number(rawThreshold)
            : 1.0;
    const attestationChainId = process.env.ATTESTATION_CHAIN_ID?.trim() || undefined;

    return {
        allowedOrigins,
        devRatelimitBypass,
        llmProvider: rawProvider,
        allowedChainHosts,
        balanceThresholdUos,
        attestationChainId,
    };
}

function buildProvider(which: 'anthropic' | 'ollama'): ChatProvider {
    return which === 'anthropic' ? new AnthropicProvider() : new OllamaProvider();
}

export type CreateAppDeps = {
    provider?: ChatProvider; // tests inject a mock
    usageLogPath?: string; // tests point the JSONL at a temp file
    readUosBalance?: (account: string, endpoint: string) => Promise<number>; // tests stub the balance gate
    attestationNow?: () => number; // tests control the attestation clock (unix seconds)
    // W10 test seams:
    readStakedUos?: (account: string, endpoint: string) => Promise<number>; // tests stub the stake reader
    readUosPrice?: (endpoint: string) => Promise<number>; // tests stub the price oracle
    usageStore?: UsageStore; // tests inject a pre-seeded store
};

export async function createApp(cfg: AppConfig, deps: CreateAppDeps = {}) {
    const app = new Hono();

    app.use('*', requestLogger);
    app.use('*', cors({ origin: cfg.allowedOrigins, allowMethods: ['GET', 'POST', 'OPTIONS'] }));

    const rateLimitStore = createRateLimitStore();

    // W10 (docs/00 §3.8): per-identity daily cost cap. Single in-memory store
    // shared by the gate and the /api/ai-quota read (single instance, roadmap §9).
    const quotaConfig = readQuotaConfig(process.env);
    const usageStore = deps.usageStore ?? new InMemoryUsageStore();
    const stakeReader = new StakeReader({ allowlist: cfg.allowedChainHosts });
    const priceSource = new PriceSource({
        allowlist: cfg.allowedChainHosts,
        fallbackUsd: quotaConfig.priceFallbackUsd,
        maxAgeS: quotaConfig.priceMaxAgeS,
    });
    const readStakedUos = deps.readStakedUos ?? ((acct: string, ep: string) => stakeReader.getStakedUos(acct, ep));
    const readUosPrice = deps.readUosPrice ?? ((ep: string) => priceSource.getUosPriceUsd(ep));
    const quotaDeps = { config: quotaConfig, store: usageStore, readStakedUos, readUosPrice };

    // /api/ai-chat — catalog + eosio-types loaded ONCE at boot per
    // backend/CLAUDE.md ("no LLM in the fact path"; deterministic data
    // sourced from disk, never re-fetched per request).
    const catalog = await loadCatalog();
    const eosioTypes = await loadEosioTypes();
    const provider = deps.provider ?? buildProvider(cfg.llmProvider);

    // G6: model-tag → price-table parity check. Silent cost_usd = 0 would
    // mean the per-month USD cap (§3.3 tier 5) becomes a no-op for this model.
    // Warning-only — boot still succeeds; operator updates PRICE_TABLE via
    // doc PR if the model rolled.
    const tag = provider.modelTag();
    if (!isKnownModelTag(tag)) {
        logger.warn(
            { modelTag: tag },
            'pricing: provider model tag is not in PRICE_TABLE; cost_usd will be 0 for every row. Update backend/src/middleware/usage-log.ts.'
        );
    }

    // W9 (docs/00 §3.7): wallet-native attestation chain on /api/ai-chat,
    // mounted BEFORE rate-limit so the final order is
    // attestation → balance-gate → ratelimit → usageLog → router.
    // attestation is opportunistic (never 401s); balance-gate is a no-op
    // unless attestation set c.var.identity.
    if (!cfg.attestationChainId) {
        logger.warn(
            'attestation: ATTESTATION_CHAIN_ID is unset — attestations are accepted for ANY chainId (origin + exp + signature still bind). Set it to enforce chain-binding per docs/proposals/wallet-native-attestation.md §5.'
        );
    }
    app.use(
        '/api/ai-chat',
        attestation({
            allowedOrigins: cfg.allowedOrigins,
            expectedChainId: cfg.attestationChainId,
            now: deps.attestationNow,
        })
    );
    app.use(
        '/api/ai-chat',
        balanceGate({
            thresholdUos: cfg.balanceThresholdUos ?? 1.0,
            catalog,
            allowlist: cfg.allowedChainHosts,
            readUosBalance: deps.readUosBalance,
        })
    );

    app.use('/api/ai-chat', rateLimit(rateLimitStore, { devBypass: cfg.devRatelimitBypass }));
    // W8: §7 telemetry row per turn. Sits between rate-limit and the chat
    // router — it wraps the handler with try/finally so the row is written
    // after c.var.toolAudit / providerModel / lastUsage / validateCoerced
    // are populated.
    app.use('/api/ai-chat', usageLog({ logPath: deps.usageLogPath }));
    app.use('/api/ai-chat', quotaGate(quotaDeps)); // W10: after usageLog, before the router
    app.route(
        '/api/ai-chat',
        createAiChatRouter({ provider, catalog, eosioTypes, allowedChainHosts: cfg.allowedChainHosts })
    );

    // ai-usage is a cheap read of logs/usage.jsonl; not gated by the per-IP
    // chat rate-limit (which is sized for LLM calls). v1 accepts that
    // ai-usage can be polled freely from a single IP; spec §4 takes the
    // same stance ('useful debugging endpoint').
    app.route('/api/ai-usage', createAiUsageRouter());

    // W10 (docs/00 §3.8): quota read for the FE badge. The chat chain's
    // attestation middleware is scoped to /api/ai-chat, so /api/ai-quota gets
    // its own pass (same options) to resolve identity; attestation is
    // opportunistic, so anonymous callers still reach the route and see the
    // free floor.
    app.use(
        '/api/ai-quota',
        attestation({
            allowedOrigins: cfg.allowedOrigins,
            expectedChainId: cfg.attestationChainId,
            now: deps.attestationNow,
        })
    );
    app.route('/api/ai-quota', createAiQuotaRouter(quotaDeps));

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
