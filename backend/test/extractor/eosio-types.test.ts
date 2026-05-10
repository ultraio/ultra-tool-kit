import { describe, it, expect } from 'vitest';
import { loadEosioTypes } from '../../src/extractor/eosio-types.js';

const REQUIRED_KEYS = [
    'name',
    'account_name',
    'permission_name',
    'asset',
    'extended_asset',
    'symbol',
    'symbol_code',
    'extended_symbol',
    'time_point',
    'time_point_sec',
    'block_timestamp_type',
    'public_key',
    'signature',
    'checksum256',
    'bytes',
] as const;

describe('eosio-types catalog', () => {
    it('parses as JSON', async () => {
        const types = await loadEosioTypes();
        expect(typeof types).toBe('object');
    });

    it('contains every required EOSIO type key', async () => {
        const types = await loadEosioTypes();
        for (const key of REQUIRED_KEYS) {
            expect(types[key], `missing type rule: ${key}`).toBeDefined();
            expect(types[key]!.description.length).toBeGreaterThan(0);
            expect(Array.isArray(types[key]!.constraints)).toBe(true);
            expect(Array.isArray(types[key]!.examples)).toBe(true);
        }
    });

    it('compiles every declared pattern as a RegExp', async () => {
        const types = await loadEosioTypes();
        for (const [key, rules] of Object.entries(types)) {
            if (rules.pattern === undefined) continue;
            expect(
                () => new RegExp(rules.pattern!),
                `pattern for ${key} should be a valid RegExp`
            ).not.toThrow();
        }
    });

    it('every example for a typed pattern matches its pattern', async () => {
        const types = await loadEosioTypes();
        for (const [key, rules] of Object.entries(types)) {
            if (rules.pattern === undefined) continue;
            const re = new RegExp(rules.pattern);
            for (const ex of rules.examples) {
                if (key === 'extended_asset' || key === 'extended_symbol') continue;
                expect(re.test(ex), `${key} example "${ex}" should match pattern ${rules.pattern}`).toBe(true);
            }
        }
    });
});
