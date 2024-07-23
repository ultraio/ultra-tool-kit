<template>
    <Modal title="Ledger Guide" @close="closeHelp">
        <span>Setting up Ledger requires a functional Ledger device and EOS application installed on it</span>
        <Button>
            <a href="https://www.ledger.com/" target="_blank" class="flex items-center justify-center">
                Purchase Ledger
            </a>
        </Button>

        <div class="flex flex-col gap-2 mt-2">
            <span class="font-bolder font-bold">Ledger EOS app setup</span>
            <span class="mb-2"
                >Follow instructions provided with your Ledger device and ensure you install the companion application
                <a href="https://www.ledger.com/ledger-live" target="_blank" class="text-purple-400">
                    Ledger Live
                </a></span
            >
            <span class="mb-2"
                >You need to install EOS application by opening "My Ledger" page within Ledger Live and searching for
                Eos (EOS) application</span
            >
            <span class="mb-2"
                >After you install Eos (EOS) application you will need to head into settings on the Ledger and set
                "Contract data" setting to be allowed</span
            >
        </div>
        <div class="flex flex-col gap-2">
            <span class="font-bolder font-bold">Video Guide</span>
            <Expand>
                <div class="p-4 bg-neutral-950 rounded">
                    <video controls>
                        <source src="/help/ledger/ledger-guide.webm" type="video/webm" />
                        Download the <a href="/help/ledger/ledger-guide.webm">WEBM</a> video.
                    </video>
                </div>
            </Expand>
        </div>
        <div class="flex flex-col gap-2">
            <span class="font-bolder font-bold">Enabling contract data</span>
            <Expand>
                <div class="p-4 bg-neutral-950 rounded">
                    <span class="mb-2">1) Select and open Eos application</span>
                    <img class="mt-2" src="/help/ledger/ledger1.jpg" />
                    <br />
                    <span class="mb-2">2) Navigate to settings page</span>
                    <img class="mt-2" src="/help/ledger/ledger2.jpg" />
                    <br />
                    <span class="mb-2">3) Set "Contract data" to be allowed</span>
                    <img class="mt-2" src="/help/ledger/ledger3.jpg" />
                </div>
            </Expand>
        </div>
        <Button @onClick="closeHelp">Close</Button>
    </Modal>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
const emits = defineEmits<{ (e: 'close') }>();

function closeHelp() {
    emits('close');
}

onMounted(async () => {});
</script>
