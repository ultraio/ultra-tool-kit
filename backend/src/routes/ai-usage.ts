// GET /api/ai-usage — today's per-sub usage aggregate (W8).
//
// Reads backend/logs/usage.jsonl on every call (single-instance v1 per
// roadmap §9; no caching), filters by the requester's JWT `sub` claim AND
// rows whose `ts` falls on today's UTC date, and returns a four-field
// aggregate. The response shape is locked — any future field additions
// land in a doc PR + a new endpoint, never a silent widening here.
//
// "Today" = UTC date boundary. `ts` rows are emitted by usage-log.ts via
// `new Date().toISOString()`, so a leading-10 prefix match on
// `YYYY-MM-DD` is the simple, timezone-stable check this endpoint uses.
//
// Auth: mounted under jwtAuth in createApp (Phase 3 wiring). This file
// only exports the factory.

import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AuthContext } from '../middleware/auth.js';
import { logger } from '../middleware/logging.js';

export type AiUsageDeps = {
    logPath?: string; // for tests; defaults to backend/logs/usage.jsonl
    now?: () => Date; // for tests
};

// Resolve <repo>/backend/logs/usage.jsonl from this file's location.
// src/routes/ai-usage.ts → ../../logs/usage.jsonl. Matches usage-log.ts's
// DEFAULT_LOG_PATH derivation — the two files must agree on the on-disk
// location or the read here will silently miss the writer's output.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_PATH = join(HERE, '..', '..', 'logs', 'usage.jsonl');

const ZERO_AGGREGATE = Object.freeze({
    tokensInToday: 0,
    tokensOutToday: 0,
    costUsdToday: 0,
    turnsToday: 0,
});

export function createAiUsageRouter(deps: AiUsageDeps = {}): Hono<AuthContext> {
    const app = new Hono<AuthContext>();

    app.get('/', async (c) => {
        const auth = c.get('auth');
        const sub = auth.sub;
        const now = (deps.now ?? (() => new Date()))();
        // 'YYYY-MM-DD' UTC. usage-log writes `ts: t0.toISOString()` so this
        // prefix match is timezone-stable across writer + reader.
        const todayPrefix = now.toISOString().slice(0, 10);
        const path = deps.logPath ?? DEFAULT_LOG_PATH;

        let raw = '';
        try {
            raw = await readFile(path, 'utf8');
        } catch (err: unknown) {
            // ENOENT = no log file yet (fresh deploy, nothing logged today).
            // Treat as zeros — same UX as "logged but no matches".
            if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') {
                return c.json({ ...ZERO_AGGREGATE }, 200);
            }
            // Other I/O errors (perm denied, etc.) are pino-logged and we
            // still return zeros — the route is best-effort by design and
            // must never 500.
            logger.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'ai-usage: read failed'
            );
            return c.json({ ...ZERO_AGGREGATE }, 200);
        }

        let tokensInToday = 0;
        let tokensOutToday = 0;
        let costUsdToday = 0;
        let turnsToday = 0;

        // Iterate line-by-line; skip malformed rows silently (defensive — a
        // future schema bump or a partial write shouldn't 500 this endpoint).
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            let row: unknown;
            try {
                row = JSON.parse(line);
            } catch {
                continue;
            }
            if (!row || typeof row !== 'object') continue;
            const r = row as Record<string, unknown>;
            // Filter strictly by `sub` — the JWT-claim rate-limit key per
            // guidelines §3.2-§3.3. Never match by pubkey or account.
            if (r.sub !== sub) continue;
            if (typeof r.ts !== 'string' || !r.ts.startsWith(todayPrefix)) continue;
            tokensInToday += Number(r.tokens_in) || 0;
            tokensOutToday += Number(r.tokens_out) || 0;
            costUsdToday += Number(r.cost_usd) || 0;
            turnsToday += 1;
        }

        return c.json(
            {
                tokensInToday,
                tokensOutToday,
                // 6 decimal places — same precision the writer uses in
                // usage-log.ts (`round6`), so the displayed total never
                // disagrees with the sum of the JSONL `cost_usd` values
                // beyond float-drift in the last digit.
                costUsdToday: Math.round(costUsdToday * 1_000_000) / 1_000_000,
                turnsToday,
            },
            200
        );
    });

    return app;
}
