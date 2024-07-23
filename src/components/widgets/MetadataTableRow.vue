<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { MetadataTableEntry } from '../../interfaces';

defineOptions({
    inheritAttrs: false,
});

const valueClass = ref<string>();

const props = withDefaults(
    defineProps<{
        row?: MetadataTableEntry;
    }>(),
    {}
);

onMounted(() => {
    if (props.row.format && props.row.format.length > 0) {
        valueClass.value = props.row.format;
    } else {
        valueClass.value = 'value';
    }
});
</script>

<template>
    <template v-if="props.row.name">
        <span class="label">{{ props.row.name }}</span>
    </template>

    <template v-if="!props.row.isNested">
        <span :class="valueClass">{{ props.row.value }}</span>
    </template>
    <template v-else>
        <MetadataTable :fields="props.row.value" />
    </template>
</template>

<style scoped>
.value {
    background: var(--vp-c-bg);
    border: 1px solid var(--vp-c-border-color);
    padding: 12px;
    box-sizing: border-box;
    font-size: 14px;
    border-radius: 3px;
    flex-grow: 1;
    word-break: break-all;
}

.label {
    padding-left: 2px;
    padding-bottom: 6px;
    font-size: 12px;
    margin-top: 12px;
}
</style>
