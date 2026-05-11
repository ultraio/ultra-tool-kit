import { test, expect } from '@playwright/test';
import { installAiStub } from './fixtures/ai-stub';

test.describe('AI cost badge', () => {
    test('shows token totals under Ollama', async ({ page }) => {
        await installAiStub(page, { usage: { ollama: true, calls: 3 } });

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const badge = page.locator('[data-testid="ai-cost-badge"]');
        await expect(badge).toBeVisible();
        await expect(badge).toContainText('🏠');
        await expect(badge).toContainText('K tok');
    });

    test('hosted mock shows $X.XXXX', async ({ page }) => {
        // calls=2 × $0.0043 = $0.0086 lifetime actualUsd.
        await installAiStub(page, { usage: { ollama: false, calls: 2 } });

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const badge = page.locator('[data-testid="ai-cost-badge"]');
        await expect(badge).toBeVisible();
        await expect(badge).toContainText('💰');
        await expect(badge).toContainText('$0.0086');
    });
});
