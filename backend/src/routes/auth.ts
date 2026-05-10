// Phase-1 stub. Phase-2 wallet-JWT challenge/verify ships under these paths.

import { Hono } from 'hono';

const PHASE_1_BODY = {
    error: 'Phase 1 uses the auth middleware stub. Wallet-JWT challenge will land in Phase 2.',
};

const app = new Hono();

app.post('/challenge', (c) => c.json(PHASE_1_BODY, 501));
app.post('/verify', (c) => c.json(PHASE_1_BODY, 501));

export default app;
