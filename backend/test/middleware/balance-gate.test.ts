// UOS balance gate tests (W9, docs/00 §3.7 + RFC §9).
//
// Gate reads UOS for the ACTIVE account only (identity.account — the verified
// primary from the signed attestation, RFC §5.6). Admin/governance keys often
// enumerate 75-100+ signableAccounts; summing all of them fires 75+ sequential
// RPC reads per turn and gets throttled. One read for the active account is
// correct and practical.
//
// thresholdUos <= 0 disables the gate entirely — no RPC read is made, the
// request passes with totalUos = 0. Anonymous callers (no identity) are still
// a no-op (reader never called).
//
// Per-(endpoint, account) reads are cached for cacheTtlMs.

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { balanceGate, type BalanceGateDeps } from '../../src/middleware/balance-gate.js';
import type { AttestedIdentity, IdentityVariables } from '../../src/middleware/attestation.js';
import type { CatalogIndex } from '../../src/pipeline/catalog.js';

// The default reader is never reached in these tests (readUosBalance is always
// injected), so an empty catalog stub is sufficient.
const CATALOG = {} as CatalogIndex;

function makeApp(deps: BalanceGateDeps, identity?: AttestedIdentity) {
    const app = new Hono<IdentityVariables>();
    if (identity) {
        app.use('/x', async (c, n) => {
            c.set('identity', identity);
            await n();
        });
    }
    app.use('/x', balanceGate(deps));
    app.post('/x', (c) => c.json({ ok: true, totalUos: c.get('totalUos') ?? null }));
    return app;
}

function req(app: Hono<IdentityVariables>) {
    return app.request('/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context: { endpoint: 'http://localhost:8888' } }),
    });
}

function identity(accounts: string[]): AttestedIdentity {
    return {
        pubkey: 'PUB_K1_test',
        account: accounts[0]!,
        permission: 'active',
        signableAccounts: accounts.map((account) => ({ account, permissions: ['active'] })),
    };
}

describe('balanceGate middleware', () => {
    it('1. attested + active account >= threshold → passes, totalUos set, reader called exactly ONCE', async () => {
        // Use 3 signableAccounts to prove only the active account is read (one call
        // despite multiple signableAccounts).
        const reader = vi.fn(async (_account: string, _endpoint: string) => 5);
        const app = makeApp(
            { thresholdUos: 1, catalog: CATALOG, allowlist: [], readUosBalance: reader },
            identity(['active', 'b', 'c'])
        );
        const res = await req(app);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, totalUos: 5 });
        expect(reader.mock.calls.length).toBe(1);
        expect(reader.mock.calls[0]![0]).toBe('active');                 // active account only, not a sibling signableAccount
        expect(reader.mock.calls[0]![1]).toBe('http://localhost:8888');  // endpoint from request body
    });

    it('2. attested + active account < threshold → refuse insufficient-uos', async () => {
        const app = makeApp(
            { thresholdUos: 1, catalog: CATALOG, allowlist: [], readUosBalance: async () => 0.1 },
            identity(['a'])
        );
        const res = await req(app);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'insufficient-uos' });
    });

    it('3. thresholdUos = 0 disables gate → passes, reader never called', async () => {
        const reader = vi.fn(async () => 99);
        const app = makeApp(
            { thresholdUos: 0, catalog: CATALOG, allowlist: [], readUosBalance: reader },
            identity(['active', 'b', 'c'])
        );
        const res = await req(app);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, totalUos: 0 });
        expect(reader).not.toHaveBeenCalled();
    });

    it('4. no identity → no-op, reader not called', async () => {
        const reader = vi.fn(async () => 5);
        const app = makeApp({ thresholdUos: 1, catalog: CATALOG, allowlist: [], readUosBalance: reader });
        const res = await req(app);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, totalUos: null });
        expect(reader).not.toHaveBeenCalled();
    });

    it('5. cache hit within TTL → reader called once across two requests', async () => {
        const reader = vi.fn(async () => 5);
        let t = 1_000_000;
        const app = makeApp(
            { thresholdUos: 1, catalog: CATALOG, allowlist: [], readUosBalance: reader, now: () => t },
            identity(['a'])
        );
        const r1 = await req(app);
        const r2 = await req(app);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(reader.mock.calls.length).toBe(1);
    });

    it('6. reader throws → refuse insufficient-uos, failure not cached (retries next turn)', async () => {
        const reader = vi.fn(async () => {
            throw new Error('RPC timeout');
        });
        const app = makeApp(
            { thresholdUos: 1, catalog: CATALOG, allowlist: [], readUosBalance: reader, now: () => 1_000_000, cacheTtlMs: 60_000 },
            identity(['a'])
        );
        const r1 = await req(app);
        expect(await r1.json()).toEqual({ kind: 'refuse', reason: 'insufficient-uos' });
        const r2 = await req(app);
        expect(await r2.json()).toEqual({ kind: 'refuse', reason: 'insufficient-uos' });
        expect(reader.mock.calls.length).toBe(2); // failure was NOT cached → re-read on the second turn
    });

    it('7. cache expiry → reader called twice after TTL elapses', async () => {
        const reader = vi.fn(async () => 5);
        let t = 1_000_000;
        const app = makeApp(
            {
                thresholdUos: 1,
                catalog: CATALOG,
                allowlist: [],
                readUosBalance: reader,
                now: () => t,
                cacheTtlMs: 1000,
            },
            identity(['a'])
        );
        await req(app);
        t += 2000; // advance past cacheTtlMs
        await req(app);
        expect(reader.mock.calls.length).toBe(2);
    });
});
