<script setup lang="ts">
import { ref } from 'vue';
import * as I from '../interfaces/index';
import { useRouter } from 'vue-router/auto';

const router = useRouter();
const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();
const links = ref([
    {
        title: 'Inventory',
        summary: 'Check out what Uniqs are available for your account',
        icon: 'fa-solid fa-box',
        link: undefined,
        callback: goToUserPage,
        requiresLogin: true,
    },
    {
        title: 'Tutorials',
        summary: 'A set of tutorials that can get you started building on our technology',
        icon: 'fa-solid fa-helmet-safety',
        link: 'https://developers.ultra.io/tutorials/index/',
    },
    {
        title: 'Blockchain',
        summary: 'In-depth documentation on our blockchain network and blocks producers that run it',
        icon: 'fa-solid fa-heart-pulse',
        link: 'https://developers.ultra.io/blockchain/general/',
    },
    {
        title: 'Ultra Contracts',
        summary: 'Documentation on Ultras system contracts that are already available and deployed',
        icon: 'fa-solid fa-book',
        link: 'https://developers.ultra.io/blockchain/contracts/',
    },
    {
        title: 'API',
        summary: `About Ultra's API, it's available nodes, and the REST endpoints available to developers`,
        icon: 'fa-solid fa-link',
        link: 'https://developers.ultra.io/products/chain-api',
    },
    {
        title: 'Products',
        summary: `Ultra's ecosystem is full of useful products that every developer should know about`,
        icon: 'fa-solid fa-wrench',
        link: 'https://developers.ultra.io/products/',
    },
]);

function goToUserPage() {
    router.push({
        path: `/user`,
        query: { id: props.state.accountName },
    });
}
</script>

<template>
    <div class="flex flex-col gap-4">
        <template v-for="data in links">
            <template v-if="(data.requiresLogin && props.state.accountName) || !data.requiresLogin">
                <a
                    v-if="data.link"
                    target="_blank"
                    :href="data.link"
                    class="flex flex-row items-center justify-center gap-6 p-6 border border-neutral-700 bg-neutral-800 rounded transition-all hover:border-l-8 hover:border-purple-400"
                >
                    <Icon :icon="data.icon" size="2xl" class="w-16" />
                    <div class="flex flex-col flex-grow">
                        <div class="font-bold text-lg text-neutral-400">{{ data.title }}</div>
                        <div class="text-md">{{ data.summary }}</div>
                    </div>
                </a>
                <div
                    v-else
                    @click="data.callback"
                    class="flex flex-row items-center justify-center gap-6 p-6 border border-neutral-700 bg-neutral-800 rounded cursor-pointer transition-all hover:border-l-8 hover:border-purple-400"
                >
                    <Icon :icon="data.icon" size="2xl" class="w-16" />
                    <div class="flex flex-col flex-grow">
                        <div class="font-bold text-lg text-neutral-400">{{ data.title }}</div>
                        <div class="text-md">{{ data.summary }}</div>
                    </div>
                </div>
            </template>
        </template>
    </div>
</template>
