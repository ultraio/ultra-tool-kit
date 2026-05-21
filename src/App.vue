<template>
    <div class="flex flex-col h-screen w-screen overflow-x-hidden overflow-y-hidden bg-neutral-900">
        <!-- Header -->
        <div
            class="fixed top-0 w-full h-28 flex justify-between items-center pb-5 pt-6 bg-neutral-800 border-b-2 border-neutral-700 sm:pl-6 md:pl-24 lg:pl-48 md:pr-24 lg:pr-48 pl-6 pr-6"
        >
            <router-link
                class="flex items-center text-2xl font-bold hover:text-neutral-100"
                to="/"
                @click="handleRefresh"
            >
                <div class="w-8 h-8 mr-4">
                    <img class="rounded-md" src="/logo.webp" alt="avatar" />
                </div>
                <span>Ultra Tool Kit</span>
            </router-link>
            <div class="flex items-center gap-3">
                <CostBadge />
                <button
                    class="p-2 rounded-md bg-neutral-900 border border-neutral-700 hover:border-purple-500 text-neutral-200"
                    title="Open AI assistant"
                    data-testid="ai-chat-open"
                    @click="aiOpen = true"
                >
                    <Icon icon="fa-comments" />
                </button>
                <Button class="mr-2" @onClick="setPageState({ showEndpoint: true })">
                    {{ authState.environment }}
                </Button>
            </div>
        </div>

        <!-- Main Content Row -->
        <div class="flex flex-row flex-grow h-full mt-28">
            <!-- Sidebar -->
            <div
                class="sticky flex flex-col bg-neutral-800 pt-6 pr-6 pl-6 border-r-2 border-neutral-700 sm:pl-6 md:pl-24 lg:pl-48"
            >
                <UserOverlay
                    @set-endpoint="setEndpoint"
                    @set-page-state="setPageState"
                    @logout="logout"
                    :state="authState"
                    :key="keyUserUpdate"
                />
                <Navigation class="w-48 pt-3 border-t-2 mt-6 border-neutral-700" :state="authState" :topLevel="true" />
            </div>
            <!-- Content -->
            <div
                id="content"
                class="flex flex-grow flex-col h-screen overflow-y-auto pr-6 sm:pr-6 md:pr-24 lg:pr-48 pt-6 pl-6 pb-32"
            >
                <router-view :state="authState" :metadata="runtimeMetadata" :key="keyRouterUpdate" @transact="setTransaction" />
            </div>
        </div>

        <!-- Modals -->
        <Login v-if="pageState.showLogin" :state="authState" @set-page-state="setPageState" @set-account="setAccount" />
        <Endpoint
            v-if="pageState.showEndpoint"
            :state="authState"
            @set-page-state="setPageState"
            @set-endpoint="setEndpoint"
        />
        <Transaction
            v-if="actions"
            :state="authState"
            :actions="actions"
            @clear-transaction="clearTransaction"
            @transaction-executed="transactionExecuted"
            :allowProposal="actions[0]?.contract == 'eosio.msig' ? false : true"
        />

        <!-- AI chat drawer is mounted once at the app root so it persists across route changes. -->
        <ChatDrawer :open="aiOpen" :state="authState" @close="aiOpen = false" />
    </div>
</template>

<script setup lang="ts">
import * as Anchor from './wallets/anchor';
import * as Ultra from './wallets/ultra';
import * as UltraWeb from './wallets/ultra-web';
import {
    populateWalletAccountsFromConnectResult,
    clearWalletAccounts,
    setAvailableAccountsFromEvent,
} from './wallets/wallet-accounts';
import * as I from './interfaces';
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { BlockchainService } from './utilities/blockchain';
import { defaultNetworks, getEnvironmentName, getNetworkByChainId } from './utilities/networks';
import { fetchWithTimeout } from './utilities/networks';
import * as NFTAPI from './utilities/nftapi/api';
import { emitter } from './eventBus';

// Use `ref` here because we want to be able to set the whole object
// and trigger a reaction when we set the whole object.
let pageState = ref<I.PageState>({});

let actions = ref<I.Action[] | undefined>(undefined);
let aiOpen = ref<boolean>(false);
let keyRouterUpdate = ref<number>(1);
let keyUserUpdate = ref<number>(1);
let isNetworkSyncing = false; // Prevents circular sync between wallet↔toolkit

// We never assign a whole object directly to authState,
// all properties must be set individually.
let authState = ref<I.AuthState>({
    accountName: undefined,
    accountPerm: undefined,
    endpoint: defaultNetworks[0].urls[0],
    environment: defaultNetworks[0].name,
    type: undefined,
    isAdmin: false
});

let runtimeMetadata = ref<I.RuntimeMetadata>({
    lastSignedActions: undefined
});

function setAuthStateKeys(newData: Partial<I.AuthState>) {
    const data = Object.assign(authState.value, { ...newData });
    authState.value = data;
}

/**
 * Reset page state back to initial login function.
 *
 */
function resetPageState() {
    pageState.value = {};
}

/**
 * Used to show different modals that needs to be displayed.
 * Uses nextTick internally, to ensure data called before a page update is set / ready.
 *
 * @param state
 */
function setPageState(state: I.PageState) {
    nextTick(() => {
        pageState.value = { ...state };
    });
}

/**
 * Set the target endpoint we should be using to making api queries.
 *
 * @param endpoint
 */
async function setEndpoint(endpoint: string, userInvoked?: boolean) {
    if (endpoint === 'custom') {
        setPageState({ showEndpoint: true });
        return;
    }

    const previousEnvironment = authState.value.environment;
    const previousType = authState.value.type;
    let environment = getEnvironmentName(endpoint);
    setAuthStateKeys({ endpoint, environment });

    // Web wallet sessions are bound to a specific env origin — they cannot
    // survive an env change, and can't sign at all on Local/Custom endpoints.
    // Log out now and (if switching between Mainnet/Testnet) open a reconnect
    // popup on the new env after the rest of initServices() completes.
    const webWalletEnvChanged =
        previousType === 'ultra-web' && previousEnvironment !== environment;
    const shouldAutoReconnectWebWallet =
        webWalletEnvChanged && UltraWeb.isSupportedEnvironment(environment);

    if (webWalletEnvChanged && !shouldAutoReconnectWebWallet) {
        alert(
            'Ultra Web Wallet does not support this network. You have been logged out — please choose a different wallet or switch back to Mainnet/Testnet.'
        );
    }

    // Logout policy:
    //   - Extension wallet (`ultra`): the wallet's session crosses chains;
    //     we flip its current chain via `Ultra.switchNetwork` (below) and
    //     refresh accounts, no logout needed.
    //   - Web wallet (`ultra-web`): env is bound at SDK construction;
    //     `shouldAutoReconnectWebWallet` either re-connects below or we
    //     log out and the user picks again.
    //   - Anchor / Ledger: sessions are env-bound, log out on env change.
    const envChanged = previousEnvironment !== environment;
    const shouldLogoutOnEndpointChange =
        authState.value.accountName &&
        previousType !== 'ultra' &&
        !shouldAutoReconnectWebWallet &&
        (envChanged || previousType !== 'ultra-web');
    if (shouldLogoutOnEndpointChange) {
        logout();
    }

    localStorage.setItem('endpoint', endpoint);
    localStorage.setItem('environment', environment);

    // Check if the current loaded page supports environment selection
    if (window.location.href.includes('env=')) {
        let uri = window.location.href.split('env=');
        let args = uri[1].split('&');
        let lastEnv = args.shift();
        if (lastEnv != environment) {
            window.location.href = uri[0] + 'env=' + environment + (args.length > 0 ? '&' + args.join('&') : '')
            return;
        }
    }

    keyRouterUpdate.value += 1;
    keyUserUpdate.value += 1;

    // Init Blockchain & NFT API service after setting authState object
    await initServices();

    // Auto-reconnect web wallet on env change (separate origin → fresh popup).
    if (shouldAutoReconnectWebWallet) {
        try {
            const response = await UltraWeb.connect(environment);
            if (response && response.status === 'success') {
                const { accountName, permission } = UltraWeb.extractAccountInfo(response.data);
                const chainId = UltraWeb.extractChainId(response.data);
                setAuthStateKeys({
                    type: 'ultra-web',
                    accountName,
                    accountPerm: permission,
                    isAdmin: I.ELEVATED_ACCOUNTS.includes(accountName),
                    chainId,
                });
                localStorage.setItem('authState', JSON.stringify(authState.value));
                keyRouterUpdate.value += 1;
                keyUserUpdate.value += 1;
            }
        } catch {
            // User closed the popup or rejected — remain logged out.
        }
    }

    //
    // Atomicity: claim isNetworkSyncing BEFORE the first await (fetchWithTimeout).
    // The old shape gate-checked the flag at the top of the if-clause but only
    // flipped it inside the inner block after two awaits — a second concurrent
    // setEndpoint call could pass the outer gate and start its own
    // fetch/switchNetwork RPC. With the flag set up-front and a single outer
    // try/finally, any throw path (fetch reject, JSON parse, switchNetwork
    // reject) resets the flag — preventing a latent deadlock that would have
    // wedged subsequent syncs.
    if (userInvoked && authState.value.type === 'ultra' && Ultra.isAvailable()) {
        if (isNetworkSyncing) return;
        isNetworkSyncing = true;
        try {
            const res = await fetchWithTimeout(`${endpoint}/v1/chain/get_info`);
            if (res?.ok) {
                const info = await res.json();
                const endpointChainId = info.chain_id;
                if (endpointChainId && endpointChainId !== authState.value.chainId) {
                    await Ultra.switchNetwork(endpointChainId);
                    setAuthStateKeys({ chainId: endpointChainId });
                    // Re-issue connect on the new chain so the wallet
                    // returns chain-resolved accounts and we update the
                    // dropdown + active account locally. The BG also
                    // emits accountChanged on env change
                    // (belt-and-suspenders), but doing this synchronously
                    // here removes the dependency on event timing for
                    // the immediate UI update.
                    const response = await Ultra.connect();
                    if (response.status === 'success') {
                        populateWalletAccountsFromConnectResult(response.data);
                        const { accountName, permission } = await Ultra.resolveSelectedAccount(
                            response.data
                        );
                        await setAccount('ultra', accountName, permission);
                    }
                    localStorage.setItem('authState', JSON.stringify(authState.value));
                }
            }
        } catch {
            // Endpoint unreachable, user rejected the switch, or wallet error
            // — mismatch warning will show on the next render.
        } finally {
            isNetworkSyncing = false;
        }
    }
}

/**
 * Updates authState with individual account details
 * to be passed to other components
 *
 * @param type
 * @param accountName
 * @param permission
 */
async function setAccount(
    type: I.WalletTypes,
    accountName: string,
    permission: string,
    ledgerIndex?: number
) {
    setAuthStateKeys({
        type,
        accountName,
        accountPerm: permission,
        isAdmin: I.ELEVATED_ACCOUNTS.includes(accountName),
        ledgerIndex,
    });
    localStorage.setItem('authState', JSON.stringify(authState.value));

    setPageState({ showLogin: false });

    // Capture wallet chain ID for network mismatch detection. Issue 1: if
    // the wallet is on a different chain than the toolkit's current
    // endpoint at connect time (e.g. toolkit on Mainnet, wallet on
    // Testnet), sync the toolkit's endpoint to the wallet's chain so
    // chain-bound operations (get_account, balance, NFT API) hit the
    // right network. This runs after every successful Ultra connection
    // (fresh login from Login.vue AND silent restoreSession), so it's
    // the single point that keeps the toolkit's endpoint following the
    // wallet's chain selection.
    if (type === 'ultra' && Ultra.isAvailable()) {
        try {
            const chainIdResponse = await Ultra.getChainId();
            if (chainIdResponse.status === 'success') {
                const walletChainId = chainIdResponse.data;
                setAuthStateKeys({ chainId: walletChainId });
                localStorage.setItem('authState', JSON.stringify(authState.value));

                // Endpoint sync: only fires if the toolkit's current endpoint
                // is on a different chain. userInvoked=false skips the
                // Toolkit→Wallet switchNetwork echo in setEndpoint (this is
                // wallet-driven; we follow, never push back).
                const matched = getNetworkByChainId(walletChainId);
                if (
                    matched &&
                    !matched.urls.includes(authState.value.endpoint) &&
                    !isNetworkSyncing
                ) {
                    isNetworkSyncing = true;
                    try {
                        await setEndpoint(matched.urls[0], false);
                    } finally {
                        isNetworkSyncing = false;
                    }
                }
            }
        } catch {
            // Non-critical — chainId just enables mismatch warning
        }
    }

    if (type === 'ultra-web') {
        try {
            const chainIdResponse = await UltraWeb.getChainId(authState.value.environment);
            if (chainIdResponse.status === 'success') {
                setAuthStateKeys({ chainId: chainIdResponse.data });
                localStorage.setItem('authState', JSON.stringify(authState.value));
            }
        } catch {
            // Non-critical
        }
    }
}

/**
 * Reset the toolkit's local session state. Does NOT call into any wallet
 * RPC — used both for local-only logout (after the wallet broadcasts
 * `disconnect` to us; we just mirror) and as the tail of the wallet-bound
 * logout flows below.
 */
function resetLocalSession() {
    clearWalletAccounts();
    setAuthStateKeys({
        type: undefined,
        accountName: undefined,
        accountPerm: undefined,
        isAdmin: false,
        chainId: undefined,
    });
    localStorage.setItem('authState', JSON.stringify(authState.value));
    resetPageState();
}

/**
 * User-initiated logout: tell the wallet, then reset local state.
 *
 * `Ultra.disconnect()` on the BG side is idempotent — even if the user
 * disconnected from the wallet UI moments earlier (so we're already
 * untrusted), the call resolves successfully. We always run the local
 * reset afterwards so a transient RPC failure doesn't leave the toolkit
 * stuck in a half-connected state.
 */
async function logout() {
    try {
        if (authState.value.type === 'ultra') {
            await Ultra.disconnect();
        } else if (authState.value.type === 'ultra-web') {
            await UltraWeb.disconnect();
        } else if (authState.value.type === 'anchor') {
            await Anchor.logout();
        }
    } catch {
        // Wallet RPC failed — proceed with local cleanup anyway. A failed
        // disconnect on a session the user wants ended must not block
        // their UI from clearing.
    }
    resetLocalSession();
}

function setTransaction(newActions: I.Action[]) {
    actions.value = newActions;
}

/**
 * Grab any local storage information, and try to restore the previous session.
 */
async function restoreSession() {
    const jsonData = localStorage.getItem('authState');
    if (!jsonData) return;

    let restoredAuthState: I.AuthState;
    try {
        restoredAuthState = JSON.parse(jsonData);
    } catch (err) {
        console.warn('[ultra-tool-kit] restoreSession: failed to parse authState', err);
        localStorage.removeItem('authState');
        return;
    }
    if (!restoredAuthState || !restoredAuthState.accountName || !restoredAuthState.endpoint) {
        return;
    }

    if (restoredAuthState.type === 'ultra') {
        if (!Ultra.isAvailable()) return;

        let response: Awaited<ReturnType<typeof Ultra.connect>>;
        try {
            response = await Ultra.connect(true);
        } catch (err) {
            console.warn(
                '[ultra-tool-kit] restoreSession: Ultra.connect threw — clearing authState',
                err
            );
            localStorage.removeItem('authState');
            return;
        }
        if (response.status !== 'success') {
            // Wallet rejected silent reconnect (locked, key removed, or not trusted)
            localStorage.removeItem('authState');
            return;
        }

        // The wallet may return status:'success' with empty data when no real
        // session exists for this origin. Verify we actually have an account
        // (via connect payload OR a live auths query) before keeping authState.
        const hasSelected = !!response.data?.selectedAccount;
        const hasAccounts = Array.isArray(response.data?.accounts) && response.data.accounts.length > 0;
        let hasAuths = false;
        if (!hasSelected && !hasAccounts) {
            const auths = await Ultra.getAvailableAuthorizations().catch(() => null);
            hasAuths =
                auths?.status === 'success' &&
                Array.isArray(auths.data) &&
                auths.data.length > 0;
        }
        const isEmptySuccess = !hasSelected && !hasAccounts && !hasAuths;
        if (isEmptySuccess) {
            // BG returned status:'success' but no accounts/selected/auths.
            // The success branch in PermissionController.connect is reached
            // only when the origin is already trusted (untrusted origins are
            // routed through openConnectPopup, which never returns success
            // immediately). Empty accounts is almost always cold-cache plus a
            // transient chain RPC failure during the resolve. Treat as
            // transient: keep authState, skip populateWalletAccountsFromConnectResult
            // (which would land an empty accounts.value via the wallet-accounts.ts
            // fallthrough and silently empty the per-action dropdown), and
            // wait for the next accountChanged with real data.
            console.warn(
                '[ultra-tool-kit] silent reconnect returned empty payload — keeping authState (treating as transient)'
            );
        } else {
            populateWalletAccountsFromConnectResult(response.data);
        }
        if (response.data.network) {
            restoredAuthState.chainId = response.data.network.chainId;
            // Issue 1: if the wallet is on a different chain than the
            // toolkit's last-saved endpoint, follow the wallet. Mutate
            // restoredAuthState directly — the setAuthStateKeys(restoredAuthState)
            // at the end of restoreSession will commit it, and initServices()
            // (called from onMounted right after restoreSession) will pick
            // up the new endpoint.
            const matched = getNetworkByChainId(response.data.network.chainId);
            if (matched && !matched.urls.includes(restoredAuthState.endpoint)) {
                restoredAuthState.endpoint = matched.urls[0];
                restoredAuthState.environment = matched.name;
            }
        }
        // Trust the wallet's currently selected account over stale localStorage —
        // user may have switched accounts in the wallet between sessions.
        if (!isEmptySuccess && response.data.selectedAccount) {
            const { accountName, permission } = await Ultra.resolveSelectedAccount(response.data);
            restoredAuthState.accountName = accountName;
            restoredAuthState.accountPerm = permission;
        }
    }

    if (restoredAuthState.type === 'ultra-web') {
        // Web Wallet has no silent reconnect (each popup is a fresh window).
        // Drop the saved session and let the user reconnect manually.
        localStorage.removeItem('authState');
        return;
    }

    if (restoredAuthState.type === 'anchor' && restoredAuthState.endpoint) {
        await Anchor.restore(restoredAuthState.endpoint);
    }

    setAuthStateKeys(restoredAuthState);
    localStorage.setItem('authState', JSON.stringify(authState.value));
    setPageState({ showEndpoint: false, showLogin: false, showTransaction: false });
}

// setActiveAccount was the writer behind UserOverlay's account-switcher
// dropdown — it overwrote `authState.accountName`, conflating "wallet
// selected" with a toolkit-side local override. Removed 2026-05-15 per the
// design directive: the wallet's selected account is authoritative and the
// toolkit cannot change it. Per-action signer choice now lives in each
// transaction form's local refs (e.g. `authorizer.value`); the global
// `authState.accountName` is sync'd from `accountChanged.data.selected` and
// from the connect payload's `selectedAccount`.

function clearTransaction() {
    actions.value = undefined;
}

function transactionExecuted() {
    runtimeMetadata.value.lastSignedActions = actions.value;
    runtimeMetadata.value.lastSignedTransactionTimestamp = Date.now();
    actions.value = undefined;
    keyRouterUpdate.value++;
}

function handleRefresh() {
    setTimeout(() => {
        location.reload();
    }, 25);
}

async function initServices() {
    NFTAPI.setEnvironment(authState.value);
    await BlockchainService.init(authState.value);
}

function handleUpdateAppActions(updatedActions) {
    actions.value = updatedActions;
}

/**
 * Sync available accounts from the wallet — and ONLY the available list.
 *
 * The toolkit's selected account is a local override (the dropdown lets
 * the developer pick any actor per-action, which is required for
 * multi-signer EOSIO transactions). So we deliberately ignore
 * `data.selected`. But the **available** account list is owned by the
 * wallet — chain-resolved via `get_accounts_by_authorizers` — and the
 * toolkit must mirror it so the dropdown only ever offers actors the
 * user actually has keys for on the active chain.
 *
 * If the toolkit's currently-selected account disappears from the new
 * list (user removed it in the wallet, or chain composition changed),
 * fall back to the first available so signing keeps working.
 */
function handleWalletAccountChanged(data: {
    accounts?: Array<{ accountName: string; permission?: string; publicKey?: string }>;
    selected?: { accountName?: string; permissions?: Array<{ name: string }> } | null;
}) {
    if (authState.value.type !== 'ultra') return;

    const eventAccounts = Array.isArray(data?.accounts) ? data.accounts : [];

    if (eventAccounts.length === 0) {
        // Empty accounts is NOT a logout signal. The wallet may be
        // transiently locked (MV3 worker mid-restore), the chain RPC may
        // have hiccupped during resolution, or the user may genuinely have
        // no accounts on the active chain. In all transient cases, wiping
        // the local list silently empties the per-action signer dropdown
        // mid-session — the visible regression the user reported. Keep the
        // last-known list and wait for either the next accountChanged with
        // real data or a `disconnect` event (the explicit logout signal).
        // The BG also guards against broadcasting empty when the vault has
        // keys (background.ts:emitAccountChanged), so this path mostly
        // protects against unforeseen variants of the same cascade.
        return;
    }
    setAvailableAccountsFromEvent(eventAccounts);

    // The wallet's selected account is authoritative; the toolkit reflects
    // it and cannot change it. Adopt `data.selected.accountName` into
    // `authState.accountName` whenever the wallet emits a different
    // selection. Per-action signer choice (e.g. transfer From dropdown) is
    // tracked in each transaction form's local state, NOT in authState —
    // so this write doesn't disturb in-flight per-action overrides.
    const selectedName = data?.selected?.accountName;
    if (selectedName && selectedName !== authState.value.accountName) {
        setAuthStateKeys({
            accountName: selectedName,
            accountPerm: preferActivePermission(selectedName, eventAccounts),
            isAdmin: I.ELEVATED_ACCOUNTS.includes(selectedName),
        });
        localStorage.setItem('authState', JSON.stringify(authState.value));
        keyRouterUpdate.value += 1;
        keyUserUpdate.value += 1;
        return;
    }

    // The wallet didn't include a selected, or selected matches current.
    // Verify the current name is still in the available list; if not,
    // adopt the first available (chain composition changed — e.g. key
    // removed in wallet).
    const currentName = authState.value.accountName;
    const stillAvailable = eventAccounts.some((a) => a.accountName === currentName);
    if (stillAvailable) return;

    const first = eventAccounts[0];
    setAuthStateKeys({
        accountName: first.accountName,
        accountPerm: preferActivePermission(first.accountName, eventAccounts),
        isAdmin: I.ELEVATED_ACCOUNTS.includes(first.accountName),
    });
    localStorage.setItem('authState', JSON.stringify(authState.value));
    keyRouterUpdate.value += 1;
    keyUserUpdate.value += 1;
}

/**
 * Pick the preferred permission for `accountName` from the BG's flat
 * `accountChanged` event payload (one row per `(account, permission)` pair).
 * Mirrors the pre-fix `validatedAccounts` sort: prefer 'active' when the
 * key authorizes both `active` and `owner` for the same account, fall
 * back to the first listed permission, fall back to 'active' as the
 * EOSIO default.
 *
 * This is the default signing permission for actions where the
 * transaction builder doesn't specify one. The user can still override
 * per-action via each form's local authorizer dropdown.
 */
function preferActivePermission(
    accountName: string,
    eventAccounts: Array<{ accountName: string; permission?: string }>,
): string {
    const matches = eventAccounts.filter((a) => a.accountName === accountName);
    const active = matches.find((m) => m.permission === 'active');
    if (active) return 'active';
    const firstPermissioned = matches.find((m) => !!m.permission);
    return firstPermissioned?.permission ?? 'active';
}

async function handleWalletNetworkChanged(data: { chainId: string; name: string }) {
    if (authState.value.type !== 'ultra') return;
    if (isNetworkSyncing) return; // We initiated this switch, ignore the echo

    setAuthStateKeys({ chainId: data.chainId });
    localStorage.setItem('authState', JSON.stringify(authState.value));

    // Try to auto-switch toolkit endpoint to match the wallet's network
    const matchedNetwork = getNetworkByChainId(data.chainId);
    if (matchedNetwork) {
        const currentEndpoint = authState.value.endpoint;
        const isAlreadyOnThisNetwork = matchedNetwork.urls.includes(currentEndpoint);

        if (!isAlreadyOnThisNetwork) {
            isNetworkSyncing = true;
            try {
                // Switch toolkit endpoint, then re-connect to get the account on the new chain
                await setEndpoint(matchedNetwork.urls[0]);
                if (Ultra.isAvailable()) {
                    try {
                        const response = await Ultra.connect();
                        if (response.status === 'success') {
                            populateWalletAccountsFromConnectResult(response.data);
                            const { accountName, permission } = await Ultra.resolveSelectedAccount(
                                response.data
                            );
                            await setAccount('ultra', accountName, permission);
                        }
                    } catch {
                        // Wallet connect failed on new network — user sees login button
                    }
                }
                // Force UserOverlay re-mount to fetch new endpoint's chainId
                keyUserUpdate.value += 1;
            } finally {
                isNetworkSyncing = false;
            }
            return;
        }
    }

    // No matching endpoint found — just show the mismatch warning
    keyUserUpdate.value += 1;
}

function handleWalletDisconnect() {
    if (authState.value.type !== 'ultra') return;
    // The wallet already removed trust on its side (this event is its
    // notification to us). Don't call `Ultra.disconnect()` again — that
    // would be a redundant RPC, and historically the BG short-circuited it
    // with USER_REJECTED_REQUEST when the origin was no longer trusted,
    // leaving the toolkit's local state un-reset. Just mirror locally.
    resetLocalSession();
}

onMounted(async () => {
    restoreSession();

    emitter.on('updateAppActions', handleUpdateAppActions);

    // Wallet event listeners.
    //
    // `accountChanged`: subscribed for its `accounts` payload only — the
    // toolkit treats wallet's available-accounts list as authoritative and
    // mirrors it. The `selected` half of the payload is intentionally
    // ignored: the toolkit's active account is a local override (developer
    // picks any actor per-action via UserOverlay's dropdown, supporting
    // multi-signer transactions where different actions need different
    // `actor@permission` authorities).
    //
    // `networkChanged`: re-runs `Ultra.connect()` on the new chain to
    // refresh both available accounts and the active account (the prior
    // chain's override is invalid on the new chain).
    //
    // `disconnect`: logs the toolkit out.
    Ultra.on('accountChanged', handleWalletAccountChanged);
    Ultra.on('networkChanged', handleWalletNetworkChanged);
    Ultra.on('disconnect', handleWalletDisconnect);

    const endpoint = localStorage.getItem('endpoint');
    if (endpoint) {
        setAuthStateKeys({ endpoint });
        keyUserUpdate.value += 1;
    }

    const environment = localStorage.getItem('environment');
    if (environment) {
        setAuthStateKeys({ environment });
        keyUserUpdate.value += 1;
    }

    // Init Blockchain & NFT API service
    await initServices();
});

onUnmounted(async () => {
    emitter.off('updateAppActions', handleUpdateAppActions);
    Ultra.off('accountChanged', handleWalletAccountChanged);
    Ultra.off('networkChanged', handleWalletNetworkChanged);
    Ultra.off('disconnect', handleWalletDisconnect);
    // Stop the SDK-recovery heartbeat. Without this the 2s setInterval keeps
    // ticking after the page is gone — benign-but-leaky. Combined with the
    // Ultra.off(...) calls above (which clear local listeners) the heartbeat
    // would short-circuit anyway, but we'd rather not pay the timer overhead.
    Ultra.dispose();
});

</script>
