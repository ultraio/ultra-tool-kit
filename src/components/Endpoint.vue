<template>
    <Modal title="Select Endpoint" @close="emit('set-page-state', { showEndpoint: false })">
        <!-- Refresh Status -->
        <Button class="flex items-center text-left gap-4" @click="refreshEndpoints" v-if="!isRefreshing">
            <Icon icon="fa-refresh" />
            <span>Refresh</span>
        </Button>
        <LoadingSpinner v-if="isRefreshing" />
        <!-- Active Endpoints -->
        <div v-for="endpoint in activeEndpoints" class="flex flex-row items-center gap-2">
            <div class="flex items-center justify-center w-12 h-12 bg-emerald-800 rounded">
                <Icon icon="fa-check" />
            </div>
            <Button class="w-full text-left" @click="selectEndpoint(endpoint.value)"
                >{{ endpoint.text }} - {{ endpoint.value }}</Button
            >
        </div>
        <!-- Inactive Endpoints -->
        <div v-for="endpoint in inactiveEndpoints" class="flex flex-row items-center gap-2">
            <div class="flex items-center justify-center w-12 h-12 bg-red-800 rounded">
                <Icon icon="fa-times" />
            </div>
            <Button :disabled="true" class="w-full text-left">{{ endpoint.text }} - {{ endpoint.value }}</Button>
        </div>
        <!-- Custom Endpoint -->
        <div class="pt-2 text-lg">Use Custom Endpoint</div>
        <div class="flex flex-row justify-between w-full gap-4">
            <input
                v-model="customEndpoint"
                placeholder="http://localhost:8888"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4"
                @input="testCustomEndpoint"
            />
            <template v-if="!isCustomValid">
                <Button :disabled="true">
                    <Icon icon="fa-spinner" size="1x" spin />
                </Button>
            </template>
            <template v-else>
                <Button @click="selectEndpoint(customEndpoint)">
                    <Icon icon="fa-check" />
                </Button>
            </template>
        </div>
    </Modal>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { SharedEmits, PageState } from '../interfaces';
import { defaultNetworks, fetchWithTimeout } from '../utilities/networks';

interface EndpointEmits extends SharedEmits {}

const emit = defineEmits<EndpointEmits>();

let isRefreshing = ref<boolean>(false);
let activeEndpoints = ref<{ text: string; value: string }[]>([]);
let inactiveEndpoints = ref<{ text: string; value: string }[]>([]);
let hiddenEndpoints = ref<{ text: string; value: string }[]>([]);

let customEndpoint = ref<string>('');
let isCustomValid = ref<boolean>(false);

async function testCustomEndpoint() {
    isCustomValid.value = await isEndpointValid(customEndpoint.value);
}

async function isEndpointValid(url: string): Promise<boolean> {
    try {
        if (!isValidUrl(url)) {
            return false;
        }

        const request = await fetchWithTimeout(`${url}/v1/chain/get_info`);
        if (!request || !request.ok) {
            return false;
        }

        return true;
    } catch (err) {}

    return false;
}

const isValidUrl = (str: string) => {
    try {
        new URL(str);
        return true;
    } catch (err) {
        return false;
    }
};

async function selectEndpoint(url: string) {
    let endpoints = localStorage.getItem('endpoints');

    if (!endpoints) {
        endpoints = url;
    }

    if (!endpoints.includes(url)) {
        endpoints += `,${url}`;
    }

    localStorage.setItem('endpoints', endpoints);

    emit('set-endpoint', url, true);
    emit('set-page-state', { showEndpoint: false });
}

async function refreshEndpoints() {
    if (isRefreshing.value) {
        return;
    }

    isRefreshing.value = true;
    activeEndpoints.value = [];
    inactiveEndpoints.value = [];
    hiddenEndpoints.value = [];

    const promises = defaultNetworks.map((data) => {
        return new Promise<void>(async (resolve, reject) => {
            isEndpointValid(data.urls[0]).then(async (isActive) => {
                if (isActive) {
                    if (data.name === 'Diablo') hiddenEndpoints.value.push({ text: data.name, value: data.urls[0] }); 
                    else activeEndpoints.value.push({ text: data.name, value: data.urls[0] });
                } else {
                    // if it's a public endpoint, retry with other URLs
                    if (data.isPublic) {
                        let success = false;
                        for (const url of data.urls.slice(1)) {
                            console.log(`Retrying for ${data.name} with url: ${url}`);
                            const _isActive = await isEndpointValid(url); // non-parallel request
                            if (_isActive) {
                                activeEndpoints.value.push({ text: data.name, value: url });
                                success = true;
                                break;
                            }
                        }

                        if (!success) {
                            inactiveEndpoints.value.push({ text: data.name, value: data.urls[0] });
                        }
                    }
                    // if not a public endpoint, and it's not active, don't add it to active/inactive list because we don't want to display it
                }
                resolve();
            });
        });
    });

    await Promise.all(promises);

    // hide Diablo network manually
    if (activeEndpoints.value.find((e) => e.text == 'Dev' || e.text == 'QA')) {
        let diablo = hiddenEndpoints.value.find((e) => e.text == 'Diablo');
        if (diablo) activeEndpoints.value.push(diablo);
    }
    isRefreshing.value = false;
}

onMounted(() => {
    refreshEndpoints();
});
</script>
