// Thin wrapper around the AI backend at VITE_AI_BACKEND_URL.
//
// Targets `POST /api/ai-chat` (W3). Returns the discriminated `Reply` union;
// throws AiClientError on transport / HTTP failures (typed refuse bodies on
// non-2xx are surfaced as Reply, not exceptions).
//
// Identity is opportunistic (docs/00 §3.7): when the wallet provides a
// connect-time attestation we forward it as `Authorization: Attestation
// <base64url(JSON)>`; when absent we send no header and the backend uses the
// per-IP path. Rate-limit / balance-gate refuses surface as `kind: 'refuse'`
// in the 200-body Reply, never as a non-200 status; transport errors throw
// `AiClientError`.

import type { Action } from '../interfaces';
import type { ConnectAttestation } from '@ultraos/wallet-sdk';

export interface AiChatContext {
    validatedAccounts: string[];
    knownAccounts: string[];
    selectedAccount?: string;
    chainId: string;
    endpoint: string;
}

export interface AiChatRequest {
    sessionId: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    context: AiChatContext;
}

// W3 Reply union — must stay in lock-step with backend/src/pipeline/validate.ts.
// One kind per chat outcome; downstream code switches over `kind`.
export type ReplyAct = { kind: 'act'; actions: Action[]; rationale: string };
export type ReplyPropose = {
    kind: 'propose';
    proposalName: string;
    actions: Action[];
    requested: Array<{ actor: string; permission: string }>;
    rationale: string;
};
export type ReplyAsk = { kind: 'ask'; question: string };
export type ReplyRefuse = { kind: 'refuse'; reason: string };
export type ReplyAnswer = { kind: 'answer'; text: string };
export type Reply = ReplyAct | ReplyPropose | ReplyAsk | ReplyRefuse | ReplyAnswer;

// W8: per-turn usage sidecar from the backend. OMITTED by the backend when it
// short-circuits before a provider call (e.g. classifier refuse/ask).
export interface AiUsageSidecar {
    cost_usd: number;
    tokens_in: number;
    tokens_out: number;
}

// W8: wrapper response shape — `reply` is the unchanged Reply union, `usage`
// is optional. Pre-W8 backends returned the Reply directly; the parser below
// handles both shapes for backward compatibility.
export interface AiChatResponse {
    reply: Reply;
    usage?: AiUsageSidecar;
}

// W8: daily aggregate from GET /api/ai-usage.
export interface AiUsageToday {
    tokensInToday: number;
    tokensOutToday: number;
    costUsdToday: number;
    turnsToday: number;
}

export class AiClientError extends Error {
    status?: number;
    cause?: unknown;
    constructor(message: string, status?: number, cause?: unknown) {
        super(message);
        this.name = 'AiClientError';
        this.status = status;
        this.cause = cause;
    }
}

const DEFAULT_BASE_URL = 'http://localhost:8787';
const REQUEST_TIMEOUT_MS = 60_000;
// Local Ollama turns commonly run 3–8 s with the retry pass; 5 s caused the
// hint to fire on every turn. 10 s catches genuine slowness without nagging.
const WARMING_HINT_MS = 10_000;

export function getBaseUrl(): string {
    const fromEnv = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AI_BACKEND_URL;
    return fromEnv?.trim() || DEFAULT_BASE_URL;
}

// base64url(JSON) for the Authorization: Attestation header. Browser-native
// (TextEncoder + btoa) — no Buffer dependency. Backend decodes with
// Buffer.from(value, 'base64url'), which accepts the unpadded -/_ alphabet.
function base64UrlEncode(input: string): string {
    const bytes = new TextEncoder().encode(input);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PostOptions {
    onWarming?: () => void;
    signal?: AbortSignal;
    // W9: when present, forwarded as `Authorization: Attestation <base64url(JSON)>`.
    attestation?: ConnectAttestation;
}

async function readErrorBody(res: Response): Promise<string> {
    try {
        return (await res.text()).slice(0, 500);
    } catch {
        return '';
    }
}

function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError';
}

// Backend may return either the W8 wrapper `{reply, usage}` or a bare Reply
// (pre-W8 / legacy). Returns null when the body matches neither.
function parseAiChatBody(body: unknown): AiChatResponse | null {
    if (!body || typeof body !== 'object') return null;
    if ('reply' in body) {
        const reply = (body as { reply: unknown }).reply;
        if (reply && typeof reply === 'object' && 'kind' in reply) {
            return { reply: reply as Reply, usage: (body as AiChatResponse).usage };
        }
    }
    if ('kind' in body) return { reply: body as Reply };
    return null;
}

export async function postAiChat(req: AiChatRequest, opts: PostOptions = {}): Promise<AiChatResponse> {
    const controller = new AbortController();
    const externalAbort = () => controller.abort(opts.signal?.reason);
    if (opts.signal) {
        if (opts.signal.aborted) controller.abort(opts.signal.reason);
        else opts.signal.addEventListener('abort', externalAbort, { once: true });
    }
    const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS);
    const warmingId = opts.onWarming ? setTimeout(opts.onWarming, WARMING_HINT_MS) : null;

    try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (opts.attestation) {
            headers['Authorization'] = `Attestation ${base64UrlEncode(JSON.stringify(opts.attestation))}`;
        }
        const res = await fetch(`${getBaseUrl()}/api/ai-chat`, {
            method: 'POST',
            headers,
            body: JSON.stringify(req),
            signal: controller.signal,
        });
        if (!res.ok) {
            if (res.headers.get('content-type')?.includes('application/json')) {
                try {
                    const parsed = parseAiChatBody(await res.json());
                    if (parsed) return parsed;
                } catch {
                    /* fall through */
                }
            }
            throw new AiClientError(`Backend returned ${res.status}`, res.status, await readErrorBody(res));
        }
        const body = await res.json();
        const parsed = parseAiChatBody(body);
        if (parsed) return parsed;
        // Fallback: unparseable response. Surface as a transport refuse.
        throw new AiClientError('Backend returned an unexpected response shape', undefined, body);
    } catch (err) {
        if (err instanceof AiClientError) throw err;
        if (isAbortError(err)) {
            const reason = controller.signal.reason;
            const isTimeout = reason instanceof Error && reason.message === 'timeout';
            throw new AiClientError(isTimeout ? 'Request timed out after 60s' : 'Request aborted', undefined, reason);
        }
        throw new AiClientError(`Couldn't reach the AI backend. Is it running on ${getBaseUrl()}?`, undefined, err);
    } finally {
        clearTimeout(timeoutId);
        if (warmingId) clearTimeout(warmingId);
        if (opts.signal) opts.signal.removeEventListener('abort', externalAbort);
    }
}

// W8: GET /api/ai-usage — daily aggregate.
// Returns today's GLOBAL usage aggregate (docs/00 §7). Public per docs/00 §3.1;
// the chip can fetch on every drawer-open without auth concerns.
export interface GetAiUsageOptions {
    signal?: AbortSignal;
}

export async function getAiUsage(opts: GetAiUsageOptions = {}): Promise<AiUsageToday> {
    const res = await fetch(`${getBaseUrl()}/api/ai-usage`, {
        method: 'GET',
        signal: opts.signal,
    });
    if (!res.ok) throw new AiClientError(`Usage endpoint returned ${res.status}`, res.status);
    const body = (await res.json()) as AiUsageToday;
    // Validate the shape so a malformed response doesn't break the chip.
    return {
        tokensInToday: Number(body.tokensInToday) || 0,
        tokensOutToday: Number(body.tokensOutToday) || 0,
        costUsdToday: Number(body.costUsdToday) || 0,
        turnsToday: Number(body.turnsToday) || 0,
    };
}
