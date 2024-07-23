<template>
    <div class="flex flex-col flex-grow w-full gap-4 text-sm">
        <div class="text-3xl font-bold">Transaction Builder</div>
        <div>Add all the contract accounts you want to use, before building a transaction.</div>

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
import { onMounted, ref } from 'vue';
import * as I from '../../interfaces/index';
import { BlockchainService } from '../../utilities/blockchain';

const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();

const accounts = ref<I.TransactionBuilderContract[]>([]);
const contractNameInput = ref<string>('');

const inputCount = ref<number>(0);

const quickAdds = ref<string[]>(['eosio', 'eosio.token', 'eosio.nft.ft', 'eosio.group', 'ultra.avatar', 'ultra.tools']);

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
            let abi = await BlockchainService.getAbi(acc.account, false);
            // ABI exists, mark as found
            if (abi) found = true;
        } catch (e) {
            console.log(e);
        }
        acc.status = found ? 'found' : 'not found';
    }
}

onMounted(async () => {
    const jsonData = localStorage.getItem('transactionBuilderState');
    if (!jsonData) {
        return;
    }

    try {
        const data = JSON.parse(jsonData);
        if (!Array.isArray(data)) {
            localStorage.setItem('transactionBuilderState', JSON.stringify([]));
        }

        accounts.value = data;
        for (let acc of accounts.value) acc.status = 'loading';
        await validateAccounts();
        inputCount.value += 1;
    } catch (err) {}
});
</script>
