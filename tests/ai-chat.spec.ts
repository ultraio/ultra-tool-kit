// End-to-end specs for the three AI chat reply kinds: propose, ask, refuse.
// Each test drives the ChatDrawer through the shared stub in `fixtures/ai-stub.ts`.

import { test, expect } from '@playwright/test';
import { installAiStub, installChainAbiStub } from './fixtures/ai-stub';

test.describe('AI chat — three reply kinds', () => {
    test.beforeEach(async ({ page }) => {
        await installAiStub(page);
        await installChainAbiStub(page);
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await page.click('[data-testid="ai-chat-open"]');
        await expect(page.locator('[data-testid="ai-chat-drawer"]')).toBeVisible();
    });

    test('propose → Sign now opens Transaction modal', async ({ page }) => {
        await page.fill('[data-testid="ai-chat-input"]', 'transfer 100 UOS from acc1 to acc2');
        await page.click('[data-testid="ai-chat-send"]');

        await expect(page.locator('[data-testid="ai-sign-now"]')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('text=100.00000000 UOS')).toBeVisible();
        await expect(page.locator('text=acc1@active')).toBeVisible();

        await page.click('[data-testid="ai-sign-now"]');

        // Drawer closes and the existing <Transaction> modal renders the action.
        await expect(page.locator('[data-testid="ai-chat-drawer"]')).not.toBeVisible();
        await expect(page.locator('text=Action Overview')).toBeVisible({ timeout: 5000 });
    });

    test('ask → answer → propose', async ({ page }) => {
        await page.fill('[data-testid="ai-chat-input"]', 'send 100 to acc2');
        await page.click('[data-testid="ai-chat-send"]');

        // First turn returns an `ask` with a quick-reply input.
        const quickReply = page.locator('input[placeholder="Type your answer…"]');
        await expect(quickReply).toBeVisible({ timeout: 5000 });

        await quickReply.fill('from acc1');
        await quickReply.press('Enter');

        // Second turn returns a `propose` and the ProposalCard renders.
        await expect(page.locator('[data-testid="ai-sign-now"]')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('text=100.00000000 UOS')).toBeVisible();
        await expect(page.locator('text=acc1@active')).toBeVisible();
    });

    test('refuse renders polite scope message', async ({ page }) => {
        await page.fill('[data-testid="ai-chat-input"]', "what's the weather?");
        await page.click('[data-testid="ai-chat-send"]');

        await expect(
            page.locator('text=I only help with building Ultra blockchain transactions.').first()
        ).toBeVisible({ timeout: 5000 });
        // No proposal buttons surface on a refusal.
        await expect(page.locator('[data-testid="ai-sign-now"]')).toHaveCount(0);
    });
});
