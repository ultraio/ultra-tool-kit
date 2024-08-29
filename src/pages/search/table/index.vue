
<template>
    <div class="flex flex-col gap-4">
        <div class="text-2xl font-bold">Search Table</div>
        <div class="flex flex-row gap-2">
            <input
                v-model="data.account"
                placeholder="Account Name"
                @keyup.enter="fetchContract"
                v-on:blur="fetchContract"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
            />
            <Button @click="clear">
                <Icon icon="fa-trash" />
            </Button>
        </div>
        <div class="flex flex-row gap-4">
            <template v-for="name in quickAdds">
                <Button
                    @click="setContract(name)"
                    class="flex flex-row gap-4 items-center justify-center"
                >
                    <span>{{ name }}</span>
                </Button>
            </template>
        </div>
        <div class="flex flex-row gap-2">
            <input
                v-model="data.table"
                placeholder="Table Name"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
            />
            <select
                class="flex-row gap-2 p-4 bg-neutral-950 rounded focus:outline-none border border-neutral-700 w-full"
                v-if="currentAbi" single
                v-model="data.table"
            >
                <template v-for="table in currentAbi.tables">
                    <option>{{ table.name }}</option>
                </template>
            </select>
            <Button
                v-if="currentAbi && data.table && tableScopes.dataTable.rows.length === 0"
                @onClick="fetchScopesInit"
                class="w-full mt-6"
            >
                Search scopes
            </Button>
        </div>
        <LoadingSpinner v-if="loading" />
        <div class="flex flex-row gap-2">
            <input
                v-model="scopeSearch"
                placeholder="Scope Name"
                class="flex flex-row gap-2 flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
            />
            <Button
                @onClick="searchTable(scopeSearch)"
                class="w-full mt-6"
            >
                Search
            </Button>
        </div>
        <EasyDataTable
            v-if="tableScopes.dataTable.rows.length > 0"
            table-class-name="datatable-table"
            :headers="tableScopes.dataTable.headers"
            :items="tableScopes.dataTable.rows"
            multi-sort
            :rows-items="['10', '25', '50', '100']"
            :rows-per-page="10"
            :search-field="scopeSearchField"
            :search-value="scopeSearch"
            buttons-pagination
            :theme-color="'rgb(169 132 232 / var(--tw-text-opacity))'"
        >
            <template #item-scope="{ scope }">
                {{ scope === '' ? '<empty>' : scope }}
            </template>
            <template #item-action="{ scope }">
                <Button
                    @onClick="searchTable(scope)"
                >
                    Search
                </Button>
            </template>
            <template #empty-message>
                <p>No Scopes found</p>
            </template>
        </EasyDataTable>
        <div v-if="tableScopes.dataTable.rows.length > 0" class="flex flex-row gap-2">
            <Button
                :disabled="!moreScopesToLoad"
                @onClick="loadAllScopes(100)"
                class="w-full mt-6"
            >
                Load 100 scopes
            </Button>
            <!-- <Button
                :disabled="!moreScopesToLoad"
                @onClick="loadAllScopes"
                class="w-full mt-6"
            >
                Load all scopes
            </Button> -->
        </div>
        <Expand title="Additional Options">
            <div class="flex flex-col p-4 border rounded border-neutral-700">
                <div class="flex flex-row h-12 gap-2">
                    <input
                        v-model="data.lower_bound"
                        placeholder="Lower Bound"
                        class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                    />
                    <input
                        v-model="data.upper_bound"
                        placeholder="Upper Bound"
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
                @click="() => searchTable(data.scope, queryResultRaw.next_key)"
            >
                Next Page
            </Button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, reactive } from 'vue';
import * as UltraAPI from '@ultraos/ultra-api-lib';
import * as I from '../../../interfaces/index';
import { SharedEmits } from '../../../interfaces/index';

import { useRoute } from 'vue-router/auto';
import { BlockchainService } from '../../../utilities/blockchain';
import { ABI } from '../../../utilities/abi';
import { routePageEnvironment } from '../../../utilities/networks';

const route = useRoute('/search/table/');
const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();

const data = reactive({
    account: '',
    table: '',
    scope: '',
    lower_bound: '',
    upper_bound: '',
});

const quickAdds = ref<string[]>(['eosio', 'eosio.token', 'eosio.nft.ft', 'eosio.group', 'ultra.avatar', 'ultra.tools']);
const currentAbiAccount = ref<string>();
const currentAbi = ref<ABI>();

const tableScopesMore = ref<string>();
const tableScopes = ref<I.DataTableType>({
    dataTable: {
        headers: [
            { text: 'Scope', value: 'scope', sortable: true },
            { text: 'Count', value: 'count', sortable: true },
            { text: 'Action', value: 'action'}
        ],
        rows: [],
    },
});
const scopeSearchField = ref("scope");
const scopeSearch = ref<string>();
const scopesPerRequest = ref<number>(100);
const moreScopesToLoad = ref<boolean>(true);

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
    
    currentAbiAccount.value = null;
    currentAbi.value = null;

    scopeSearch.value = '';
    tableScopes.value.dataTable.rows = [];

    moreScopesToLoad.value = true;
}

interface TableEmits extends SharedEmits {
}

const emits = defineEmits<TableEmits>();

async function parseQueryParams() {
    routePageEnvironment(emits, route);

    if (route.query.code) {
        data.account = <string>route.query.code;
        await fetchContract();
    }
    if (route.query.scope) {
        data.scope = <string>route.query.scope;
        scopeSearch.value = <string>route.query.scope;
    }
    if (route.query.table) {
        data.table = <string>route.query.table;
    }

    // If all 3 required fields were set - perform the search automatically
    if (route.query.code && route.query.scope && route.query.table) {
        await searchTable(data.scope);
    }
}

async function searchTable(scope: string, lower_bound = null) {
    data.scope = scope;

    window.history.pushState('table', '', `${route.path}?env=${BlockchainService.environment}&code=${data.account}&scope=${data.scope}&table=${data.table}`);

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

    try {
        queryResultRaw.value = await BlockchainService.getTableData(data.account, data.scope, data.table, data.lower_bound, data.upper_bound);
        queryResult.value = JSON.stringify(queryResultRaw.value);
    } catch (err) {}

    loading.value = false;
}

async function setContract(name: string) {
    data.account = name;
    fetchContract();
}

async function fetchContract() {
    // Preserve the contract that we want to search
    let contract = data.account;
    clear();
    data.account = contract;
    if (!data.account || data.account.length === 0) {
        return;
    }
    console.log(data.account);

    currentAbiAccount.value = null;
    currentAbi.value = null;

    let abi = await BlockchainService.getAbi(data.account, false);
    if (abi) {
        currentAbiAccount.value = data.account;
        currentAbi.value = abi.ABI;
    }
}

async function loadAllScopes(count: number = -1) {
    let loaded = 0;
    while (moreScopesToLoad.value) {
        const countBefore = tableScopes.value.dataTable.rows.length;
        await fetchScopes(false);
        loaded += tableScopes.value.dataTable.rows.length - countBefore;
        if (count > 0 && loaded >= count) break;
    }
}

async function fetchScopesInit() {
    await fetchScopes(true);
}

async function fetchScopes(clear: boolean) {
    if (!currentAbi.value.tables.find(t => t.name === data.table)) return;

    loading.value = true;
    if (clear) {
        tableScopes.value.dataTable.rows = [];
    }

    let lower_bound = clear ? undefined : tableScopesMore.value;
    let scopes = await BlockchainService.getTableByScope(data.account, data.table, scopesPerRequest.value, lower_bound);
    // Fetch until we reach the slice of desired data or reach the end of the contract
    while(scopes.rows.length === 0) {
        if (!scopes.more || scopes.more === '') {
            moreScopesToLoad.value = false;
        }
        lower_bound = scopes.more;
        scopes = await BlockchainService.getTableByScope(data.account, data.table, scopesPerRequest.value, lower_bound);
    }
    
    // Result with contract scope is sometimes not returned because it is deeper in the scope list
    // Need to fetch it manually and append to the list of results
    const contractScope = clear ? await BlockchainService.getTableByScope(data.account, data.table, 1, data.account) : null;
    // Make sure that the result for the contract scope is actually for the contract
    if (contractScope && contractScope.rows.length === 1 && contractScope.rows[0].scope === data.account) {
        if (!scopes.rows.find((s) => s.scope === data.account) &&
            !tableScopes.value.dataTable.rows.find((s) => s.scope === data.account)) {
            scopes.rows.push(contractScope.rows[0]);
        }
    }

    // Concatenate and delete duplicates
    tableScopes.value.dataTable.rows = tableScopes.value.dataTable.rows.concat(scopes.rows).filter((value, index, self) =>
        index === self.findIndex((t) => (
            t.scope === value.scope
        ))
    )

    let resultsCountBefore = tableScopes.value.dataTable.rows.length;
    if (!scopes.more || scopes.more === '') {
        //moreScopesToLoad.value = false;
    }
    tableScopesMore.value = scopes.more;
    loading.value = false;
}

onMounted(() => {
    parseQueryParams();
});
</script>
