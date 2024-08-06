<template>
    <div class="text-3xl font-bold">Bulk Factory Creation</div>
    <br />
    <div class="grid gap-4 grid-cols-1">
        <div v-if="!refreshDefaultInput()">
            <span>You are not currently logged in, please log in to view this page.</span>
        </div>
        <template v-else>
            <div class="grid gap-4 grid-cols-1 text-md p-2 border rounded-md px-4 bg-neutral-700 border-neutral-600">
                <div class="grid gap-px grid-rows-1">
                    <span class="[font-family:'Inter-Regular',Helvetica] text-[#f9d198]">
                        <b>Input Format</b>
                    </span>
                    <br />
                    <p>
                        Please ensure your CSV file is formatted as specified below. The first row should contain column headers,
                        and each subsequent row should include the corresponding data for a Uniq Factory. All fields are required
                        unless otherwise specified.
                    </p>
                </div>
                <div class="grid gap-px grid-rows-1 mb-2">
                    <p>For a detailed example, download the template: <a href="/resources/bulk-factories.csv" target="_blank">bulk-factories.csv</a>
                    </p>
                </div>
            </div>

            <div class="grid gap-4 grid-cols-1 text-md p-2 border rounded-md px-5 border-neutral-700">
                <div class="grid gap-px grid-rows-1"></div>
                <div class="grid grid-rows-1 gap-4">
                    <div class="grid grid-cols-2 gap-4">
                        <LabelWithTooltip label="Authorizer" />
                        <div class="flex flex-row h-12 gap-4">
                            <input
                                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                                v-model="authorizer"
                                placeholder="name"
                            />
                        </div>
                        <LabelWithTooltip label="Permission" />
                        <div class="flex flex-row h-12 gap-4">
                            <input
                                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                                v-model="permission"
                                placeholder="name"
                            />
                        </div>
                        Select CSV File <input type="file" @change="onFileSelected($event)" accept=".csv" capture />
                    </div>
                    <div class="grid grid-cols-3 gap-4 py-4">
                        <span></span>
                        <Button :disabled="userActions.length == 0" @onClick="emits('transact', userActions)">{{
                                userActions.length ? `Create ${dataRows.length} Factories` : 'Create Factory'
                            }}
                        </Button>
                    </div>
                </div>
            </div>
            <LoadingSpinner v-if="loading"></LoadingSpinner>
        </template>
    </div>

    <!-- Error Modal -->
    <ErrorModal
        :title="errorType == 'parse' ? 'CSV Parsing Error' : 'Transaction Error'"
        :errorMessage="`${errorMessage}`"
        v-if="errorMessage"
        @close="clearErrorMessage"
    ></ErrorModal>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import * as I from '../../interfaces/index';
import LoadingSpinner from '../../components/widgets/LoadingSpinner.vue';
import Papa from 'papaparse';

const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();

const authorizer = ref<string>();
const permission = ref<string>();
const file = ref<string>('');
const isFileParsed = ref<boolean>(false);
const loading = ref<boolean>(false);
const dataRows = ref<any[]>([]);
const userActions = ref<I.Action[]>([]);
const errorMessage = ref<string>('');
const errorType = ref<'parse' | 'transact'>();

function clearErrorMessage() {
    errorMessage.value = '';
    errorType.value = undefined;
}

const resetData = () => {
    file.value = '';
    isFileParsed.value = false;
    loading.value = false;
    dataRows.value = [];
    userActions.value = [];
    clearErrorMessage();
};

const onFileSelected = (event: any) => {
    resetData();

    file.value = event.target.files[0];
    if (file.value) {
        loading.value = true;
        isFileParsed.value = false;
        parseFile();
    }
};

const parseFile = async () => {
    Papa.parse(file.value, {
        header: true,
        skipEmptyLines: true,
        complete: function(results) {
            if (results.errors) {
                errorType.value = 'parse';
                errorMessage.value = results.errors
                    .slice(0, 100)
                    .map((x) => `${x.message} at row ${x.row}`)
                    .join('<br>');
            }

            dataRows.value = results.data;
            generateActions();
            isFileParsed.value = true;
            loading.value = false;
        },
    });
};

const parseArrayField = (prefix: string, count: number, row: any, parseFn: (field: string) => any) => {
    const array = [];
    for (let i = 1; i <= count; i++) {
        const field = row[`${prefix}${i}`];
        if (field) {
            array.push(parseFn(field));
        }
    }
    return array;
};

const mapAuthorizedMinters = (row: any) => parseArrayField('authorized_minters_', 5, row, field => {
    const [authorized_minter, quantity] = field.split(':');
    return { authorized_minter, quantity: parseInt(quantity) };
});

const mapConditionlessReceivers = (row: any) => parseArrayField('conditionless_receivers_', 5, row, field => field);

const mapResalesShares = (row: any) => parseArrayField('resale_shares_', 5, row, field => {
    const [receiver, basis_point] = field.split(':');
    return { receiver, basis_point: parseInt(basis_point) };
});

const mapTimePointSec = (field: string | undefined) => {
    if (!field || field === '') {
        return null;
    }
    return field;
};

const generateActions = () => {
    userActions.value = dataRows.value.map((row) => {
        return {
            contract: 'eosio.nft.ft',
            action: 'create.b',
            authorization: [
                {
                    actor: authorizer.value,
                    permission: permission.value,
                },
            ],
            data: {
                create: {
                    account_minting_limit: row.account_minting_limit || null,
                    asset_creator: row.asset_creator,
                    asset_manager: row.asset_manager,
                    authorized_minters: mapAuthorizedMinters(row),
                    conditionless_receivers: mapConditionlessReceivers(row),
                    default_token_uri: row.default_token_uri,
                    default_token_hash: row.default_token_hash,
                    factory_hash: row.factory_hash,
                    factory_uri: row.factory_uri,
                    lock_hash: row.lock_hash ? row.lock_hash === 'true' : null,
                    lockup_time: row.lockup_time || null,
                    max_mintable_tokens: row.max_mintable_tokens || null,
                    maximum_uos_payment: row.maximum_uos_payment || null,
                    memo: row.memo || '',
                    minimum_resell_price: row.minimum_resell_price || null,
                    mintable_window_end: mapTimePointSec(row.mintable_window_end),
                    mintable_window_start: mapTimePointSec(row.mintable_window_start),
                    recall_window_end: mapTimePointSec(row.recall_window_end),
                    recall_window_start: mapTimePointSec(row.recall_window_start),
                    resale_shares: mapResalesShares(row),
                    stat: row.stat,
                    trading_window_end: mapTimePointSec(row.trading_window_end),
                    trading_window_start: mapTimePointSec(row.trading_window_start),
                    transfer_window_end: mapTimePointSec(row.transfer_window_end),
                    transfer_window_start: mapTimePointSec(row.transfer_window_start),
                },
            },
        };
    });
};

const refreshDefaultInput = () => {
    if (props.state.accountName) {
        if (!authorizer.value || authorizer.value.length === 0) {
            if (I.ELEVATED_ACCOUNTS.includes(props.state.accountName)) {
                authorizer.value = 'ultra.mrktng';
                permission.value = 'team';
            } else {
                authorizer.value = props.state.accountName;
                permission.value = 'active';
            }
        }
        return true;
    }
    return false;
};

onMounted(async () => {
});
</script>
