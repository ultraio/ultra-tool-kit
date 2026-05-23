// extractIdentifiers — pure walker that pulls every EOSIO-name-shaped string
// out of a tool response. Used by the W4 route handler to populate gate 5's
// toolReturnedIdentifiers source (see validate.ts).
//
// Tests cover the four spec points:
//   1. Nested object with mixed strings (keys + values).
//   2. Array of strings (caps drop).
//   3. Deep nesting capped at maxDepth.
//   4. Output size capped at 100 even when input has more.

import { describe, expect, it } from 'vitest';

import { extractIdentifiers } from '../../src/pipeline/validate.js';

describe('extractIdentifiers', () => {
    it('walks objects, collects EOSIO-shaped values AND keys, skips non-matching', () => {
        const payload = {
            account: 'duncan',
            permissions: [{ perm_name: 'active', parent: 'owner' }],
            extra: 'NOT A NAME', // uppercase + spaces — fails the regex
        };
        const out = extractIdentifiers(payload);
        // Object keys that match the regex are also captured.
        expect(out.has('account')).toBe(true);
        expect(out.has('permissions')).toBe(true);
        expect(out.has('perm_name')).toBe(false); // underscore is not in [a-z1-5.]
        expect(out.has('parent')).toBe(true);
        expect(out.has('extra')).toBe(true);
        // Values that match.
        expect(out.has('duncan')).toBe(true);
        expect(out.has('active')).toBe(true);
        expect(out.has('owner')).toBe(true);
        // The uppercase string is excluded.
        expect(out.has('NOT A NAME')).toBe(false);
    });

    it('walks arrays of strings, keeping only the ones matching the EOSIO regex', () => {
        const out = extractIdentifiers(['alice', 'bob', 'CAPS']);
        expect(out.has('alice')).toBe(true);
        expect(out.has('bob')).toBe(true);
        expect(out.has('CAPS')).toBe(false);
        expect(out.size).toBe(2);
    });

    it('stops recursion at maxDepth (5 by default) — deeper strings are skipped', () => {
        // depth-7 nesting around a name. With maxDepth=5 the walker stops
        // before reaching the leaf string.
        const buried = { a: { b: { c: { d: { e: { f: { g: 'deepname' } } } } } } };
        const out = extractIdentifiers(buried);
        expect(out.has('deepname')).toBe(false);
        // But shallow keys / values are still picked up.
        expect(out.has('a')).toBe(true);
    });

    it('caps output at 100 identifiers even when the input has more', () => {
        // Build a flat array of 200 valid EOSIO names. Each must match
        // ^[a-z][a-z1-5.]{0,11}[a-j1-5]?$ — keep them short.
        const inputs: string[] = [];
        const letters = 'abcdefghij';
        // Cartesian product: 10×10×10 = 1000 distinct 3-char names like "aaa",
        // "aab", ... — well past our cap of 100, all matching the regex.
        for (const x of letters) {
            for (const y of letters) {
                for (const z of letters) {
                    inputs.push(`${x}${y}${z}`);
                    if (inputs.length >= 200) break;
                }
                if (inputs.length >= 200) break;
            }
            if (inputs.length >= 200) break;
        }
        expect(inputs.length).toBe(200);
        const out = extractIdentifiers(inputs);
        expect(out.size).toBe(100);
    });

    it('handles null, undefined, numbers, booleans, and Dates without throwing', () => {
        // Use camelCase keys with uppercase letters so they don't match the
        // EOSIO regex — we want to isolate the test to "non-string values
        // get skipped" without keys polluting the result.
        const payload = {
            nullField: null,
            undefField: undefined,
            numField: 42,
            flagField: true,
            tsField: new Date('2024-01-01T00:00:00Z'),
            accountField: 'duncan',
        };
        const out = extractIdentifiers(payload);
        // The one matching VALUE survives; nothing else (no key matches).
        expect(out.has('duncan')).toBe(true);
        expect(out.size).toBe(1);
    });

    it('returns an empty set for primitive inputs that do not match the regex', () => {
        expect(extractIdentifiers('CAPS').size).toBe(0);
        expect(extractIdentifiers(42).size).toBe(0);
        expect(extractIdentifiers(null).size).toBe(0);
        expect(extractIdentifiers(undefined).size).toBe(0);
    });

    it('captures a primitive string input that DOES match the regex', () => {
        const out = extractIdentifiers('duncan');
        expect(out.has('duncan')).toBe(true);
        expect(out.size).toBe(1);
    });
});
