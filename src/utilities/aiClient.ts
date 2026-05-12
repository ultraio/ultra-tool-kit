// Thin wrapper around the AI backend (Hono service at VITE_AI_BACKEND_URL).
// Returns the discriminated `Reply` union; throws AiClientError on transport / HTTP failures.

export interface AiActionRequest {
    sessionId: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    context: {
        account: string;
        permission: string;
        endpoint: string;
        chainId: string;
        isAdmin: boolean;
        knownAccounts: string[];
    };
    model?: 'haiku' | 'gpt4o-mini';
}

export type ReplyAsk = { kind: 'ask'; question: string };
export type ReplyPropose = {
    kind: 'propose';
    contract: string;
    action: string;
    data: Record<string, unknown>;
    authorization: { actor: string; permission: string };
    rationale: string;
    candidates?: Array<{ contract: string; action: string; score: number }>;
};
export type ReplyRefuse = { kind: 'refuse'; reason: string; detail?: string };
export type Reply = ReplyAsk | ReplyPropose | ReplyRefuse;

export interface UsageTotals {
    calls: number;
    actualUsd: number;
    projectedUsd: number;
}

export interface UsagePerModel extends UsageTotals {
    modelTag: string;
    inputTokens: number;
    outputTokens: number;
}

export interface UsageResponse {
    lifetime: UsageTotals;
    today: UsageTotals;
    lastRequest: { at: string; modelTag: string; actualUsd: number; projectedUsd: number } | null;
    perModel: UsagePerModel[];
}

export function isOllamaTag(tag: string | undefined | null): boolean {
    return !!tag && tag.startsWith('ollama:');
}

export function formatUsd(amount: number): string {
    return `$${amount.toFixed(4)}`;
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
    const fromEnv = (import.meta as any).env?.VITE_AI_BACKEND_URL as string | undefined;
    return fromEnv?.trim() || DEFAULT_BASE_URL;
}

export interface PostOptions {
    onWarming?: () => void;
    signal?: AbortSignal;
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

export async function postAiAction(req: AiActionRequest, opts: PostOptions = {}): Promise<Reply> {
    const controller = new AbortController();
    const externalAbort = () => controller.abort(opts.signal?.reason);
    if (opts.signal) {
        if (opts.signal.aborted) controller.abort(opts.signal.reason);
        else opts.signal.addEventListener('abort', externalAbort, { once: true });
    }
    const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS);
    const warmingId = opts.onWarming ? setTimeout(opts.onWarming, WARMING_HINT_MS) : null;

    try {
        const res = await fetch(`${getBaseUrl()}/api/ai-action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(req),
            signal: controller.signal,
        });
        if (!res.ok) {
            // Servers may still send a typed refuse body on 4xx.
            if (res.headers.get('content-type')?.includes('application/json')) {
                try {
                    const body = (await res.json()) as Reply;
                    if (body && typeof body === 'object' && 'kind' in body) return body;
                } catch {
                    // fall through to error
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
        throw new AiClientError(`Couldn't reach the AI backend. Is it running on ${getBaseUrl()}?`, undefined, err);
    } finally {
        clearTimeout(timeoutId);
        if (warmingId) clearTimeout(warmingId);
        if (opts.signal) opts.signal.removeEventListener('abort', externalAbort);
    }
}

export async function getAiUsage(opts: { signal?: AbortSignal } = {}): Promise<UsageResponse> {
    try {
        const res = await fetch(`${getBaseUrl()}/api/ai-usage`, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: opts.signal,
        });
        if (!res.ok) {
            throw new AiClientError(`Backend returned ${res.status}`, res.status, await readErrorBody(res));
        }
        return (await res.json()) as UsageResponse;
    } catch (err) {
        if (err instanceof AiClientError || isAbortError(err)) throw err;
        throw new AiClientError("Couldn't reach the AI backend.", undefined, err);
    }
}
