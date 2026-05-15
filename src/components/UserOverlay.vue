<template>
    <div>
        <div v-if="!props.state.accountName" class="flex flex-row w-full">
            <div
                @click="emit('set-page-state', { showLogin: true })"
                class="flex flex-grow items-center justify-center text-sm p-2 border rounded-md bg-neutral-700 border-neutral-600 cursor-pointer hover:bg-neutral-600 hover:border-neutral-500"
            >
                Login to Tool Kit
            </div>
        </div>
        <div v-else class="flex flex-col w-full items-center gap-4 select-none">
            <div class="flex flex-row w-full items-center gap-2 pr-2 pl-2">
                <img class="rounded w-8 h-8 flex-shrink-0" :src="userAvatarURL" alt="avatar" />
                <div class="flex flex-row items-center flex-grow gap-2 min-w-0">
                    <div
                        @click="copyToClipboard"
                        class="hover:text-purple-400 hover:cursor-pointer truncate"
                        :title="props.state.accountName"
                    >
                        <span>{{ wasNameCopied ? 'Copied' : displayName }}</span>
                    </div>
                </div>
            </div>
            <div
                v-if="walletBadge"
                class="flex flex-row items-center justify-center gap-2 text-xs w-full rounded border px-2 py-1"
                :class="walletBadge.classes"
            >
                <Icon :icon="walletBadge.icon" />
                <span>{{ walletBadge.label }}</span>
            </div>
            <div
                @click="emit('logout')"
                class="flex flex-grow w-full items-center justify-center text-sm p-2 border rounded-md bg-neutral-700 border-neutral-600 cursor-pointer hover:bg-neutral-600 hover:border-neutral-500"
            >
                Logout
            </div>
            <div
                v-if="isNetworkMismatch"
                class="flex flex-grow w-full items-center justify-center text-xs p-2 border rounded-md bg-amber-900 border-amber-700 text-amber-200 mt-2"
            >
                Wallet network differs from endpoint
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import * as I from '../interfaces';
import { SharedEmits } from '../interfaces';
import { fetchWithTimeout } from '../utilities/networks';

const props = defineProps<{ state: I.AuthState }>();
const custom_endpoints = ref<{ text: string; value: string }[]>([]);
const endpointChainId = ref<string | undefined>(undefined);

interface UserOverlayEmits extends SharedEmits {
    (e: 'logout'): void;
}

const emit = defineEmits<UserOverlayEmits>();

// The account-switcher dropdown was removed 2026-05-15 per the design
// directive: the wallet's selected account is authoritative, and the
// toolkit must not change it. Per-action signer choice lives in each
// transaction form's local state (e.g. transfer From dropdown), not in
// the global UserOverlay header.

const displayName = computed(() => {
    if (!props.state.accountName) return '';
    if (props.state.accountPerm && props.state.accountPerm !== 'active') {
        return `${props.state.accountName}@${props.state.accountPerm}`;
    }
    return props.state.accountName;
});

const isNetworkMismatch = computed(() => {
    // Web wallet's env is fixed at SDK construction, so mismatch isn't possible.
    if (props.state.type !== 'ultra') return false;
    if (!props.state.chainId || !endpointChainId.value) return false;
    return props.state.chainId !== endpointChainId.value;
});

const walletBadge = computed(() => {
    const base = 'bg-neutral-800 border-neutral-600 text-neutral-200';
    switch (props.state.type) {
        case 'ultra':
            return { label: 'Ultra Wallet · Extension', icon: 'fa-puzzle-piece', classes: base };
        case 'ultra-web':
            return { label: 'Ultra Wallet · Web', icon: 'fa-globe', classes: base };
        case 'anchor':
            return { label: 'Anchor', icon: 'fa-anchor', classes: base };
        case 'ledger':
            return { label: 'Ledger', icon: 'fa-microchip', classes: base };
        default:
            return null;
    }
});

const userAvatarURL = computed(() => {
    return `https://api.dicebear.com/6.x/thumbs/svg?seed=${props.state.accountName}&backgroundColor=0a5b83,1c799f,69d2e7,f1f4dc,f88c49,d1d4f9,c0aede,b6e3f4,ffd5dc,ffdfbf&backgroundType=solid,gradientLinear`;
});

let wasNameCopied = ref<boolean>(false);

function copyToClipboard() {
    navigator.clipboard.writeText(props.state.accountName);
    wasNameCopied.value = true;

    setTimeout(() => {
        wasNameCopied.value = false;
    }, 1000);
}

onMounted(async () => {
    const endpoints = localStorage.getItem('endpoints');
    if (endpoints && endpoints.length > 0) {
        custom_endpoints.value = endpoints.split(',').map((x) => {
            return { text: x, value: x };
        });
    }

    // Fetch endpoint chain ID for network mismatch detection
    if (props.state.endpoint) {
        try {
            const res = await fetchWithTimeout(`${props.state.endpoint}/v1/chain/get_info`);
            if (res?.ok) {
                const info = await res.json();
                endpointChainId.value = info.chain_id;
            }
        } catch {
            // Non-critical
        }
    }
});
</script>
