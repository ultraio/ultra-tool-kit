<template>
    <div class="flex flex-col gap-4">
        <div class="text-3xl font-bold">Proposals</div>
        <div v-if="!props.state.accountName">
            <span>You are not currently logged in, please log in to view proposals.</span>
        </div>
        <template v-else>
            <div class="flex flex-row gap-2">
                <input
                    v-model="searchText"
                    placeholder="Search..."
                    class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                />
                <Button :disabled="searchText === ''">
                    <Icon icon="fa-trash" class="clear-search" @click="updateSearch('')" />
                </Button>
            </div>
            <div class="flex flex-row gap-2" v-for="proposal in filteredProposals">
                <div
                    class="flex flex-col items-center justify-center h-12 w-12 bg-neutral-700 rounded"
                    :class="proposal.approved ? ['text-green-300'] : ['text-red-300']"
                >
                    <Icon
                        :icon="proposal.approved ? 'fa-check' : 'fa-times'"
                        class="clear-search"
                        @click="updateSearch('')"
                    />
                </div>
                <div
                    class="flex flex-col items-center justify-center w-32 flex-grow bg-neutral-700 rounded select-none"
                    :class="proposal.approved ? ['text-green-300'] : ['text-red-300']"
                >
                    {{ proposal.name }}
                </div>
                <Button title="Review" @onClick="reviewProposal(proposal)">
                    <Icon icon="fa-magnifying-glass" />
                </Button>
                <Button title="Approve" :disabled="proposal.approved" @onClick="handleApprove(proposal)">
                    <Icon icon="fa-check" />
                </Button>
                <Button title="Execute" :disabled="proposal.approved === false" @onClick="handleExecute(proposal)">
                    <Icon icon="fa-paper-plane" />
                </Button>
                <Button title="Unapprove" :disabled="proposal.approved === false" @onClick="handleUnapprove(proposal)">
                    <Icon icon="fa-ban" />
                </Button>
                <Button title="Cancel" :disabled="!canCancel(proposal)" @onClick="handleCancel(proposal)">
                    <Icon icon="fa-trash" />
                </Button>
            </div>
            <p v-if="filteredProposals.length == 0 && !loading">No proposals found</p>
            <LoadingSpinner v-if="loading"></LoadingSpinner>
        </template>
        <Modal v-if="previewData" :title="previewData.name + ' Proposal'" @close="previewData = undefined">
            <div class="flex flex-col gap-4">
                <div>Details about what is inside of this proposal.</div>
                <div v-for="(action, index) in previewData.readable.actions" :key="index">
                    <ActionDetail>
                        <template #contract>
                            {{ action.account }}
                        </template>
                        <template #action>
                            {{ action.name }}
                        </template>
                    </ActionDetail>
                </div>
                <div class="container">
                    <Expand :title="`View Proposal JSON`">
                        <div class="flex flex-col gap-4">
                            <div v-for="(hash, index) in contractHashes" :key="index">
                                <ActionDetail>
                                    <template #contract>
                                        {{ hash.contract }}{{ hash.isAbi ? '.abi' : '.wasm' }}
                                    </template>
                                    <template #action>
                                        {{ hash.hash }}
                                    </template>
                                </ActionDetail>
                            </div>
                            <Code :code="JSON.stringify(previewData.readable)" />
                        </div>
                    </Expand>
                </div>
            </div>
        </Modal>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router/auto';
import { BlockchainService } from '../../utilities/blockchain';
import * as I from '../../interfaces/index';
import LoadingSpinner from '../../components/widgets/LoadingSpinner.vue';
import { PublicKey } from '@wharfkit/antelope';
import * as crypto from 'crypto';

const route = useRoute('/proposals/');
const props = defineProps<{ state: I.AuthState; metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();
const proposals = ref<I.Proposal[]>([]);
const searchText = ref<string>('');
const loading = ref<boolean>(false);
const previewData = ref<I.Proposal>(undefined);
const contractHashes = ref<{contract: string, isAbi: boolean, hash: string}[]>([]);

async function getProposals() {
    loading.value = true;
    proposals.value = await BlockchainService.getProposals(props.state.accountName || '');
    loading.value = false;
}

const updateSearch = async (text: string) => {
    searchText.value = text;
};

const filteredProposals = computed(() => {
    if (!searchText.value || searchText.value === '') {
        return proposals.value;
    }

    return proposals.value.filter((x) => x.name.includes(searchText.value) || x.proposer.includes(searchText.value));
});

const convertPubK1 = (obj: any) => {
    for (let key in obj) {
        let field = obj[key];
        if (typeof field === 'string') {
            if (field.startsWith('PUB_K1_')) {
                try {
                    let pubkey = PublicKey.from(field);
                    obj[key] = pubkey.toLegacyString();
                } catch (e) {
                    // failed to convert, ignore
                }
            }
        } else if (typeof field === 'object') {
            convertPubK1(field);
        }
    }
}

const reviewProposal = async (proposal: I.Proposal) => {
    previewData.value = proposal;
    contractHashes.value = [];

    for (let p of previewData.value.readable.actions) {
        if (p.account === 'eosio' && p.name === 'setcode') {
            contractHashes.value.push({
                contract: p.data.account,
                isAbi: false,
                hash: crypto.createHash('sha256').update(p.data.code, 'hex').digest('hex'),
            });
        }
        else if (p.account === 'eosio' && p.name === 'setabi') {
            contractHashes.value.push({
                contract: p.data.account,
                isAbi: true,
                hash: crypto.createHash('sha256').update(p.data.abi, 'hex').digest('hex'),
            });
        }
    }

    convertPubK1(proposal);
}

const canCancel = (proposal: I.Proposal) => {
    if (proposal.proposer === props.state.accountName) return true;
    let proposalDate = new Date(proposal.readable.expiration + 'Z');
    if (proposal.readable && proposal.readable.expiration) {
        if (Date.now() > proposalDate.getTime()) return true;
    }
    return false;
}

const handleApprove = (proposal: I.Proposal) => {
    const approveAction = [
        {
            contract: 'eosio.msig',
            action: 'approve',
            authorization: [
                {
                    actor: props.state.accountName,
                    permission: props.state.accountPerm ? props.state.accountPerm : 'active',
                },
            ],
            data: {
                proposer: proposal.proposer,
                proposal_name: proposal.name,
                level: {
                    actor: props.state.accountName,
                    permission: props.state.accountPerm ? props.state.accountPerm : 'active',
                },
                // TODO: Computing the hash isn't working, need to figure this out.
                // proposal_hash:ecc.sha256(Buffer.from(proposal.packed_transaction)),
            },
        },
    ];

    emits('transact', approveAction);
};

const handleExecute = (proposal: I.Proposal) => {
    const executeAction = [
        {
            contract: 'eosio.msig',
            action: 'exec',
            authorization: [
                {
                    actor: props.state.accountName,
                    permission: props.state.accountPerm ? props.state.accountPerm : 'active',
                },
            ],
            data: {
                proposer: proposal.proposer,
                proposal_name: proposal.name,
                executer: props.state.accountName,
            },
        },
    ];

    emits('transact', executeAction);
};

const handleUnapprove = (proposal: I.Proposal) => {
    const unapproveAction = [
        {
            contract: 'eosio.msig',
            action: 'unapprove',
            authorization: [
                {
                    actor: props.state.accountName,
                    permission: props.state.accountPerm ? props.state.accountPerm : 'active',
                },
            ],
            data: {
                proposer: proposal.proposer,
                proposal_name: proposal.name,
                level: {
                    actor: props.state.accountName,
                    permission: props.state.accountPerm ? props.state.accountPerm : 'active',
                },
            },
        },
    ];

    emits('transact', unapproveAction);
};

const handleCancel = (proposal: I.Proposal) => {
    const cancelAction = [
        {
            contract: 'eosio.msig',
            action: 'cancel',
            authorization: [
                {
                    actor: props.state.accountName,
                    permission: props.state.accountPerm ? props.state.accountPerm : 'active',
                },
            ],
            data: {
                proposer: proposal.proposer,
                proposal_name: proposal.name,
                canceler: props.state.accountName,
            },
        },
    ];

    emits('transact', cancelAction);
};

// Listens to any changes in the AuthState from parent component (App.vue);
// Will trigger when a user logs in
watch(
    () => props.state,
    (currentValue, oldValue) => {
        console.log('Watch props.state function called with args:', oldValue.accountName, currentValue.accountName);
        if (currentValue.accountName) {
            getProposals();
        }
    },
    {
        deep: true,
    }
);

onMounted(async () => {
    // Only get proposals after user logs in
    if (props.state.accountName) {
        getProposals();
    }
});
</script>
