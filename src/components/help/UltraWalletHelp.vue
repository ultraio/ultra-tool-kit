<template>
    <Modal title="Ultra Wallet Guide" @close="closeHelp">
        <span>Ultra wallet requires a Chrome based browser such as Chrome, Brave, or Chromium</span>
        <Button>
            <a
                href="https://chrome.google.com/webstore/detail/ultra-wallet/kjjebdkfeagdoogagbhepmbimaphnfln"
                target="_blank"
                class="flex items-center justify-center"
            >
                Download Ultra Wallet Chrome Extension
            </a>
        </Button>
        <div class="flex flex-col gap-2">
            <span class="font-bolder font-bold">Wallet Environment</span>
            <span class="mb-2"
                >Ensure you are selecting the correct environment at the top of the wallet on login.</span
            >
            <div class="flex items-center justify-center p-4 bg-neutral-950 rounded">
                <img src="/help/ultra/version-toggle.png" />
            </div>
        </div>
        <Button @onClick="closeHelp">Close</Button>
    </Modal>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {fetchWithTimeout} from '../../utilities/networks';

const props = defineProps<{ endpoint: string }>();
let chain = ref<string>(undefined);

const emits = defineEmits<{ (e: 'close') }>();

function closeHelp() {
    emits('close');
}

onMounted(async () => {
    console.log(props.endpoint);
    if (!props.endpoint) {
        return;
    }
    const options = { method: 'GET', headers: { 'Content-Type': 'application/json' } };
    const response = await fetchWithTimeout(`${props.endpoint}/v1/chain/get_info`, options).catch((err) => {
        console.error(err);
        return undefined;
    });
    if (!response || !response.ok) {
        return;
    }
    const data: { chain_id: string } = await response.json();
    chain.value = data.chain_id;
});
</script>
