<template>
    <div class="text-3xl font-bold">UOS Mass Transfer</div>
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
                        <br />
                        <br />
                            Your CSV file must be formatted like below, make sure you have the first row with the
                            header. Duplicate receiver accounts are allowed.
                    </span>
                </div>
                <div class="grid gap-px grid-rows-1">
                    <pre>
<b>account,quantity</b>
ab1bc2cd3de4,100.0
ab1bc2cd3de4,150.05
bb1cc2dd3ee4,420
</pre>
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
                        <LabelWithTooltip label="Memo" />
                        <div class="flex flex-row h-12 gap-4">
                            <input
                                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                                v-model="memo"
                                placeholder="string"
                            />
                        </div>
                        Select CSV File <input type="file" @change="onFileSelected($event)" accept=".csv" capture />
                    </div>
                    <div class="grid gap-4 py-4">
                        <span></span>
                        <Button :disabled="userActions.length == 0" @onClick="emits('transact', userActions)">{{
                            userActions.length ? `Make ${userActions.length} UOS transfers (total ${totalUosTransferred} UOS)` : 'Transfer'
                        }}</Button>
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
import { useRoute } from 'vue-router/auto';
import * as I from '../../interfaces/index';
import LoadingSpinner from '../../components/widgets/LoadingSpinner.vue';
import Papa from 'papaparse';

const route = useRoute('/uosMassTransfer/');
const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();

const authorizer = ref<string>();
const permission = ref<string>();
const memo = ref<string>('');
const file = ref<string>('');
const isFileParsed = ref<boolean>(false);
const loading = ref<boolean>(false);
const dataRows = ref<any[]>([]);
const userActions = ref<I.Action[]>([]);
const totalUosTransferred = ref<number>(0);
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
        complete: function (results) {
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

const generateActions = () => {
    totalUosTransferred.value = 0;
    userActions.value = dataRows.value.map((row) => {
        let quantity = parseFloat(row.quantity)
        totalUosTransferred.value += quantity;
        return {
            contract: 'eosio.token',
            action: 'transfer',
            authorization: [
                {
                    actor: authorizer.value,
                    permission: permission.value,
                },
            ],
            data: {
                from: authorizer.value,
                to: row.account,
                quantity: `${quantity.toFixed(8)} UOS`,
                memo: memo.value,
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

onMounted(async () => {});
</script>
