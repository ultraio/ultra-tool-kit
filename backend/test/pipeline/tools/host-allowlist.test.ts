// host-allowlist.ts — guidelines §4.2 host filter and §4.6 protocol gate.
//
// Every reject case below is a real attacker shape called out in §4.2
// (suffix-confusion, scheme-bypass, credentials-in-URL, fragment trickery)
// — these MUST keep failing.

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_ALLOWLIST,
    buildAllowlistFromEnv,
    isAllowedEndpoint,
} from '../../../src/pipeline/tools/host-allowlist.js';

describe('isAllowedEndpoint — pass cases', () => {
    it('allows https://api.ultra.io/...', () => {
        expect(
            isAllowedEndpoint('https://api.ultra.io/v1/chain/get_account', DEFAULT_ALLOWLIST)
        ).toBe(true);
    });

    it('allows the suffix root (https://ultra.io) for the *.ultra.io wildcard', () => {
        expect(isAllowedEndpoint('https://ultra.io', DEFAULT_ALLOWLIST)).toBe(true);
    });

    it('allows http://localhost:8888 (loopback http exception)', () => {
        expect(
            isAllowedEndpoint('http://localhost:8888/v1/chain/get_abi', DEFAULT_ALLOWLIST)
        ).toBe(true);
    });

    it('allows http://127.0.0.1:8888 (loopback http exception)', () => {
        expect(
            isAllowedEndpoint('http://127.0.0.1:8888/v1/chain/get_abi', DEFAULT_ALLOWLIST)
        ).toBe(true);
    });

    it('allows env-derived hosts via a custom allowlist', () => {
        const allowlist = [...DEFAULT_ALLOWLIST, 'test.ultra.eosusa.io'];
        expect(
            isAllowedEndpoint('https://test.ultra.eosusa.io/v1/chain/get_account', allowlist)
        ).toBe(true);
    });
});

describe('isAllowedEndpoint — reject cases', () => {
    it('rejects fragment trickery (http://evil.com#.ultra.io)', () => {
        expect(isAllowedEndpoint('http://evil.com#.ultra.io', DEFAULT_ALLOWLIST)).toBe(false);
    });

    it('rejects path trickery (https://attacker.com/.ultra.io)', () => {
        expect(isAllowedEndpoint('https://attacker.com/.ultra.io', DEFAULT_ALLOWLIST)).toBe(false);
    });

    it('rejects suffix-confusion (https://ultra.io.evil.com)', () => {
        expect(isAllowedEndpoint('https://ultra.io.evil.com', DEFAULT_ALLOWLIST)).toBe(false);
    });

    it('rejects file:// scheme', () => {
        expect(isAllowedEndpoint('file:///etc/passwd', DEFAULT_ALLOWLIST)).toBe(false);
    });

    it('rejects javascript: scheme', () => {
        expect(isAllowedEndpoint('javascript:alert(1)', DEFAULT_ALLOWLIST)).toBe(false);
    });

    it('rejects http:// on non-loopback (http://api.ultra.io)', () => {
        expect(isAllowedEndpoint('http://api.ultra.io/v1/chain/get_account', DEFAULT_ALLOWLIST)).toBe(
            false
        );
    });

    it('rejects credentials-in-URL (https://user:pass@api.ultra.io)', () => {
        expect(
            isAllowedEndpoint('https://user:pass@api.ultra.io/v1/chain/get_account', DEFAULT_ALLOWLIST)
        ).toBe(false);
    });

    it('rejects unparseable strings', () => {
        expect(isAllowedEndpoint('not a url', DEFAULT_ALLOWLIST)).toBe(false);
    });

    it('rejects the empty string', () => {
        expect(isAllowedEndpoint('', DEFAULT_ALLOWLIST)).toBe(false);
    });

    it('rejects http://[::1] (IPv6 loopback is intentionally not in DEFAULT_ALLOWLIST)', () => {
        expect(isAllowedEndpoint('http://[::1]:8888/v1/chain/get_abi', DEFAULT_ALLOWLIST)).toBe(
            false
        );
    });

    it('rejects https://[::1] (IPv6 loopback is intentionally not in DEFAULT_ALLOWLIST)', () => {
        expect(isAllowedEndpoint('https://[::1]:8888/v1/chain/get_abi', DEFAULT_ALLOWLIST)).toBe(
            false
        );
    });
});

describe('buildAllowlistFromEnv', () => {
    it('returns DEFAULT_ALLOWLIST when ALLOWED_CHAIN_HOSTS is unset', () => {
        const out = buildAllowlistFromEnv({});
        expect(out).toEqual(DEFAULT_ALLOWLIST);
    });

    it('appends comma-separated entries (trimmed)', () => {
        const out = buildAllowlistFromEnv({
            ALLOWED_CHAIN_HOSTS: 'ultra.eosusa.io, test.ultra.eosusa.io',
        });
        expect(out).toEqual([
            ...DEFAULT_ALLOWLIST,
            'ultra.eosusa.io',
            'test.ultra.eosusa.io',
        ]);
    });
});
