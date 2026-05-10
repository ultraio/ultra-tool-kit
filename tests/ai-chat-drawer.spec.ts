import { test, expect } from '@playwright/test';

// Stubs the AI backend so the drawer flow can be exercised without Hono+Ollama.

const PROPOSE_BODY = {
    kind: 'propose',
    contract: 'eosio.token',
    action: 'transfer',
    data: {
        from: 'acc1',
        to: 'acc2',
        quantity: '100.00000000 UOS',
        memo: '',
    },
    authorization: { actor: 'acc1', permission: 'active' },
    rationale: 'Standard transfer of 100 UOS from acc1 to acc2.',
};

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

async function mockChain(page) {
    // Minimal eosio.token ABI so ProposalCard can resolve field types via getAbi.
    await page.route('**/v1/chain/get_abi', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                account_name: 'eosio.token',
                abi: {
                    version: 'eosio::abi/1.1',
                    types: [],
                    structs: [
                        {
                            name: 'transfer',
                            base: '',
                            fields: [
                                { name: 'from', type: 'name' },
                                { name: 'to', type: 'name' },
                                { name: 'quantity', type: 'asset' },
                                { name: 'memo', type: 'string' },
                            ],
                        },
                    ],
                    actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
                    tables: [],
                    ricardian_clauses: [],
                    error_messages: [],
                    abi_extensions: [],
                    variants: [],
                },
            }),
        })
    );
}

test.describe('AI chat drawer', () => {
    test('opens, sends, renders proposal, hands off to builder', async ({ page }) => {
        await mockUsage(page);
        await mockChain(page);
        await page.route('**/api/ai-action', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(PROPOSE_BODY),
            })
        );

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        // Open the drawer.
        await page.click('[data-testid="ai-chat-open"]');
        await expect(page.locator('[data-testid="ai-chat-drawer"]')).toBeVisible();

        // Send a request.
        await page.fill('[data-testid="ai-chat-input"]', 'transfer 100 UOS from acc1 to acc2');
        await page.click('[data-testid="ai-chat-send"]');

        // Proposal renders with the right contract::action.
        await expect(page.locator('text=eosio.token')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('text=transfer').first()).toBeVisible();
        await expect(page.locator('text=100.00000000 UOS')).toBeVisible();
        await expect(page.locator('text=acc1@active')).toBeVisible();

        // Open in Builder hands off via aiHandoff + router push.
        await page.click('[data-testid="ai-open-in-builder"]');
        await expect(page).toHaveURL(/\/builder/);
        await expect(page.locator('[data-testid="ai-handoff-banner"]')).toBeVisible({ timeout: 5000 });
    });

    test('Sign now path opens Transaction modal pre-filled', async ({ page }) => {
        await mockUsage(page);
        await mockChain(page);
        await page.route('**/api/ai-action', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(PROPOSE_BODY),
            })
        );

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        await page.click('[data-testid="ai-chat-open"]');
        await page.fill('[data-testid="ai-chat-input"]', 'transfer 100 UOS from acc1 to acc2');
        await page.click('[data-testid="ai-chat-send"]');

        await expect(page.locator('[data-testid="ai-sign-now"]')).toBeVisible({ timeout: 5000 });
        await page.click('[data-testid="ai-sign-now"]');

        // <Transaction> modal renders when actions ref is set; the chat drawer closes.
        await expect(page.locator('[data-testid="ai-chat-drawer"]')).not.toBeVisible();
    });
});
