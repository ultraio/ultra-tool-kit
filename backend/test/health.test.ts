import { describe, it, expect } from 'vitest';
import { createApp, type AppConfig } from '../src/index.js';
import type { ChatProvider } from '../src/llm/provider.js';

// Minimal config; the only provider method used at boot is modelTag() (index.ts:138).
const cfg: AppConfig = {
    allowedOrigins: ['http://localhost:5172'],
    devRatelimitBypass: true,
    llmProvider: 'anthropic',
    allowedChainHosts: [],
};

const stubProvider = {
    modelTag: () => 'claude-haiku-4-5-20251001',
} as unknown as ChatProvider;

describe('GET /health', () => {
    it('returns 200 {ok:true} without auth, outside the /api chain', async () => {
        const app = await createApp(cfg, { provider: stubProvider });
        const res = await app.request('/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });
});
