import { test, expect } from '@playwright/test';

test.describe('AI cost badge', () => {
    test('shows token totals under Ollama, dollar amount under hosted', async ({ page }) => {
        // First load: Ollama (lastRequest.modelTag starts with "ollama:").
        await page.route('**/api/ai-usage', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    lifetime: { calls: 3, actualUsd: 0, projectedUsd: 0.0123 },
                    today: { calls: 1, actualUsd: 0, projectedUsd: 0.0042 },
                    lastRequest: {
                        at: '2026-05-11T12:00:00.000Z',
                        modelTag: 'ollama:qwen2.5:7b',
                        actualUsd: 0,
                        projectedUsd: 0.0042,
                    },
                    perModel: [
                        {
                            modelTag: 'ollama:qwen2.5:7b',
                            calls: 3,
                            inputTokens: 8000,
                            outputTokens: 4500,
                            actualUsd: 0,
                            projectedUsd: 0.0123,
                        },
                    ],
                }),
            })
        );

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const badge = page.locator('[data-testid="ai-cost-badge"]');
        await expect(badge).toBeVisible();
        await expect(badge).toContainText('🏠');
        await expect(badge).toContainText('K tok');
    });

    test('hosted mock shows $X.XXXX', async ({ page }) => {
        await page.route('**/api/ai-usage', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    lifetime: { calls: 2, actualUsd: 0.0086, projectedUsd: 0.0086 },
                    today: { calls: 1, actualUsd: 0.0043, projectedUsd: 0.0043 },
                    lastRequest: {
                        at: '2026-05-11T12:00:00.000Z',
                        modelTag: 'claude-haiku-4-5-20251001',
                        actualUsd: 0.0043,
                        projectedUsd: 0.0043,
                    },
                    perModel: [
                        {
                            modelTag: 'claude-haiku-4-5-20251001',
                            calls: 2,
                            inputTokens: 6000,
                            outputTokens: 500,
                            actualUsd: 0.0086,
                            projectedUsd: 0.0086,
                        },
                    ],
                }),
            })
        );

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const badge = page.locator('[data-testid="ai-cost-badge"]');
        await expect(badge).toBeVisible();
        await expect(badge).toContainText('💰');
        await expect(badge).toContainText('$0.0086');
    });
});
