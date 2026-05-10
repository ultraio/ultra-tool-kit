import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/llm/ollama.js', () => {
    const ctor = vi.fn();
    class OllamaProvider {
        constructor(...args: unknown[]) {
            ctor(...args);
        }
        modelTag(): string {
            return 'ollama:mock';
        }
        vectorDim(): 768 {
            return 768;
        }
        chat(): Promise<never> {
            return Promise.reject(new Error('not used in router test'));
        }
        embed(): Promise<never> {
            return Promise.reject(new Error('not used in router test'));
        }
    }
    return { OllamaProvider, __ctor: ctor };
});

vi.mock('../../src/llm/anthropic.js', () => {
    const ctor = vi.fn();
    class AnthropicProvider {
        constructor(...args: unknown[]) {
            ctor(...args);
        }
        modelTag(): string {
            return 'anthropic:mock';
        }
        vectorDim(): 1536 {
            return 1536;
        }
        chat(): Promise<never> {
            return Promise.reject(new Error('not used in router test'));
        }
        embed(): Promise<never> {
            return Promise.reject(new Error('not used in router test'));
        }
    }
    return { AnthropicProvider, __ctor: ctor };
});

vi.mock('../../src/llm/openai.js', () => {
    const ctor = vi.fn();
    class OpenAIProvider {
        constructor(...args: unknown[]) {
            ctor(...args);
        }
        modelTag(): string {
            return 'openai:mock';
        }
        vectorDim(): 1536 {
            return 1536;
        }
        chat(): Promise<never> {
            return Promise.reject(new Error('not used in router test'));
        }
        embed(): Promise<never> {
            return Promise.reject(new Error('not used in router test'));
        }
    }
    return { OpenAIProvider, __ctor: ctor };
});

const ENV_KEYS = ['LLM_PROVIDER', 'EMBED_PROVIDER', 'CLASSIFIER_PROVIDER'] as const;

describe('llm router', () => {
    let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

    beforeEach(() => {
        originalEnv = {};
        for (const k of ENV_KEYS) {
            originalEnv[k] = process.env[k];
            delete process.env[k];
        }
        vi.resetModules();
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            const v = originalEnv[k];
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('defaults all three roles to ollama when no env set', async () => {
        const { getRouter } = await import('../../src/llm/router.js');
        const r = getRouter();
        expect(r.chat.modelTag()).toBe('ollama:mock');
        expect(r.embed.modelTag()).toBe('ollama:mock');
        expect(r.classifier.modelTag()).toBe('ollama:mock');
    });

    it('routes each role independently from env vars', async () => {
        process.env.LLM_PROVIDER = 'anthropic';
        process.env.EMBED_PROVIDER = 'openai';
        process.env.CLASSIFIER_PROVIDER = 'ollama';
        const { getRouter } = await import('../../src/llm/router.js');
        const r = getRouter();
        expect(r.chat.modelTag()).toBe('anthropic:mock');
        expect(r.embed.modelTag()).toBe('openai:mock');
        expect(r.classifier.modelTag()).toBe('ollama:mock');
    });

    it('embed and classifier inherit LLM_PROVIDER when their env var is unset', async () => {
        process.env.LLM_PROVIDER = 'anthropic';
        const { getRouter } = await import('../../src/llm/router.js');
        const r = getRouter();
        expect(r.chat.modelTag()).toBe('anthropic:mock');
        expect(r.embed.modelTag()).toBe('anthropic:mock');
        expect(r.classifier.modelTag()).toBe('anthropic:mock');
    });

    it('caches provider instances per provider name', async () => {
        process.env.LLM_PROVIDER = 'anthropic';
        process.env.EMBED_PROVIDER = 'anthropic';
        process.env.CLASSIFIER_PROVIDER = 'anthropic';
        const { getRouter } = await import('../../src/llm/router.js');
        const r = getRouter();
        expect(r.chat).toBe(r.embed);
        expect(r.embed).toBe(r.classifier);
    });

    it('returns three independent instances when providers differ', async () => {
        process.env.LLM_PROVIDER = 'anthropic';
        process.env.EMBED_PROVIDER = 'openai';
        process.env.CLASSIFIER_PROVIDER = 'ollama';
        const { getRouter } = await import('../../src/llm/router.js');
        const r = getRouter();
        expect(r.chat).not.toBe(r.embed);
        expect(r.embed).not.toBe(r.classifier);
        expect(r.chat).not.toBe(r.classifier);
    });

    it('throws ProviderError on unknown provider names', async () => {
        process.env.LLM_PROVIDER = 'gemini';
        const { getRouter } = await import('../../src/llm/router.js');
        expect(() => getRouter()).toThrow(/Unknown LLM_PROVIDER/);
    });
});
