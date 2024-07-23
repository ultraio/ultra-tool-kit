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
                <span>Toolkit</span>
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
import UltraWallet from '@ultraos/ultra-extension-wallet-lib';
import * as I from './interfaces';
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { BlockchainService } from './utilities/blockchain';
import { defaultNetworks, getEnvironmentName } from './utilities/networks';
import * as NFTAPI from './utilities/nftapi/api';
import { emitter } from './eventBus';

// Use `ref` here because we want to be able to set the whole object
// and trigger a reaction when we set the whole object.
let pageState = ref<I.PageState>({});

let actions = ref<I.Action[] | undefined>(undefined);
let keyRouterUpdate = ref<number>(1);
let keyUserUpdate = ref<number>(1);

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
}

/**
 *
 * Removes local storage, and resets current session.
 */
async function logout() {
    if (authState.value.type === 'ultra') {
        await UltraWallet().disconnect();
    }

    if (authState.value.type === 'anchor') {
        await Anchor.logout();
    }

    setAuthStateKeys({
        type: undefined,
        accountName: undefined,
        accountPerm: undefined,
        isAdmin: false,
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
            await window['ultra'].connect({ onlyIfTrusted: true })
            .catch(async () => {
                await window['ultra'].connect({ onlyIfTrusted: false })
            });
        }

        if (restoredAuthState.type === 'anchor' && restoredAuthState.endpoint) {
            await Anchor.restore(restoredAuthState.endpoint);
        }

        setAuthStateKeys(restoredAuthState);
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

onMounted(async () => {
    restoreSession();

    emitter.on('updateAppActions', handleUpdateAppActions);

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
});

</script>
