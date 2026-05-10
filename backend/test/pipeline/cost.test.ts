import { describe, expect, it } from 'vitest';
import { computeCost, PRICING } from '../../src/pipeline/cost.js';

describe('computeCost', () => {
    it('Haiku tag computes both actual and projected from Haiku rates', () => {
        const usage = { input: 1000, output: 500, cached: 200 };
        const r = computeCost('anthropic:claude-haiku-4-5-20251001', usage);
        const expected =
            usage.input * PRICING['claude-haiku-4-5-20251001'].input +
            usage.output * PRICING['claude-haiku-4-5-20251001'].output +
            usage.cached * PRICING['claude-haiku-4-5-20251001'].cache_read;
        expect(r.actualUsd).toBeGreaterThan(0);
        expect(r.actualUsd).toBeCloseTo(expected, 12);
        expect(r.projectedUsd).toBeCloseTo(r.actualUsd, 12);
    });

    it('Ollama tag → actualUsd is 0 and projectedUsd uses Haiku rates', () => {
        const usage = { input: 1000, output: 500, cached: 0 };
        const r = computeCost('ollama:qwen2.5:7b', usage);
        const haikuExpected =
            usage.input * PRICING['claude-haiku-4-5-20251001'].input +
            usage.output * PRICING['claude-haiku-4-5-20251001'].output;
        expect(r.actualUsd).toBe(0);
        expect(r.projectedUsd).toBeCloseTo(haikuExpected, 12);
    });

    it('Unknown non-ollama model → returns 0/0 without throwing', () => {
        const r = computeCost('anthropic:claude-future-9000', { input: 100, output: 50 });
        expect(r.actualUsd).toBe(0);
        expect(r.projectedUsd).toBe(0);
    });

    it('Embed-only usage (no output rate in PRICING) → input-only cost', () => {
        const usage = { input: 4096, output: 0 };
        const r = computeCost('openai:text-embedding-3-small', usage);
        const expected = usage.input * PRICING['text-embedding-3-small'].input;
        expect(r.actualUsd).toBeCloseTo(expected, 12);
        expect(r.projectedUsd).toBeCloseTo(expected, 12);
    });

    it('gpt-4o-mini computes input+output with no cached rate', () => {
        const usage = { input: 1500, output: 250 };
        const r = computeCost('openai:gpt-4o-mini', usage);
        const expected = usage.input * PRICING['gpt-4o-mini'].input + usage.output * PRICING['gpt-4o-mini'].output;
        expect(r.actualUsd).toBeCloseTo(expected, 12);
        expect(r.projectedUsd).toBeCloseTo(expected, 12);
    });
});
