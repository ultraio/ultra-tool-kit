// GET /api/ai-usage tests (W8).
//
// Each test wires a minimal Hono stack (jwtAuth + createAiUsageRouter) so
// the auth path is exercised end-to-end without booting createApp(). The
// usage JSONL is written to a per-test temp file under os.tmpdir(); each
// test injects logPath + a fixed `now` so the "today" UTC boundary is
// deterministic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { type AuthContext, jwtAuth } from '../../src/middleware/auth.js';
import { createAiUsageRouter } from '../../src/routes/ai-usage.js';

const JWT_SECRET = 'test-secret-w8-usage';
const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as const;
const WAN_ENV = { incoming: { socket: { remoteAddress: '203.0.113.7' } } } as const;

// DEV_AUTH_BYPASS injects this synthetic sub on loopback (see middleware/auth.ts).
const BYPASS_SUB = 'k1:dev-loopback-bypass';

// Fixed clock so "today" is reproducible. 2026-05-24T12:00:00Z falls
// inside the bypass-sub's "today" rows below.
const FIXED_NOW = new Date('2026-05-24T12:00:00.000Z');

const tempPaths: string[] = [];

function makeTempLogPath(): string {
    const p = join(tmpdir(), `ai-usage-${randomUUID()}.jsonl`);
    tempPaths.push(p);
    return p;
}

function makeApp(logPath: string, now: () => Date = () => FIXED_NOW) {
    const app = new Hono<AuthContext>();
    app.use('/api/ai-usage', jwtAuth({ jwtSecret: JWT_SECRET, devBypass: true }));
    app.route('/api/ai-usage', createAiUsageRouter({ logPath, now }));
    return app;
}

async function writeJsonl(path: string, rows: Array<Record<string, unknown> | string>): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // Allow raw string entries so tests can inject malformed lines verbatim.
    const lines = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
    await writeFile(path, lines.join('\n') + '\n', 'utf8');
}

beforeEach(() => {
    tempPaths.length = 0;
});

afterEach(async () => {
    await Promise.all(tempPaths.map((p) => rm(p, { force: true })));
});

describe('GET /api/ai-usage — empty/missing log', () => {
    it('returns all zeros when the log file does not exist (ENOENT)', async () => {
        const path = makeTempLogPath();
        // Note: we never write to `path` — it should not exist.
        const app = makeApp(path);
        const res = await app.request('/api/ai-usage', { method: 'GET' }, LOOPBACK_ENV);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            tokensInToday: 0,
            tokensOutToday: 0,
            costUsdToday: 0,
            turnsToday: 0,
        });
    });

    it('returns all zeros when the log file exists but is empty', async () => {
        const path = makeTempLogPath();
        await writeFile(path, '', 'utf8');
        tempPaths.push(path);
        const app = makeApp(path);
        const res = await app.request('/api/ai-usage', { method: 'GET' }, LOOPBACK_ENV);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            tokensInToday: 0,
            tokensOutToday: 0,
            costUsdToday: 0,
            turnsToday: 0,
        });
    });
});

describe('GET /api/ai-usage — today aggregate filtered by sub', () => {
    it('sums only rows whose sub matches AND ts is today (UTC)', async () => {
        const path = makeTempLogPath();
        // The bypass sub is what jwtAuth attaches on loopback.
        const SUB = BYPASS_SUB;
        const OTHER_SUB = 'k1:someone-else';

        await writeJsonl(path, [
            // 3 matching rows for today + SUB.
            {
                ts: '2026-05-24T01:00:00.000Z',
                sub: SUB,
                tokens_in: 100,
                tokens_out: 30,
                cost_usd: 0.001,
            },
            {
                ts: '2026-05-24T11:30:00.000Z',
                sub: SUB,
                tokens_in: 200,
                tokens_out: 50,
                cost_usd: 0.002,
            },
            {
                ts: '2026-05-24T23:59:59.000Z',
                sub: SUB,
                tokens_in: 300,
                tokens_out: 70,
                cost_usd: 0.003,
            },
            // Yesterday — SUB matches but date doesn't.
            {
                ts: '2026-05-23T12:00:00.000Z',
                sub: SUB,
                tokens_in: 9999,
                tokens_out: 9999,
                cost_usd: 99,
            },
            // Today but different sub.
            {
                ts: '2026-05-24T12:00:00.000Z',
                sub: OTHER_SUB,
                tokens_in: 4444,
                tokens_out: 4444,
                cost_usd: 44,
            },
        ]);

        const app = makeApp(path);
        const res = await app.request('/api/ai-usage', { method: 'GET' }, LOOPBACK_ENV);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            tokensInToday: number;
            tokensOutToday: number;
            costUsdToday: number;
            turnsToday: number;
        };
        expect(body.turnsToday).toBe(3);
        expect(body.tokensInToday).toBe(600); // 100 + 200 + 300
        expect(body.tokensOutToday).toBe(150); // 30 + 50 + 70
        expect(body.costUsdToday).toBe(0.006); // 0.001 + 0.002 + 0.003
    });
});

describe('GET /api/ai-usage — malformed rows', () => {
    it('skips unparseable lines and still returns the valid aggregate', async () => {
        const path = makeTempLogPath();
        const SUB = BYPASS_SUB;
        await writeJsonl(path, [
            { ts: '2026-05-24T01:00:00.000Z', sub: SUB, tokens_in: 100, tokens_out: 20, cost_usd: 0.01 },
            'bad json line not parseable',
            { ts: '2026-05-24T02:00:00.000Z', sub: SUB, tokens_in: 50, tokens_out: 10, cost_usd: 0.005 },
        ]);

        const app = makeApp(path);
        const res = await app.request('/api/ai-usage', { method: 'GET' }, LOOPBACK_ENV);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            tokensInToday: number;
            tokensOutToday: number;
            costUsdToday: number;
            turnsToday: number;
        };
        expect(body.turnsToday).toBe(2);
        expect(body.tokensInToday).toBe(150);
        expect(body.tokensOutToday).toBe(30);
        expect(body.costUsdToday).toBe(0.015);
    });
});

describe('GET /api/ai-usage — cost rounding', () => {
    it('rounds costUsdToday to 6 decimal places', async () => {
        const path = makeTempLogPath();
        const SUB = BYPASS_SUB;
        // 0.000001 + 0.0000005 + 0.0000001 = 0.0000016 → round6 → 0.000002
        await writeJsonl(path, [
            { ts: '2026-05-24T01:00:00.000Z', sub: SUB, tokens_in: 0, tokens_out: 0, cost_usd: 0.000001 },
            { ts: '2026-05-24T02:00:00.000Z', sub: SUB, tokens_in: 0, tokens_out: 0, cost_usd: 0.0000005 },
            { ts: '2026-05-24T03:00:00.000Z', sub: SUB, tokens_in: 0, tokens_out: 0, cost_usd: 0.0000001 },
        ]);

        const app = makeApp(path);
        const res = await app.request('/api/ai-usage', { method: 'GET' }, LOOPBACK_ENV);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { costUsdToday: number; turnsToday: number };
        expect(body.turnsToday).toBe(3);
        expect(body.costUsdToday).toBe(0.000002);
    });
});

describe('GET /api/ai-usage — auth gate', () => {
    it('returns 401 when unauthenticated (non-loopback, no Bearer)', async () => {
        const path = makeTempLogPath();
        const app = makeApp(path);
        const res = await app.request('/api/ai-usage', { method: 'GET' }, WAN_ENV);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'auth-required' });
    });
});
