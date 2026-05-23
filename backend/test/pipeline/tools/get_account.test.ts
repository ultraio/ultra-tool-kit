// get_account tool — happy path, HTTP error, and host allowlist reject.
//
// §4.4 says: post-filter tool responses to only the allowlisted fields.
// We assert here that extra fields the chain returns (e.g. `voter_info`,
// `total_resources`) NEVER make it to the LLM — the explicit-whitelist
// builder in get_account.ts blocks them.

import { beforeEach, describe, expect, it } from 'vitest';

import { _resetCatalogCache, loadCatalog } from '../../../src/pipeline/catalog.js';
import { DEFAULT_ALLOWLIST } from '../../../src/pipeline/tools/host-allowlist.js';
import { dispatch, type ToolCtx } from '../../../src/pipeline/tools/index.js';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

async function ctxWith(fetchImpl: ToolCtx['fetchImpl'], endpoint = 'https://api.ultra.io'): Promise<ToolCtx> {
    _resetCatalogCache();
    const catalog = await loadCatalog();
    return {
        endpoint,
        allowlist: DEFAULT_ALLOWLIST,
        catalog,
        fetchImpl,
    };
}

const fullChainBody = {
    account_name: 'duncan',
    core_liquid_balance: '100.00000000 UOS',
    ram_quota: 8192,
    ram_usage: 4096,
    permissions: [
        {
            perm_name: 'owner',
            parent: '',
            required_auth: {
                threshold: 1,
                keys: [{ key: 'EOS6mock', weight: 1 }],
                accounts: [],
                waits: [{ wait_sec: 3600, weight: 1 }], // <-- not in allowlist
            },
            linked_actions: [], // <-- extra, must be dropped
        },
        {
            perm_name: 'active',
            parent: 'owner',
            required_auth: {
                threshold: 1,
                keys: [{ key: 'EOS6mock2', weight: 1 }],
                accounts: [
                    {
                        permission: { actor: 'parentacct', permission: 'active' },
                        weight: 1,
                    },
                ],
                waits: [],
            },
        },
    ],
    voter_info: { producers: ['producer.a'] }, // <-- must be dropped
    total_resources: { net_weight: '0.0000 EOS' }, // <-- must be dropped
    refund_request: null, // <-- must be dropped
};

describe('get_account — happy path with field allowlist', () => {
    let calls = 0;
    beforeEach(() => {
        calls = 0;
    });

    it('filters out unallowlisted top-level + permission fields', async () => {
        const ctx = await ctxWith(async () => {
            calls++;
            return jsonResponse(fullChainBody);
        });
        const res = await dispatch('get_account', { accountName: 'duncan' }, ctx);
        expect(res.audit.status).toBe('ok');
        const payload = res.payload as Record<string, unknown>;
        expect(payload.account_name).toBe('duncan');
        expect(payload.core_liquid_balance).toBe('100.00000000 UOS');
        expect(payload.ram_quota).toBe(8192);
        expect(payload.ram_usage).toBe(4096);
        // Extra top-level fields must be absent.
        expect('voter_info' in payload).toBe(false);
        expect('total_resources' in payload).toBe(false);
        expect('refund_request' in payload).toBe(false);

        const perms = payload.permissions as Array<Record<string, unknown>>;
        expect(perms).toHaveLength(2);
        // No 'waits' or 'linked_actions' on the permission object.
        for (const p of perms) {
            expect('linked_actions' in p).toBe(false);
            const auth = p.required_auth as Record<string, unknown>;
            expect('waits' in auth).toBe(false);
            expect(Array.isArray(auth.keys)).toBe(true);
            expect(Array.isArray(auth.accounts)).toBe(true);
        }
        expect(calls).toBe(1);
    });
});

describe('get_account — error paths', () => {
    it('HTTP 404 → audit error', async () => {
        const ctx = await ctxWith(async () => jsonResponse({ error: 'unknown' }, 404));
        const res = await dispatch('get_account', { accountName: 'noexist' }, ctx);
        expect(res.audit.status).toBe('error');
        expect(res.audit.error).toMatch(/HTTP 404/);
    });

    it('endpoint not in allowlist → EndpointRejectedError → audit error', async () => {
        const ctx = await ctxWith(async () => jsonResponse(fullChainBody), 'https://evil.example.com');
        const res = await dispatch('get_account', { accountName: 'duncan' }, ctx);
        expect(res.audit.status).toBe('error');
        expect(res.audit.error).toMatch(/endpoint/i);
    });
});
