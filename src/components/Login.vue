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
            <!-- Ultra Wallet -->
            <div class="flex items-center justify-between flex-row">
                <Button
                    :disabled="loginState.isUltraWalletAvailable ? false : true"
                    @onClick="login('ultra')"
                    class="flex flex-row items-center flex-grow mr-4"
                >
                    <span>Ultra Wallet</span>
                </Button>
                <Button @onClick="ultraHelp = true"> Help </Button>
            </div>

            <!-- Ultra Ledger Lib -->
            <div class="flex items-center justify-between flex-row">
                <Button @onClick="login('ledger')" class="flex flex-row items-center flex-grow mr-4">
                    <span>Ledger</span>
                </Button>
                <Button @onClick="ledgerHelp = true"> Help </Button>
            </div>

            <!-- Anchor Wallet -->
            <div class="flex items-center justify-between flex-row">
                <Button @onClick="login('anchor')" class="flex flex-row items-center flex-grow mr-4">
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
                    <Icon icon="fa-spinner" size="2x" spin />
                    <div v-if="walletProviderForm" class="text-center">
                        Ensure that your Ledger is connected to the computer, unlocked and has EOS application installed
                        and opened
                    </div>
                    <div v-if="walletProviderForm" class="text-center">
                        If you still experience issues try resetting USB device permission in your browser and reloading
                        the page
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

import UltraWallet from '@ultraos/ultra-extension-wallet-lib';

import { SharedEmits, AuthState, WalletTypes, PageState } from '../interfaces';
import * as Anchor from '../wallets/anchor';
import { connect as ledgerConnect, LedgerConnectionAPI } from '@ultraos/ultra-ledger-lib';
import { BlockchainService } from '../utilities/blockchain';
import { GetAccountsByAuthorizersAccount } from '../interfaces';
import {fetchWithTimeout} from '../utilities/networks';

interface LoginState {
    isUltraWalletAvailable: boolean;
    isSelectingLogin: boolean;
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
});

const props = defineProps<{ state: Pick<AuthState, 'endpoint'> }>();

let anchorHelp = ref<boolean>(false);
let ultraHelp = ref<boolean>(false);
let ledgerHelp = ref<boolean>(false);

let walletProviderForm = ref<WalletProviderForm>(undefined);

function resetState() {
    loginState.isSelectingLogin = true;
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

    const response = await fetchWithTimeout(`${props.state.endpoint}/v1/chain/get_account`, options).catch((err) => {
        console.error(err);
        return undefined;
    });

    if (!response || !response.ok) {
        if (type === 'ultra') {
            resetState();
            alert('Could not find account, did you select the right endpoint in the Ultra Wallet Extension?');
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

async function login(type: 'ledger' | 'anchor' | 'ultra') {
    loginState.isSelectingLogin = false;

    // 1. Ultra Login
    // 2. Connect with Wallet
    // 3. Pass Public Key + Account to Main App
    if (type === 'ultra') {
        const api = UltraWallet();
        if (!api) {
            loginState.isSelectingLogin = true;
            alert('Could not connect to the Ultra Wallet Extension, is the extension installed?');
            return;
        }

        try {
            const response = await api.connect();

            if (!response || !response.status) {
                loginState.isSelectingLogin = true;
                alert('Ultra Wallet Extension connection was canceled.');
                return;
            }

            // Handles a cancel mid-selection
            if (loginState.isSelectingLogin) {
                console.log('User canceled login selection.');
                return;
            }

            setAccount(type, response.data.blockchainid, 'active');
        } catch (err) {
            loginState.isSelectingLogin = true;
            alert('Ultra Wallet Extension connection was canceled.');
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
    loginState.isUltraWalletAvailable = UltraWallet() ? true : false;
});
</script>
