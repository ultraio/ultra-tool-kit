// Structured request logging via pino.
//
// Guidelines §4.4 hard rule: JWT and signature bytes NEVER appear in any log
// line. The request logger reads the Authorization header to detect that a
// Bearer token was present, but logs only the sub-prefix (set by the auth
// middleware after verify) and the origin/IP — never the token itself.
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

// Single source of truth for reading the remote address off Hono's env;
// the auth middleware reuses this for its loopback check. Test code passes
// `env: { incoming: { socket: { ... } } }` directly into
// `app.request(url, init, env)`.
export function remoteAddressOf(c: Parameters<MiddlewareHandler>[0]): string | undefined {
    try {
        return getConnInfo(c).remote.address;
    } catch {
        return undefined;
    }
}

export const requestLogger: MiddlewareHandler = async (c, next) => {
    const start = Date.now();
    await next();
    const sub = c.get('authSub') as string | undefined;
    logger.info(
        {
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            ip: remoteAddressOf(c),
            origin: c.req.header('origin'),
            sub_prefix: sub ? sub.slice(0, 14) : undefined, // "k1:" + 11 chars
            durMs: Date.now() - start,
        },
        'request'
    );
};
