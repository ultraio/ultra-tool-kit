// W10 wiring test — proves createApp mounts GET /api/ai-quota and threads the
// quota deps (store + stake/price readers) through. /api/ai-quota never calls
// the LLM provider, so the mock only needs modelTag() (read once at boot for
// the price-table parity warning). Also covers the discoverability follow-up:
// the unlock fields (heldUos/thresholdUos/locked) flow through createApp.

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
    balanceThresholdUos: 2, // gate enabled; anon is never locked regardless
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

describe('quota wiring (W10)', () => {
    it('mounts GET /api/ai-quota and returns quota + unlock fields for an anon caller', async () => {
        const app = await createApp(CFG, {
            provider: mockProvider(),
            readStakedUos: async () => 0,
            readUosPrice: async () => 0.02,
            readUosBalance: async () => 0,
        });
        const res = await app.request('/api/ai-quota?sessionId=s1');
        expect(res.status).toBe(200);
        const b = await json(res);
        expect(b.dailyCapUsd).toBe(0.01); // QUOTA_FREE_FLOOR_USD default (free floor for anon)
        expect(b.spentTodayUsd).toBe(0);
        // Unlock fields present; anon is never locked and triggers no balance read.
        expect(b.thresholdUos).toBe(2);
        expect(b.heldUos).toBe(0);
        expect(b.locked).toBe(false);
    });
});
