import { test, expect } from '@playwright/test';

// W8 AI chat smoke test.
//
// Mocks both backend endpoints the drawer touches so the test never leaves
// the page:
//   - POST /api/ai-chat     → returns a kind:'act' Reply + usage sidecar
//   - GET  /api/ai-usage    → returns a static daily aggregate so CostBadge's
//                              initial fetch doesn't fail
//
// The drawer's data-testids (ai-chat-drawer, ai-chat-input, ai-chat-send) are
// already exposed by src/components/ai/ChatDrawer.vue. The cost badge is
// expected to expose data-testid="ai-cost-badge" (sibling W8 task —
// CostBadge.vue).
//
// Style reference: tests/wallet-integration.spec.ts.

test.describe('AI chat smoke', () => {
    test('sends a message, renders the action reply, displays the cost badge', async ({ page }) => {
        // --- Mock POST /api/ai-chat ---
        await page.route(/.*\/api\/ai-chat$/, async (route) => {
            const body = {
                reply: {
                    kind: 'act',
                    actions: [
                        {
                            contract: 'eosio.token',
                            action: 'transfer',
                            data: {
                                from: 'duncan',
                                to: 'bob',
                                quantity: '100.00000000 UOS',
                                memo: '',
                            },
                            authorization: [{ actor: 'duncan', permission: 'active' }],
                        },
                    ],
                    rationale: 'Compose UOS transfer to bob.',
                },
                usage: {
                    cost_usd: 0.001234,
                    tokens_in: 1000,
                    tokens_out: 200,
                },
            };
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(body),
            });
        });

        // --- Mock GET /api/ai-usage so CostBadge's initial fetch doesn't fail ---
        await page.route(/.*\/api\/ai-usage$/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    tokensInToday: 12345,
                    tokensOutToday: 678,
                    costUsdToday: 0.0123,
                    turnsToday: 5,
                }),
            });
        });

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        // Find and click the AI chat drawer trigger. The toolkit's trigger is
        // expected to be a button with the FA "fa-comments" icon or an
        // aria-label / data-testid matching /ai|chat|assistant/. Try the most
        // common patterns; if none resolve, the test fails fast with a clear
        // selector miss (which is what we want to surface to the W8 sibling
        // tasks that own the drawer mount + trigger).
        const drawerTrigger = page
            .getByRole('button', { name: /ai|chat|assistant/i })
            .first();
        await drawerTrigger.click();

        // Confirm the drawer rendered.
        const drawer = page.getByTestId('ai-chat-drawer');
        await expect(drawer).toBeVisible();

        // Type the message and send.
        const input = page.getByTestId('ai-chat-input');
        await input.fill('transfer 100 UOS from duncan to bob');
        await page.getByTestId('ai-chat-send').click();

        // The cost badge should be visible (mocked usage has cost_usd > 0) —
        // proves: aiClient parsed the { reply, usage } wrapper → useAiChat
        // surfaced lastUsage → CostBadge accumulated the session cost. The
        // badge text matches the mocked sidecar values precisely.
        const costBadge = page.getByTestId('ai-cost-badge');
        await expect(costBadge).toBeVisible({ timeout: 5000 });
        await expect(costBadge).toContainText('Session: $0.0012');

        // The act reply was emitted onto the event bus, which App.vue listens
        // to and mounts <Transaction> for review/sign — that's the chat→wallet
        // hand-off. The modal's "Action Overview" header is its stable anchor.
        await expect(page.getByText('Action Overview')).toBeVisible({ timeout: 5000 });

        // The composed action's contract+action pair appears in the modal's
        // overview row (the bubble's identical text is hidden behind the modal
        // because the modal's z-index sits above the drawer's; asserting on the
        // modal text is the practical proof the act reply landed cleanly).
        const txModal = page.locator('text=Action Overview').locator('..');
        await expect(txModal.getByText(/eosio\.token/)).toBeVisible({ timeout: 5000 });
        await expect(txModal.getByText('transfer')).toBeVisible({ timeout: 5000 });
    });
});
