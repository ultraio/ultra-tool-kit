import { test, expect } from '@playwright/test';
import { installAiStub } from './fixtures/ai-stub';

test.describe('AI empty + error states', () => {
    test.beforeEach(async ({ page }) => {
        await installAiStub(page);
    });

    test('layer-1 length cap shows inline error and skips network', async ({ page }) => {
        // Override the shared stub with a counter so we can assert Layer 1 short-circuits.
        let actionCalls = 0;
        await page.route('**/api/ai-action', (route) => {
            actionCalls += 1;
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ kind: 'refuse', reason: 'should-not-be-called' }),
            });
        });

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        await page.click('[data-testid="ai-chat-open"]');
        const long = 'x'.repeat(1500);
        await page.fill('[data-testid="ai-chat-input"]', long);
        await page.click('[data-testid="ai-chat-send"]');

        await expect(page.locator('[data-testid="ai-inline-error"]')).toBeVisible();
        expect(actionCalls).toBe(0);
    });

    test('graceful failure when backend is unreachable', async ({ page }) => {
        await page.route('**/api/ai-action', (route) => route.abort('failed'));

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        await page.click('[data-testid="ai-chat-open"]');
        await page.fill('[data-testid="ai-chat-input"]', 'transfer 1 UOS from a to b');
        await page.click('[data-testid="ai-chat-send"]');

        await expect(page.locator('[data-testid="ai-inline-error"]')).toBeVisible({ timeout: 5000 });
    });
});
