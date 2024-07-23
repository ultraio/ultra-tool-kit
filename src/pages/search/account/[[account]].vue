<script setup lang="ts">
import { ref, onMounted } from 'vue';
import * as I from '../../../interfaces/index';

import { useRoute } from 'vue-router/auto';
import { BlockchainService } from '../../../utilities/blockchain';

const route = useRoute('/search/account/[[account]]');
const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();
const searchText = ref<string>('');
const loading = ref<boolean>(false);
const account = ref();

function updateSearch(text: string) {
    searchText.value = text;
    account.value = undefined;
}

async function searchAccount() {
    loading.value = true;

    if (searchText.value.length <= 0) {
        loading.value = false;
        return;
    }

    try {
        const result = await BlockchainService.roundRobinRequest(async () => await BlockchainService.api.account(searchText.value).get());
        account.value = JSON.stringify(result);
    } catch (err) {}

    loading.value = false;
}

onMounted(() => {
    if (!route.params.account) {
        return;
    }

    searchText.value = route.params.account;
    searchAccount();
});
</script>

<template>
    <div class="flex flex-col gap-4">
        <div class="text-2xl font-bold">Search Account</div>
        <div class="flex flex-row gap-2">
            <input
                v-model="searchText"
                placeholder="Search Account Name"
                @keyup.enter="searchAccount"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
            />
            <Button @click="searchAccount">
                <Icon icon="fa-check" class="clear-search" />
            </Button>
            <Button :disabled="searchText === ''" @click="updateSearch('')">
                <Icon icon="fa-trash" class="clear-search" />
            </Button>
        </div>
        <LoadingSpinner v-if="loading" />
        <div v-if="account && !loading" class="flex flex-col">
            <Code :code="account" />
        </div>
    </div>
</template>
