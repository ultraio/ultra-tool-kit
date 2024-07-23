<template>
    <div class="flex flex-col gap-4">
        <div class="text-3xl font-bold">Uniq Explorer</div>
        <div>Start the search by entering the Uniq ID, or factory ID and serial number</div>
        <!-- Inputs start -->
        <div class="flex flex-col gap-4" v-if="!isSearchingByFactory">
            <div class="font-bold">Search by Uniq</div>
            <div class="flex flex-row gap-4">
                <input
                    v-model="uniqId"
                    placeholder="Uniq Identifier"
                    :min="0"
                    type="number"
                    @keyup.enter="searchByUniqID"
                    class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                />
                <Button :disabled="isNaN(Number(uniqId)) || isLoading" @onClick="searchByUniqID">
                    <div v-if="!isLoading">Search</div>
                    <Icon v-else icon="fa-spinner" spin />
                </Button>
            </div>
            <Button @onClick="isSearchingByFactory = !isSearchingByFactory"> Switch to Factory Search</Button>
        </div>
        <div class="flex flex-col gap-4" v-else>
            <div class="font-bold">Search by Factory ID & Serial Number</div>
            <div class="flex flex-row gap-4 h-12">
                <input
                    v-model="factoryId"
                    placeholder="Factory Identifier"
                    :min="0"
                    type="number"
                    @keyup.enter="searchByFactoryId"
                    class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                />
                <input
                    v-model="serialNum"
                    placeholder="Serial Number"
                    :min="0"
                    type="number"
                    @keyup.enter="searchByFactoryId"
                    class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                />
            </div>
            <Button :disabled="isNaN(Number(serialNum)) || isLoading" @onClick="searchByFactoryId">
                <div v-if="!isLoading">Search</div>
                <Icon v-else icon="fa-spinner" spin />
            </Button>
            <Button @onClick="isSearchingByFactory = !isSearchingByFactory"> Switch to Uniq ID Search </Button>
        </div>
        <!-- Inputs end -->

        <LoadingSpinner v-if="isLoading"></LoadingSpinner>

        <!-- Pre/Post search text -->
        <div v-if="!isLoading && searchStatus === 'failure'" class="flex flex-col justify-center items-center gap-4">
            <div>Sorry, there seems to be no results for your search</div>
            <Button @click="clearSearch"> Clear Search </Button>
        </div>

        <!-- Uniq Details -->
        <div v-if="!isLoading && !!uniqData" class="flex flex-col gap-4 mt-4">
            <div class="text-2xl font-bold">On Chain</div>
            <div
                class="flex flex-col bg-neutral-800 pl-4 pr-4 pt-4 pb-4 rounded border border-neutral-700 text-neutral-300 [&>*]:border-b [&>*]:border-neutral-600 [&>*]:pb-3 [&>*]:pt-3"
            >
                <div class="grid grid-cols-4 gap-4 items-center !pt-0">
                    <div class="col-span-1">Uniq ID</div>
                    <div class="col-span-3">{{ uniqData.id }}</div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Created On</div>
                    <div class="col-span-3">{{ uniqData.mintDate }}</div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Serial Number</div>
                    <div class="col-span-3">{{ uniqData.serialNumber }}</div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Owner</div>
                    <div class="col-span-3">
                        <a class="underline" target="_blank" :href="`/user?id=${uniqData.owner}`">{{
                            uniqData.owner
                        }}</a>
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Metadata URI</div>
                    <div class="col-span-3 truncate">
                        <a class="underline" target="_blank" :href="`${uniqData.metadata?.cachedSource?.uri}`">{{
                            formatIfNull(uniqData.metadata?.cachedSource?.uri)
                        }}</a>
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Metadata Hash</div>
                    <div class="col-span-3 truncate">
                        {{ formatIfNull(uniqData.metadata?.cachedSource?.integrity?.hash) }}
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Factory ID</div>
                    <div class="col-span-3">
                        <a class="underline" target="_blank" :href="`/uniqFactory?id=${uniqData.factory.id}`">{{
                            uniqData.factory.id
                        }}</a>
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center !border-b-0 !pb-0">
                    <div class="col-span-1">Explorer Link</div>
                    <div class="col-span-3">
                        <a class="underline" target="_blank" :href="`${route.path}?id=${uniqData.id}`">Link</a>
                    </div>
                </div>
            </div>

            <!-- Metadata Section -->
            <div class="text-2xl font-bold">Metadata</div>
            <div
                class="flex flex-col bg-neutral-800 pl-4 pr-4 pt-4 pb-4 rounded border border-neutral-700 text-neutral-300 [&>*]:border-b [&>*]:border-neutral-600 [&>*]:pb-3 [&>*]:pt-3"
            >
                <div class="grid grid-cols-4 gap-4 items-center !pt-0">
                    <div class="col-span-1">Type</div>
                    <div class="col-span-3">{{ uniqData.type }}</div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Name</div>
                    <div class="col-span-3">{{ formatIfNull(uniqData.metadata?.content?.name) }}</div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Subname</div>
                    <div class="col-span-3">{{ formatIfNull(uniqData.metadata?.content?.subName) }}</div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Description</div>
                    <div class="col-span-3">{{ formatIfNull(uniqData.metadata?.content?.description) }}</div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center !pb-0 !border-b-0">
                    <div class="col-span-1">Attributes</div>
                    <div class="col-span-3">
                        {{
                            uniqData.metadata.content?.attributes
                                ? `${uniqData.metadata.content.attributes.length} attributes`
                                : 'No attributes found'
                        }}
                    </div>
                </div>

                <div
                    v-if="uniqData.metadata.content?.attributes"
                    class="flex flex-col gap-4 bg-neutral-700 p-4 rounded"
                >
                    <div
                        class="grid grid-cols-4 gap-4 items-center"
                        v-for="atrb in uniqData.metadata.content?.attributes"
                    >
                        <div class="col-span-1">{{ atrb.key }}</div>
                        <div class="col-span-3">
                            Type: {{ atrb.value.type }} <br />
                            Description: {{ formatIfNull(atrb.value.description) }}
                        </div>
                    </div>
                </div>
            </div>

            <!-- Resale Section -->
            <template v-if="uniqData.resale">
                <div class="text-2xl font-bold">Purchase Options / Listing</div>
                <div
                    class="flex flex-col bg-neutral-800 pl-4 pr-4 pt-4 pb-4 rounded border border-neutral-700 text-neutral-300 [&>*]:border-b [&>*]:border-neutral-600 [&>*]:pb-3 [&>*]:pt-3"
                >
                    <div class="grid grid-cols-4 gap-4 items-center">
                        <div class="col-span-1">Second hand</div>
                    </div>
                    <div class="grid grid-cols-4 gap-4 items-center">
                        <div class="col-span-1">On Sale Date</div>
                        <div class="col-span-3">{{ uniqData.resale.onSaleDate }}</div>
                    </div>
                    <div class="grid grid-cols-4 gap-4 items-center">
                        <div class="col-span-1">Price</div>
                        <div class="col-span-3">
                            {{ uniqData.resale.price.amount }} {{ uniqData.resale.price.currency.code }}
                        </div>
                    </div>
                    <div v-if="uniqData.resale.promoterBasisPoints" class="grid grid-cols-4 gap-4 items-center">
                        <div class="col-span-1">Promoter Share</div>
                        <div class="col-span-3">
                            {{ uniqData.resale.promoterBasisPoints / 100 }}% ({{ uniqData.resale.promoterBasisPoints }})
                        </div>
                    </div>
                    <div v-if="uniqData.resale.shares" class="grid grid-cols-4 gap-4 items-center !border-b-0">
                        <div class="col-span-1">Resale Shares</div>
                    </div>
                    <div
                        v-if="uniqData.resale.shares"
                        class="grid grid-cols-4 gap-4 items-center !pt-0 !border-b-0"
                        v-for="share in uniqData.resale.shares"
                    >
                        <div class="col-span-1">
                            <a class="underline" target="_blank" :href="`/user?id=${share.receiver}`">
                                {{ share.receiver }}
                            </a>
                        </div>
                        <div class="col-span-3">{{ share.basisPoints / 100 }}% ({{ share.basisPoints }})</div>
                    </div>
                </div>
            </template>

            <!-- Buy Offers Section -->
            <br />
            <div class="flex flex-col gap-4">
                <div class="text-2xl font-bold">Received Offers</div>
                <Expand :expanded="true">
                    <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                        <EasyDataTable
                            table-class-name="datatable-table"
                            :headers="receivedOffers.dataTable.headers"
                            :items="receivedOffers.dataTable.rows"
                            multi-sort
                            :rows-items="['25', '50', '100']"
                            :rows-per-page="100"
                            buttons-pagination
                            :theme-color="'rgb(169 132 232 / var(--tw-text-opacity))'"
                        >
                            <template #item-uniqFactoryId="{ uniqFactoryId }">
                                <a
                                    v-if="uniqFactoryId != '-'"
                                    class="underline"
                                    :href="`/uniqFactory?id=${uniqFactoryId}`"
                                    target="_blank"
                                    >{{ uniqFactoryId }}
                                </a>
                                <span v-else>{{ uniqFactoryId }}</span>
                            </template>
                            <template #item-uniqId="{ uniqId }">
                                <a v-if="uniqId != '-'" class="underline" :href="`/uniq?id=${uniqId}`" target="_blank"
                                    >{{ uniqId }}
                                </a>
                                <span v-else>{{ uniqId }}</span>
                            </template>
                            <template #item-buyer="{ buyer }">
                                <a class="underline" :href="`/user?id=${buyer}`" target="_blank">{{ buyer }} </a>
                            </template>
                            <template #item-price="{ price, priceUnit }"> {{ price }} {{ priceUnit }} </template>
                            <template #item-cancelAction="{ cancelAction }">
                                <Button
                                    v-if="
                                        cancelAction.status === 'ACTIVE' &&
                                        cancelAction.buyer != props.state.accountName
                                    "
                                    size="sm"
                                    :disabled="
                                        !(cancelAction.owner == props.state.accountName && !!props.state.accountName)
                                    "
                                    @onClick="
                                        handleAcceptReceivedOffer(
                                            cancelAction.type,
                                            cancelAction.owner,
                                            cancelAction.uniqId,
                                            cancelAction.offerId
                                        )
                                    "
                                >
                                    Accept
                                </Button>
                                <Button
                                    v-else-if="
                                        (cancelAction.status == 'EXPIRED' ||
                                            cancelAction.buyer == props.state.accountName) &&
                                        !!props.state.accountName
                                    "
                                    size="sm"
                                    :disabled="!!!props.state.accountName"
                                    @onClick="
                                        handleCancelSentOffer(
                                            cancelAction.type,
                                            cancelAction.uniqFactoryId,
                                            cancelAction.uniqId,
                                            cancelAction.offerId
                                        )
                                    "
                                >
                                    Cancel
                                </Button>
                            </template>
                            <template #empty-message>
                                <p>No Received Offers found</p>
                            </template>
                        </EasyDataTable>
                        <Button
                            :disabled="receivedOffers.totalCount == receivedOffers.data.length || isLoading"
                            @onClick="fetchReceivedOffers"
                            class="w-full mt-6"
                        >
                            {{
                                isLoading
                                    ? 'Loading...'
                                    : `Load More (${receivedOffers.totalCount - receivedOffers.data.length})`
                            }}
                        </Button>
                    </div>
                </Expand>
            </div>

            <!-- Media Section -->
            <div class="flex flex-col gap-4">
                <div class="text-2xl font-bold">Media</div>
                <Expand :expanded="true">
                    <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                        <MediaArea :media="uniqData.metadata" />
                    </div>
                </Expand>
            </div>

            <div>
                <h4 class="mt-2 mb-2">JSON Data</h4>
                <Expand>
                    <Code :code="JSON.stringify(uniqData)"></Code>
                </Expand>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import * as I from '../../interfaces/index';
import { SharedEmits } from '../../interfaces/index';
import { useRoute } from 'vue-router/auto';
import * as NFTAPI from '../../utilities/nftapi/api';
import { UniqResponse } from '../../utilities/nftapi/schemas/uniqResponse';
import { formatIfNull } from '../../utilities/formatters';
import { getEnvironmentEndpoint, routePageEnvironment } from '../../utilities/networks';
import { PaginationResponse } from '../../utilities/nftapi/schemas/paginationResponse';
import { BlockchainService } from '../../utilities/blockchain';

interface UniqEmits extends SharedEmits {
    (e: 'transact', actions: I.Action[]): void;
}

const emits = defineEmits<UniqEmits>();

const route = useRoute('/uniq/');
const props = defineProps<{ state: I.AuthState; metadata: I.RuntimeMetadata }>();

// Input fields
let isSearchingByFactory = ref(false);
const uniqId = ref<number | undefined>(undefined);
const uniqIdInputKey = ref<number>(1);
const factoryId = ref<number | undefined>(undefined);
const factoryIdInputKey = ref<number>(2);
const serialNum = ref<number | undefined>(undefined);
const serialNumInputKey = ref<number>(3);

const searchStatus = ref<'waiting' | 'success' | 'failure' | 'error'>('waiting');
const isLoading = ref<boolean>(false);

// api and onchain data
const uniqData = ref<UniqResponse>(null);

const receivedOffers = ref<PaginationResponse<I.ReceivedOffer> & I.DataTableType>({
    pagination: { limit: 25, skip: 0 },
    totalCount: 0,
    data: [],
    dataTable: {
        headers: [
            { text: 'Type', value: 'type', sortable: true },
            { text: 'Offer Expiry', value: 'expiryDate', sortable: true },
            { text: 'Bidder', value: 'buyer' },
            { text: 'Price', value: 'price', sortable: true },
            { text: 'Status', value: 'status' },
            { text: 'Action', value: 'cancelAction' },
        ],
        rows: [],
    },
});

function updateUniqIdInputText(id: number | null) {
    uniqId.value = id;
    uniqIdInputKey.value++;
}

function updateFactoryIdSerialNumInputText(facId: number | null, sNum: number | null) {
    factoryId.value = facId;
    serialNum.value = sNum;
    factoryIdInputKey.value++;
    serialNumInputKey.value++;
}

function clearData() {
    uniqData.value = null;
    receivedOffers.value = {
        pagination: { limit: 25, skip: 0 },
        totalCount: 0,
        data: [],
        dataTable: {
            headers: receivedOffers.value.dataTable.headers,
            rows: [],
        },
    };
}

function clearSearch() {
    searchStatus.value = 'waiting';
    clearData();
    updateUniqIdInputText(undefined);
    updateFactoryIdSerialNumInputText(undefined, undefined);
}

async function parseQueryParams() {
    routePageEnvironment(emits, route);

    // search by uniq id
    if (route.query.id) {
        updateUniqIdInputText(parseInt(route.query.id as string));
        findUniq();
    }

    // search by factoryId + serialNum
    if (route.query.factoryId && route.query.serialNum) {
        isSearchingByFactory.value = true;
        updateFactoryIdSerialNumInputText(
            parseInt(route.query.factoryId as string),
            parseInt(route.query.serialNum as string)
        );
        findUniq();
    }
}

async function findUniq() {
    console.log({ uid: uniqId.value, fid: factoryId.value, sno: serialNum.value });

    clearData();
    isLoading.value = true;

    try {
        let thisUniqId: string | number = null;
        // get data from NFT API
        if (uniqId.value != undefined) {
            console.log(`Search mode: uniqId`, uniqId.value);
            window.history.pushState('uniq', '', `${route.path}?env=${BlockchainService.environment}&id=${uniqId.value}`);
            uniqData.value = await NFTAPI.fetchUniq(uniqId.value);
        }
        console.log(uniqData.value);

        if (factoryId.value != undefined && serialNum.value != undefined) {
            console.log(`Search mode: factoryId & serialNum`, factoryId.value, serialNum.value);
            window.history.pushState('uniq', '', `${route.path}?env=${BlockchainService.environment}&factoryId=${factoryId.value}&serialNum=${serialNum.value}`);
            const apiData = await NFTAPI.fetchUniqsOfFactory(factoryId.value, null, null, null, null, {
                min: serialNum.value,
                max: serialNum.value,
            });

            // if apiData is not undefined, and a uniq is present, get uniq data from it
            if (apiData && apiData.data[0]) {
                uniqData.value = apiData.data[0];
            }
        }

        thisUniqId = uniqData.value.id;

        // get received offers
        await fetchReceivedOffers(thisUniqId);

        searchStatus.value = uniqData.value ? 'success' : 'failure';
    } catch (error) {
        console.error(`findUniq error: ${error}`);
        searchStatus.value = 'error';
    }

    isLoading.value = false;
}

async function fetchReceivedOffers(uniqId: string | number) {
    isLoading.value = true;

    try {
        const apiData = await NFTAPI.fetchReceivedOffers(
            { owner: undefined, uniqId },
            receivedOffers.value.pagination.limit,
            receivedOffers.value.pagination.skip
        );

        receivedOffers.value.data.push(...apiData.data);
        receivedOffers.value.pagination.skip += apiData.data.length;
        receivedOffers.value.totalCount = apiData.totalCount;
        receivedOffers.value.dataTable.rows = receivedOffers.value.data.map((offer) => {
            const currentDate = new Date();
            const expiryDate = new Date(offer.expiryDate);
            const status = expiryDate < currentDate ? 'EXPIRED' : 'ACTIVE';

            return {
                id: offer.id,
                type: offer.type,
                expiryDate: offer.expiryDate,
                buyer: offer.buyer,
                price: parseFloat(offer.price.amount),
                priceUnit: offer.price.currency.code,
                status: status,
                cancelAction: {
                    type: offer.type,
                    uniqId: offer.uniq.id,
                    uniqFactoryId: offer.uniqFactory.id,
                    offerId: offer.id,
                    buyer: offer.buyer,
                    owner: offer.uniq.owner,
                    status: status,
                },
            };
        });
    } catch (error) {
        console.error('Error fetching received offers:', error);
    } finally {
        isLoading.value = false;
    }
}

async function handleAcceptReceivedOffer(type: string, owner: string, uniqId: string, offerId: string) {
    let acceptAction = [
        {
            contract: 'eosio.nft.ft',
            action: type == 'UNIQ' ? 'acptnftofr.a' : 'acptfctofr.a',
            authorization: [
                {
                    actor: props.state.accountName,
                    permission: props.state.accountPerm ? props.state.accountPerm : 'active',
                },
            ],
            data: {
                owner: owner,
                nft_id: uniqId,
                offer_id: offerId,
                memo: 'Accept Offer',
            },
        },
    ];

    emits('transact', acceptAction);
}

async function handleCancelSentOffer(type: string, factoryId: string, uniqId: string, offerId: string) {
    let cancelAction = [
        {
            contract: 'eosio.nft.ft',
            action: type == 'UNIQ' ? 'rmnftofr.a' : 'rmfctofr.a',
            authorization: [
                {
                    actor: props.state.accountName,
                    permission: props.state.accountPerm ? props.state.accountPerm : 'active',
                },
            ],
            data: {
                canceler: props.state.accountName,
                offer_id: offerId,
                memo: 'Cancel Offer',
            },
        },
    ];

    // use factory_id for factory offers and nft_id for uniq offers
    cancelAction[0].data[type == 'UNIQ_FACTORY' ? 'factory_id' : 'nft_id'] =
        type == 'UNIQ_FACTORY' ? factoryId : uniqId;

    emits('transact', cancelAction);
}

async function searchByUniqID() {
    updateFactoryIdSerialNumInputText(undefined, undefined);
    findUniq();
}

async function searchByFactoryId() {
    updateUniqIdInputText(undefined);
    findUniq();
}

onMounted(() => {
    parseQueryParams();
});
</script>
