<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { MetadataTableEntry } from '../../interfaces';

defineOptions({
    inheritAttrs: false,
});

const rowClass = ref<string>('');

const props = withDefaults(
    defineProps<{
        fields?: MetadataTableEntry[];
        collapsible?: boolean;
    }>(),
    {}
);

onMounted(() => {
    if (props.fields.length > 0 && props.fields[0].name) {
        rowClass.value = 'split-grid';
    } else {
        rowClass.value = 'no-split-grid';
    }
});
</script>

<template>
    <template v-if="collapsible">
        <Expand :expanded="true">
            <div class="form-wrapper">
                <template v-if="props.fields.length >= 1">
                    <div v-for="(param, paramIndex) in props.fields" :key="paramIndex" :class="rowClass">
                        <MetadataTableRow :row="param" />
                    </div>
                </template>
            </div>
        </Expand>
    </template>
    <template v-else>
        <div class="form-wrapper">
            <template v-if="props.fields.length >= 1">
                <div v-for="(param, paramIndex) in props.fields" :key="paramIndex" :class="rowClass">
                    <MetadataTableRow :row="param" />
                </div>
            </template>
        </div>
    </template>
</template>

<style scoped>
.form-wrapper {
    padding: 12px;
    box-sizing: border-box;
    background: var(--vp-c-bg-alt);
    border: 1px solid var(--vp-c-border-color);
    border-radius: 6px;
    margin-top: 0px;
}

.split-grid {
    display: grid;
    grid-template-columns: 1fr 4fr;
    width: 100%;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    box-sizing: border-box;
    margin-right: 12px;
}

.no-split-grid {
    display: grid;
    grid-template-columns: 1fr;
    width: 100%;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    box-sizing: border-box;
    margin-right: 12px;
}

.value {
    background: var(--vp-c-bg);
    border: 1px solid var(--vp-c-border-color);
    padding: 12px;
    box-sizing: border-box;
    font-size: 14px;
    border-radius: 3px;
    flex-grow: 1;
}

.label {
    padding-left: 2px;
    padding-bottom: 6px;
    font-size: 12px;
    margin-top: 12px;
}

.opened {
    padding-bottom: 12px;
}

.opened,
.closed {
    cursor: pointer;
}

.expandable {
    width: 100%;
    background: var(--vp-c-bg2);
    border-radius: 6px;
}

.expand-box {
    border: 1px solid var(--vp-c-border-color);
    border-radius: 6px;
    padding: 12px;
    box-sizing: border-box;
    user-select: none;
}

.expand-box:has(.closed:hover) {
    border-color: var(--vp-c-brand);
}

.expand-box:has(.opened:hover) {
    border-color: var(--vp-c-brand);
}
</style>
