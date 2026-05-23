// Tool registry + dispatcher contract tests.
//
// Source of truth: docs/00-ai-global-guidelines.md §4.2 (five tools,
// "tool dispatcher rejects unknown tool names — no dynamic dispatch") and
// §4.7 (per-turn / per-session tool budget).

import { describe, expect, it } from 'vitest';

import { loadCatalog, _resetCatalogCache } from '../../../src/pipeline/catalog.js';
import { DEFAULT_ALLOWLIST } from '../../../src/pipeline/tools/host-allowlist.js';
import {
    BudgetError,
    TOOL_REGISTRY,
    dispatch,
    enforceBudget,
    type ToolCtx,
} from '../../../src/pipeline/tools/index.js';

async function makeCtx(): Promise<ToolCtx> {
    _resetCatalogCache();
    const catalog = await loadCatalog();
    return {
        endpoint: 'https://api.ultra.io',
        allowlist: DEFAULT_ALLOWLIST,
        catalog,
        // Always-failing fetch — this test never reaches the network. A
        // test that DOES exercise the network mocks via its own fetchImpl.
        fetchImpl: async () => {
            throw new Error('fetch must not be called in this test');
        },
    };
}

describe('TOOL_REGISTRY shape', () => {
    it('has EXACTLY 5 entries', () => {
        const names = Object.keys(TOOL_REGISTRY).sort();
        expect(names).toEqual(
            ['get_abi', 'get_account', 'get_action_schema', 'get_balance', 'get_table_rows'].sort()
        );
        expect(names).toHaveLength(5);
    });

    it('every entry has name, description, inputSchema, call', () => {
        for (const [key, spec] of Object.entries(TOOL_REGISTRY)) {
            expect(spec.name).toBe(key);
            expect(typeof spec.description).toBe('string');
            expect(spec.description.length).toBeGreaterThan(0);
            expect(spec.inputSchema).toBeDefined();
            expect(typeof spec.call).toBe('function');
        }
    });
});

describe('dispatch — unknown tool', () => {
    it('throws UnknownToolError with the offending toolName', async () => {
        const ctx = await makeCtx();
        await expect(dispatch('get_evil', {}, ctx)).rejects.toMatchObject({
            name: 'UnknownToolError',
            toolName: 'get_evil',
        });
    });
});

describe('dispatch — spec input parse failures surface as error audit', () => {
    it("get_account with an invalid name → audit.status = 'error'", async () => {
        const ctx = await makeCtx();
        const res = await dispatch(
            'get_account',
            { accountName: 'invalid_name_with_underscore' },
            ctx
        );
        expect(res.audit.status).toBe('error');
        expect(res.audit.name).toBe('get_account');
        expect(res.audit.error).toBeTruthy();
        expect(typeof res.audit.durMs).toBe('number');
    });
});

describe('enforceBudget', () => {
    it('throws tool-budget at the per-turn ceiling', () => {
        expect(() => enforceBudget(3, 0)).toThrow(BudgetError);
        try {
            enforceBudget(3, 0);
        } catch (e) {
            expect(e).toBeInstanceOf(BudgetError);
            if (e instanceof BudgetError) {
                expect(e.reason).toBe('tool-budget');
            }
        }
    });

    it('throws tool-budget-session at the per-session ceiling', () => {
        try {
            enforceBudget(0, 6);
            throw new Error('should not reach');
        } catch (e) {
            expect(e).toBeInstanceOf(BudgetError);
            if (e instanceof BudgetError) {
                expect(e.reason).toBe('tool-budget-session');
            }
        }
    });

    it('does NOT throw under both ceilings (2, 5)', () => {
        expect(() => enforceBudget(2, 5)).not.toThrow();
    });
});
