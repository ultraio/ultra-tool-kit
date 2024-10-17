<template>
    <div class="flex flex-col">
        <div class="text-3xl font-bold">Factory Management</div>
        <AbiRender
            :accounts="['eosio.nft.ft']"
            :actions="[
                'authmint.b',
                'purchase',
                'clrmintst',
                'create.b',
                'issue.b',
                'lckfactory',
                'limitmint',
                'setconrecv',
                'setdflttkn',
                'setmeta.b',
                'setstatus',
                'setprchsreq.b',
                'delprchsreq.a',
                'purchase.a',
                'mkfctofr.a',
                'acptfctofr.a',
                'rmfctofr.a',
                'addkeys.a'                
            ]"
            @transact="(actions) => emits('transact', actions)"
            :state="props.state"
            :metadata="props.metadata"
        />
    </div>
</template>

<script setup lang="ts">
import * as I from '../../interfaces/index';
import { useRoute } from 'vue-router/auto';

const route = useRoute('/factoryManagement/');
const props = defineProps<{ state: I.AuthState; metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();
</script>
