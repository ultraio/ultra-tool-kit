// W10 wiring test — proves createApp mounts GET /api/ai-quota and threads the
// quota deps (store + stake/price readers) through. /api/ai-quota never calls
// the LLM provider, so the mock only needs modelTag() (read once at boot for
// the price-table parity warning).

import { describe, expect, it } from 'vitest';

import { createApp, type AppConfig } from '../src/index.js';
import type { ChatProvider } from '../src/llm/provider.js';

function mockProvider(): ChatProvider {
    return { modelTag: () => 'anthropic:haiku-4-5' } as unknown as ChatProvider;
}

const CFG: AppConfig = {
    allowedOrigins: ['http://localhost:5172'],
    devRatelimitBypass: true,
    llmProvider: 'anthropic', // ignored — provider is injected
    allowedChainHosts: ['127.0.0.1', 'localhost', '*.ultra.io'],
    balanceThresholdUos: 0, // disable the balance gate
};

describe('quota wiring (W10)', () => {
    it('mounts GET /api/ai-quota and returns the free floor for an anon caller', async () => {
        const app = await createApp(CFG, {
            provider: mockProvider(),
            readStakedUos: async () => 0,
            readUosPrice: async () => 0.02,
        });
        const res = await app.request('/api/ai-quota?sessionId=s1');
        expect(res.status).toBe(200);
        const b = (await res.json()) as { dailyCapUsd: number; spentTodayUsd: number };
        expect(b.dailyCapUsd).toBe(0.01); // QUOTA_FREE_FLOOR_USD default
        expect(b.spentTodayUsd).toBe(0);
    });
});
