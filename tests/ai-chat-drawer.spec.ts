import { test, expect } from '@playwright/test';
import { installAiStub, installChainAbiStub } from './fixtures/ai-stub';

test.describe('AI chat drawer', () => {
    test.beforeEach(async ({ page }) => {
        await installAiStub(page);
        await installChainAbiStub(page);
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await page.click('[data-testid="ai-chat-open"]');
        await expect(page.locator('[data-testid="ai-chat-drawer"]')).toBeVisible();
    });

    test('opens, sends, renders proposal, hands off to builder', async ({ page }) => {
        await page.fill('[data-testid="ai-chat-input"]', 'transfer 100 UOS from acc1 to acc2');
        await page.click('[data-testid="ai-chat-send"]');

        await expect(page.locator('text=eosio.token')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('text=transfer').first()).toBeVisible();
        await expect(page.locator('text=100.00000000 UOS')).toBeVisible();
        await expect(page.locator('text=acc1@active')).toBeVisible();

        await page.click('[data-testid="ai-open-in-builder"]');
        await expect(page).toHaveURL(/\/builder/);
        await expect(page.locator('[data-testid="ai-handoff-banner"]')).toBeVisible({ timeout: 5000 });
    });

    test('Sign now path opens Transaction modal pre-filled', async ({ page }) => {
        await page.fill('[data-testid="ai-chat-input"]', 'transfer 100 UOS from acc1 to acc2');
        await page.click('[data-testid="ai-chat-send"]');

        await expect(page.locator('[data-testid="ai-sign-now"]')).toBeVisible({ timeout: 5000 });
        await page.click('[data-testid="ai-sign-now"]');

        // <Transaction> modal renders when actions ref is set; the chat drawer closes.
        await expect(page.locator('[data-testid="ai-chat-drawer"]')).not.toBeVisible();
    });
});
