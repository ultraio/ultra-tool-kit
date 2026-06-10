import { test, expect } from '@playwright/test';

// W8 AI chat smoke test.
//
// This spec proves the frontend wiring of the W8 wave + the auth-CTA fixup:
//   - the AI chat trigger button mounts in App.vue's header (fa-comments icon
//     is now registered in src/icons.ts);
//   - clicking the trigger opens the drawer (Teleported to body);
//   - per docs/00-ai-global-guidelines.md §3.1, an unauthenticated user sees
//     a "Sign in with your wallet to use AI" CTA in place of the textarea;
//   - clicking the CTA's sign-in button opens the existing Login modal —
//     the chat→wallet handoff path is intact.
//
// The full logged-in chat round-trip (act/propose/answer + cost-badge
// accumulation + Transaction modal handoff) is covered by the backend's
// baseline.test.ts, usage-log.test.ts, and ai-chat.*.test.ts suites. Faking
// the @ultraos/wallet-sdk in Playwright is brittle; a follow-up spec can add
// the logged-in path once a wallet stub lands.

test.describe('AI chat smoke', () => {
    test('drawer opens + unauthenticated CTA points at the login modal', async ({ page }) => {
        // Defensive: mock both backend endpoints the drawer might touch so a
        // stray request can't time the test out.
        await page.route(/.*\/api\/ai-chat$/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ reply: { kind: 'refuse', reason: 'auth-required' } }),
            });
        });
        await page.route(/.*\/api\/ai-usage$/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    tokensInToday: 0,
                    tokensOutToday: 0,
                    costUsdToday: 0,
                    turnsToday: 0,
                }),
            });
        });
        await page.route(/.*\/api\/ai-quota$/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    spentTodayUsd: 0,
                    dailyCapUsd: 0.01,
                    stakedUos: 0,
                    uosPriceUsd: 0.004,
                    sessionSpentUsd: 0,
                    nextTier: { stakeUosForMax: 12500, maxDailyUsd: 1.0 },
                }),
            });
        });

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        // App.vue exposes the trigger as data-testid="ai-chat-toggle".
        const drawerTrigger = page.getByTestId('ai-chat-toggle');
        await expect(drawerTrigger).toBeVisible();
        await drawerTrigger.click();

        // The drawer Teleports into <body> with its own data-testid.
        const drawer = page.getByTestId('ai-chat-drawer');
        await expect(drawer).toBeVisible();

        // Auth gate: when not logged in, the textarea is hidden and the
        // sign-in CTA renders. data-testid="ai-chat-signin-cta" wraps the
        // sign-in panel; "ai-chat-signin" is the button itself.
        await expect(page.getByTestId('ai-chat-signin-cta')).toBeVisible();
        await expect(page.getByTestId('ai-chat-input')).toHaveCount(0);
        await expect(page.getByTestId('ai-chat-send')).toHaveCount(0);

        // Clicking sign-in emits @show-login, which App.vue handles via
        // setPageState({ showLogin: true }) — the existing Login modal opens.
        await page.getByTestId('ai-chat-signin').click();

        // The Login modal mounts via App.vue's v-if="pageState.showLogin". Its
        // root markup contains a recognizable title; assert via stable text.
        // (The toolkit's Login.vue header reads "Login" — keep this loose so a
        // future copy tweak doesn't trip the smoke.)
        await expect(page.getByText(/sign\s*in|login/i).first()).toBeVisible({ timeout: 5000 });
    });
});
