<template>
    <Modal :title="`Transaction - @${props.state.accountName}`" @close="closeModal">
        <div v-if="!isTransacting && !transactionHash" class="flex flex-col gap-4">
            <div class="text-xl font-bold">Action Overview</div>
            <div>Brief overview of contracts being called, with specific actions.</div>
            <!-- Actions Overview -->
            <Expand title="Actions" :expanded="true">
                <div class="flex flex-col gap-4">
                    <div v-if="props.actions.length === 0">
                        No actions provided. Transaction is invalid
                    </div>
                    <ActionDetail v-for="(actionInfo, index) in props.actions" :key="index">
                        <template #contract>
                            {{ actionInfo.contract }}
                        </template>
                        <template #action>
                            {{ actionInfo.action }}
                        </template>
                        <template #delete>
                            <Button @click="removeAction(index)">
                                <Icon icon="fa-trash" />
                            </Button>
                        </template>
                    </ActionDetail>
                </div>
            </Expand>
            <Expand title="Details">
                <Code
                    ref="codeComponent"
                    :code="editableTransactionBody"
                    :editable="true"
                    @apply-changes="applyTransactionBodyEdit"
                />
            </Expand>
            <!-- Proposal Generator -->
            <Expand title="Proposal Details">
                <div class="flex flex-col p-4 border border-neutral-700 rounded bg-neutral-900">
                    <Button v-if="!isMakingProposal" @click="isMakingProposal = true">Create Proposal</Button>
                    <div v-if="isMakingProposal" class="flex flex-col gap-4">
                        <div class="font-bold">Action Authorizations</div>
                        <AuthorizerForm
                            v-for="(actionInfo, index) in props.actions"
                            :authorizers="authorizers[index]"
                            :index="index"
                            :action="actionInfo"
                            @set-authorizer="setAuthorizer"
                        />
                        <div class="font-bold">Request Signatures*</div>
                        <SignatureForm @set-signatures="setSignatures" :signatures="signatures" :state="props.state" />
                        <div class="font-bold">Proposal Name*</div>
                        <input
                            placeholder="12 Characters Max | Uses: (a-z1-5.)"
                            v-model="proposalName"
                            class="h-12 flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                        />
                        <div class="font-bold">Proposal Expiration Date</div>
                        <input
                            placeholder="Date like 2023-12-31T12:34:56 or a number of seconds. Default expiration: 30 days"
                            v-model="proposalExpiration"
                            class="h-12 flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                        />
                        <div class="italic">* fields are mandatory</div>
                        <Button v-if="isMakingProposal" @click="isMakingProposal = false">Cancel Proposal</Button>
                    </div>
                </div>
            </Expand>
            <div class="text-sm">By clicking confirm, you will start the transaction process.</div>
        </div>

        <template v-if="isTransacting && !transactionHash">
            <p>{{ getWaitingText }}</p>
        </template>

        <template v-if="transactionHash">
            <p>Transaction was completed successfully...</p>
            <div class="transaction-body">
                <Link :link="transactionLink" v-if="transactionLink" />
                <div v-else>
                    <p>No Explorer Link Available</p>
                    <pre>{{ transactionHash }}</pre>
                </div>
            </div>
        </template>

        <div class="split">
            <template v-if="!transactionHash">
                <Button
                    :disabled="
                        isTransacting ||
                        (isMakingProposal && !proposalName) ||
                        (isMakingProposal && signatures.length <= 0) ||
                        !props.state.accountName ||
                        props.actions.length === 0
                    "
                    @onClick="confirm"
                >
                    <template v-if="isTransacting">
                        <Icon icon="fa-spinner" size="1x" spin />
                    </template>
                    <template v-else>
                        <div class="split">
                            <span>{{ props.state.accountName ? 'Confirm' : 'Not Signed In' }}</span>
                        </div>
                    </template>
                </Button>
            </template>
            <Button @onClick="closeModal">
                <div class="split">
                    <span>{{ transactionHash ? 'Close' : 'Cancel' }}</span>
                </div>
            </Button>
        </div>
    </Modal>

    <!-- Error Modal -->
    <ErrorModal v-if="errorMessage" :errorMessage="errorMessage" @close="clearErrorMessage"></ErrorModal>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, getCurrentInstance, nextTick, watch } from 'vue';
import { AuthState, Action, TransactionResponse } from '../interfaces/index';
import { getTransactionLink } from '../utilities/networks';

import * as Anchor from '../wallets/anchor';
import UltraWallet from '@ultraos/ultra-extension-wallet-lib';
import { connect as ledgerConnect } from '@ultraos/ultra-ledger-lib';
// import { API as SignerAPI } from '@ultraos/ultra-signer-lib';
import { API as UltraSignerAPI } from '@ultraos/ultra-signer-lib';

import { BlockchainService } from '../utilities/blockchain';

import { emitter } from '../eventBus';

const props = withDefaults(defineProps<{ state: AuthState; actions: Action[]; allowProposal?: boolean }>(), {
    allowProposal: true, // Allow proposal option by default
});

const emit = defineEmits([ 
    'clear-transaction',
    'transaction-executed'
]);

let transactionHash = ref<string | undefined>(undefined);
let isTransacting = ref<boolean>(false);
let isMakingProposal = ref<boolean>(false);

let authorizers = ref<Array<Array<{ actor: string; permission: string }>>>([]);
let signatures = ref<Array<{ actor: string; permission: string }>>([]);
let proposalName = ref<string>('');
let proposalExpiration = ref<string>('');

let errorMessage = ref('');

const editableTransactionBody = ref<string | undefined>('');
const codeComponent = ref(null); // Ref to the Code component

function closeModal() {
    if (transactionHash.value) {
        emit('transaction-executed');
    } else {
        emit('clear-transaction');
    }
}

function toSignerActions(actions: Action[], actor: string, permission: string) {
    let result: any[] = [];
    actions.forEach((action) => {
        result.push({
            account: action.contract,
            name: action.action,
            authorization: action.authorization
                ? action.authorization
                : [
                      {
                          actor,
                          permission: permission ? permission : 'active',
                      },
                  ],
            data: action.data,
        });
    });
    return result;
}

async function validateTransaction(currentActions: Array<Action>) {
    try {
        let signerAPI = new UltraSignerAPI(props.state.endpoint, { signingMode: 'PRIVATE_KEY', privateKeys: [] });
        const transaction = await signerAPI.buildTransaction(
            toSignerActions(currentActions, props.state.accountName, props.state.accountPerm)
        );
    } catch (err) {
        errorMessage.value = String(err);
        return false;
    }

    return true;
}

async function confirm() {
    let transaction_id: string;
    isTransacting.value = true;

    // Apply edits from the Code component
    if (codeComponent.value && typeof codeComponent.value.applyEdit === 'function') {
        await codeComponent.value.applyEdit();
    }

    // Unbind references
    let currentActions: Array<Action> = JSON.parse(JSON.stringify(props.actions));

    // Convert to Proposal
    if (isMakingProposal.value) {
        for (let i = 0; i < currentActions.length; i++) {
            currentActions[i].authorization = JSON.parse(JSON.stringify(authorizers.value[i]));
        }

        try {
            const data = await BlockchainService.getProposalTxData(
                props.state.accountName,
                proposalName.value,
                JSON.parse(JSON.stringify(signatures.value)),
                currentActions,
                proposalExpiration.value
            );

            currentActions = [{ contract: 'eosio.msig', action: 'proposex', data }];
        } catch (err) {
            errorMessage.value = err.message || JSON.stringify(err);
            isTransacting.value = false;
            return undefined;
        }
    }

    // Anchor Ledger Integration for Signing Transactions
    if (props.state.type === 'anchor') {
        const session = Anchor.getSession();
        const transaction = await Anchor.convertActions(
            currentActions,
            props.state.accountName,
            props.state.accountPerm
        );

        try {
            const res = await session.transact(transaction, { broadcast: true });
            if (res.response) {
                transaction_id = res.response.transaction_id;
            }
        } catch (err) {
            errorMessage.value = err.message || JSON.stringify(err);
            isTransacting.value = false;
            return undefined;
        }
    }

    // Validate transaction before sending
    if (!(await validateTransaction(currentActions))) {
        isTransacting.value = false;
        return;
    }

    // Ultra Wallet Integration
    if (props.state.type === 'ultra') {
        // We need to sanitize the array and remove any vue bindings.
        // This makes it easy.
        const actions = JSON.parse(JSON.stringify(currentActions));
        for (let action of actions) {
            action.authorizations = [];
            for (let auth of action.authorization) {
                action.authorizations.push(`${auth.actor}@${auth.permission}`);
            }
            delete action.authorization;
        }

        const result = await UltraWallet()
            .signTransaction(actions)
            .catch((err) => {
                if (err && err.data && err.data.error && err.data.error.details && err.data.error.details.length > 0) {
                    errorMessage.value = err.data.error.details[0].message;
                } else {
                    errorMessage.value = err.message;
                }

                isTransacting.value = false;
                return undefined;
            });

        if (!result || !result.data) {
            isTransacting.value = false;
            return;
        }

        console.log(result);
        transaction_id = result.data.transactionHash;
    }

    // Direct Ledger Integration for Signing Transactions
    if (props.state.type === 'ledger') {
        // This will wait until the ledger app is open and connected.
        // Tries roughly for 30s before giving up.
        const ledgerApi = await ledgerConnect();
        if (!ledgerApi) {
            errorMessage.value = 'Failed to connect to ledger device';
            isTransacting.value = false;
            return undefined;
        }

        let signerAPI = new UltraSignerAPI(props.state.endpoint, { signingMode: 'PRIVATE_KEY', privateKeys: [] });
        const transaction = await signerAPI.buildTransaction(
            toSignerActions(currentActions, props.state.accountName, props.state.accountPerm)
        );

        const chain_id = await Anchor.getChainIdentifier(props.state.endpoint);
        const signedTransaction = await ledgerApi.signTransaction(
            JSON.parse(JSON.stringify(transaction)),
            chain_id,
            props.state.ledgerIndex
        );

        const result = await signerAPI.sendSignedTransaction(signedTransaction);

        // TODO (jlr) : result can be failed then we should not log into console.
        console.log(result);
        if (!result || !result.data) {
            errorMessage.value = JSON.stringify(result);
            isTransacting.value = false;
            return undefined;
        }
        if (!result.status) {
            errorMessage.value = result.data as string;
            isTransacting.value = false;
            return undefined;
        }
        transaction_id = (<TransactionResponse>result.data).transaction_id;
    }

    if (!transaction_id) {
        isTransacting.value = false;
        return;
    }

    transactionHash.value = transaction_id;
    isTransacting.value = false;
}

// Updates authorizers array when making a proposal.
// Sets the relevant action with relevant actions to use.
// Used for final creation of proposal.
function setAuthorizer(index: number, newAuths: Array<{ actor: string; permission: string }>) {
    authorizers.value[index] = newAuths;
}

// Updates signatures array when making a proposal.
function setSignatures(newSignatures: Array<{ actor: string; permission: string }>) {
    signatures.value = newSignatures;
}

const getWaitingText = computed(() => {
    if (props.state.type === 'anchor') {
        return `Waiting for Anchor...`;
    } else if (props.state.type === 'ledger') {
        return `Waiting for Ledger... (go to your ledger and approve the transaciton request)`;
    }

    return `Waiting for Ultra Wallet...`;
});

const transactionLink = computed(() => {
    return getTransactionLink(props.state.environment, transactionHash.value);
});

function clearErrorMessage() {
    errorMessage.value = '';
}

function removeAction(index: number) {
    props.actions.splice(index, 1);
    authorizers.value.splice(index, 1);
    editableTransactionBody.value = JSON.stringify(props.actions);
}

onMounted(() => {
    editableTransactionBody.value = JSON.stringify(props.actions, null, 2);
    // Used for proposal creation
    // Populates authorizers array with necessary amount of authorizer arrays.
    for (let i = 0; i < props.actions.length; i++) {
        authorizers.value.push(props.actions[i].authorization ? props.actions[i].authorization : []);
    }
});

function applyTransactionBodyEdit(text: string) {
    editableTransactionBody.value = text;
    const parsed = JSON.parse(text);
    emitter.emit('updateAbiActions', parsed);
    emitter.emit('updateAppActions', parsed);
}

</script>
