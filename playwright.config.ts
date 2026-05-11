import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 30000,
    // Chrome-extension e2e is flake-prone by nature: MV3 service-worker
    // cold-start, chrome.storage.session propagation, async vault →
    // AccountCacheService → router chains, and cross-context (popup/tab)
    // disk-read races. Retrying twice is the standard mitigation in this
    // domain (matches MetaMask / Coinbase Wallet test conventions). It does
    // NOT mask production bugs — a test that fails 3/3 still fails the run;
    // a test that flakes 1/3 surfaces in the report as a flaky-passed entry
    // so it's still actionable. CI uses 2 retries, local dev uses 0 to keep
    // iteration fast.
    retries: process.env.CI ? 2 : 0,
    // Show the flaky pass count in the run summary so we can track which
    // tests need a real fix (production race) vs a tighter selector.
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: 'http://localhost:5172',
        headless: true,
        // Saved on retry so a passing retry still leaves diagnostic data.
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    // AI chat e2e specs run against deterministic route stubs in
    // `tests/fixtures/ai-stub.ts`, so CI never needs the backend (Hono,
    // Postgres, Ollama) up. For a real end-to-end pass against a running
    // backend, follow backend/README.md and run `npm --prefix backend run dev`
    // alongside Vite.
    webServer: {
        command: 'npm run dev -- --host',
        port: 5172,
        reuseExistingServer: true,
        timeout: 30000,
    },
    projects: [
        {
            name: 'chromium',
            use: { browserName: 'chromium' },
        },
    ],
});
