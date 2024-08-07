<template>
    <div class="flex flex-col">
        <!-- Action Manager Controls -->
        <div class="flex flex-col gap-4 flex-grow" v-if="userActions.length >= 1">
            <div class="text-xl font-bold mt-4">Actions</div>
            <div class="flex flex-row gap-4 flex-grow">
                <Button class="flex-grow" @click="startTransaction">
                    Review {{ userActions.length }} Action(s)
                </Button>
                <Button class="flex-grow" @click="clearTransaction"> Clear All Action(s) </Button>
            </div>
        </div>

        <!-- Search Field -->
        <div class="text-xl font-bold mt-4">Search Actions</div>
        <div class="flex flex-row gap-4 mt-4">
            <input
                placeholder="Search..."
                v-model="searchText"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
            />
            <Button
                class="flex flex-row items-center justify-center"
                :disabled="searchText == ''"
                @onClick="searchText = ''"
            >
                <Icon icon="fa-times" />
            </Button>
        </div>

        <!-- Actions -->
        <div class="flex flex-col gap-4 mt-4">
            <LoadingSpinner v-if="loading" />
            <Button class="flex flex-row" v-for="data in getContractActions" @click="actionFormData = data">
                {{ buildTitle(data) }}
            </Button>
        </div>

        <!-- Modals -->
        <!-- Action Form -->
        <Modal v-if="actionFormData" :title="buildTitle(actionFormData)" @close="actionFormData = undefined">
            <ActionForm
                @add-action="addAction"
                :account="actionFormData.account"
                :name="actionFormData.name"
                :abi="actionFormData.abi"
                :state="props.state"
                :userActions="userActions"
            />
        </Modal>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { AuthState } from '../interfaces';
import * as I from '../interfaces/index';
import { ABI } from '../utilities/abi';
import { BlockchainService } from '../utilities/blockchain';
import { emitter } from '../eventBus';

defineOptions({
    inheritAttrs: false,
});

const props = defineProps<{ state: AuthState; accounts: (I.TransactionBuilderContract | string)[]; actions?: string[], metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]) }>();

const loading = ref<boolean>(false);
const searchText = ref<string>('');
const userActions = ref<I.Action[]>([]);
const contractActions = ref<Array<I.AbiRenderAction>>([]);

const actionFormData = ref<I.AbiRenderAction>(undefined);

let lastRefreshEndTimestamp: number = 0;

function addAction(action: I.Action, submit = false) {
    userActions.value.push(action);
    actionFormData.value = undefined;

    localStorage.setItem('abiRenderState', JSON.stringify(userActions.value));

    if (!submit) {
        return;
    }

    emits('transact', userActions.value);
}

const handleUpdateAbiActions = (updatedActions) => {
    userActions.value = updatedActions;
    localStorage.setItem('abiRenderState', JSON.stringify(updatedActions));
};

function removeAction(index: number) {
    userActions.value.splice(index, 1);
    localStorage.setItem('abiRenderState', JSON.stringify(userActions.value));
}

function startTransaction() {
    emits('transact', userActions.value);
}

function clearTransaction() {
    userActions.value = [];
    localStorage.setItem('abiRenderState', JSON.stringify(userActions.value));
}

function parseAbi(account: string, abi: ABI) {
    const actions: { [action: string]: I.AbiRenderAction } = {};
    for (let abiStruct of abi.structs) {
        const actionIndex = abi.actions.findIndex((x) => x.type === abiStruct.name);
        if (actionIndex < 0) {
            continue;
        }

        actions[abi.actions[actionIndex].name] = {
            account: account,
            name: abi.actions[actionIndex].name,
            abi: abi,
        };
    }
    return actions;
}

const getContractActions = computed(() => {
    if (!searchText.value || searchText.value === '') {
        return contractActions.value;
    }

    return contractActions.value.filter(
        (x) => x.name.includes(searchText.value) || x.account.includes(searchText.value)
    );
});

function buildTitle(data: I.AbiRenderAction) {
    const type = data.abi.getActionType(data.name);
    if (type.metadata.friendlyName !== data.name)
        return `${type.metadata.friendlyName} (${data.account}::${data.name})`;
    return `${data.account}::${data.name}`;
}

onMounted(async () => {
    loading.value = true;

    emitter.on('updateAbiActions', handleUpdateAbiActions);

    const jsonData = localStorage.getItem('abiRenderState');
    if (jsonData) {
        try {
            const data = JSON.parse(jsonData);
            if (!Array.isArray(data)) {
                localStorage.setItem('abiRenderState', JSON.stringify([]));
            }

            userActions.value = data;
        } catch (err) {}
    }

    // If transaction was recently executed - check if it matches the current buffer and clear it
    if (
        props.metadata &&
        props.metadata.lastSignedTransactionTimestamp && props.metadata.lastSignedTransactionTimestamp > lastRefreshEndTimestamp &&
        props.metadata.lastSignedActions && props.metadata.lastSignedActions.length === userActions.value.length
        ) {
        let isSame = true;
        for (let i = 0; i < props.metadata.lastSignedActions.length; i++) {
            if (JSON.stringify(props.metadata.lastSignedActions[i]) !== JSON.stringify(userActions.value[i])) {
                isSame = false;
                break;
            }
        }

        // If transaction was executed successfully - remove it from the storage
        if (isSame) {
            clearTransaction();
        }
    }

    // Try to fetch contract ABIs
    for (let contract of props.accounts) {
        if (typeof(contract) === 'string') {
            contract = <I.TransactionBuilderContract>{account: contract, status: 'found'};
        }
        if (contract.status !== 'found') continue;
        try {
            let abi = await BlockchainService.getAbi(contract.account, true);
            const parsedAbi = parseAbi(contract.account, abi.ABI);

            let actions: Array<I.AbiRenderAction> = [];

            // Filters actions by name, if a list of action names are provided
            const abiKeys = Object.keys(parsedAbi);
            if (props.actions) {
                // If action list is provided then use the specified order
                props.actions.forEach((actionName) => {
                    if (!abiKeys.find((x) => x === actionName)) {
                        return;
                    }
                    actions.push(parsedAbi[actionName]);
                });
            } else {
                actions = Object.values(parsedAbi);
            }

            contractActions.value = contractActions.value.concat(actions);
        } catch (e) {
            console.error(e);
        }
    }
    loading.value = false;
    lastRefreshEndTimestamp = Date.now();
});

onUnmounted(async () => {
    emitter.off('updateAbiActions', handleUpdateAbiActions);
});
</script>
