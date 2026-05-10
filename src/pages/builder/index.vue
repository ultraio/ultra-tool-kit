<template>
    <div class="flex flex-col flex-grow w-full gap-4 text-sm">
        <div class="text-3xl font-bold">Transaction Builder</div>
        <div>Add all the contract accounts you want to use, before building a transaction.</div>

        <!-- AI handoff status banner -->
        <div
            v-if="aiHandoffStatus"
            class="rounded border px-3 py-2 text-xs"
            :class="
                aiHandoffStatus.kind === 'error'
                    ? 'border-red-700 bg-red-900/30 text-red-200'
                    : 'border-purple-700 bg-purple-900/20 text-purple-200'
            "
            data-testid="ai-handoff-banner"
        >
            {{ aiHandoffStatus.message }}
        </div>

        <!-- Quick Add -->
        <div class="text-2xl font-bold mt-4">Add Contract Accounts</div>
        <div class="flex flex-col">
            <div class="flex flex-row gap-4 mb-4">
                <input
                    placeholder="Contract account name"
                    v-model="contractNameInput"
                    @keyup.enter="addContract(undefined)"
                    class="bg-neutral-950 rounded flex-grow text-neutral-200 pl-4 pr-4 focus:outline-none"
                />
                <Button @click="addContract(undefined)">Add Contract Account</Button>
            </div>
            <div class="flex flex-row gap-4">
                <template v-for="name in quickAdds">
                    <Button
                        @click="addContract(name)"
                        v-if="!accounts.find((acc) => acc.account === name)"
                        class="flex flex-row gap-4 items-center justify-center"
                    >
                        <span>{{ name }}</span>
                    </Button>
                </template>
            </div>
        </div>

        <!-- Actions -->
        <template v-if="accounts.length >= 1">
            <div class="text-2xl font-bold mt-4">Added Contract Accounts</div>
            <div class="flex flex-row gap-4">
                <Button
                    v-for="(account, index) in accounts"
                    @click="removeByIndex(index)"
                    class="flex flex-row gap-4 items-center justify-center"
                >
                    <span>{{ account.account }} {{ (account.status === 'found') ? '' : (account.status === 'not found') ? '(not found)' : '(loading)' }}</span>
                    <Icon icon="fa-close" />
                </Button>
            </div>
            <AbiRender
                :key="inputCount"
                :accounts="accounts"
                :state="props.state"
                :metadata="props.metadata"
                @transact="(actions) => emits('transact', actions)"
            />
        </template>
    </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router/auto';
import * as I from '../../interfaces/index';
import { BlockchainService } from '../../utilities/blockchain';
import { aiHandoff } from '../../composables/useAiChat';
import { emitter } from '../../eventBus';

const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();

const route = useRoute();
const accounts = ref<I.TransactionBuilderContract[]>([]);
const contractNameInput = ref<string>('');

const inputCount = ref<number>(0);

const quickAdds = ref<string[]>(['eosio', 'eosio.token', 'eosio.nft.ft', 'eosio.group', 'ultra.avatar', 'ultra.tools']);

const aiHandoffStatus = ref<{ kind: 'pending' | 'ready' | 'error'; message: string } | null>(null);

async function addContract(name: string) {
    if (name) {
        accounts.value.push({account: name, status: 'loading'});
        await update();
        return;
    }

    if (contractNameInput.value === '') {
        return;
    }

    accounts.value.push({account: contractNameInput.value, status: 'loading'});
    contractNameInput.value = '';
    await update();
}

async function removeByIndex(index: number) {
    accounts.value.splice(index, 1);
    await update();
}

async function update() {
    await validateAccounts();
    inputCount.value += 1;
    localStorage.setItem('transactionBuilderState', JSON.stringify(accounts.value));
}

async function validateAccounts() {
    for (let acc of accounts.value) {
        if (acc.status === 'not found') continue;
        let found: boolean = false;
        try {
            let abi = await BlockchainService.getAbi(acc.account, true);
            // ABI exists, mark as found
            if (abi) found = true;
        } catch (e) {
            console.log(e);
        }
        acc.status = found ? 'found' : 'not found';
    }
}

async function processAiHandoff() {
    if (route.query.ai !== 'pending') return;
    const handoff = aiHandoff.value;
    if (!handoff) return;

    aiHandoff.value = null;
    aiHandoffStatus.value = {
        kind: 'pending',
        message: `Loading ${handoff.contract} for the AI proposal…`,
    };

    if (!accounts.value.find((acc) => acc.account === handoff.contract)) {
        await addContract(handoff.contract);
    } else {
        await update();
    }

    const stop = watch(
        accounts,
        (list) => {
            const entry = list.find((acc) => acc.account === handoff.contract);
            if (!entry) return;
            if (entry.status === 'found') {
                emitter.emit('aiAddAction', {
                    contract: handoff.contract,
                    action: handoff.action,
                    data: handoff.data,
                    authorization: [handoff.authorization],
                });
                aiHandoffStatus.value = {
                    kind: 'ready',
                    message: `AI proposal queued: ${handoff.contract}::${handoff.action}. Click "Review 1 Action(s)" to send.`,
                };
                stop();
            } else if (entry.status === 'not found') {
                aiHandoffStatus.value = {
                    kind: 'error',
                    message: `Contract ${handoff.contract} was not found on this endpoint.`,
                };
                stop();
            }
        },
        { deep: true, immediate: true }
    );
}

onMounted(async () => {
    const jsonData = localStorage.getItem('transactionBuilderState');
    if (jsonData) {
        try {
            const data = JSON.parse(jsonData);
            if (!Array.isArray(data)) {
                localStorage.setItem('transactionBuilderState', JSON.stringify([]));
            } else {
                accounts.value = data;
                for (let acc of accounts.value) acc.status = 'loading';
                await validateAccounts();
                inputCount.value += 1;
            }
        } catch (err) {}
    }

    await processAiHandoff();
});
</script>
