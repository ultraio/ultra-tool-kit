<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import * as I from '../../interfaces/index';
import { useRoute } from 'vue-router/auto';
import { BlockchainService } from '../../utilities/blockchain';
import * as NFTAPI from '../../utilities/nftapi/api';
import { UniqResponse } from '../../utilities/nftapi/schemas/uniqResponse';
import { formatIfNull } from '../../utilities/formatters';
import { PaginationResponse } from '../../utilities/nftapi/schemas/paginationResponse';
import { UniqFactoryResponse } from '../../utilities/nftapi/schemas/uniqFactoryResponse';
import { routePageEnvironment } from '../../utilities/networks';

// Define emits
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();

// Use route for navigation
const route = useRoute('/uniq/');

// Define props
const props = defineProps<{ state: I.AuthState; metadata: I.RuntimeMetadata }>();

// Input fields
const userName = ref<string | null>(null);
const userNameInputKey = ref<number>(1);

// Search status
const searchStatus = ref<'waiting' | 'success' | 'failure' | 'error'>('waiting');
const isLoading = ref<boolean>(false);
const isLoadingMoreData = ref<boolean>(false);

// On-chain data
const userOnChain = ref<any>(null);

// API data for user factories and uniqs
const userFactories = ref<PaginationResponse<UniqFactoryResponse> & I.DataTableType>({
    pagination: { limit: 25, skip: 0 },
    totalCount: 0,
    data: [],
    dataTable: {
        headers: [
            { text: 'Factory ID', value: 'id' },
            { text: 'Factory Name', value: 'name' },
        ],
        rows: [],
    },
});

const userUniqs = ref<PaginationResponse<UniqResponse> & I.DataTableType>({
    pagination: { limit: 25, skip: 0 },
    totalCount: 0,
    data: [],
    dataTable: {
        headers: [
            { text: 'Uniq ID', value: 'id', sortable: true },
            { text: 'Serial Number', value: 'serialNumber', sortable: true },
            { text: 'Uniq Name', value: 'name' },
            { text: 'Factory ID', value: 'factoryId', sortable: true },
            { text: 'Factory Name', value: 'factory' },
        ],
        rows: [],
    },
});

const userUniqsResale = ref<PaginationResponse<UniqResponse> & I.DataTableType>({
    pagination: { limit: 25, skip: 0 },
    totalCount: 0,
    data: [],
    dataTable: {
        headers: [
            { text: 'Uniq ID', value: 'id', sortable: true },
            { text: 'Factory ID', value: 'factoryId', sortable: true },
            { text: 'Price', value: 'price' },
            { text: 'Promoter Basis Points', value: 'basisPoints' },
        ],
        rows: [],
    },
});

const receivedOffers = ref<PaginationResponse<I.ReceivedOffer> & I.DataTableType>({
    pagination: { limit: 25, skip: 0 },
    totalCount: 0,
    data: [],
    dataTable: {
        headers: [
            { text: 'Type', value: 'type', sortable: true },
            { text: 'Offer Expiry', value: 'expiryDate', sortable: true },
            { text: 'Uniq Factory ID', value: 'uniqFactoryId', sortable: true },
            { text: 'Uniq ID', value: 'uniqId', sortable: true },
            { text: 'Bidder', value: 'buyer' },
            { text: 'Price', value: 'price', sortable: true },
            { text: 'Status', value: 'status' },
            { text: 'Action', value: 'cancelAction' },
        ],
        rows: [],
    },
});

const sentOffers = ref<PaginationResponse<I.SentOffer> & I.DataTableType>({
    pagination: { limit: 25, skip: 0 },
    totalCount: 0,
    data: [],
    dataTable: {
        headers: [
            { text: 'Type', value: 'type', sortable: true },
            { text: 'Offer Expiry', value: 'expiryDate', sortable: true },
            { text: 'Uniq Factory ID', value: 'uniqFactoryId', sortable: true },
            { text: 'Uniq ID', value: 'uniqId', sortable: true },
            { text: 'Owner', value: 'owner' },
            { text: 'Price', value: 'price', sortable: true },
            { text: 'Status', value: 'status' },
            { text: 'Action', value: 'cancelAction' },
        ],
        rows: [],
    },
});

const enableActions = ref<boolean>(false);

function clearReceivedOffersData() {
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

function clearSentOffersData() {
    sentOffers.value = {
        pagination: { limit: 25, skip: 0 },
        totalCount: 0,
        data: [],
        dataTable: {
            headers: sentOffers.value.dataTable.headers,
            rows: [],
        },
    };
}

// Function to update the user input text
function updateUserNameInputText(user: string | null) {
    userName.value = user;
    userNameInputKey.value++;
}

// Function to clear data
function clearData() {
    userFactories.value = {
        pagination: { limit: 25, skip: 0 },
        totalCount: 0,
        data: [],
        dataTable: {
            headers: userFactories.value.dataTable.headers,
            rows: [],
        },
    };

    userUniqs.value = {
        pagination: { limit: 25, skip: 0 },
        totalCount: 0,
        data: [],
        dataTable: {
            headers: userUniqs.value.dataTable.headers,
            rows: [],
        },
    };

    userUniqsResale.value = {
        pagination: { limit: 25, skip: 0 },
        totalCount: 0,
        data: [],
        dataTable: {
            headers: userUniqsResale.value.dataTable.headers,
            rows: [],
        },
    };

    clearReceivedOffersData();
    clearSentOffersData();
}

// Function to clear the search
function clearSearch() {
    searchStatus.value = 'waiting';
    clearData();
    updateUserNameInputText(null);
}

// Function to parse query parameters
async function parseQueryParams() {
    routePageEnvironment(emits, route);

    if (route.query.id) {
        updateUserNameInputText(route.query.id as string);
        findUser();
    }
}

// Function to fetch uniq factories managed
async function fetchUniqFactoriesManaged() {
    isLoadingMoreData.value = true;
    const factories = await NFTAPI.fetchUniqFactoriesManaged(
        userName.value,
        userFactories.value.pagination.limit,
        userFactories.value.pagination.skip
    );

    userFactories.value.data.push(...factories.data);
    userFactories.value.pagination.skip += factories.data.length;
    userFactories.value.totalCount = factories.totalCount;

    // Transform data to DataTable type
    userFactories.value.dataTable.rows = userFactories.value.data.map((factory) => {
        return {
            id: parseInt(factory.id),
            name: formatIfNull(factory.metadata?.content?.name),
        };
    });
    isLoadingMoreData.value = false;
}

// Function to fetch uniqs of wallet
async function fetchUniqsOfWallet(isResale: boolean) {
    isLoadingMoreData.value = true;
    let dataToPopulate = isResale ? userUniqsResale : userUniqs;

    const apiData = await NFTAPI.fetchUniqsOfWallet(
        userName.value,
        null,
        dataToPopulate.value.pagination.limit,
        dataToPopulate.value.pagination.skip,
        isResale ? true : undefined
    );

    dataToPopulate.value.data.push(...apiData.data);
    dataToPopulate.value.pagination.skip += apiData.data.length;
    dataToPopulate.value.totalCount = apiData.totalCount;

    // Transform data to DataTable type
    dataToPopulate.value.dataTable.rows = dataToPopulate.value.data.map((uniq) => {
        return isResale
            ? {
                  id: parseInt(uniq.id),
                  factoryId: parseInt(uniq.factory.id),
                  price: `${uniq.resale.price.amount} ${uniq.resale.price.currency.code}`,
                  basisPoints: `${uniq.resale.promoterBasisPoints / 100}% (${uniq.resale.promoterBasisPoints})`,
              }
            : {
                  id: parseInt(uniq.id),
                  serialNumber: parseInt(uniq.serialNumber),
                  name: formatIfNull(uniq.metadata?.content?.name),
                  factoryId: parseInt(uniq.factory.id),
                  factory: formatIfNull(uniq.factory.metadata?.content?.name),
              };
    });

    isLoadingMoreData.value = false;
}

async function fetchReceivedOffers() {
    isLoadingMoreData.value = true;

    try {
        const apiData = await NFTAPI.fetchReceivedOffers(
            { owner: userName.value, uniqId: undefined },
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
                uniqFactoryId: offer.uniqFactory.id ?? '-',
                uniqId: offer.uniq.id ?? '-',
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
                    owner: userName.value,
                    status: status,
                },
            };
        });
    } catch (error) {
        console.error('Error fetching received offers:', error);
    } finally {
        isLoadingMoreData.value = false;
    }
}

async function fetchSentOffers() {
    isLoadingMoreData.value = true;

    try {
        const apiData = await NFTAPI.fetchSentOffers(
            userName.value,
            sentOffers.value.pagination.limit,
            sentOffers.value.pagination.skip
        );

        sentOffers.value.data.push(...apiData.data);
        sentOffers.value.pagination.skip += apiData.data.length;
        sentOffers.value.totalCount = apiData.totalCount;

        // Transform data to DataTable type
        sentOffers.value.dataTable.rows = sentOffers.value.data.map((offer) => {
            const currentDate = new Date();
            const expiryDate = new Date(offer.expiryDate);
            const status = expiryDate < currentDate ? 'EXPIRED' : 'ACTIVE';

            return {
                type: offer.type,
                expiryDate: offer.expiryDate,
                uniqFactoryId: offer.uniqFactoryId ?? '-',
                uniqId: offer.uniqId ?? '-',
                owner: offer.type == 'UNIQ' ? offer.uniq.owner : offer.uniqFactory.owner,
                price: parseFloat(offer.price.amount),
                priceUnit: offer.price.currency.code,
                status: status,
                cancelAction: {
                    type: offer.type,
                    factoryId: offer.uniqFactoryId,
                    uniqId: offer.uniqId,
                    offerId: offer.id,
                },
            };
        });
    } catch (error) {
        console.error('Error fetching sent offers:', error);
    } finally {
        isLoadingMoreData.value = false;
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

// Function to find user and fetch relevant data
async function findUser() {
    userName.value = userName.value.trim();
    window.history.pushState('user', '', `${route.path}?env=${BlockchainService.environment}&id=${userName.value}`);

    clearData();
    isLoading.value = true;

    // check if the current logged in user is this one
    // if so, enable actions
    enableActions.value = userName.value === props.state.accountName;

    try {
        // get data from NFT API
        if (userName.value) {
            userOnChain.value = await BlockchainService.getAccountData(userName.value);
            await fetchUniqFactoriesManaged();
            await fetchUniqsOfWallet(false); // For all uniqs
            await fetchUniqsOfWallet(true); // For uniqs listed for resale
            await fetchReceivedOffers(); // Fetch received offers
            await fetchSentOffers(); // Fetch sent offers
        }

        searchStatus.value = userOnChain.value ? 'success' : 'failure';
    } catch (error) {
        console.error(`findUniq error: ${error}`);
        searchStatus.value = 'error';
    }

    isLoading.value = false;
}

onMounted(() => {
    parseQueryParams();
});

// Listens to any changes in the AuthState from parent component (App.vue);
// Will trigger when a user logs in
watch(
    () => props.state,
    (currentValue, oldValue) => {
        enableActions.value = userName.value === currentValue?.accountName;
    },
    {
        deep: true,
    }
);
</script>

<template>
    <div class="flex flex-col gap-4">
        <div class="text-3xl font-bold">User Uniq Explorer</div>
        <div>Start the search by entering a username</div>
        <!-- Inputs start -->
        <div class="flex flex-col gap-4">
            <div class="flex flex-row gap-4">
                <input
                    v-model="userName"
                    placeholder="12 Characters Max | Uses: (a-z1-5.)"
                    :min="0"
                    type="string"
                    @keyup.enter="findUser"
                    class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                />
                <Button :disabled="userName === ''" @click="findUser">
                    <Icon v-if="!isLoading" icon="fa-solid fa-magnifying-glass" />
                    <Icon v-else icon="fa-spinner" spin />
                </Button>
            </div>
        </div>
        <!-- Inputs end -->

        <LoadingSpinner v-if="isLoading"></LoadingSpinner>

        <div v-if="!isLoading && searchStatus === 'failure'" class="flex flex-col justify-center items-center gap-4">
            <div>Sorry, there seems to be no results for your search</div>
            <Button @click="clearSearch"> Clear Search </Button>
        </div>

        <template v-if="!isLoading && !!userOnChain">
            <div class="text-2xl font-bold">Inventory</div>

            <div class="flex flex-col gap-4">
                <div class="text-2xl font-bold">Factories</div>
                <Expand :expanded="true">
                    <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                        <EasyDataTable
                            table-class-name="datatable-table"
                            :headers="userFactories.dataTable.headers"
                            :items="userFactories.dataTable.rows"
                            multi-sort
                            :rows-items="['25', '50', '100']"
                            :rows-per-page="100"
                            buttons-pagination
                            :theme-color="'rgb(169 132 232 / var(--tw-text-opacity))'"
                        >
                            <template #item-id="{ id }">
                                <a class="underline" :href="`/uniqFactory?id=${id}`" target="_blank">{{ id }}</a>
                            </template>
                            <template #empty-message>
                                <p>No Factories found</p>
                            </template>
                        </EasyDataTable>
                        <Button
                            :disabled="userFactories.totalCount == userFactories.data.length || isLoadingMoreData"
                            @onClick="fetchUniqFactoriesManaged"
                            class="w-full mt-6"
                        >
                            {{
                                isLoadingMoreData
                                    ? 'Loading...'
                                    : `Load More (${userFactories.totalCount - userFactories.data.length})`
                            }}
                        </Button>
                    </div>
                </Expand>
            </div>

            <br />
            <div class="flex flex-col gap-4">
                <div class="text-2xl font-bold">Uniqs</div>
                <Expand :expanded="true">
                    <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                        <EasyDataTable
                            table-class-name="datatable-table"
                            :headers="userUniqs.dataTable.headers"
                            :items="userUniqs.dataTable.rows"
                            multi-sort
                            :rows-items="['25', '50', '100']"
                            :rows-per-page="100"
                            buttons-pagination
                            :theme-color="'rgb(169 132 232 / var(--tw-text-opacity))'"
                        >
                            <template #item-id="{ id }">
                                <a class="underline" :href="`/uniq?id=${id}`" target="_blank">{{ id }}</a>
                            </template>
                            <template #item-factoryId="{ factoryId }">
                                <a class="underline" :href="`/uniqFactory?id=${factoryId}`" target="_blank">{{
                                    factoryId
                                }}</a>
                            </template>
                            <template #empty-message>
                                <p>No Uniqs found</p>
                            </template>
                        </EasyDataTable>
                        <Button
                            :disabled="userUniqs.totalCount == userUniqs.data.length || isLoadingMoreData"
                            @onClick="fetchUniqsOfWallet(false)"
                            class="w-full mt-6"
                        >
                            {{
                                isLoadingMoreData
                                    ? 'Loading...'
                                    : `Load More (${userUniqs.totalCount - userUniqs.data.length})`
                            }}
                        </Button>
                    </div>
                </Expand>
            </div>

            <br />
            <div class="flex flex-col gap-4">
                <div class="text-2xl font-bold">Uniqs Resale</div>
                <Expand :expanded="true">
                    <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                        <EasyDataTable
                            table-class-name="datatable-table"
                            :headers="userUniqsResale.dataTable.headers"
                            :items="userUniqsResale.dataTable.rows"
                            multi-sort
                            :rows-items="['25', '50', '100']"
                            :rows-per-page="100"
                            buttons-pagination
                            :theme-color="'rgb(169 132 232 / var(--tw-text-opacity))'"
                        >
                            <template #item-id="{ id }">
                                <a class="underline" :href="`/uniq?id=${id}`" target="_blank">{{ id }}</a>
                            </template>
                            <template #item-factoryId="{ factoryId }">
                                <a class="underline" :href="`/uniqFactory?id=${factoryId}`" target="_blank">{{
                                    factoryId
                                }}</a>
                            </template>
                            <template #empty-message>
                                <p>No Uniqs found</p>
                            </template>
                        </EasyDataTable>
                        <Button
                            :disabled="userUniqsResale.totalCount == userUniqsResale.data.length || isLoadingMoreData"
                            @onClick="fetchUniqsOfWallet(true)"
                            class="w-full mt-6"
                        >
                            {{
                                isLoadingMoreData
                                    ? 'Loading...'
                                    : `Load More (${userUniqsResale.totalCount - userUniqsResale.data.length})`
                            }}
                        </Button>
                    </div>
                </Expand>
            </div>

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
                                    v-if="cancelAction.status === 'ACTIVE'"
                                    size="sm"
                                    :disabled="!enableActions"
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
                                    v-else-if="cancelAction.status === 'EXPIRED'"
                                    size="sm"
                                    :disabled="!enableActions"
                                    @onClick="
                                        handleCancelSentOffer(
                                            cancelAction.type,
                                            cancelAction.factoryId,
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
                            :disabled="receivedOffers.totalCount == receivedOffers.data.length || isLoadingMoreData"
                            @onClick="fetchReceivedOffers"
                            class="w-full mt-6"
                        >
                            {{
                                isLoadingMoreData
                                    ? 'Loading...'
                                    : `Load More (${receivedOffers.totalCount - receivedOffers.data.length})`
                            }}
                        </Button>
                    </div>
                </Expand>
            </div>

            <br />
            <div class="flex flex-col gap-4">
                <div class="text-2xl font-bold">Sent Offers</div>
                <Expand :expanded="true">
                    <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                        <EasyDataTable
                            table-class-name="datatable-table"
                            :headers="sentOffers.dataTable.headers"
                            :items="sentOffers.dataTable.rows"
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
                            <template #item-owner="{ owner }">
                                <a class="underline" :href="`/user?id=${owner}`" target="_blank">{{ owner }} </a>
                            </template>
                            <template #item-price="{ price, priceUnit }"> {{ price }} {{ priceUnit }} </template>
                            <template #item-cancelAction="{ cancelAction }">
                                <Button
                                    size="sm"
                                    :disabled="!enableActions"
                                    @onClick="
                                        handleCancelSentOffer(
                                            cancelAction.type,
                                            cancelAction.factoryId,
                                            cancelAction.uniqId,
                                            cancelAction.offerId
                                        )
                                    "
                                >
                                    Cancel
                                </Button>
                            </template>
                            <template #empty-message>
                                <p>No Sent Offers found</p>
                            </template>
                        </EasyDataTable>
                        <Button
                            :disabled="sentOffers.totalCount == sentOffers.data.length || isLoadingMoreData"
                            @onClick="fetchSentOffers"
                            class="w-full mt-6"
                        >
                            {{
                                isLoadingMoreData
                                    ? 'Loading...'
                                    : `Load More (${sentOffers.totalCount - sentOffers.data.length})`
                            }}
                        </Button>
                    </div>
                </Expand>
            </div>
        </template>
    </div>
</template>
