// Pino-backed request logger. Logs method/path/userId/durationMs/status only —
// never request bodies (per backend/CLAUDE.md and docs/03-guardrails.md).

import pino, { type Logger } from 'pino';
import type { MiddlewareHandler } from 'hono';

export type { Logger };

export const logger: Logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
});

export const loggingMiddleware: MiddlewareHandler = async (c, next) => {
    const start = Date.now();
    let status = 0;
    try {
        await next();
        status = c.res.status;
    } catch (err) {
        status = 500;
        logger.error(
            {
                method: c.req.method,
                path: c.req.path,
                userId: c.get('userId') ?? null,
                durationMs: Date.now() - start,
                status,
                err: err instanceof Error ? err.message : String(err),
            },
            'request error'
        );
        throw err;
    }
    logger.info(
        {
            method: c.req.method,
            path: c.req.path,
            userId: c.get('userId'),
            durationMs: Date.now() - start,
            status,
        },
        'request'
    );
};
