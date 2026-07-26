// summarisePriorHistory contract tests — no real network, mock the ChatProvider.
//
// Pins the W8 sliding-window summary behaviour:
//   - threshold (only summarise when more than HISTORY_WINDOW prior turns)
//   - env-gate (SUMMARY=off short-circuits before any provider call)
//   - silent failure (provider throws / malformed JSON → empty summary)
//   - prompt shape (surplus turns fenced; recent tail excluded)
//   - usage attribution (returned for the route to fold into telemetry)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HISTORY_WINDOW, summarisePriorHistory } from '../../src/pipeline/summary.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';
import type { PromptHistoryTurn } from '../../src/pipeline/prompts.js';

function makeMessages(n: number): PromptHistoryTurn[] {
    // Alternating roles. The last entry is the "current" user turn.
    const out: PromptHistoryTurn[] = [];
    for (let i = 0; i < n; i++) {
        out.push({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `turn-${i} content`,
        });
    }
    return out;
}

function mockProvider(impl: (req: ChatRequest) => Promise<ChatResponse> | ChatResponse): ChatProvider {
    const chat = vi.fn(async (req: ChatRequest): Promise<ChatResponse> => impl(req));
    return {
        chat,
        modelTag: () => 'anthropic:test',
    };
}

describe('summarisePriorHistory', () => {
    const ORIG_SUMMARY = process.env.SUMMARY;

    beforeEach(() => {
        delete process.env.SUMMARY;
    });

    afterEach(() => {
        if (ORIG_SUMMARY === undefined) {
            delete process.env.SUMMARY;
        } else {
            process.env.SUMMARY = ORIG_SUMMARY;
        }
    });

    it('returns empty summary and does NOT call the provider when there is no surplus', async () => {
        const provider = mockProvider(() => ({
            json: { summary: 'should not be called' },
            usage: { input: 1, output: 1 },
        }));

        const messages = makeMessages(HISTORY_WINDOW + 1); // 7 messages → 6 prior turns, no surplus

        const result = await summarisePriorHistory(messages, { provider });

        expect(result).toEqual({ summary: '' });
        expect(provider.chat).not.toHaveBeenCalled();
    });

    it('calls the provider exactly once when there is surplus and returns the summary + usage', async () => {
        const provider = mockProvider(() => ({
            json: { summary: 'duncan asked about UOS transfer to alice' },
            usage: { input: 123, output: 45 },
        }));

        // 10 messages → 9 prior turns, surplus = 10 - HISTORY_WINDOW = 4 messages
        const messages = makeMessages(10);

        const result = await summarisePriorHistory(messages, { provider });

        expect(provider.chat).toHaveBeenCalledTimes(1);
        expect(result.summary).toBe('duncan asked about UOS transfer to alice');
        expect(result.usage).toEqual({ input: 123, output: 45 });
    });

    it('short-circuits on SUMMARY=off env var', async () => {
        process.env.SUMMARY = 'off';
        const provider = mockProvider(() => ({
            json: { summary: 'should not run' },
            usage: { input: 1, output: 1 },
        }));

        const messages = makeMessages(10);

        const result = await summarisePriorHistory(messages, { provider });

        expect(result).toEqual({ summary: '' });
        expect(provider.chat).not.toHaveBeenCalled();
    });

    it('short-circuits on deps.enabled === false', async () => {
        const provider = mockProvider(() => ({
            json: { summary: 'should not run' },
            usage: { input: 1, output: 1 },
        }));

        const messages = makeMessages(10);

        const result = await summarisePriorHistory(messages, { provider, enabled: false });

        expect(result).toEqual({ summary: '' });
        expect(provider.chat).not.toHaveBeenCalled();
    });

    it('returns empty summary (no rethrow) when the provider throws', async () => {
        const provider = mockProvider(() => {
            throw new Error('upstream 503');
        });

        const messages = makeMessages(10);

        const result = await summarisePriorHistory(messages, { provider });

        expect(result).toEqual({ summary: '' });
        expect(provider.chat).toHaveBeenCalledTimes(1);
    });

    it('returns empty summary when the provider returns JSON missing the summary key', async () => {
        const provider = mockProvider(() => ({
            json: { not_summary: 'oops' },
            usage: { input: 10, output: 5 },
        }));

        const messages = makeMessages(10);

        const result = await summarisePriorHistory(messages, { provider });

        expect(result).toEqual({ summary: '' });
    });

    it('returns empty summary when the provider returns summary as an empty string', async () => {
        const provider = mockProvider(() => ({
            json: { summary: '   ' },
            usage: { input: 10, output: 5 },
        }));

        const messages = makeMessages(10);

        const result = await summarisePriorHistory(messages, { provider });

        expect(result).toEqual({ summary: '' });
    });

    it('builds a user prompt that fences the surplus turns as <user_input> / <prior_assistant>', async () => {
        let captured: ChatRequest | null = null;
        const provider = mockProvider((req) => {
            captured = req;
            return {
                json: { summary: 'ok' },
                usage: { input: 10, output: 5 },
            };
        });

        const messages = makeMessages(10); // surplus = first 4 turns (indices 0..3)

        await summarisePriorHistory(messages, { provider });

        expect(captured).not.toBeNull();
        const req = captured as unknown as ChatRequest;

        // The verbatim preamble from the W8 brief.
        expect(req.user).toContain(
            'Summarize the prior conversation into one sentence. Keep account names, asset symbols, and intent verbs verbatim.'
        );

        // Every surplus turn appears, properly fenced. Turns 0 (user), 1
        // (assistant), 2 (user), 3 (assistant) per makeMessages alternation.
        expect(req.user).toContain('<user_input>');
        expect(req.user).toContain('</user_input>');
        expect(req.user).toContain('<prior_assistant>');
        expect(req.user).toContain('</prior_assistant>');
        expect(req.user).toContain('turn-0 content');
        expect(req.user).toContain('turn-1 content');
        expect(req.user).toContain('turn-2 content');
        expect(req.user).toContain('turn-3 content');

        // Schema is JSON-shape-gated so the route can read back result.json.summary.
        expect(req.toolSchema).toBeDefined();
        expect(req.maxTokens).toBe(200);
    });

    it('does NOT include the last HISTORY_WINDOW turns (the recent tail) in the summary prompt', async () => {
        let captured: ChatRequest | null = null;
        const provider = mockProvider((req) => {
            captured = req;
            return {
                json: { summary: 'ok' },
                usage: { input: 10, output: 5 },
            };
        });

        const messages = makeMessages(10); // surplus = indices 0..3; tail = indices 4..9

        await summarisePriorHistory(messages, { provider });

        const req = captured as unknown as ChatRequest;
        // Recent tail (indices 4..9) must NOT appear in the summariser's prompt —
        // the route already keeps those verbatim for the main call.
        expect(req.user).not.toContain('turn-4 content');
        expect(req.user).not.toContain('turn-5 content');
        expect(req.user).not.toContain('turn-6 content');
        expect(req.user).not.toContain('turn-7 content');
        expect(req.user).not.toContain('turn-8 content');
        expect(req.user).not.toContain('turn-9 content');
    });
});
