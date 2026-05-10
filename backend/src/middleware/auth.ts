// Phase-1 auth stub — sets a synthetic userId on every request so downstream
// code can read `c.get('userId')` unconditionally. Phase 2 swaps this for a
// wallet-JWT verifier without changing call sites.

import type { MiddlewareHandler } from 'hono';

export const PHASE_1_USER_ID = '00000000-0000-0000-0000-000000000001';

declare module 'hono' {
    interface ContextVariableMap {
        userId: string;
    }
}

export const authMiddleware: MiddlewareHandler = async (c, next) => {
    c.set('userId', PHASE_1_USER_ID);
    await next();
};
