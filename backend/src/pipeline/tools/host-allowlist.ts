// Host allowlist for read-only chain RPC calls.
//
// Source of truth: docs/00-ai-global-guidelines.md §4.2 ("The chain endpoint
// URL ... is normalized + matched against a host allowlist (*.ultra.io,
// localhost, 127.0.0.1, user-configured custom endpoints)") and §4.6 (DNS
// rebinding is out-of-scope; host is logged). Roadmap §6 row W4.
//
// Pure module. URL parsing only — string regex on a raw URL is forbidden
// because of the well-known "evil.com#.ultra.io" / "ultra.io.evil.com"
// shapes the §4.2 wording is reacting to. We always go through `new URL()`.

// Default baseline — guidelines §4.2 lists exactly these three host shapes.
// Adding to this list is a docs change first (§4.2: "New tool / new
// allowlist row → doc change first").
export const DEFAULT_ALLOWLIST: readonly string[] = ['*.ultra.io', 'localhost', '127.0.0.1'];

// Canonical public Ultra RPC providers — mirrored host-for-host from the
// toolkit's `src/utilities/networks.ts` (`Mainnet.urls` + `Testnet.urls`). The
// read-only tool dispatcher and the W9 balance gate must reach these to read
// chain state (e.g. a `get_currency_balance` for the attested account's UOS).
// Without them an attested mainnet/testnet caller's balance read is REJECTED →
// the gate fails closed → counts 0 UOS → false `insufficient-uos` refuse.
// Hosts only (the matcher compares hostname, https-only). Keep in sync with
// networks.ts. NOTE (docs §4.2): this widens the baseline beyond `*.ultra.io`
// to the official third-party Ultra RPC hosts — read-only chain RPC only.
export const ULTRA_PUBLIC_RPC_HOSTS: readonly string[] = [
    // Mainnet (networks.ts → Mainnet.urls)
    'ultra.eosusa.io',
    'api.ultra.cryptolions.io',
    'api.ultra.eossweden.org',
    'ultra-api.eoseoul.io',
    'ultra.eosphere.io',
    'ultra.eosrio.io',
    // Testnet (networks.ts → Testnet.urls)
    'test.ultra.eosusa.io',
    'api.ultra-testnet.cryptolions.io',
    'api.testnet.ultra.eossweden.org',
    'ultra-testnet.eosphere.io',
    'testnet.ultra.eosrio.io',
];

// The baked-in baseline = the §4.2 minimal set + the canonical Ultra RPC hosts.
export const BASE_ALLOWLIST: readonly string[] = [...DEFAULT_ALLOWLIST, ...ULTRA_PUBLIC_RPC_HOSTS];

// Parses ALLOWED_CHAIN_HOSTS (comma-separated) and concatenates onto the
// baked-in baseline. Whitespace-trimmed; blank entries are dropped. Tests
// pass a synthetic env so this never reads process.env at import time.
export function buildAllowlistFromEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
    const raw = env.ALLOWED_CHAIN_HOSTS;
    if (!raw) return BASE_ALLOWLIST;
    const extra = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    return [...BASE_ALLOWLIST, ...extra];
}

function hostMatches(host: string, entry: string): boolean {
    if (entry.startsWith('*.')) {
        const suffix = entry.slice(2); // strip "*."
        // Match exact suffix root ("ultra.io" matches the "*.ultra.io" wildcard)
        // AND any "*.ultra.io" subdomain — but NOT "ultra.io.evil.com" which
        // is the canonical attack shape §4.2 calls out.
        if (host === suffix) return true;
        return host.endsWith(`.${suffix}`);
    }
    return host === entry;
}

export function isAllowedEndpoint(url: string, allowlist: readonly string[]): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }

    // Reject credentials-in-URL form — `https://user:pass@api.ultra.io/...`
    // — because the host check would otherwise pass while the credentials
    // are silently sent to the chain endpoint.
    if (parsed.username !== '' || parsed.password !== '') return false;

    const host = parsed.hostname.toLowerCase();
    // IPv6 loopback intentionally NOT supported in W4 — add to DEFAULT_ALLOWLIST
    // and to this list together if needed (avoid widening one without the other).
    const isLoopback = host === 'localhost' || host === '127.0.0.1';

    // Protocol gate. https only, except loopback may use http (local dev).
    if (parsed.protocol === 'https:') {
        // ok
    } else if (parsed.protocol === 'http:' && isLoopback) {
        // ok
    } else {
        return false;
    }

    return allowlist.some((entry) => hostMatches(host, entry));
}
