<template>
    <Modal title="Anchor Wallet Guide" @close="closeHelp">
        <span
            >Setting up Anchor requires a chain identifier, an endpoint, and the external Anchor Wallet
            Application.</span
        >
        <Button>
            <a href="https://www.greymass.com/anchor" target="_blank" class="flex items-center justify-center">
                Download Anchor
            </a>
        </Button>

        <div class="flex flex-col gap-2 mt-2">
            <span class="font-bolder font-bold">Chain Identifier</span>
            <span class="flex bg-neutral-950 p-4 rounded-md font-mono text-sm">{{
                chain ? chain : 'Could not fetch chain identifier...'
            }}</span>
        </div>
        <div class="flex flex-col gap-2 mt-2">
            <span class="font-bolder font-bold">Chain Endpoint</span>
            <span class="flex bg-neutral-950 p-4 rounded-md font-mono text-sm">{{ props.endpoint }}</span>
        </div>
        <div class="flex flex-col gap-2">
            <span class="font-bolder font-bold">Video Guide</span>
            <Expand>
                <div class="p-4 bg-neutral-950 rounded">
                    <video controls>
                        <source src="/help/anchor/anchor-guide.webm" type="video/webm" />
                        Download the <a href="/help/anchor/anchor-guide.webm">WEBM</a> video.
                    </video>
                </div>
            </Expand>
        </div>
        <Button @onClick="closeHelp">Close</Button>
    </Modal>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { fetchWithTimeout } from '../../utilities/networks';

const props = defineProps<{ endpoint: string }>();
let chain = ref<string>(undefined);

const emits = defineEmits<{ (e: 'close') }>();

function closeHelp() {
    console.log('closing?');
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
