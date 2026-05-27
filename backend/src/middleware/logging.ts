// Structured request logging via pino. Logs the connection-level remote
// address (per `clientIpOf`); no JWT / signature concerns because the backend
// is anonymous (docs/00 §3.1).
//
// pino's default behavior is fine for everything else. We expose `logger`
// so routes can attach extra context; no global mutable state.

import pino from 'pino';
import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

export const logger = pino({
    name: 'ultra-tool-kit-backend',
    level: process.env.LOG_LEVEL ?? 'info',
});

// Single source of truth for reading the client IP off Hono's env. Used by
// both the request logger and the per-IP rate-limit middleware.
//
// Hosted deploy WARNING: this returns the connection-level remote address.
// v1 binds loopback only so the connection-level remote address is always
// trustworthy. When hosted-deploy lands, this MUST be replaced with a
// trusted-proxy header read (CF-Connecting-IP for Cloudflare). Trusting
// X-Forwarded-For naively allows trivial per-request IP spoofing.
//
// Test code passes `env: { incoming: { socket: { ... } } }` directly into
// `app.request(url, init, env)`.
export function clientIpOf(c: Parameters<MiddlewareHandler>[0]): string | undefined {
    try {
        return getConnInfo(c).remote.address;
    } catch {
        return undefined;
    }
}

export const requestLogger: MiddlewareHandler = async (c, next) => {
    const start = Date.now();
    await next();
    logger.info(
        {
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            ip: clientIpOf(c),
            origin: c.req.header('origin'),
            durMs: Date.now() - start,
        },
        'request'
    );
};
