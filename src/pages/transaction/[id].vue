<script setup lang="ts">
import { onMounted, ref } from 'vue';
import * as I from '../../interfaces/index';
import { useRoute } from 'vue-router/auto';
import {fetchWithTimeout} from '../../utilities/networks';

const route = useRoute('/transaction/[id]');

const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();

const data = ref();

async function getTrxData() {
    if (!route.params.id) {
        data.value = null;
        return;
    }

    const options = {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
        },
    };

    const response = await fetchWithTimeout(`${props.state.endpoint}/v0/transactions/${route.params.id}`, options).catch((err) => {
        console.error(err);
        return undefined;
    });

    if (!response || !response.ok) {
        data.value = null;
        return;
    }

    data.value = await response.json();
}

onMounted(getTrxData);
</script>

<template>
    <h2>Transaction</h2>
    <template v-if="data">
        <Code :code="JSON.stringify(data)" />
    </template>
    <template v-else>
        <p v-if="data === null">Invalid transaction provided...</p>
        <p v-else>Fetching transaction information...</p>
    </template>
</template>
