<template>
    <AnchorHelp v-if="anchorHelp" @close="anchorHelp = false" :endpoint="props.state.endpoint" />
    <UltraWalletHelp v-if="ultraHelp" @close="ultraHelp = false" :endpoint="props.state.endpoint" />
    <LedgerHelp v-if="ledgerHelp" @close="ledgerHelp = false" :endpoint="props.state.endpoint" />
    <Modal title="Select a Wallet Provider" v-if="!isShowingHelp" @close="emit('set-page-state', { showLogin: false })">
        <!-- Selecting Login Step -->
        <template v-if="loginState.isSelectingLogin">
            <p>
                We currently support any of the following wallet providers. Use 'help' if you need setup instructions.
            </p>
            <!-- Ultra Wallet Extension -->
            <div class="flex items-center flex-row gap-3">
                <div
                    class="flex items-center justify-center w-10 h-10 rounded border border-neutral-600 bg-neutral-800 text-neutral-200 flex-shrink-0"
                >
                    <Icon icon="fa-puzzle-piece" />
                </div>
                <Button
                    :disabled="loginState.isUltraWalletAvailable ? false : true"
                    @onClick="login('ultra')"
                    class="flex-grow text-left"
                >
                    <span>Ultra Wallet (Extension)</span>
                </Button>
                <Button @onClick="ultraHelp = true"> Help </Button>
            </div>

            <!-- Ultra Web Wallet -->
            <div class="flex items-center flex-row gap-3">
                <div
                    class="flex items-center justify-center w-10 h-10 rounded border border-neutral-600 bg-neutral-800 text-neutral-200 flex-shrink-0"
                >
                    <Icon icon="fa-globe" />
                </div>
                <Button
                    :disabled="!isWebWalletSupported"
                    :title="isWebWalletSupported ? '' : 'Web Wallet only supports Mainnet and Testnet'"
                    @onClick="login('ultra-web')"
                    class="flex-grow text-left"
                >
                    <span>Ultra Wallet (Web)</span>
                </Button>
                <Button @onClick="ultraHelp = true"> Help </Button>
            </div>

            <!-- Ultra Ledger Lib -->
            <div class="flex items-center flex-row gap-3">
                <div
                    class="flex items-center justify-center w-10 h-10 rounded border border-neutral-600 bg-neutral-800 text-neutral-200 flex-shrink-0"
                >
                    <Icon icon="fa-microchip" />
                </div>
                <Button @onClick="login('ledger')" class="flex-grow text-left">
                    <span>Ledger</span>
                </Button>
                <Button @onClick="ledgerHelp = true"> Help </Button>
            </div>

            <!-- Anchor Wallet -->
            <div class="flex items-center flex-row gap-3">
                <div
                    class="flex items-center justify-center w-10 h-10 rounded border border-neutral-600 bg-neutral-800 text-neutral-200 flex-shrink-0"
                >
                    <Icon icon="fa-anchor" />
                </div>
                <Button @onClick="login('anchor')" class="flex-grow text-left">
                    <span>Anchor</span>
                </Button>
                <Button @onClick="anchorHelp = true"> Help </Button>
            </div>
        </template>

        <!-- Connecting to Account w/ Other -->
        <template v-if="!loginState.isSelectingLogin">
            <div class="flex flex-col items-center justify-center w-full gap-4">
                <template
                    v-if="
                        walletProviderForm && (walletProviderForm.errorMessage || walletProviderForm.ledgerIndex >= 0)
                    "
                >
                    <template v-if="walletProviderForm.errorMessage">
                        <div class="text-center">{{ walletProviderForm.errorMessage }}</div>
                    </template>
                    <template
                        v-if="
                            !walletProviderForm.errorMessage &&
                            walletProviderForm.ledgerIndex >= 0 &&
                            !walletProviderForm.possibleAccounts
                        "
                    >
                        <div class="text-center">Enter desired Ledger index</div>
                        <div class="flex flex-row h-12 gap-4">
                            <input
                                :type="'number'"
                                :name="'index'"
                                :placeholder="'Ledger index'"
                                :min="0"
                                :max="18446744073709551615"
                                v-model="walletProviderForm.ledgerIndex"
                                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                            />
                        </div>
                        <Button @onClick="selectLedgerIndex" class="w-full">
                            <span>Select</span>
                        </Button>
                    </template>
                    <template
                        v-if="
                            !walletProviderForm.errorMessage &&
                            walletProviderForm.possibleAccounts &&
                            walletProviderForm.possibleAccounts.length > 0
                        "
                    >
                        <div class="text-center">Select account associated with your Ledger</div>
                        <div
                            v-for="account in walletProviderForm.possibleAccounts"
                            class="flex flex-row items-center gap-4 w-full"
                        >
                            <Button @click="selectLedgerAccount(account)" class="w-full"
                                >{{ account.account_name }}@{{ account.permission_name }}</Button
                            >
                        </div>
                    </template>
                </template>
                <template v-else>
                    <Icon icon="fa-spinner" size="2x" class="animate-spin" />
                    <div v-if="walletProviderForm" class="text-center">
                        Ensure that your Ledger is connected to the computer, unlocked and has EOS application installed
                        and opened
                    </div>
                    <div v-if="walletProviderForm" class="text-center">
                        If you still experience issues try resetting USB device permission in your browser and reloading
                        the page
                    </div>
                    <div v-if="loginState.connectingWalletType === 'ultra'" class="text-center">
                        Please sign in to your Ultra Wallet extension and approve the connection request.
                    </div>
                    <div v-if="loginState.connectingWalletType === 'ultra-web'" class="text-center">
                        Please complete sign-in in the Ultra Web Wallet popup. If you don't see it, make sure popups
                        are allowed for this site.
                    </div>
                    <div class="text-center">Waiting for wallet provider...</div>
                </template>
            </div>
            <Button @onClick="resetState">
                <div class="split">
                    <span>Cancel</span>
                </div>
            </Button>
        </template>
    </Modal>
</template>

<script setup lang="ts">
import { ref, onMounted, reactive, computed } from 'vue';

import * as Ultra from '../wallets/ultra';
import * as UltraWeb from '../wallets/ultra-web';
import { populateWalletAccountsFromConnectResult } from '../wallets/wallet-accounts';

import { SharedEmits, AuthState, WalletTypes, PageState } from '../interfaces';
import * as Anchor from '../wallets/anchor';
import { connect as ledgerConnect, LedgerConnectionAPI } from '@ultraos/ultra-ledger-lib';
import { BlockchainService } from '../utilities/blockchain';
import { GetAccountsByAuthorizersAccount } from '../interfaces';
import {fetchWithTimeout} from '../utilities/networks';

interface LoginState {
    isUltraWalletAvailable: boolean;
    isSelectingLogin: boolean;
    connectingWalletType: 'ultra' | 'ultra-web' | 'ledger' | 'anchor' | null;
}

interface WalletProviderForm {
    ledgerApi?: LedgerConnectionAPI;
    errorMessage?: string;
    ledgerIndex?: number;
    publicKey?: string;
    possibleAccounts?: GetAccountsByAuthorizersAccount[];
}

interface LoginEmits extends SharedEmits {
    (e: 'set-account', type: WalletTypes, accountName: string, permission: string, ledgerIndex?: number): void;
}

const emit = defineEmits<LoginEmits>();

const loginState = reactive<LoginState>({
    isUltraWalletAvailable: false,
    isSelectingLogin: true,
    connectingWalletType: null,
});

const props = defineProps<{ state: Pick<AuthState, 'endpoint' | 'environment'> }>();

const isWebWalletSupported = computed(() => UltraWeb.isSupportedEnvironment(props.state.environment));

let anchorHelp = ref<boolean>(false);
let ultraHelp = ref<boolean>(false);
let ledgerHelp = ref<boolean>(false);

let walletProviderForm = ref<WalletProviderForm>(undefined);

function resetState() {
    loginState.isSelectingLogin = true;
    loginState.connectingWalletType = null;
    walletProviderForm.value = undefined;
}

async function selectLedgerIndex() {
    console.log(walletProviderForm.value.ledgerIndex);
    const pubKey = await walletProviderForm.value.ledgerApi.getPublicKey({
        ledgerIndex: walletProviderForm.value.ledgerIndex,
    });
    if (!pubKey || !pubKey.status) {
        walletProviderForm.value = {
            errorMessage: `Could not get public key on index ${walletProviderForm.value.ledgerIndex}`,
        };
        return;
    }
    console.log(pubKey);
    walletProviderForm.value.publicKey = pubKey.response;

    let response = await BlockchainService.getAccountsByKey(pubKey.response);
    if (!response) {
        walletProviderForm.value = { errorMessage: `Could not get API response to obtain the list of accounts` };
        return;
    }

    // filter accounts only accounts that satisfy the ability to sign transactions without proposals
    walletProviderForm.value.possibleAccounts = [];
    response.accounts.forEach((account) => {
        if (account.weight >= account.threshold) {
            walletProviderForm.value.possibleAccounts.push(account);
        }
    });

    if (walletProviderForm.value.possibleAccounts.length === 0) {
        walletProviderForm.value = { errorMessage: `No accounts found associated with public key: ${pubKey.response}` };
        return;
    }
}

async function selectLedgerAccount(account: GetAccountsByAuthorizersAccount) {
    setAccount('ledger', account.account_name, account.permission_name);
}

/**
 * Test if an account exists given the selected endpoint.
 * If it does, pass up the account to the main state controller.
 *
 * @param type
 * @param accountName
 * @param publicKey
 */
async function setAccount(type: WalletTypes, accountName: string, permission: string) {
    accountName = accountName.includes('@') ? accountName.split('@')[0] : accountName;

    const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_name: accountName, json: true }),
    };

    // For type === 'ultra', the wallet is the source of truth for which chain
    // its account lives on. We don't validate the account here — App.vue's
    // setAccount handler runs Ultra.getChainId() right after this emit and
    // syncs the toolkit endpoint to the wallet's chain before any chain-bound
    // operation runs. Validating here against props.state.endpoint would
    // 404 in the toolkit-on-Mainnet/wallet-on-Testnet case (Issue 1).
    if (type === 'ultra') {
        emit('set-account', type, accountName, permission);
        return;
    }

    const response = await fetchWithTimeout(`${props.state.endpoint}/v1/chain/get_account`, options).catch((err) => {
        console.error(err);
        return undefined;
    });

    if (!response || !response.ok) {
        if (type === 'ultra-web') {
            resetState();
            alert(
                `Could not find account '${accountName}' on the current endpoint. Make sure your wallet's network matches the selected endpoint.`
            );
            return;
        }

        resetState();
        alert(`Account '${accountName}' not found at endpoint '${props.state.endpoint}'`);
        return;
    }

    if (type === 'ledger') {
        emit('set-account', type, accountName, permission, walletProviderForm.value.ledgerIndex);
    } else {
        emit('set-account', type, accountName, permission);
    }
}

async function login(type: 'ledger' | 'anchor' | 'ultra' | 'ultra-web') {
    loginState.isSelectingLogin = false;
    loginState.connectingWalletType = type;

    if (type === 'ultra-web') {
        if (!UltraWeb.isSupportedEnvironment(props.state.environment)) {
            loginState.isSelectingLogin = true;
            alert('Ultra Web Wallet only supports Mainnet and Testnet.');
            return;
        }

        try {
            const response = await UltraWeb.connect(props.state.environment);
            if (!response || response.status !== 'success') {
                loginState.isSelectingLogin = true;
                alert('Ultra Web Wallet connection was canceled.');
                return;
            }

            if (loginState.isSelectingLogin) {
                return;
            }

            const { accountName, permission } = UltraWeb.extractAccountInfo(response.data);
            setAccount(type, accountName, permission);
        } catch (err) {
            loginState.isSelectingLogin = true;
            alert('Ultra Web Wallet connection failed. Check that popups are allowed for this site.');
        }

        return;
    }

    // 1. Ultra Login
    // 2. Connect with Wallet
    // 3. Pass Public Key + Account to Main App
    if (type === 'ultra') {
        if (!Ultra.isAvailable()) {
            loginState.isSelectingLogin = true;
            alert('Could not connect to the Ultra Wallet Extension, is the extension installed?');
            return;
        }

        try {
            const CONNECT_TIMEOUT_MS = 120_000; // 2 minutes
            const response = await Promise.race([
                Ultra.connect(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), CONNECT_TIMEOUT_MS)
                ),
            ]);

            if (!response || response.status !== 'success') {
                loginState.isSelectingLogin = true;
                alert('Ultra Wallet Extension connection was canceled.');
                return;
            }

            // Handles a cancel mid-selection
            if (loginState.isSelectingLogin) {
                console.log('User canceled login selection.');
                return;
            }

            populateWalletAccountsFromConnectResult(response.data);
            const { accountName, permission } = await Ultra.resolveSelectedAccount(response.data);
            await setAccount(type, accountName, permission);
        } catch (err) {
            loginState.isSelectingLogin = true;
            if (err instanceof Error && err.message === 'timeout') {
                alert('Connection timed out. Please make sure you are signed in to the Ultra Wallet extension and try again.');
            } else {
                alert('Ultra Wallet Extension connection was canceled.');
            }
        }

        return;
    }

    if (type === 'anchor') {
        try {
            const response = await Anchor.connect(props.state.endpoint);
            setAccount(type, response.blockchainid, response.permission);
        } catch (err) {
            loginState.isSelectingLogin = true;
            alert('Could not connect to Anchor Wallet');
        }

        return;
    }

    if (type === 'ledger') {
        walletProviderForm.value = {};
        const ledgerApi = await ledgerConnect();

        if (!ledgerApi) {
            walletProviderForm.value = {
                errorMessage:
                    'Failed to connect to ledger device. Ensure it is connected, unlocked and EOS application is installed and opened',
            };
            return;
        }

        // default index is 0, will also initialize the process for user to select desried index
        walletProviderForm.value.ledgerIndex = 0;
        walletProviderForm.value.ledgerApi = ledgerApi;
    }
}

const isShowingHelp = computed(() => {
    return anchorHelp.value || ultraHelp.value || ledgerHelp.value;
});

onMounted(() => {
    loginState.isUltraWalletAvailable = Ultra.isAvailable();
});
</script>
