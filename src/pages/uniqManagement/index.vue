<script setup lang="ts">
import * as I from '../../interfaces/index';
import { useRoute } from 'vue-router/auto';

const route = useRoute('/uniqManagement/');
const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();
</script>

<template>
    <div class="flex flex-col">
        <div class="text-3xl font-bold">Uniq Manager</div>
        <AbiRender
            :accounts="['eosio.nft.ft']"
            :actions="[
                'buy',
                'burn',
                'resell',
                'transfer',
                'cancelresell',
                'settknmeta',
                'mknftofr.a',
                'acptnftofr.a',
                'rmnftofr.a',
                'createauct.a',
                'bidauction.a',
                'settleauct.a',
                'cancelauct.a',
                'setvals.a'
            ]"
            @transact="(actions) => emits('transact', actions)"
            :state="props.state"
            :metadata="props.metadata"
        />
    </div>
</template>
