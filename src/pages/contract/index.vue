<template>
    <div class="flex flex-col">
        <template v-if="getActions">
            <AbiRender
                :accounts="[getAccountName]"
                :actions="getActions"
                @transact="(actions) => emits('transact', actions)"
                :state="props.state"
                :metadata="props.metadata"
            />
        </template>
        <template v-else>
            <AbiRender
                :accounts="[getAccountName]"
                @transact="(actions) => emits('transact', actions)"
                :state="props.state"
                :metadata="props.metadata"
            />
        </template>
    </div>
</template>

<script setup lang="ts">
import { onMounted, computed } from 'vue';
import * as I from '../../interfaces/index';
import { useRoute } from 'vue-router/auto';

const route = useRoute('/contract/');

const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();

const getAccountName = computed(() => {
    if (!route.query.account) {
        return 'eosio';
    }

    return route.query.account;
});

const getActions = computed(() => {
    console.log(route.query);

    if (!route.query.actions) {
        return undefined;
    }

    if (Array.isArray(route.query.actions)) {
        return route.query.actions;
    }

    return route.query.actions.split(',');
});

onMounted(() => {});
</script>
