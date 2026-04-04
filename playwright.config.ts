import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 30000,
    use: {
        baseURL: 'http://localhost:5172',
        headless: true,
    },
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
