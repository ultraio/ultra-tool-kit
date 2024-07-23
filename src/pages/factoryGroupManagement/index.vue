<template>
    <div class="flex flex-col">
        <div class="text-3xl font-bold">Factory Group Actions</div>
        <AbiRender
            :accounts="['eosio.nft.ft']"
            :actions="['addgrpfcts', 'rmgrpfcts', 'creategrp', 'deletegrp', 'updategrp']"
            @transact="(actions) => emits('transact', actions)"
            :state="props.state"
            :metadata="props.metadata"
        />
    </div>
</template>

<script setup lang="ts">
import * as I from '../../interfaces/index';
import { useRoute } from 'vue-router/auto';

const route = useRoute('/factoryGroupManagement/');
const props = defineProps<{ state: I.AuthState; metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();
</script>
