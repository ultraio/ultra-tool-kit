<template>
    <div class="flex flex-col gap-4">
        <div class="text-3xl font-bold">Factory Explorer</div>
        <div>Start the search by entering the factory ID</div>
        <div class="flex flex-rol gap-4">
            <input
                v-model="factoryId"
                placeholder="Factory Identifier"
                min="0"
                type="number"
                @keyup.enter="findFactory"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
            />
            <Button :disabled="isNaN(Number(factoryId)) || isLoading" @onClick="findFactory">
                <Icon v-if="!isLoading" icon="fa-solid fa-magnifying-glass" />
                <Icon v-else icon="fa-spinner" spin />
            </Button>
        </div>

        <LoadingSpinner v-if="isLoading" />

        <!-- Failed to Search -->
        <div v-if="!isLoading && searchStatus === 'failure'" class="flex flex-col justify-center items-center gap-4">
            <div>Sorry, there seems to be no results for your search</div>
            <Button @click="clearSearch"> Clear Search </Button>
        </div>

        <!-- Tab Selection -->
        <div v-if="!isLoading && factoryData" class="flex flex-row gap-4 h-12 rounded">
            <div
                @click="changeTabs('factory')"
                class="flex flex-row items-center justify-center flex-grow h-12 cursor-pointer rounded border hover:bg-neutral-600"
                :class="
                    selectedTab === 'factory'
                        ? ['bg-neutral-600 border-neutral-500']
                        : ['bg-neutral-700 border-neutral-600']
                "
            >
                Token Factory
            </div>
            <div
                @click="changeTabs('defaultUniq')"
                class="flex flex-row items-center justify-center flex-grow h-12 cursor-pointer rounded border hover:bg-neutral-600"
                :class="
                    selectedTab === 'defaultUniq'
                        ? ['bg-neutral-600 border-neutral-500']
                        : ['bg-neutral-700 border-neutral-600']
                "
            >
                Default Uniq
            </div>
        </div>

        <!-- Factory Details -->
        <div v-if="!isLoading && factoryData && selectedTab == 'factory'" class="flex flex-col gap-4 mt-4">
            <!-- On chain Section -->
            <div class="text-2xl font-bold">On Chain</div>
            <div
                class="flex flex-col bg-neutral-800 pl-4 pr-4 pt-4 pb-4 rounded border border-neutral-700 text-neutral-300 [&>*]:border-b [&>*]:border-neutral-600 [&>*]:pb-3 [&>*]:pt-3"
            >
                <div class="grid grid-cols-4 gap-4 items-center !pt-0">
                    <div class="col-span-1">Factory ID</div>
                    <div class="col-span-3">{{ factoryData.id }}</div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Creator</div>
                    <div class="col-span-3">
                        <a class="underline" target="_blank" :href="`/user?id=${factoryData.assetCreator}`">{{
                            factoryData.assetCreator
                        }}</a>
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Manager</div>
                    <div class="col-span-3">
                        <a class="underline" target="_blank" :href="`/user?id=${factoryData.assetManager}`">{{
                            factoryData.assetManager
                        }}</a>
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Tradeability</div>
                    <div class="col-span-3">
                        {{
                            formatTradabilityValue(
                                factoryData.tradingWindow.startDate,
                                factoryData.tradingWindow.endDate
                            )
                        }}
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Transferability</div>
                    <div class="col-span-3">
                        {{
                            formatTransferabilityValue(
                                factoryData.transferWindow.startDate,
                                factoryData.transferWindow.endDate
                            )
                        }}
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Minimum Resell Price</div>
                    <div class="col-span-3">
                        {{
                            factoryData.resale.minimumPrice.amount + ' ' + factoryData.resale.minimumPrice.currency.code
                        }}
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Account Minting Limit</div>
                    <div class="col-span-3">
                        {{ formatIfNull(factoryData.accountMintingLimit) }}
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Minted / Max Supply</div>
                    <div class="col-span-3">
                        {{ factoryData.stock.minted + ' / ' + formatIfNull(factoryData.stock.maxMintable) }}
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Mintable Amount</div>
                    <div class="col-span-3">
                        {{ formatIfNull(factoryData.stock.mintable) }}
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center">
                    <div class="col-span-1">Existing Token Amount</div>
                    <div class="col-span-3">
                        {{ factoryData.stock.existing }}
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 items-center !border-b-0 !pb-0">
                    <div class="col-span-1">Authorized Amount</div>
                    <div class="col-span-3">
                        {{ formatIfNull(factoryData.stock.authorized) }}
                    </div>
                </div>
            </div>

            <!-- Resale Shares Section -->
            <div class="flex flex-col gap-4" v-if="factoryData.resale.shares.length > 0">
                <div class="text-2xl font-bold">Resale Shares</div>
                <div
                    class="flex flex-col bg-neutral-800 pl-4 pr-4 pt-4 pb-4 rounded border border-neutral-700 text-neutral-300 [&>*]:border-b [&>*]:border-neutral-600 [&>*]:pb-3 [&>*]:pt-3"
                >
                    <div
                        v-for="(share, index) in factoryData.resale.shares"
                        class="grid grid-cols-4 gap-4 items-center"
                        :class="getRepeatedDataClass(factoryData.resale.shares, index)"
                    >
                        <a target="_blank" :href="`/user?id=${share.receiver}`">
                            {{ share.receiver }}
                        </a>
                        <div>{{ share.basisPoints / 100 }}%</div>
                    </div>
                </div>
            </div>

            <!-- Metadata Section -->
            <div class="flex flex-col gap-4">
                <div class="text-2xl font-bold">Metadata</div>
                <div
                    class="flex flex-col bg-neutral-800 pl-4 pr-4 pt-4 pb-4 rounded border border-neutral-700 text-neutral-300 [&>*]:border-b [&>*]:border-neutral-600 [&>*]:pb-3 [&>*]:pt-3"
                >
                    <div class="grid grid-cols-4 gap-4 items-center !pt-0">
                        <div class="col-span-1">Type</div>
                        <div class="col-span-3">
                            {{ factoryData.type }}
                        </div>
                    </div>

                    <div class="grid grid-cols-4 gap-4 items-center">
                        <div class="col-span-1">Name</div>
                        <div class="col-span-3">
                            {{ formatIfNull(factoryData.metadata.content?.name) }}
                        </div>
                    </div>

                    <div class="grid grid-cols-4 gap-4 items-center">
                        <div class="col-span-1">Subname</div>
                        <div class="col-span-3">
                            {{ formatIfNull(factoryData.metadata.content?.subName) }}
                        </div>
                    </div>

                    <div class="grid grid-cols-4 gap-4 items-center">
                        <div class="col-span-1">Description</div>
                        <div class="col-span-3">
                            {{ formatIfNull(factoryData.metadata.content?.description) }}
                        </div>
                    </div>

                    <div class="flex flex-col gap-4 rounded" v-if="factoryData.metadata.content?.properties">
                        <div class="col-span-1">Properties</div>
                        <Expand :expanded="false">
                            <div class="flex flex-col gap-4 bg-neutral-700 rounded-md p-4">
                                <div
                                    class="flex flex-row gap-4 bg-neutral-600 p-4 rounded"
                                    v-for="(value, propertyName) in factoryData.metadata.content?.properties"
                                >
                                    <!-- Currently Unused by Any Default Token -->
                                    <div class="grid grid-cols-2 w-full">
                                        <span class="font-bold">Key</span>
                                        <span class="font-bold">Value</span>
                                        <span>{{ propertyName }}</span>
                                        <span>{{ value }}</span>
                                    </div>
                                </div>
                            </div>
                        </Expand>
                    </div>

                    <div
                        v-if="
                            factoryData.metadata.content?.attributes &&
                            factoryData.metadata.content?.attributes.length >= 1
                        "
                        class="flex flex-col gap-4 rounded"
                    >
                        <div class="col-span-1">Attributes</div>
                        <div class="bg-neutral-700 rounded-md p-4">
                            <Expand :expanded="false">
                                <div
                                    class="grid grid-cols-4 gap-4 bg-neutral-700 p-4 rounded-sm"
                                    v-for="(atrb, index) in factoryData.metadata.content?.attributes"
                                >
                                    <div class="col-span-1">{{ index }}</div>

                                    <div class="flex flex-col col-span-3 gap-4">
                                        <span class="font-bold">Key</span>
                                        <span class="pl-2">{{ atrb.key }}</span>
                                        <span class="font-bold">Value</span>
                                        <ul class="flex flex-col w-full gap-4 pl-2">
                                            <li class="bg-neutral-600 rounded p-4">
                                                name:
                                                {{ atrb.value.name === '' ? 'null' : atrb.value.name }}
                                            </li>
                                            <li class="bg-neutral-600 rounded p-4">
                                                description:
                                                {{ atrb.value.description === '' ? 'null' : atrb.value.description }}
                                            </li>
                                            <li class="bg-neutral-600 rounded p-4">
                                                type:
                                                {{ atrb.value['type'] ? atrb.value['type'] : null }}
                                            </li>
                                            <li class="bg-neutral-600 rounded p-4">
                                                dynamic:
                                                {{ !atrb.value.dynamic ? false : true }}
                                            </li>
                                        </ul>
                                    </div>
                                </div>
                            </Expand>
                        </div>
                    </div>

                    <div
                        class="flex flex-col gap-4"
                        v-if="
                            factoryData.metadata.content?.resources &&
                            Object.keys(factoryData.metadata.content?.resources).length >= 1
                        "
                    >
                        <div class="text-2xl font-bold">Resources</div>
                        <Expand :expanded="true">
                            <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                                <MediaArea :media="factoryData.metadata" :isResource="true" />
                            </div>
                        </Expand>
                    </div>
                </div>
            </div>

            <!-- Media Section -->
            <div class="flex flex-col gap-4">
                <div class="text-2xl font-bold">Media</div>
                <Expand :expanded="true">
                    <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                        <MediaArea :media="factoryData.metadata" />
                    </div>
                </Expand>
            </div>

            <!-- Uniqs of factory Section -->
            <div class="flex flex-col gap-4">
                <div class="text-2xl font-bold">Uniqs of Factory</div>
                <Expand :expanded="true">
                    <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                        <EasyDataTable
                            table-class-name="datatable-table"
                            :headers="uniqsOfFactory.dataTable.headers"
                            :items="uniqsOfFactory.dataTable.rows"
                            multi-sort
                            :rows-items="['25', '50', '100']"
                            :rows-per-page="100"
                            buttons-pagination
                            :theme-color="'rgb(169 132 232 / var(--tw-text-opacity))'"
                        >
                            <template #item-id="{ id }">
                                <a class="underline" :href="`/uniq?id=${id}`" target="_blank">{{ id }}</a>
                            </template>
                            <template #item-owner="{ owner }">
                                <a class="underline" :href="`/user?id=${owner}`" target="_blank">{{ owner }}</a>
                            </template>
                            <template #empty-message>
                                <p>No Uniqs found</p>
                            </template>
                        </EasyDataTable>
                        <Button
                            :disabled="uniqsOfFactory.totalCount == uniqsOfFactory.data.length || isLoading"
                            @onClick="fetchUniqsOfFactory(false)"
                            class="w-full mt-6"
                        >
                            {{
                                isLoading
                                    ? 'Loading...'
                                    : `Load More (${uniqsOfFactory.totalCount - uniqsOfFactory.data.length})`
                            }}
                        </Button>
                    </div>
                </Expand>
            </div>

            <!-- Factory Uniqs resale Section -->
            <div
                class="flex flex-col gap-4"
                v-if="
                    uniqsOfFactoryResale.data &&
                    uniqsOfFactoryResale.data.length > 0 &&
                    uniqsOfFactoryResale.data[0].resale !== null
                "
            >
                <div class="text-2xl font-bold">Uniqs Resale</div>
                <Expand :expanded="true">
                    <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                        <EasyDataTable
                            table-class-name="datatable-table"
                            :headers="uniqsOfFactoryResale.dataTable.headers"
                            :items="uniqsOfFactoryResale.dataTable.rows"
                            multi-sort
                            :rows-items="['25', '50', '100']"
                            :rows-per-page="100"
                            buttons-pagination
                            :theme-color="'rgb(169 132 232 / var(--tw-text-opacity))'"
                        >
                            <template #item-id="{ id }">
                                <a class="underline" :href="`/uniq?id=${id}`" target="_blank">{{ id }}</a>
                            </template>
                            <template #item-owner="{ owner }">
                                <a class="underline" :href="`/user?id=${owner}`" target="_blank">{{ owner }}</a>
                            </template>
                            <template #empty-message>
                                <p>No Uniqs found</p>
                            </template>
                        </EasyDataTable>
                        <Button
                            :disabled="uniqsOfFactoryResale.totalCount == uniqsOfFactoryResale.data.length || isLoading"
                            @onClick="fetchUniqsOfFactory(false)"
                            class="w-full mt-6"
                        >
                            {{
                                isLoading
                                    ? 'Loading...'
                                    : `Load More (${uniqsOfFactoryResale.totalCount - uniqsOfFactoryResale.data.length})`
                            }}
                        </Button>
                    </div>
                </Expand>
            </div>

            <!-- Firsthand purchase options -->
            <div class="flex flex-col gap-4" v-if="factoryData.firsthandPurchases">
                <div class="text-2xl font-bold">Purchase Options</div>
                <Expand :expanded="true">
                    <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                        <EasyDataTable
                            table-class-name="datatable-table"
                            :headers="firsthandPurchases.dataTable.headers"
                            :items="firsthandPurchases.dataTable.rows"
                            :rows-items="['25', '50', '100']"
                            :rows-per-page="100"
                            buttons-pagination
                            :theme-color="'rgb(169 132 232 / var(--tw-text-opacity))'"
                        >
                            <template #expand="item">
                                <div
                                    class="flex flex-col bg-neutral-800 pl-4 pr-4 pt-4 pb-4 rounded border border-neutral-700 text-neutral-300 [&>*]:border-b [&>*]:border-neutral-600 [&>*]:pb-3 [&>*]:pt-3"
                                >
                                    <div class="grid grid-cols-4 gap-4 items-center !pt-0">
                                        <div class="col-span-1 font-bold">Purchase Window Start</div>
                                        <div class="col-span-3">{{ item.purchaseWindowStart }}</div>
                                    </div>
                                    <div class="grid grid-cols-4 gap-4 items-center">
                                        <div class="col-span-1 font-bold">Purchase Window End</div>
                                        <div class="col-span-3">{{ item.purchaseWindowEnd }}</div>
                                    </div>
                                    <div class="grid grid-cols-4 gap-4 items-center">
                                        <div class="col-span-1 font-bold">Purchase Options With Uniqs</div>
                                        <div class="col-span-3">
                                            <div v-html="item.purchaseOptionsWithUniqs"></div>
                                        </div>
                                    </div>
                                    <div class="grid grid-cols-4 gap-4 items-center">
                                        <div class="col-span-1 font-bold">Sale Shares</div>
                                        <div class="col-span-3">
                                            <div v-html="item.saleShares"></div>
                                        </div>
                                    </div>
                                    <div class="grid grid-cols-4 gap-4 items-center">
                                        <div class="col-span-1 font-bold">Group Restrictions</div>
                                        <div class="col-span-3">{{ item.groupRestrictions }}</div>
                                    </div>
                                </div>
                            </template>
                        </EasyDataTable>
                    </div>
                </Expand>
            </div>

            <!-- Buy Offers -->
            <br />
            <div class="flex flex-col gap-4">
                <div class="text-2xl font-bold">Buy Offers</div>
                <Expand :expanded="true">
                    <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                        <EasyDataTable
                            table-class-name="datatable-table"
                            :headers="buyOffers.dataTable.headers"
                            :items="buyOffers.dataTable.rows"
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
                            <template #item-offerCreator="{ offerCreator }">
                                <a class="underline" :href="`/user?id=${offerCreator}`" target="_blank"
                                    >{{ offerCreator }}
                                </a>
                            </template>
                            <template #item-price="{ price, priceUnit }"> {{ price }} {{ priceUnit }} </template>
                            <template #item-cancelAction="{ cancelAction }">
                                <Button
                                    size="sm"
                                    :disabled="!canCancelOffer(cancelAction)"
                                    @click="
                                        canCancelOffer(cancelAction) && handleCancelOffer(
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
                                <p>No Buy Offers found</p>
                            </template>
                        </EasyDataTable>
                        <Button
                            :disabled="buyOffers.totalCount == buyOffers.data.length || isLoading"
                            @onClick="fetchBuyOffers"
                            class="w-full mt-6"
                        >
                            {{
                                isLoading ? 'Loading...' : `Load More (${buyOffers.totalCount - buyOffers.data.length})`
                            }}
                        </Button>
                    </div>
                </Expand>
            </div>

            <!-- Raw JSON -->
            <div class="flex flex-col gap-4">
                <div class="text-2xl font-bold">JSON Data</div>
                <Expand>
                    <Code :code="JSON.stringify(factoryData)"></Code>
                </Expand>
            </div>
        </div>

        <!-- Default Uniq Details -->
        <template v-if="!isLoading && !!factoryData && selectedTab == 'defaultUniq'">
            <template v-if="!!factoryData.defaultUniqMetadata">
                <div
                    class="flex flex-col bg-neutral-800 pl-4 pr-4 pt-4 pb-4 rounded border border-neutral-700 text-neutral-300 [&>*]:border-b [&>*]:border-neutral-600 [&>*]:pb-3 [&>*]:pt-3"
                >
                    <div class="grid grid-cols-4 gap-4 items-center !pt-0">
                        <div class="col-span-1">Type</div>
                        <div class="col-span-3">{{ factoryData.type }}</div>
                    </div>
                    <div class="grid grid-cols-4 gap-4 items-center">
                        <div class="col-span-1">Name</div>
                        <div class="col-span-3">
                            {{ formatIfNull(factoryData.defaultUniqMetadata?.content?.name) }}
                        </div>
                    </div>
                    <div class="grid grid-cols-4 gap-4 items-center">
                        <div class="col-span-1">Subname</div>
                        <div class="col-span-3">
                            {{ formatIfNull(factoryData.defaultUniqMetadata?.content?.subName) }}
                        </div>
                    </div>
                    <div class="grid grid-cols-4 gap-4 items-center">
                        <div class="col-span-1">Description</div>
                        <div class="col-span-3">
                            {{ formatIfNull(factoryData.defaultUniqMetadata?.content?.description) }}
                        </div>
                    </div>

                    <div class="flex flex-col gap-4 rounded" v-if="factoryData.defaultUniqMetadata.content?.properties">
                        <div class="col-span-1">Properties</div>
                        <Expand :expanded="false">
                            <div class="flex flex-col gap-4 bg-neutral-700 rounded-md p-4">
                                <div
                                    class="flex flex-row gap-4 bg-neutral-600 p-4 rounded"
                                    v-for="(value, propertyName) in factoryData.defaultUniqMetadata.content?.properties"
                                >
                                    <!-- Currently Unused by Any Default Token -->
                                    <div class="grid grid-cols-2 w-full">
                                        <span class="font-bold">Key</span>
                                        <span class="font-bold">Value</span>
                                        <span>{{ propertyName }}</span>
                                        <span>{{ value }}</span>
                                    </div>
                                </div>
                            </div>
                        </Expand>
                    </div>

                    <div class="flex flex-col gap-4 rounded" v-if="factoryData.defaultUniqMetadata.content.attributes">
                        <div class="col-span-1">Attributes</div>
                        <Expand :expanded="false">
                            <div class="flex flex-col gap-4 bg-neutral-700 rounded-md p-4">
                                <div
                                    class="flex flex-row gap-4 bg-neutral-600 p-4 rounded"
                                    v-for="(value, propertyName) in factoryData.defaultUniqMetadata.content?.attributes"
                                >
                                    <!-- Currently Unused by Any Default Token -->
                                    <div class="grid grid-cols-2 w-full">
                                        <span class="font-bold">Key</span>
                                        <span class="font-bold">Value</span>
                                        <span>{{ propertyName }}</span>
                                        <span>{{ value }}</span>
                                    </div>
                                </div>
                            </div>
                        </Expand>
                    </div>

                    <div
                        class="flex flex-col gap-4"
                        v-if="
                            factoryData.defaultUniqMetadata.content?.resources &&
                            Object.keys(factoryData.defaultUniqMetadata.content?.resources).length >= 1
                        "
                    >
                        <div class="text-2xl font-bold">Resources</div>
                        <Expand :expanded="true">
                            <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                                <MediaArea :media="factoryData.defaultUniqMetadata" :isResource="true" />
                            </div>
                        </Expand>
                    </div>

                    <div
                        class="grid grid-cols-4 gap-4"
                        v-if="
                            factoryData.defaultUniqMetadata.content.dynamicResources &&
                            Object.keys(factoryData.defaultUniqMetadata.content.dynamicResources).length >= 1
                        "
                    >
                        <div class="col-span-1">Dynamic Resources</div>
                        <div class="col-span-3 flex flex-col gap-2">
                            <div
                                class="flex flex-col gap-2 bg-neutral-700 rounded p-4"
                                v-for="(value, propertyName) in factoryData.defaultUniqMetadata.content
                                    .dynamicResources"
                            >
                                <span class="font-bold">contentType:</span>
                                <span>{{ value.contentType }}</span>
                                <span class="font-bold">URIs</span>
                                <ul class="flex flex-col gap-2">
                                    <li v-for="uri in value.uris" class="truncate">
                                        <a target="_blank" :href="uri">{{ uri }}</a>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Media Section -->
                <div class="flex flex-col gap-4">
                    <div class="text-2xl font-bold">Media</div>
                    <Expand :expanded="true">
                        <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                            <MediaArea :media="factoryData.defaultUniqMetadata" />
                        </div>
                    </Expand>
                </div>
            </template>
            <template v-else>
                <div class="value">No default uniq exists.</div>
            </template>
        </template>
    </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import * as I from '../../interfaces/index';
import { useRoute } from 'vue-router/auto';
import { UniqFactoryResponse } from '../../utilities/nftapi/schemas/uniqFactoryResponse';
import { formatTradabilityValue, formatTransferabilityValue, formatIfNull } from '../../utilities/formatters';
import * as NFTAPI from '../../utilities/nftapi/api';
import { UniqResponse } from '../../utilities/nftapi/schemas/uniqResponse';
import { PaginationResponse } from '../../utilities/nftapi/schemas/paginationResponse';
import { routePageEnvironment } from '../../utilities/networks';
import { BlockchainService } from '../../utilities/blockchain';

const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();
const route = useRoute('/uniqFactory/');
const props = defineProps<{ state: I.AuthState; metadata: I.RuntimeMetadata }>();

// Input fields
const factoryId = ref<number | undefined>(undefined);
const factoryIdInputKey = ref<number>(1);

// Search variables
const searchStatus = ref<'waiting' | 'success' | 'failure' | 'error'>('waiting');
const isLoading = ref<boolean>(false);
const isUniqsOfFactoryLoading = ref<boolean>(false);
const isUniqsOfFactoryResaleLoading = ref<boolean>(false);

// Tabs variables
const selectedTab = ref<'factory' | 'defaultUniq'>('factory');

// api data
const factoryData = ref<UniqFactoryResponse>(null);
const uniqsOfFactory = ref<PaginationResponse<UniqResponse> & I.DataTableType>({
    pagination: { limit: 25, skip: 0 },
    totalCount: 0,
    data: [],
    dataTable: {
        headers: [
            { text: 'Serial Number', value: 'serialNumber', sortable: true },
            { text: 'Uniq ID', value: 'id', sortable: true },
            { text: 'Uniq Name', value: 'name' },
            { text: 'Owner', value: 'owner' },
        ],
        rows: [],
    },
});
const uniqsOfFactoryResale = ref<PaginationResponse<UniqResponse> & I.DataTableType>({
    pagination: { limit: 25, skip: 0 },
    totalCount: 0,
    data: [],
    dataTable: {
        headers: [
            { text: 'Uniq ID', value: 'id', sortable: true },
            { text: 'Owner', value: 'owner' },
            { text: 'Price', value: 'price' },
            { text: 'Promoter Basis Points', value: 'basisPoints' },
        ],
        rows: [],
    },
});
const firsthandPurchases = ref<I.DataTableType>({
    dataTable: {
        headers: [
            { text: 'Index', value: 'index', sortable: true },
            { text: 'Purchase Limit', value: 'purchaseLimit' },
            { text: 'Purchased Uniqs', value: 'purchasedUniqs' },
            { text: 'Price', value: 'price' },
            { text: 'RAM Payment', value: 'ramPayment' },
        ],
        rows: [],
    },
});
const buyOffers = ref<PaginationResponse<I.SentOffer> & I.DataTableType>({
    pagination: { limit: 25, skip: 0 },
    totalCount: 0,
    data: [],
    dataTable: {
        headers: [
            { text: 'Type', value: 'type', sortable: true },
            { text: 'Offer Expiry', value: 'expiryDate', sortable: true },
            { text: 'Uniq ID', value: 'uniqId', sortable: true },
            { text: 'Offer Creator', value: 'offerCreator', sortable: true },
            { text: 'Price', value: 'price', sortable: true },
            { text: 'Status', value: 'status' },
            { text: 'Action', value: 'cancelAction' },
        ],
        rows: [],
    },
});

function updateFactoryIdInputText(id: number | null) {
    factoryId.value = id;
    factoryIdInputKey.value++;
}

function clearData() {
    factoryData.value = null;

    firsthandPurchases.value = {
        dataTable: {
            headers: firsthandPurchases.value.dataTable.headers, // so we don't change headers when refreshing data
            rows: [],
        },
    };

    uniqsOfFactory.value = {
        pagination: { limit: 25, skip: 0 },
        totalCount: 0,
        data: [],
        dataTable: {
            headers: uniqsOfFactory.value.dataTable.headers,
            rows: [],
        },
    };

    uniqsOfFactoryResale.value = {
        pagination: { limit: 25, skip: 0 },
        totalCount: 0,
        data: [],
        dataTable: {
            headers: uniqsOfFactoryResale.value.dataTable.headers,
            rows: [],
        },
    };

    buyOffers.value = {
        pagination: { limit: 25, skip: 0 },
        totalCount: 0,
        data: [],
        dataTable: {
            headers: buyOffers.value.dataTable.headers,
            rows: [],
        },
    };

    selectedTab.value = 'factory';
}

function clearSearch() {
    searchStatus.value = 'waiting';
    clearData();
    updateFactoryIdInputText(undefined);
}

async function parseQueryParams() {
    routePageEnvironment(emits, route);

    if (route.query.id) {
        updateFactoryIdInputText(parseInt(route.query.id as string));
        findFactory();
    }
}

async function fetchUniqsOfFactory(isResale: boolean) {
    let dataToPopulate = isResale ? uniqsOfFactoryResale : uniqsOfFactory;
    let isLoading = isResale ? isUniqsOfFactoryResaleLoading : isUniqsOfFactoryLoading;

    isLoading.value = true;
    const apiData = await NFTAPI.fetchUniqsOfFactory(
        factoryId.value,
        null,
        dataToPopulate.value.pagination.limit,
        dataToPopulate.value.pagination.skip,
        // If we pass 'false' instead of 'undefined' it will return only Uniqs that are strictly not listed for resale
        // Instead we want to get a list of all uniqs listed
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
                  owner: uniq.owner,
                  price: uniq.resale ? `${uniq.resale.price.amount} ${uniq.resale.price.currency.code}` : 'null',
                  basisPoints: uniq.resale
                      ? `${uniq.resale.promoterBasisPoints / 100}% (${uniq.resale.promoterBasisPoints})`
                      : 'null',
              }
            : {
                  id: parseInt(uniq.id),
                  serialNumber: parseInt(uniq.serialNumber),
                  name: formatIfNull(uniq.metadata?.content?.name),
                  owner: uniq.owner,
              };
    });

    isLoading.value = false;
}

async function fetchBuyOffers() {
    isLoading.value = true;
    const apiData = await NFTAPI.fetchFactoryOffers(
        factoryId.value,
        buyOffers.value.pagination.limit,
        buyOffers.value.pagination.skip
    );

    buyOffers.value.data.push(...apiData.data);
    buyOffers.value.pagination.skip += apiData.data.length;
    buyOffers.value.totalCount = apiData.totalCount;

    // Transform data to DataTable type
    buyOffers.value.dataTable.rows = buyOffers.value.data.map((offer) => {
        const currentDate = new Date();
        const expiryDate = new Date(offer.expiryDate);
        const status = expiryDate < currentDate ? 'EXPIRED' : 'ACTIVE';

        return {
            type: offer.type,
            expiryDate: offer.expiryDate,
            uniqId: offer.uniqId ?? '-',
            offerCreator: offer.buyer,
            price: parseFloat(offer.price.amount),
            priceUnit: offer.price.currency.code,
            status: status,
            cancelAction: {
                type: offer.type,
                factoryId: offer.uniqFactoryId,
                uniqId: offer.uniqId,
                offerId: offer.id,
                status,
                offerCreator: offer.buyer,
            },
        };
    });

    isLoading.value = false;
}

function canCancelOffer(cancelAction: any) {
    return props.state.accountName &&
        (cancelAction.status === 'EXPIRED' ||
         cancelAction.offerCreator === props.state.accountName)
}

async function handleCancelOffer(type: string, factoryId: string, uniqId: string, offerId: string) {
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

async function findFactory() {
    if (factoryId.value == undefined) {
        return;
    }
    console.log({ fid: factoryId.value });
    window.history.pushState('uniqFactory', '', `${route.path}?env=${BlockchainService.environment}&id=${factoryId.value}`);

    clearData();
    isLoading.value = true;

    try {
        // get data from NFT API
        factoryData.value = await NFTAPI.fetchUniqFactory(factoryId.value);

        if (!factoryData.value) {
            searchStatus.value = 'failure';
            isLoading.value = false;
            return;
        }

        if (factoryData.value.firsthandPurchases) {
            parseFirsthandPurchaseData();
        }

        // Comment this in if you need a `resources` example
        // if (factoryData.value && factoryData.value.metadata && factoryData.value.metadata.content) {
        //     factoryData.value.metadata.content.resources = {
        //         gallery: {
        //             contentType: 'IMAGE',
        //             integrity: {
        //                 hash: '772158341417c8a7717ae0ac4979dc821ee29072e4f3c4615d3bbf1f3f9004c4',
        //                 type: 'SHA256',
        //             },
        //             uri: 'https://static.ultra.io/uniq/original/655b5b55d4127f2dce770208/media/gallery/772158341417c8a7717ae0ac4979dc821ee29072e4f3c4615d3bbf1f3f9004c4.png',
        //         },
        //     };
        // }

        // if (
        //     factoryData.value &&
        //     factoryData.value.defaultUniqMetadata &&
        //     factoryData.value.defaultUniqMetadata.content
        // ) {
        //     factoryData.value.defaultUniqMetadata.content.resources = {
        //         gallery: {
        //             contentType: 'IMAGE',
        //             integrity: {
        //                 hash: '772158341417c8a7717ae0ac4979dc821ee29072e4f3c4615d3bbf1f3f9004c4',
        //                 type: 'SHA256',
        //             },
        //             uri: 'https://static.ultra.io/uniq/original/655b5b55d4127f2dce770208/media/gallery/772158341417c8a7717ae0ac4979dc821ee29072e4f3c4615d3bbf1f3f9004c4.png',
        //         },
        //     };
        // }

        // Comment this in if you need a dynamicResources example
        // if (
        //     factoryData.value &&
        //     factoryData.value.defaultUniqMetadata &&
        //     factoryData.value.defaultUniqMetadata.content
        // ) {
        //     factoryData.value.defaultUniqMetadata.content.dynamicResources = {
        //         test: {
        //             contentType: 'image/png',
        //             uris: [
        //                 'https://static.ultra.io/uniq/original/655b5b55d4127f2dce770208/media/gallery/772158341417c8a7717ae0ac4979dc821ee29072e4f3c4615d3bbf1f3f9004c4.png',
        //             ],
        //         },
        //         test2: {
        //             contentType: 'image/png',
        //             uris: [
        //                 'https://static.ultra.io/uniq/original/655b5b55d4127f2dce770208/media/gallery/772158341417c8a7717ae0ac4979dc821ee29072e4f3c4615d3bbf1f3f9004c4.png',
        //                 'https://static.ultra.io/uniq/original/655b5b55d4127f2dce770208/media/gallery/772158341417c8a7717ae0ac4979dc821ee29072e4f3c4615d3bbf1f3f9004c4.png',
        //             ],
        //         },
        //     };
        // }

        // Get uniqs list
        await fetchUniqsOfFactory(false);
        await fetchUniqsOfFactory(true);

        // Get buy offers
        await fetchBuyOffers();

        searchStatus.value = 'success';
    } catch (error) {
        console.error(`findUniq error: ${error}`);
        searchStatus.value = 'error';
    }

    isLoading.value = false;
}

function parseFirsthandPurchaseData() {
    firsthandPurchases.value.dataTable.rows = factoryData.value.firsthandPurchases.map((data) => {
        return {
            index: parseInt(data.id),
            purchaseLimit: formatIfNull(data.purchaseLimit),
            purchasedUniqs: data.purchasedUniqs,
            price: `${data.price.amount} ${data.price.currency.code}`,
            ramPayment: `${parseInt(data.uosPayment) / 1e8} UOS`,
            purchaseWindowStart: formatIfNull(data.purchaseWindow?.startDate),
            purchaseWindowEnd: formatIfNull(data.purchaseWindow?.endDate),
            purchaseOptionsWithUniqs: data.option
                ? data.option.factories
                      .map(
                          (fac) =>
                              `${fac.strategy} (${fac.count}x<a class="underline" target="_blank" href="/uniqFactory?id=${fac.id}">${fac.id}</a>)`
                      )
                      .join('<br>')
                : 'null',
            saleShares:
                data.saleShares && data.saleShares.length > 0
                    ? data.saleShares
                          .map(
                              (share) =>
                                  `${share.basisPoints / 100}% x <a class="underline" target="_blank" href="/user?id=${share.receiver}">${share.receiver}</a>`
                          )
                          .join('<br>')
                    : 'null',
            groupRestrictions: parseGroupRestrictions(data.groupRestriction),
        };
    });
}

function parseGroupRestrictions(restrictions: { includes: string[]; excludes: string[] }[]) {
    // Rules:
    // use | between two items (i.e; two restrictions)
    // use & between two sub-items (i.e; elements of restrictions.includes and restrictions.excludes)
    // if excludes: ~item
    // if includes: item

    if (!restrictions || restrictions.length < 1) {
        return 'null';
    }

    return restrictions
        .map(
            (restriction) =>
                restriction.excludes?.map((id) => `~${id}`).join('&') +
                (restriction.excludes?.length && restriction.includes?.length ? '&' : '') +
                restriction.includes.join('&')
        )
        .join('|');
}

function getRepeatedDataClass(data: Array<any>, index: number) {
    let classes = [];
    if (index === 0) {
        classes.push('!pt-0');
    }

    if (index === data.length - 1) {
        classes.push('!border-b-0');
        classes.push('!pb-0');
    }

    return classes;
}

function changeTabs(tab: 'factory' | 'defaultUniq') {
    if (selectedTab.value == tab) {
        return;
    }

    selectedTab.value = tab;
}

onMounted(async () => {
    parseQueryParams();

    // Check what factories exist with certain data
    // for (let i = 500; i < 1500; i++) {
    //     console.log(`Checking ${i}`);
    //     try {
    //         const fd = await NFTAPI.fetchUniqFactory(i);
    //         if (fd.metadata.content.properties) {
    //             console.log(`PROPERTY ID: ${i}`);
    //         }

    //         if (fd.metadata.content.resources && fd.metadata.content.resources.length >= 1) {
    //             console.log(`RESOURCE ID: ${i}`);
    //         }
    //     } catch (err) {
    //         if (err.toString().includes('429')) {
    //             i -= 1;
    //             console.log('Rate limited...');
    //         }
    //     }

    //     await new Promise((resolve) => {
    //         setTimeout(resolve, 10);
    //     });
    // }
});
</script>
