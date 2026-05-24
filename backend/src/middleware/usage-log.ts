// Per-turn usage telemetry middleware.
//
// Spec: docs/00-ai-global-guidelines.md §7 (row schema) + §4.4 (privacy
// gates). Implements roadmap §6 row W8 — one JSONL line per chat turn,
// append-only, PII-minimal by construction.
//
// The row schema is a contract: §7.1 lists this file in the
// simplifier-exclusion list because future log consumers depend on the
// exact named-field set. Extra fields → CI failure. Missing fields → CI
// failure. The buildRow helper is the single named-field constructor — any
// future change to the schema lands here AND in the doc.
//
// This middleware is generic. It reads typed values off `c.var` set by the
// route handler (provider model tag, last-call usage, validator-coerced
// flag, tool audit, auth claims) — it does NOT import from
// `routes/ai-chat.ts`. Phase 3 wires it into createApp.

import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MiddlewareHandler } from 'hono';

import type { VerifiedClaims } from '../auth/jwt.js';
import { logger } from './logging.js';

// Resolve <repo>/backend/logs/usage.jsonl from this file's location.
// src/middleware/usage-log.ts → ../../logs/usage.jsonl
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOG_PATH = join(HERE, '..', '..', 'logs', 'usage.jsonl');

// Frozen module-top price table. Unknown tag → cost 0 (defensive); ollama
// tags are pinned at 0 so local dev never reports a phantom dollar figure.
// Values are USD per 1M tokens; source: Anthropic public pricing snapshot
// captured at W8 wave-start. Update with a doc PR if pricing changes.
const PRICE_TABLE: Record<string, { inPerM: number; outPerM: number }> = {
    'anthropic:haiku-4-5': { inPerM: 1.0, outPerM: 5.0 },
    'anthropic:claude-haiku-4-5': { inPerM: 1.0, outPerM: 5.0 },
    'ollama:qwen3:14b': { inPerM: 0, outPerM: 0 },
    'ollama:llama3.1:8b': { inPerM: 0, outPerM: 0 },
};

// Sentinel when the route handler never set providerModel (e.g. 401 short-
// circuit before the harness ran). Treated as unknown → cost 0.
const UNKNOWN_MODEL = 'unknown:unknown';

export type UsageLogContext = {
    Variables: {
        validateCoerced?: boolean;
        providerModel?: string;
        lastUsage?: { input: number; output: number };
        // toolAudit is already declared in the ai-chat context (W4); we read
        // it loosely here and don't redeclare to avoid type-merge clashes.
    };
};

export type UsageLogDeps = {
    logPath?: string;
    now?: () => Date;
};

// §7 row shape. Every field is required — Phase 3 / W8 CI greps will
// assert the keyset matches exactly. Don't widen this type.
export type UsageRow = {
    ts: string;
    sub: string;
    pubkey_prefix: string;
    account: string;
    endpoint_chainid: string;
    session_id_hash: string;
    turn_kind: 'act' | 'propose' | 'ask' | 'refuse' | 'answer';
    provider_model: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    latency_ms: number;
    tool_calls: string[];
    validation_outcome: 'pass' | 'coerced' | 'downgraded' | 'refused';
    user_msg_sha: string;
    user_msg_prefix: string;
};

type ToolAuditLike = { tool: string };

// Round to 6 decimals so a sub-cent figure still renders legibly in the
// JSONL — and so cost_usd equality assertions in tests don't fight float
// drift.
function round6(n: number): number {
    return Math.round(n * 1_000_000) / 1_000_000;
}

function sha256Hex(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

function pickTurnKind(inner: unknown): UsageRow['turn_kind'] {
    if (inner && typeof inner === 'object' && 'kind' in inner) {
        const k = String((inner as { kind: unknown }).kind);
        if (k === 'act' || k === 'propose' || k === 'ask' || k === 'refuse' || k === 'answer') {
            return k;
        }
    }
    // Defensive fallback — an unparseable response body is treated as a
    // refuse for telemetry purposes (matches the route's 401 / catch path).
    return 'refuse';
}

function pickValidationOutcome(
    turnKind: UsageRow['turn_kind'],
    validateCoerced: boolean
): UsageRow['validation_outcome'] {
    if (turnKind === 'refuse') return 'refused';
    if (turnKind === 'ask') return 'downgraded';
    if (turnKind === 'act' || turnKind === 'propose' || turnKind === 'answer') {
        return validateCoerced ? 'coerced' : 'pass';
    }
    return 'refused';
}

// Shared cost lookup so the route handler's response-wrapper `usage.cost_usd`
// uses the SAME price table the JSONL row uses. The PRICE_TABLE itself stays
// module-local — only this function is exported.
export function computeCostUsd(modelTag: string, tokensIn: number, tokensOut: number): number {
    const price = PRICE_TABLE[modelTag];
    if (!price) return 0;
    return round6((tokensIn / 1_000_000) * price.inPerM + (tokensOut / 1_000_000) * price.outPerM);
}

// Named-field row constructor. Order of property assignment fixes the
// JSON.stringify ordering — V8 preserves insertion order for string keys,
// which gives every row a stable key sequence in the on-disk file.
function buildRow(input: {
    ts: string;
    auth: VerifiedClaims | undefined;
    chainIdFromBody: string;
    sessionId: string;
    turnKind: UsageRow['turn_kind'];
    providerModel: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    latencyMs: number;
    toolCalls: string[];
    validationOutcome: UsageRow['validation_outcome'];
    userMessage: string;
}): UsageRow {
    const auth = input.auth;
    return {
        ts: input.ts,
        sub: auth?.sub ?? '',
        // PII gate (§4.4): never the full pubkey. Slice first 6 chars only.
        pubkey_prefix: auth?.pubkey ? auth.pubkey.slice(0, 6) : '',
        account: auth?.account ?? '',
        endpoint_chainid: input.chainIdFromBody || auth?.chainId || '',
        session_id_hash: sha256Hex(input.sessionId),
        turn_kind: input.turnKind,
        provider_model: input.providerModel,
        tokens_in: input.tokensIn,
        tokens_out: input.tokensOut,
        cost_usd: input.costUsd,
        latency_ms: input.latencyMs,
        tool_calls: input.toolCalls,
        validation_outcome: input.validationOutcome,
        user_msg_sha: sha256Hex(input.userMessage),
        // PII gate (§4.4): 80-char hard cap on the only field where user
        // text surfaces. LOG_FULL_BODIES does NOT widen this — see below.
        user_msg_prefix: input.userMessage.slice(0, 80),
    };
}

async function appendRow(logPath: string, row: UsageRow): Promise<void> {
    // Ensure the parent directory exists. fs.appendFile uses O_APPEND
    // under the hood, so concurrent writers stay line-atomic on POSIX.
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, JSON.stringify(row) + '\n', 'utf8');
}

export function usageLog(deps: UsageLogDeps = {}): MiddlewareHandler<UsageLogContext> {
    const logPath = deps.logPath ?? DEFAULT_LOG_PATH;
    const now = deps.now ?? (() => new Date());

    return async (c, next) => {
        const t0 = now();
        const startMs = Date.now();
        let userMessage = '';
        let sessionId = '';
        let bodyChainId = '';

        // Drain the body once to lift userMessage, sessionId, context.chainId.
        // The downstream handler reads c.req.json() too — so we clone the
        // underlying Request before consuming. If the body is non-JSON or
        // oversize, fall through with empty strings and let the route's own
        // gate produce the refuse.
        try {
            const cloned = c.req.raw.clone();
            const body = (await cloned.json()) as {
                messages?: Array<{ role: string; content: string }>;
                sessionId?: string;
                context?: { chainId?: string };
            };
            if (typeof body.sessionId === 'string') sessionId = body.sessionId;
            if (body.context && typeof body.context.chainId === 'string') {
                bodyChainId = body.context.chainId;
            }
            if (Array.isArray(body.messages)) {
                const lastUser = [...body.messages].reverse().find((m) => m && m.role === 'user');
                if (lastUser && typeof lastUser.content === 'string') userMessage = lastUser.content;
            }
        } catch {
            // keep defaults
        }

        try {
            await next();
        } finally {
            const latency_ms = Date.now() - startMs;

            // Response body comes from cloning c.res — Hono has already
            // called c.json() in the handler, so the body is set; cloning
            // avoids consuming it for any future reader (there is none,
            // but the discipline keeps the middleware composable).
            let response: unknown = {};
            try {
                response = await c.res.clone().json();
            } catch {
                // keep {}
            }

            // The future response wrapper form is `{ reply, usage }`. Until
            // that lands, the route returns the Reply directly. Detect both.
            const inner =
                response && typeof response === 'object' && 'reply' in response
                    ? (response as { reply: unknown }).reply
                    : response;

            // `auth` and `toolAudit` are owned by AuthContext / the ai-chat
            // route's context — this middleware deliberately doesn't import
            // those types to stay decoupled. Read via the untyped var bag.
            const vars = c.var as Record<string, unknown>;
            const auth = vars.auth as VerifiedClaims | undefined;
            const toolAudit = (vars.toolAudit as ToolAuditLike[] | undefined) ?? [];
            const validateCoerced = (vars.validateCoerced as boolean | undefined) ?? false;
            // providerModel is set by the route handler after the harness
            // call so the middleware never touches the provider singleton.
            // Falling back to UNKNOWN_MODEL ensures cost_usd=0 on 401 paths.
            const providerModel = (vars.providerModel as string | undefined) ?? UNKNOWN_MODEL;
            const lastUsage =
                (vars.lastUsage as { input: number; output: number } | undefined) ?? {
                    input: 0,
                    output: 0,
                };

            const turnKind = pickTurnKind(inner);
            const validationOutcome = pickValidationOutcome(turnKind, validateCoerced);
            const toolCalls = toolAudit.map((a) => a.tool).sort();
            const cost_usd = computeCostUsd(providerModel, lastUsage.input, lastUsage.output);

            // §4.4 dev-only gate. Even with LOG_FULL_BODIES the on-disk JSONL
            // row is unchanged (user_msg_prefix stays 80-capped) — only an
            // extra DEBUG log line surfaces full text. The brief is explicit.
            if (process.env.LOG_FULL_BODIES === 'true') {
                logger.debug(
                    { userMessage, sub: auth?.sub },
                    'usage-log: full body (LOG_FULL_BODIES dev gate)'
                );
            }

            const row = buildRow({
                ts: t0.toISOString(),
                auth,
                chainIdFromBody: bodyChainId,
                sessionId,
                turnKind,
                providerModel,
                tokensIn: lastUsage.input,
                tokensOut: lastUsage.output,
                costUsd: cost_usd,
                latencyMs: latency_ms,
                toolCalls,
                validationOutcome,
                userMessage,
            });

            // A failed write must NEVER fail the request — guidelines §7
            // makes telemetry best-effort by design.
            try {
                await appendRow(logPath, row);
            } catch (err) {
                logger.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    'usage-log: write failed'
                );
            }
        }
    };
}
