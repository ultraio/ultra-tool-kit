// One-shot nonce store backing POST /api/auth/{challenge,verify}.
//
// Guidelines §3.2: nonces are 32 random bytes (hex-encoded), live for
// `NONCE_TTL_SECONDS` (default 300 = 5 min), and are deleted on first use
// — a successful or failed verify both consume the nonce, so replay attempts
// fall through to the "unknown nonce" branch.
//
// In-process Map only (backend/CLAUDE.md hard rule 1: no DB; nonces lost on
// restart is acceptable for v1 single-instance per roadmap §9). Cross-process
// rate limiting / nonce sharing is deferred past v1.

import { randomBytes } from 'node:crypto';

export type NonceEntry = {
    nonce: string; // 32-byte hex string (64 chars)
    expiresAt: number; // ms epoch
};

export class NonceStore {
    private readonly nonces = new Map<string, number>();

    constructor(private readonly ttlMs: number) {}

    issue(now = Date.now()): NonceEntry {
        const nonce = randomBytes(32).toString('hex');
        const expiresAt = now + this.ttlMs;
        this.nonces.set(nonce, expiresAt);
        return { nonce, expiresAt };
    }

    // Returns true if `nonce` was known and unexpired. ALWAYS deletes — even
    // when expired or unknown — so a replay attempt past TTL still falls
    // through to "unknown nonce" on the next verify. This is the load-bearing
    // reuse-rejection branch.
    consume(nonce: string, now = Date.now()): boolean {
        const expiresAt = this.nonces.get(nonce);
        this.nonces.delete(nonce);
        if (expiresAt === undefined) return false;
        return expiresAt > now;
    }

    // Test/admin hook; production code should never call this.
    _size(): number {
        return this.nonces.size;
    }
}
