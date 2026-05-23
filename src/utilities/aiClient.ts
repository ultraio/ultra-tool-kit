// Thin wrapper around the AI backend at VITE_AI_BACKEND_URL.
//
// Targets `POST /api/ai-chat` (W3). Returns the discriminated `Reply` union;
// throws AiClientError on transport / HTTP failures (typed refuse bodies on
// non-2xx are surfaced as Reply, not exceptions).
//
// JWT is passed in by the caller as `Authorization: Bearer <jwt>` when
// supplied. In local dev with DEV_AUTH_BYPASS=true the backend accepts
// loopback requests without a bearer; in hosted environments a 401 will
// surface as an AiClientError with status 401 — the caller decides how to
// prompt for re-auth.

import type { Action } from '../interfaces';

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
    const fromEnv = (import.meta as { env?: Record<string, string | undefined> }).env
        ?.VITE_AI_BACKEND_URL;
    return fromEnv?.trim() || DEFAULT_BASE_URL;
}

export interface PostOptions {
    onWarming?: () => void;
    signal?: AbortSignal;
    jwt?: string;
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

export async function postAiChat(req: AiChatRequest, opts: PostOptions = {}): Promise<Reply> {
    const controller = new AbortController();
    const externalAbort = () => controller.abort(opts.signal?.reason);
    if (opts.signal) {
        if (opts.signal.aborted) controller.abort(opts.signal.reason);
        else opts.signal.addEventListener('abort', externalAbort, { once: true });
    }
    const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS);
    const warmingId = opts.onWarming ? setTimeout(opts.onWarming, WARMING_HINT_MS) : null;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.jwt) headers.authorization = `Bearer ${opts.jwt}`;

    try {
        const res = await fetch(`${getBaseUrl()}/api/ai-chat`, {
            method: 'POST',
            headers,
            body: JSON.stringify(req),
            signal: controller.signal,
        });
        // The backend returns HTTP 200 for every authed outcome (including
        // refuse) per guidelines §3.3. 401 from the auth gate is the one
        // documented non-200; surface it as a typed refuse so the caller
        // can prompt re-auth without exception-catching.
        if (res.status === 401) {
            return { kind: 'refuse', reason: 'auth-required' };
        }
        if (!res.ok) {
            if (res.headers.get('content-type')?.includes('application/json')) {
                try {
                    const body = (await res.json()) as Reply;
                    if (body && typeof body === 'object' && 'kind' in body) return body;
                } catch {
                    /* fall through */
                }
            }
            throw new AiClientError(`Backend returned ${res.status}`, res.status, await readErrorBody(res));
        }
        return (await res.json()) as Reply;
    } catch (err) {
        if (err instanceof AiClientError) throw err;
        if (isAbortError(err)) {
            const reason = controller.signal.reason;
            const isTimeout = reason instanceof Error && reason.message === 'timeout';
            throw new AiClientError(
                isTimeout ? 'Request timed out after 60s' : 'Request aborted',
                undefined,
                reason
            );
        }
        throw new AiClientError(
            `Couldn't reach the AI backend. Is it running on ${getBaseUrl()}?`,
            undefined,
            err
        );
    } finally {
        clearTimeout(timeoutId);
        if (warmingId) clearTimeout(warmingId);
        if (opts.signal) opts.signal.removeEventListener('abort', externalAbort);
    }
}
