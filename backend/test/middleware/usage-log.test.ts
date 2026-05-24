// usage-log middleware contract tests (guidelines §7 + §4.4).
//
// The row shape is an audit contract — extra fields or missing fields are a
// CI failure. These tests pin every required key and the PII gates that
// keep raw bearer tokens, nonces, and signatures out of the JSONL.

import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { usageLog, type UsageLogContext, type UsageRow } from '../../src/middleware/usage-log.js';
import type { AuthContext } from '../../src/middleware/auth.js';
import type { VerifiedClaims } from '../../src/auth/jwt.js';

// Every key the §7 row must carry, in sorted order. The middleware's
// buildRow emits these in insertion order; tests sort for comparison.
const REQUIRED_KEYS = [
    'account',
    'cost_usd',
    'endpoint_chainid',
    'pubkey_prefix',
    'provider_model',
    'session_id_hash',
    'sub',
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
    Variables: AuthContext['Variables'] &
        UsageLogContext['Variables'] & {
            toolAudit: Array<{ tool: string }>;
        };
};

type RouteOpts = {
    auth?: VerifiedClaims | null; // null = don't set auth (simulate 401)
    toolAudit?: Array<{ tool: string }>;
    validateCoerced?: boolean;
    providerModel?: string;
    lastUsage?: { input: number; output: number };
    reply?: unknown; // body to return from the route
    status?: number;
};

function makeApp(logPath: string, opts: RouteOpts) {
    const app = new Hono<RouteContext>();
    app.use('/chat', usageLog({ logPath, now: () => new Date('2026-05-20T03:14:15.123Z') }));
    app.post('/chat', (c) => {
        if (opts.auth !== null && opts.auth !== undefined) c.set('auth', opts.auth);
        if (opts.toolAudit) c.set('toolAudit', opts.toolAudit);
        if (opts.validateCoerced !== undefined) c.set('validateCoerced', opts.validateCoerced);
        if (opts.providerModel) c.set('providerModel', opts.providerModel);
        if (opts.lastUsage) c.set('lastUsage', opts.lastUsage);
        const body = opts.reply ?? { kind: 'refuse', reason: 'auth-required' };
        return c.json(body as object, (opts.status ?? 200) as 200);
    });
    return app;
}

function defaultClaims(overrides: Partial<VerifiedClaims> = {}): VerifiedClaims {
    return {
        sub: 'k1:abcdef0123',
        pubkey: 'EOS6mAB1234567XYZ',
        account: 'duncan',
        permission: 'active',
        chainId: 'chain-mainnet',
        iat: 0,
        exp: 0,
        ...overrides,
    };
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
            auth: defaultClaims(),
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
            auth: defaultClaims(),
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
            auth: defaultClaims(),
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

    it('pubkey_prefix is exactly 6 chars — never the full pubkey', async () => {
        const app = makeApp(logPath, {
            auth: defaultClaims({ pubkey: 'EOS6mAB1234567XYZ' }),
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
        expect(row!.pubkey_prefix).toBe('EOS6mA');
        expect(row!.pubkey_prefix.length).toBe(6);
        // Belt-and-suspenders: the long form must not appear anywhere.
        expect(JSON.stringify(row)).not.toContain('EOS6mAB1234567XYZ');
    });

    describe('validation_outcome lookup', () => {
        async function runWith(reply: unknown, coerced: boolean): Promise<UsageRow> {
            const tmp = join(tmpdir(), `usage-log-vo-${randomUUID()}.jsonl`);
            const app = makeApp(tmp, {
                auth: defaultClaims(),
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
            auth: defaultClaims(),
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
            auth: defaultClaims(),
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

    it('cost_usd is 0 for an unknown model tag', async () => {
        const app = makeApp(logPath, {
            auth: defaultClaims(),
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

    it('writes one row per turn even when the handler returned 401 (no auth set)', async () => {
        const app = new Hono<RouteContext>();
        app.use('/chat', usageLog({ logPath, now: () => new Date('2026-05-20T03:14:15.123Z') }));
        // A handler that bails before any c.set — mimics the auth middleware's
        // unauthenticated short-circuit.
        app.post('/chat', (c) => c.json({ kind: 'refuse', reason: 'auth-required' }, 401));
        const res = await app.request('/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(defaultBody()),
        });
        expect(res.status).toBe(401);
        const [row] = await readRows(logPath);
        expect(row!.sub).toBe('');
        expect(row!.account).toBe('');
        expect(row!.pubkey_prefix).toBe('');
        expect(row!.turn_kind).toBe('refuse');
        expect(row!.validation_outcome).toBe('refused');
    });

    it('LOG_FULL_BODIES=true does NOT widen the JSONL row shape', async () => {
        const baseApp = makeApp(logPath, {
            auth: defaultClaims(),
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
                auth: defaultClaims(),
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
            auth: defaultClaims(),
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
            auth: defaultClaims(),
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

    it('endpoint_chainid prefers body.context.chainId, falls back to auth.chainId', async () => {
        const app = makeApp(logPath, {
            auth: defaultClaims({ chainId: 'auth-fallback-chain' }),
            providerModel: 'anthropic:haiku-4-5',
            lastUsage: { input: 1, output: 1 },
            reply: { kind: 'refuse', reason: 'refused' },
        });
        // Body provides context.chainId explicitly.
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
            auth: defaultClaims(),
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
});
