
<template>
    <div class="flex flex-col gap-4">
        <div class="text-2xl font-bold">Search Table</div>
        <div class="flex flex-row gap-2">
            <input
                v-model="data.account"
                placeholder="Contract Account Name"
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
                v-on:input="clearScopeSearch"
                placeholder="Table Name"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4 h-12"
            />
            <select
                class="flex-row gap-2 bg-neutral-950 rounded focus:outline-none border border-neutral-700 w-full h-12 px-4"
                v-if="currentAbi" single
                v-model="data.table"
                v-on:change="clearScopeSearch"
            >
                <template v-for="table in currentAbi.tables">
                    <option>{{ table.name }}</option>
                </template>
            </select>
            <Button
                v-if="currentAbi && data.table && tableScopes.dataTable.rows.length === 0 && !tableScopes.notFound"
                @onClick="fetchScopesInit"
                class="w-full"
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
            >
                Search by scope name
            </Button>
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
        <EasyDataTable
            v-if="tableScopes.dataTable.rows.length > 0 || tableScopes.notFound"
            table-class-name="datatable-table"
            :headers="tableScopes.dataTable.headers"
            :items="tableScopes.dataTable.rows"
            multi-sort
            :rows-items="[10, 25, 50, 100]"
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
        <div class="flex flex-col gap-4" v-if="queryResult">
            <div class="text-2xl font-bold">Results</div>
            <EasyDataTable
                table-class-name="datatable-table"
                :headers="queryResult.dataTable.headers"
                :items="queryResult.dataTable.rows"
                multi-sort
                :rows-items="[10, 25, 50, 100]"
                :rows-per-page="10"
                buttons-pagination
                :theme-color="'rgb(169 132 232 / var(--tw-text-opacity))'"
            >
                <template #empty-message>
                    <p>No Entries found</p>
                </template>
            </EasyDataTable>
            <Button
                v-if="moreResultsToLoad"
                @click="() => searchTable(data.scope, queryResultRaw.next_key)"
            >
                Load 100 results
            </Button>
            <Expand title="Raw response">
                <div class="flex flex-col">
                    <Code :code="queryResultJson" />
                </div>
            </Expand>
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
const tableScopes = ref<I.DataTableType & {notFound: boolean}>({
    dataTable: {
        headers: [
            { text: 'Scope', value: 'scope', sortable: true },
            { text: 'Count', value: 'count', sortable: true },
            { text: 'Action', value: 'action'}
        ],
        rows: [],
    },
    notFound: false
});
const scopeSearchField = ref("scope");
const scopeSearch = ref<string>();
const scopesPerRequest = ref<number>(100);
const moreScopesToLoad = ref<boolean>(true);

const loading = ref<boolean>(false);
const queryResultRaw = ref<{ rows: Object[]; next_key?: string }>(undefined);
const queryResultJson = ref<string>();
const queryResult = ref<I.DataTableType>(undefined);
const resultsPerRequest = ref<number>(100);
const moreResultsToLoad = ref<boolean>(true);

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
    moreResultsToLoad.value = true;
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
    if (route.query.lower_bound) {
        data.lower_bound = <string>(route.query.lower_bound);
    }
    if (route.query.upper_bound) {
        data.upper_bound = <string>(route.query.upper_bound);
    }

    // If 3 required fields were set - perform the search automatically
    if (route.query.code && route.query.scope && route.query.table) {
        await searchTable(data.scope);
    }
}

function populateResultHeaders() {
    let headers = [];

    for (let r of queryResultRaw.value.rows) {
        Object.keys(r).forEach((k) => {
            if (headers.find((h) => h.value === k)) return;
            headers.push({ text: k, value: k, sortable: true });
        });
    }

    let table = currentAbi.value.tables.find((t) => t.name === data.table);
    table.key_names.forEach((k) => {
        headers.push({ text: k, value: k, sortable: true });
    })

    queryResult.value = {
        dataTable: {
            headers: headers,
            rows: [],
        },
    }
}

async function searchTable(scope: string, lower_bound = null) {
    moreResultsToLoad.value = true;
    // Initialize empty scope
    // String with a space should be an equivalent to 0 or null
    // Otherwise ultra-api-lib will set it to account name
    if (!scope) {
        scope = ' ';
    }
    data.scope = scope;

    let state = `${route.path}?env=${BlockchainService.environment}&code=${data.account}&scope=${data.scope}&table=${data.table}`;
    if (data.lower_bound) state += `&lower_bound=${data.lower_bound}`;
    if (data.upper_bound) state += `&upper_bound=${data.upper_bound}`;
    window.history.pushState('table', '', state);

    loading.value = true;

    if (lower_bound) {
        data.lower_bound = lower_bound;
    }

    try {
        // if lower_bound is set, it means we want to load more data
        // otherwise - initialize new results array
        if (!lower_bound) {
            queryResultJson.value = '';
            queryResultRaw.value = undefined;
        }

        const response = await BlockchainService.getTableData(data.account, data.scope, data.table, data.lower_bound, data.upper_bound, resultsPerRequest.value);
        if (!queryResultRaw.value) queryResultRaw.value = response;
        else {
            queryResultRaw.value.next_key = response.next_key;
            queryResultRaw.value.rows = queryResultRaw.value.rows.concat(response.rows);
        }
        queryResultJson.value = JSON.stringify(queryResultRaw.value);

        if (!lower_bound) {
            // We can't easily know the possible rows of the table
            // The simplest solution is to figure it out based on the response
            populateResultHeaders();
        }

        // Convert any objects to strings so that they display properly
        for (let r of response.rows) {
            Object.keys(r).forEach((k) => {
                if (r[k] && typeof r[k] === 'object') {
                    r[k] = JSON.stringify(r[k]);
                }
            });
        }
        
        queryResult.value.dataTable.rows = queryResult.value.dataTable.rows.concat(response.rows);

        if (!response.next_key || queryResultRaw.value.rows.length < resultsPerRequest.value) {
            moreResultsToLoad.value = false;
        }

        // Automatically scroll to the list of results, otherwise it may not be obvious where the results are
        let content = document.getElementById('content');
        content.scrollTo(0, content.scrollHeight);
    } catch (err) {
        console.log(err);
    }

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

    currentAbiAccount.value = null;
    currentAbi.value = null;

    let abi = await BlockchainService.getAbi(data.account, false);
    if (abi) {
        currentAbiAccount.value = data.account;
        currentAbi.value = abi.ABI;
        if (currentAbi.value.tables.length > 0) data.table = currentAbi.value.tables[0].name;
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

async function clearScopeSearch() {
    tableScopes.value.dataTable.rows = [];
    tableScopes.value.notFound = false;
    queryResult.value = undefined;
}

async function fetchScopesInit() {
    // Clear scopeSearch so it won't filter the scopes table as soon as it loads
    scopeSearch.value = '';
    await fetchScopes(true);
}

async function fetchScopes(clear: boolean) {
    // Ensure that the table exists
    if (!currentAbi.value.tables.find(t => t.name === data.table)) return;

    loading.value = true;
    if (clear) {
        tableScopes.value.dataTable.rows = [];
    }

    // For initial load no lower bound is specified. When "Load more" button is pressed this argument will be used
    let lower_bound = clear ? undefined : tableScopesMore.value;
    let scopes = await BlockchainService.getTableByScope(data.account, data.table, scopesPerRequest.value, lower_bound);
    // Fetch until we reach the slice of desired data or reach the end of the contract
    while(scopes.rows.length === 0) {
        lower_bound = scopes.more;
        scopes = await BlockchainService.getTableByScope(data.account, data.table, scopesPerRequest.value, lower_bound);
        if (!scopes.more || scopes.more === '') {
            moreScopesToLoad.value = false;
            break;
        }
    }

    // Make sure an empty table is shown if no scopes are found
    if (scopes.rows.length === 0) tableScopes.value.notFound = true;
    
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

    if (!scopes.more || scopes.more === '') {
        moreScopesToLoad.value = false;
    }
    tableScopesMore.value = scopes.more;
    loading.value = false;
}

onMounted(() => {
    parseQueryParams();
});
</script>
