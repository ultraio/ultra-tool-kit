// usage-log middleware contract tests (guidelines §7 + §4.4).
//
// W1.5-redo (docs/00 §3.1): anonymous backend — no JWT-sourced fields. The
// row's identity slot is `client_ip_hash` = sha256(clientIpOf(c)).
//
// The row shape is an audit contract — extra fields or missing fields are a
// CI failure. These tests pin every required key and the PII gates.

import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { usageLog, type UsageLogContext, type UsageRow } from '../../src/middleware/usage-log.js';

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as const;

// Every key the §7 row must carry, in sorted order. The middleware's
// buildRow emits these in insertion order; tests sort for comparison.
const REQUIRED_KEYS = [
    'client_ip_hash',
    'identity_pubkey_hash',
    'cost_usd',
    'endpoint_chainid',
    'provider_model',
    'session_id_hash',
    'tokens_in',
    'tokens_out',
    'tool_calls',
    'ts',
    'turn_kind',
    'user_msg_prefix',
    'user_msg_sha',
    'validation_outcome',
    'latency_ms',
].sort();

// Mirror the ai-chat context union — usageLog reads `toolAudit` off c.var
// (set by the W4 harness plumbing), so the test app must declare it too.
type RouteContext = {
    Variables: UsageLogContext['Variables'] & {
        toolAudit: Array<{ tool: string }>;
        identity?: { pubkey: string };
    };
};

type RouteOpts = {
    toolAudit?: Array<{ tool: string }>;
    validateCoerced?: boolean;
    providerModel?: string;
    lastUsage?: { input: number; output: number };
    identity?: { pubkey: string };
    reply?: unknown; // body to return from the route
    status?: number;
};

function makeApp(logPath: string, opts: RouteOpts) {
    const app = new Hono<RouteContext>();
    app.use('/chat', usageLog({ logPath, now: () => new Date('2026-05-20T03:14:15.123Z') }));
    app.post('/chat', (c) => {
        if (opts.toolAudit) c.set('toolAudit', opts.toolAudit);
        if (opts.validateCoerced !== undefined) c.set('validateCoerced', opts.validateCoerced);
        if (opts.providerModel) c.set('providerModel', opts.providerModel);
        if (opts.lastUsage) c.set('lastUsage', opts.lastUsage);
        if (opts.identity) c.set('identity', opts.identity);
        const body = opts.reply ?? { kind: 'refuse', reason: 'refused' };
        return c.json(body as object, (opts.status ?? 200) as 200);
    });
    return app;
}

function defaultBody(overrides: Record<string, unknown> = {}) {
    return {
        sessionId: 's-1',
        messages: [{ role: 'user', content: 'transfer 100 UOS to bob' }],
        context: { chainId: 'chain-mainnet' },
        ...overrides,
    };
}

async function readRows(logPath: string): Promise<UsageRow[]> {
    const raw = await readFile(logPath, 'utf8');
    return raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as UsageRow);
}

let logPath: string;

beforeEach(() => {
    logPath = join(tmpdir(), `usage-log-test-${randomUUID()}.jsonl`);
});

afterEach(async () => {
    await rm(logPath, { force: true });
});

describe('usageLog middleware', () => {
    it('writes a row whose keyset matches §7 exactly — no extras, none missing', async () => {
        const app = makeApp(logPath, {
toolAudit: [{ tool: 'get_account' }],
            validateCoerced: false,
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1287, output: 312 },
            reply: { kind: 'act', actions: [] },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody()),
        });
        const rows = await readRows(logPath);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(Object.keys(row).sort()).toEqual(REQUIRED_KEYS);
    });

    it('redacts the Authorization bearer token + body nonce/signature from the row', async () => {
        const app = makeApp(logPath, {
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 10, output: 5 },
            reply: { kind: 'refuse', reason: 'refused' },
        });
        const bearer = 'eyJsensitive-jwt-do-not-log-12345';
        const body = defaultBody({
            nonce: 'nonce-ABCDEFG-must-not-leak',
            signature: 'SIG_K1_must-not-leak-XYZ',
        });
        await app.request('/chat', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${bearer}`,
            },
            body: JSON.stringify(body),
        });
        const rows = await readRows(logPath);
        const serialized = JSON.stringify(rows[0]);
        expect(serialized).not.toContain(bearer);
        expect(serialized).not.toContain('nonce-ABCDEFG-must-not-leak');
        expect(serialized).not.toContain('SIG_K1_must-not-leak-XYZ');
    });

    it('user_msg_prefix is capped at 80 chars; user_msg_sha hashes the full message', async () => {
        const long = 'A'.repeat(200);
        const app = makeApp(logPath, {
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1, output: 1 },
            reply: { kind: 'ask', question: 'huh?' },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody({ messages: [{ role: 'user', content: long }] })),
        });
        const [row] = await readRows(logPath);
        expect(row!.user_msg_prefix.length).toBe(80);
        expect(row!.user_msg_prefix).toBe('A'.repeat(80));
        expect(row!.user_msg_sha).toBe(createHash('sha256').update(long).digest('hex'));
    });

    it('client_ip_hash is sha256(clientIp) — raw IP never appears in the row', async () => {
        const app = makeApp(logPath, {
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1, output: 1 },
            reply: { kind: 'refuse', reason: 'refused' },
        });
        await app.request(
            '/chat',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(defaultBody()),
            },
            { incoming: { socket: { remoteAddress: '192.0.2.42' } } }
        );
        const [row] = await readRows(logPath);
        expect(row!.client_ip_hash).toBe(createHash('sha256').update('192.0.2.42').digest('hex'));
        // Belt-and-suspenders: the raw IP must not appear anywhere in the row.
        expect(JSON.stringify(row)).not.toContain('192.0.2.42');
    });

    describe('validation_outcome lookup', () => {
        async function runWith(reply: unknown, coerced: boolean): Promise<UsageRow> {
            const tmp = join(tmpdir(), `usage-log-vo-${randomUUID()}.jsonl`);
            const app = makeApp(tmp, {
        validateCoerced: coerced,
                providerModel: 'anthropic:haiku-4-5',
                lastUsage: { input: 1, output: 1 },
                reply,
            });
            await app.request('/chat', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(defaultBody()),
            });
            const rows = await readRows(tmp);
            await rm(tmp, { force: true });
            return rows[0]!;
        }

        it("'refuse' → 'refused'", async () => {
            const row = await runWith({ kind: 'refuse', reason: 'refused' }, false);
            expect(row.validation_outcome).toBe('refused');
            expect(row.turn_kind).toBe('refuse');
        });
        it("'ask' → 'downgraded'", async () => {
            const row = await runWith({ kind: 'ask', question: '?' }, false);
            expect(row.validation_outcome).toBe('downgraded');
            expect(row.turn_kind).toBe('ask');
        });
        it("'act' + coerced=true → 'coerced'", async () => {
            const row = await runWith({ kind: 'act', actions: [] }, true);
            expect(row.validation_outcome).toBe('coerced');
            expect(row.turn_kind).toBe('act');
        });
        it("'act' + coerced=false → 'pass'", async () => {
            const row = await runWith({ kind: 'act', actions: [] }, false);
            expect(row.validation_outcome).toBe('pass');
            expect(row.turn_kind).toBe('act');
        });
    });

    it('tool_calls is alphabetically sorted (deterministic)', async () => {
        const app = makeApp(logPath, {
toolAudit: [{ tool: 'get_balance' }, { tool: 'get_account' }, { tool: 'get_abi' }],
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1, output: 1 },
            reply: { kind: 'act', actions: [] },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody()),
        });
        const [row] = await readRows(logPath);
        expect(row!.tool_calls).toEqual(['get_abi', 'get_account', 'get_balance']);
    });

    it('cost_usd uses the frozen price table (anthropic:haiku-4-5)', async () => {
        const app = makeApp(logPath, {
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1000, output: 500 },
            reply: { kind: 'act', actions: [] },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody()),
        });
        const [row] = await readRows(logPath);
        // (1000/1e6)*1 + (500/1e6)*5 = 0.001 + 0.0025 = 0.0035
        expect(row!.cost_usd).toBeCloseTo(0.0035, 9);
    });

    it('cost_usd uses the frozen price table (anthropic:claude-haiku-4-5-20251001 — date-stamped tag matching ANTHROPIC_CHAT_MODEL default)', async () => {
        const app = makeApp(logPath, {
            providerModel: 'anthropic:claude-haiku-4-5-20251001',
            lastUsage: { input: 1000, output: 500 },
            reply: { kind: 'act', actions: [] },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody()),
        });
        const [row] = await readRows(logPath);
        // (1000/1e6)*1 + (500/1e6)*5 = 0.001 + 0.0025 = 0.0035
        expect(row!.cost_usd).toBeCloseTo(0.0035, 9);
        expect(row!.cost_usd).not.toBe(0);
    });

    it('cost_usd is 0 for an unknown model tag', async () => {
        const app = makeApp(logPath, {
            providerModel: 'made-up:model-9000',
            lastUsage: { input: 999, output: 999 },
            reply: { kind: 'act', actions: [] },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody()),
        });
        const [row] = await readRows(logPath);
        expect(row!.cost_usd).toBe(0);
    });

    it('writes one row per turn even when the handler short-circuits (no c.var set)', async () => {
        const app = new Hono<RouteContext>();
        app.use('/chat', usageLog({ logPath, now: () => new Date('2026-05-20T03:14:15.123Z') }));
        // A handler that bails before any c.set — mimics a rate-limit refuse
        // or an internal-error short-circuit. Anonymous backend (docs/00 §3.1)
        // — no 401 path exists; refuses are HTTP 200 per guidelines §3.3.
        app.post('/chat', (c) => c.json({ kind: 'refuse', reason: 'rate-limit-minute' }, 200));
        const res = await app.request(
            '/chat',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(defaultBody()),
            },
            LOOPBACK_ENV
        );
        expect(res.status).toBe(200);
        const [row] = await readRows(logPath);
        // client_ip_hash present (sha256 of the loopback IP), but no JWT-
        // sourced fields exist on the row at all (W1.5-redo).
        expect(row!.client_ip_hash).toBe(createHash('sha256').update('127.0.0.1').digest('hex'));
        expect(row!.turn_kind).toBe('refuse');
        expect(row!.validation_outcome).toBe('refused');
    });

    it('LOG_FULL_BODIES=true does NOT widen the JSONL row shape', async () => {
        const baseApp = makeApp(logPath, {
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1, output: 1 },
            reply: { kind: 'refuse', reason: 'refused' },
        });
        await baseApp.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody()),
        });
        const baselineKeys = JSON.stringify(Object.keys((await readRows(logPath))[0]!).sort());
        await rm(logPath, { force: true });

        const prev = process.env.LOG_FULL_BODIES;
        process.env.LOG_FULL_BODIES = 'true';
        try {
            const app = makeApp(logPath, {
        providerModel: 'anthropic:haiku-4-5',
                lastUsage: { input: 1, output: 1 },
                reply: { kind: 'refuse', reason: 'refused' },
            });
            await app.request('/chat', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(defaultBody({
                    messages: [{ role: 'user', content: 'B'.repeat(200) }],
                })),
            });
            const [row] = await readRows(logPath);
            expect(JSON.stringify(Object.keys(row!).sort())).toBe(baselineKeys);
            // Prefix still 80-capped — dev gate doesn't widen.
            expect(row!.user_msg_prefix.length).toBe(80);
        } finally {
            if (prev === undefined) delete process.env.LOG_FULL_BODIES;
            else process.env.LOG_FULL_BODIES = prev;
        }
    });

    it('is append-only — N requests produce N lines', async () => {
        const app = makeApp(logPath, {
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1, output: 1 },
            reply: { kind: 'refuse', reason: 'refused' },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody()),
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody({ sessionId: 's-2' })),
        });
        const rows = await readRows(logPath);
        expect(rows).toHaveLength(2);
    });

    it("unwraps the future { reply, usage } response wrapper for turn_kind", async () => {
        const app = makeApp(logPath, {
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1, output: 1 },
            reply: {
                reply: { kind: 'act', actions: [] },
                usage: { tokens_in: 1, tokens_out: 1 },
            },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody()),
        });
        const [row] = await readRows(logPath);
        expect(row!.turn_kind).toBe('act');
    });

    it('endpoint_chainid uses body.context.chainId (anonymous backend has no fallback)', async () => {
        const app = makeApp(logPath, {
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1, output: 1 },
            reply: { kind: 'refuse', reason: 'refused' },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody({ context: { chainId: 'body-chain' } })),
        });
        const [row] = await readRows(logPath);
        expect(row!.endpoint_chainid).toBe('body-chain');
    });

    it('session_id_hash is sha256(sessionId) hex', async () => {
        const app = makeApp(logPath, {
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1, output: 1 },
            reply: { kind: 'refuse', reason: 'refused' },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody({ sessionId: 'sess-42' })),
        });
        const [row] = await readRows(logPath);
        expect(row!.session_id_hash).toBe(createHash('sha256').update('sess-42').digest('hex'));
    });

    it('identity_pubkey_hash is sha256(identity.pubkey) when identity is present', async () => {
        const pubkey = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
        const app = makeApp(logPath, {
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1, output: 1 },
            identity: { pubkey },
            reply: { kind: 'act', actions: [] },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody()),
        });
        const [row] = await readRows(logPath);
        expect(row!.identity_pubkey_hash).toBe(createHash('sha256').update(pubkey).digest('hex'));
    });

    it('identity_pubkey_hash is null on the per-IP path (no identity)', async () => {
        const app = makeApp(logPath, {
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1, output: 1 },
            reply: { kind: 'refuse', reason: 'refused' },
        });
        await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody()),
        });
        const [row] = await readRows(logPath);
        expect(row!.identity_pubkey_hash).toBeNull();
    });
});
