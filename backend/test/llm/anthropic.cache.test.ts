// W8 prompt-cache snapshot test.
//
// Locks down the `cache_control: { type: 'ephemeral' }` directive on the
// system block so a future refactor that accidentally drops it gets caught
// (roadmap §3 ~80% input-token savings depends on this directive landing
// on every request). Also verifies the ANTHROPIC_PROMPT_CACHE=off rollback
// path: when set to 'off', the cache_control field is absent from the
// system block.
//
// No real network — mock the SDK at the import boundary. The mock records
// the `req` argument passed to `messages.create` so assertions can inspect
// the exact request body that would have hit Anthropic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the most recent request body across every test in this file.
const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
    // The SDK is a default-export class constructed via `new Anthropic({...})`
    // returning an object with `messages.create()`. Mirror that shape.
    return {
        default: class {
            messages = { create: createMock };
        },
    };
});

// Import AFTER vi.mock so the provider picks up the mocked SDK.
import { AnthropicProvider } from '../../src/llm/anthropic.js';

function stubToolUseResponse() {
    return {
        content: [
            {
                type: 'tool_use',
                name: 'emit_structured_response',
                input: { kind: 'answer', text: 'ok' },
            },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
    };
}

describe('anthropic provider prompt caching', () => {
    const savedEnv = process.env.ANTHROPIC_PROMPT_CACHE;

    beforeEach(() => {
        createMock.mockReset();
        createMock.mockResolvedValue(stubToolUseResponse());
        delete process.env.ANTHROPIC_PROMPT_CACHE;
    });

    afterEach(() => {
        if (typeof savedEnv === 'string') {
            process.env.ANTHROPIC_PROMPT_CACHE = savedEnv;
        } else {
            delete process.env.ANTHROPIC_PROMPT_CACHE;
        }
    });

    it('attaches cache_control to the system block by default (env unset)', async () => {
        const provider = new AnthropicProvider({ apiKey: 'test-key', chatModel: 'test-model' });
        await provider.chat({ system: 'HELLO WORLD', user: 'hi' });

        expect(createMock).toHaveBeenCalledTimes(1);
        const req = createMock.mock.calls[0]![0] as { system: Array<Record<string, unknown>> };
        expect(Array.isArray(req.system)).toBe(true);
        expect(req.system).toHaveLength(1);

        // Snapshot the request system block — this is the "snapshot the
        // request body" lock from the W8 brief.
        expect(req.system[0]).toEqual({
            type: 'text',
            text: 'HELLO WORLD',
            cache_control: { type: 'ephemeral' },
        });
    });

    it('attaches cache_control when ANTHROPIC_PROMPT_CACHE=on', async () => {
        process.env.ANTHROPIC_PROMPT_CACHE = 'on';
        const provider = new AnthropicProvider({ apiKey: 'test-key', chatModel: 'test-model' });
        await provider.chat({ system: 'HELLO WORLD', user: 'hi' });

        const req = createMock.mock.calls[0]![0] as { system: Array<Record<string, unknown>> };
        const block = req.system[0]!;
        expect(block.type).toBe('text');
        expect(block.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('omits cache_control when ANTHROPIC_PROMPT_CACHE=off', async () => {
        process.env.ANTHROPIC_PROMPT_CACHE = 'off';
        const provider = new AnthropicProvider({ apiKey: 'test-key', chatModel: 'test-model' });
        await provider.chat({ system: 'HELLO WORLD', user: 'hi' });

        const req = createMock.mock.calls[0]![0] as { system: Array<Record<string, unknown>> };
        expect(req.system).toHaveLength(1);
        const block = req.system[0]!;
        expect(block.type).toBe('text');
        expect(block.text).toBe('HELLO WORLD');
        expect('cache_control' in block).toBe(false);
    });

    it('treats ANTHROPIC_PROMPT_CACHE=OFF (case-insensitive, padded) as off', async () => {
        process.env.ANTHROPIC_PROMPT_CACHE = '  OFF  ';
        const provider = new AnthropicProvider({ apiKey: 'test-key', chatModel: 'test-model' });
        await provider.chat({ system: 'HELLO WORLD', user: 'hi' });

        const req = createMock.mock.calls[0]![0] as { system: Array<Record<string, unknown>> };
        const block = req.system[0]!;
        expect('cache_control' in block).toBe(false);
    });
});
