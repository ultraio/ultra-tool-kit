// Hono app factory. Kept separate from src/index.ts so integration tests can
// build the app and call `app.request(...)` without starting a listener.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware } from './middleware/auth.js';
import { loggingMiddleware } from './middleware/logging.js';
import { rateLimitMiddleware } from './middleware/ratelimit.js';
import authRoute from './routes/auth.js';
import aiUsageRoute from './routes/ai-usage.js';
import aiActionRoute from './routes/ai-action.js';

function parseAllowedOrigins(): string[] {
    const raw = process.env.ALLOWED_ORIGINS;
    if (!raw || raw.trim().length === 0) return ['http://localhost:5172'];
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s !== '*');
}

export function createApp(): Hono {
    const app = new Hono();

    app.use('*', loggingMiddleware);
    app.use(
        '*',
        cors({
            origin: parseAllowedOrigins(),
            credentials: false,
        })
    );
    app.use('*', authMiddleware);

    app.route('/api/auth', authRoute);
    app.route('/api/ai-usage', aiUsageRoute);

    const aiActionApp = new Hono();
    aiActionApp.use('*', rateLimitMiddleware);
    aiActionApp.route('/', aiActionRoute);
    app.route('/api/ai-action', aiActionApp);

    app.get('/health', (c) => c.json({ ok: true }));

    return app;
}
