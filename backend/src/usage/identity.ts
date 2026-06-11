// Shared identity-key derivation for the quota gate + /api/ai-quota read
// (docs/00 §3.8). Both must derive the SAME key from the SAME request — the
// route reports the spend the gate enforces — so the logic lives here once.
//
// Key: verified attested account → `acct:<account>`; else the hashed client
// IP → `ip:<sha256(clientIpOf ?? 'unknown')>`. The IP is hashed so raw client
// IPs never become map keys (spec §5.1).

import { createHash } from 'node:crypto';
import type { Context } from 'hono';

import { clientIpOf } from '../middleware/logging.js';
import type { AttestedIdentity } from '../middleware/attestation.js';

export function sha256Hex(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

export function identityKey(c: Context, identity: AttestedIdentity | undefined): string {
    return identity ? `acct:${identity.account}` : `ip:${sha256Hex(clientIpOf(c) ?? 'unknown')}`;
}
