<template>
    <div>
        <div v-if="!props.state.accountName" class="flex flex-row w-full">
            <div
                @click="emit('set-page-state', { showLogin: true })"
                class="flex flex-grow items-center justify-center text-sm p-2 border rounded-md bg-neutral-700 border-neutral-600 cursor-pointer hover:bg-neutral-600 hover:border-neutral-500"
            >
                Login to Toolkit
            </div>
        </div>
        <div v-else class="flex flex-col w-full items-center gap-4 select-none">
            <div class="flex flex-row w-full justify-between pr-2 pl-2">
                <img class="rounded w-8 h-8" :src="userAvatarURL" alt="avatar" />
                <div
                    @click="copyToClipboard"
                    class="flex flex-row items-center justify-center gap-3 hover:text-purple-400 hover:cursor-pointer"
                >
                    <span>{{ wasNameCopied ? 'Copied' : props.state.accountName }}</span>
                    <Icon :icon="wasNameCopied ? 'fa-check' : 'fa-copy'" />
                </div>
            </div>
            <div
                @click="emit('logout')"
                class="flex flex-grow w-full items-center justify-center text-sm p-2 border rounded-md bg-neutral-700 border-neutral-600 cursor-pointer hover:bg-neutral-600 hover:border-neutral-500"
            >
                Logout
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import * as I from '../interfaces';
import { SharedEmits } from '../interfaces';

const props = defineProps<{ state: I.AuthState }>();
const custom_endpoints = ref<{ text: string; value: string }[]>([]);

interface EndpointEmits extends SharedEmits {
    (e: 'logout'): void;
}

const emit = defineEmits<EndpointEmits>();

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

onMounted(() => {
    let endpoints = localStorage.getItem('endpoints');
    if (!endpoints || endpoints.length <= 0) {
        return;
    }

    custom_endpoints.value = endpoints.split(',').map((x) => {
        return { text: x, value: x };
    });
});
</script>
