<script setup lang="ts">
import { ref, onMounted, reactive } from 'vue';
import * as UltraAPI from '@ultraos/ultra-api-lib';
import * as I from '../../../interfaces/index';

import { useRoute } from 'vue-router/auto';
import { BlockchainService } from '../../../utilities/blockchain';

const route = useRoute('/search/table/');
const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();

const data = reactive({
    account: '',
    table: '',
    scope: '',
    lower_bound: '',
    upper_bound: '',
});

const loading = ref<boolean>(false);
const queryResult = ref();
const queryResultRaw = ref<{ rows: Object[]; next_key?: string }>(undefined);

function clear() {
    (data.account = ''),
        (data.table = ''),
        (data.scope = ''),
        (data.lower_bound = ''),
        (data.upper_bound = ''),
        (queryResult.value = undefined);
}

async function searchTable(lower_bound = null) {
    loading.value = true;

    if (lower_bound) {
        data.lower_bound = lower_bound;
    }

    for (let key of Object.keys(data)) {
        if (key === 'lower_bound' || key === 'upper_bound') {
            continue;
        }

        if (data[key] === '') {
            loading.value = false;
            return;
        }
    }

    const api = await UltraAPI.connect(props.state.endpoint);
    if (!api) {
        loading.value = false;
        return;
    }

    try {
        queryResultRaw.value = await BlockchainService.roundRobinRequest(async () => await api
            .contract(data.account)
            .getTableLimited(data.table, data.scope, data.lower_bound, data.upper_bound, 10));
        queryResult.value = JSON.stringify(queryResultRaw.value);
    } catch (err) {}

    loading.value = false;
}
</script>

<template>
    <div class="flex flex-col gap-4">
        <div class="text-2xl font-bold">Search Table</div>
        <div>
            When searching large tables please use lower_bound and upper_bound to limit the amount of table entries
            returned.
        </div>
        <div class="flex flex-row gap-2">
            <input
                v-model="data.account"
                placeholder="Account Name"
                @keyup.enter="searchTable"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
            />
            <input
                v-model="data.table"
                placeholder="Table Name"
                @keyup.enter="searchTable"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
            />
            <input
                v-model="data.scope"
                placeholder="Scope Name"
                @keyup.enter="searchTable"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
            />
            <Button @click="() => searchTable()">
                <Icon icon="fa-check" />
            </Button>
            <Button @click="clear">
                <Icon icon="fa-trash" />
            </Button>
        </div>
        <Expand title="Additional Options">
            <div class="flex flex-col p-4 border rounded border-neutral-700">
                <div class="flex flex-row h-12 gap-2">
                    <input
                        v-model="data.lower_bound"
                        placeholder="Lower Bound"
                        @keyup.enter="searchTable"
                        class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                    />
                    <input
                        v-model="data.upper_bound"
                        placeholder="Upper Bound"
                        @keyup.enter="searchTable"
                        class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                    />
                </div>
            </div>
        </Expand>
        <div class="flex flex-col gap-4" v-if="queryResult">
            <div class="text-2xl font-bold">Results</div>
            <div class="flex flex-col">
                <LoadingSpinner v-if="loading" />
                <div v-if="queryResult && !loading" class="flex flex-col">
                    <Code :code="queryResult" />
                </div>
            </div>
            <Button
                v-if="queryResultRaw && queryResultRaw.next_key"
                @click="() => searchTable(queryResultRaw.next_key)"
            >
                Next Page
            </Button>
        </div>
    </div>
</template>
