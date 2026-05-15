<template>
    <Modal title="Select Endpoint" @close="emit('set-page-state', { showEndpoint: false })">
        <!-- Refresh Status -->
        <Button class="flex items-center text-left gap-4" @click="refreshEndpoints" v-if="!isRefreshing">
            <Icon icon="fa-refresh" />
            <span>Refresh</span>
        </Button>
        <LoadingSpinner v-if="isRefreshing" />

        <!-- Grouped Public Networks (Mainnet, Testnet) -->
        <template v-for="group in publicGroups" :key="group.name">
            <div class="pt-2 text-lg font-semibold">{{ group.name }}</div>
            <div
                v-for="endpoint in group.endpoints"
                :key="endpoint.value"
                class="flex flex-row items-center gap-2 rounded"
                :class="isActiveSelection(endpoint.value) ? 'ring-2 ring-purple-400 p-1' : ''"
            >
                <div
                    class="flex items-center justify-center w-12 h-12 rounded flex-shrink-0"
                    :class="endpoint.active ? 'bg-emerald-800' : 'bg-red-800'"
                >
                    <Icon :icon="endpoint.active ? 'fa-check' : 'fa-times'" />
                </div>
                <Button
                    :disabled="!endpoint.active"
                    class="w-full text-left flex items-center justify-between gap-2"
                    @click="endpoint.active && selectEndpoint(endpoint.value)"
                >
                    <span>{{ endpoint.value }}</span>
                    <span
                        v-if="isActiveSelection(endpoint.value)"
                        class="text-xs font-semibold uppercase text-purple-300"
                    >
                        Selected
                    </span>
                </Button>
            </div>
        </template>

        <!-- Local -->
        <template v-if="localEndpoints.length">
            <div class="pt-2 text-lg font-semibold">Local</div>
            <div
                v-for="endpoint in localEndpoints"
                :key="endpoint.value"
                class="flex flex-row items-center gap-2 rounded"
                :class="isActiveSelection(endpoint.value) ? 'ring-2 ring-purple-400 p-1' : ''"
            >
                <div
                    class="flex items-center justify-center w-12 h-12 rounded flex-shrink-0"
                    :class="endpoint.active ? 'bg-emerald-800' : 'bg-red-800'"
                >
                    <Icon :icon="endpoint.active ? 'fa-check' : 'fa-times'" />
                </div>
                <Button
                    :disabled="!endpoint.active"
                    class="w-full text-left flex items-center justify-between gap-2"
                    @click="endpoint.active && selectEndpoint(endpoint.value)"
                >
                    <span>{{ endpoint.text }} - {{ endpoint.value }}</span>
                    <span
                        v-if="isActiveSelection(endpoint.value)"
                        class="text-xs font-semibold uppercase text-purple-300"
                    >
                        Selected
                    </span>
                </Button>
            </div>
        </template>

        <!-- Custom Endpoint -->
        <div class="pt-2 text-lg font-semibold">Use Custom Endpoint</div>
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
import { SharedEmits, AuthState } from '../interfaces';
import { defaultNetworks, fetchWithTimeout } from '../utilities/networks';

interface EndpointEmits extends SharedEmits {}

const props = defineProps<{ state: AuthState }>();
const emit = defineEmits<EndpointEmits>();

function isActiveSelection(url: string) {
    return props.state.endpoint === url;
}

type EndpointStatus = { text: string; value: string; active: boolean };
type PublicGroup = { name: string; endpoints: EndpointStatus[] };

const isRefreshing = ref<boolean>(false);
const publicGroups = ref<PublicGroup[]>([]);
const localEndpoints = ref<EndpointStatus[]>([]);

const customEndpoint = ref<string>('');
const isCustomValid = ref<boolean>(false);

async function testCustomEndpoint() {
    isCustomValid.value = await isEndpointValid(customEndpoint.value);
}

async function isEndpointValid(url: string): Promise<boolean> {
    try {
        if (!isValidUrl(url)) return false;
        const request = await fetchWithTimeout(`${url}/v1/chain/get_info`);
        return !!(request && request.ok);
    } catch {
        return false;
    }
}

function isValidUrl(str: string) {
    try {
        new URL(str);
        return true;
    } catch {
        return false;
    }
}

async function selectEndpoint(url: string) {
    let endpoints = localStorage.getItem('endpoints');
    if (!endpoints) endpoints = url;
    if (!endpoints.includes(url)) endpoints += `,${url}`;
    localStorage.setItem('endpoints', endpoints);

    emit('set-endpoint', url, true);
    emit('set-page-state', { showEndpoint: false });
}

async function checkUrl(text: string, url: string): Promise<EndpointStatus> {
    const active = await isEndpointValid(url);
    return { text, value: url, active };
}

async function refreshEndpoints() {
    if (isRefreshing.value) return;

    isRefreshing.value = true;
    publicGroups.value = [];
    localEndpoints.value = [];

    const nextPublicGroups: PublicGroup[] = [];
    const nextLocal: EndpointStatus[] = [];

    await Promise.all(
        defaultNetworks.map(async (net) => {
            const isLocal = net.name.startsWith('Local');
            const endpoints = await Promise.all(net.urls.map((url) => checkUrl(net.name, url)));
            if (isLocal) {
                nextLocal.push(...endpoints);
            } else {
                nextPublicGroups.push({ name: net.name, endpoints });
            }
        })
    );

    // Preserve the order declared in defaultNetworks for public groups
    const order = defaultNetworks.filter((n) => !n.name.startsWith('Local')).map((n) => n.name);
    nextPublicGroups.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

    publicGroups.value = nextPublicGroups;
    localEndpoints.value = nextLocal;
    isRefreshing.value = false;
}

onMounted(() => {
    refreshEndpoints();
});
</script>
