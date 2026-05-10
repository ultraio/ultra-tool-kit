// Listener entry — boots the Hono app on BIND_HOST:BIND_PORT.
// Phase-1 hard rule: stub auth must not bind 0.0.0.0 (no LAN exposure).

import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { closeDb } from './db/client.js';
import { logger } from './middleware/logging.js';

const host = process.env.BIND_HOST ?? '127.0.0.1';
const port = Number(process.env.BIND_PORT ?? 8787);

if (host === '0.0.0.0') {
    throw new Error(
        'Refusing to bind 0.0.0.0 in Phase-1 stub-auth mode. Set BIND_HOST=127.0.0.1 or land Phase-2 wallet auth.'
    );
}

const app = createApp();

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    logger.info({ host: info.address, port: info.port }, `listening on ${info.address}:${info.port}`);
});

async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'shutting down');
    server.close();
    await closeDb();
    process.exit(0);
}

process.on('SIGINT', () => {
    void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});
