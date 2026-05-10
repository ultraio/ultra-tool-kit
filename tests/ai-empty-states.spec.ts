import { test, expect } from '@playwright/test';

async function mockUsage(page) {
    await page.route('**/api/ai-usage', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                lifetime: { calls: 0, actualUsd: 0, projectedUsd: 0 },
                today: { calls: 0, actualUsd: 0, projectedUsd: 0 },
                lastRequest: null,
                perModel: [],
            }),
        })
    );
}

test.describe('AI empty + error states', () => {
    test('layer-1 length cap shows inline error and skips network', async ({ page }) => {
        await mockUsage(page);
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
        // Layer 1 must NOT call the backend.
        expect(actionCalls).toBe(0);
    });

    test('graceful failure when backend is unreachable', async ({ page }) => {
        await mockUsage(page);
        await page.route('**/api/ai-action', (route) => route.abort('failed'));

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        await page.click('[data-testid="ai-chat-open"]');
        await page.fill('[data-testid="ai-chat-input"]', 'transfer 1 UOS from a to b');
        await page.click('[data-testid="ai-chat-send"]');

        await expect(page.locator('[data-testid="ai-inline-error"]')).toBeVisible({ timeout: 5000 });
    });
});
