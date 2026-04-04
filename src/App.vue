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
            <Button class="mr-2" @onClick="setPageState({ showEndpoint: true })">
                {{ authState.endpoint }}
            </Button>
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
                <router-view :state="authState" :metadata="runtimeMetadata" :key="keyRouterUpdate" @transact="setTransaction" @set-endpoint="setEndpoint" @set-page-state="setPageState" />
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
    </div>
</template>

<script setup lang="ts">
import * as Anchor from './wallets/anchor';
import * as Ultra from './wallets/ultra';
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

    let environment = getEnvironmentName(endpoint);
    setAuthStateKeys({ endpoint, environment });
    if (authState.value.accountName) {
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

    console.log({ endpoint, environment });

    // Init Blockchain & NFT API service after setting authState object
    await initServices();

    // Toolkit→Wallet sync: if user changed endpoint while Ultra is connected,
    // request the wallet to switch to the new chain
    if (userInvoked && authState.value.type === 'ultra' && Ultra.isAvailable() && !isNetworkSyncing) {
        try {
            const res = await fetchWithTimeout(`${endpoint}/v1/chain/get_info`);
            if (res?.ok) {
                const info = await res.json();
                const endpointChainId = info.chain_id;
                if (endpointChainId && endpointChainId !== authState.value.chainId) {
                    isNetworkSyncing = true;
                    try {
                        await Ultra.switchNetwork(endpointChainId);
                        setAuthStateKeys({ chainId: endpointChainId });
                        localStorage.setItem('authState', JSON.stringify(authState.value));
                    } catch {
                        // User rejected the switch or wallet error — mismatch warning will show
                    } finally {
                        isNetworkSyncing = false;
                    }
                }
            }
        } catch {
            // Endpoint unreachable — can't determine chainId
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
    type: 'ultra' | 'anchor' | 'ledger',
    accountName: string,
    permission: string,
    ledgerIndex?: number
) {
    setAuthStateKeys({
        type,
        accountName,
        accountPerm: permission,
        isAdmin: I.ELEVATED_ACCOUNTS.includes(accountName) ? true : false,
        ledgerIndex: ledgerIndex,
    });
    localStorage.setItem('authState', JSON.stringify(authState.value));

    setPageState({ showLogin: false });

    // Capture wallet chain ID for network mismatch detection
    if (type === 'ultra' && Ultra.isAvailable()) {
        try {
            const chainIdResponse = await Ultra.getChainId();
            if (chainIdResponse.status === 'success') {
                setAuthStateKeys({ chainId: chainIdResponse.data });
                localStorage.setItem('authState', JSON.stringify(authState.value));
            }
        } catch {
            // Non-critical — chainId just enables mismatch warning
        }
    }
}

/**
 *
 * Removes local storage, and resets current session.
 */
async function logout() {
    if (authState.value.type === 'ultra') {
        await Ultra.disconnect();
    }

    if (authState.value.type === 'anchor') {
        await Anchor.logout();
    }

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

function setTransaction(newActions: I.Action[]) {
    actions.value = newActions;
}

/**
 * Grab any local storage information, and try to restore the previous session.
 */
async function restoreSession() {
    try {
        const jsonData = localStorage.getItem('authState');
        if (!jsonData) {
            return;
        }

        const restoredAuthState = JSON.parse(jsonData);
        if (!restoredAuthState || !restoredAuthState.accountName || !restoredAuthState.endpoint) {
            return;
        }

        if (restoredAuthState.type === 'ultra') {
            if (Ultra.isAvailable()) {
                try {
                    const response = await Ultra.connect(true);
                    if (response.status === 'success' && response.data.network) {
                        restoredAuthState.chainId = response.data.network.chainId;
                    }
                } catch {
                    // Silent connect failed — user will need to log in manually
                    return;
                }
            } else {
                return;
            }
        }

        if (restoredAuthState.type === 'anchor' && restoredAuthState.endpoint) {
            await Anchor.restore(restoredAuthState.endpoint);
        }

        setAuthStateKeys(restoredAuthState);
        localStorage.setItem('authState', JSON.stringify(authState.value));
        setPageState({ showEndpoint: false, showLogin: false, showTransaction: false });
    } catch (err) {}
}

function clearTransaction() {
    actions.value = undefined;
}

function transactionExecuted() {
    runtimeMetadata.value.lastSignedActions = actions.value;
    runtimeMetadata.value.lastSignedTransactionTimestamp = Date.now();
    console.log(runtimeMetadata.value);
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

async function handleWalletAccountChanged(data: { selected: { accountName: string } | null }) {
    if (authState.value.type !== 'ultra') return;

    if (!data.selected) {
        // Wallet locked — log out
        logout();
        return;
    }

    if (data.selected.accountName !== authState.value.accountName) {
        // Account switched in wallet — resolve actual permission
        let perm = 'active';
        try {
            const selected = await Ultra.getSelectedAccount();
            if (selected.status === 'success' && selected.data) {
                const { permission } = Ultra.extractAccountInfo({
                    blockchainid: selected.data.accountName,
                    publicKey: '',
                    selectedAccount: selected.data,
                });
                perm = permission;
            }
        } catch {
            // Fall back to 'active'
        }

        setAuthStateKeys({
            accountName: data.selected.accountName,
            accountPerm: perm,
        });
        localStorage.setItem('authState', JSON.stringify(authState.value));
        keyRouterUpdate.value += 1;
        keyUserUpdate.value += 1;
    }
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
                            const { accountName, permission } = Ultra.extractAccountInfo(response.data);
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
    logout();
}

onMounted(async () => {
    restoreSession();

    emitter.on('updateAppActions', handleUpdateAppActions);

    // Wallet event listeners
    Ultra.on('accountChanged', handleWalletAccountChanged);
    Ultra.on('networkChanged', handleWalletNetworkChanged);
    Ultra.on('disconnect', handleWalletDisconnect);

    const endpoint = localStorage.getItem('endpoint');
    if (endpoint && endpoint !== '') {
        setAuthStateKeys({ endpoint });
        keyUserUpdate.value += 1;

        console.log('endpoint found in localStore');
    }

    const environment = localStorage.getItem('environment');
    if (environment && environment !== '') {
        setAuthStateKeys({ environment });
        keyUserUpdate.value += 1;

        console.log('environment found in localStore');
    }

    // Init Blockchain & NFT API service
    await initServices();
});

onUnmounted(async () => {
    emitter.off('updateAppActions', handleUpdateAppActions);
    Ultra.off('accountChanged', handleWalletAccountChanged);
    Ultra.off('networkChanged', handleWalletNetworkChanged);
    Ultra.off('disconnect', handleWalletDisconnect);
});

</script>
