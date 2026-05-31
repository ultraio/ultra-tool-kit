// UOS balance gate tests (W9, docs/00 §3.7 + RFC §9).
//
// Gate sums UOS across the attested signableAccounts via an injected reader,
// refuses below threshold, and is a no-op when no identity is present. Per-
// (endpoint, account) reads are cached for cacheTtlMs.

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
    it('1. sufficient balance → passes through with totalUos set', async () => {
        const app = makeApp(
            { thresholdUos: 1, catalog: CATALOG, allowlist: [], readUosBalance: async () => 5 },
            identity(['a'])
        );
        const res = await req(app);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, totalUos: 5 });
    });

    it('2. insufficient balance → refuse insufficient-uos', async () => {
        const app = makeApp(
            { thresholdUos: 1, catalog: CATALOG, allowlist: [], readUosBalance: async () => 0.1 },
            identity(['a'])
        );
        const res = await req(app);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'insufficient-uos' });
    });

    it('3. no identity → no-op, reader not called', async () => {
        const reader = vi.fn(async () => 5);
        const app = makeApp({ thresholdUos: 1, catalog: CATALOG, allowlist: [], readUosBalance: reader });
        const res = await req(app);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, totalUos: null });
        expect(reader).not.toHaveBeenCalled();
    });

    it('4. multiple accounts are summed', async () => {
        const app = makeApp(
            { thresholdUos: 1, catalog: CATALOG, allowlist: [], readUosBalance: async () => 0.6 },
            identity(['a', 'b'])
        );
        const res = await req(app);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; totalUos: number };
        expect(body.ok).toBe(true);
        expect(body.totalUos).toBeCloseTo(1.2, 9);
    });

    it('5. 5-min cache hit → reader called once across two requests', async () => {
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

    it('6. cache expiry → reader called twice after TTL elapses', async () => {
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
