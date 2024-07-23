<script setup lang="ts">
import { onMounted, ref } from 'vue';

defineOptions({
    inheritAttrs: false,
});

const props = withDefaults(
    defineProps<{
        label?: string;
        value?: string | number;
        placeholder?: string;
        min?: number;
        max?: number;
        disabled?: boolean;
        fill?: boolean;
        tooltip?: string;
        type?: string;
    }>(),
    {
        disabled: false,
    }
);
const emit = defineEmits<{ (e: 'updated', value: string | number): void }>();

let inputData = ref<string | number>('');

function update() {
    emit('updated', inputData.value);
}

onMounted(() => {
    inputData.value = props.value;
});
</script>

<template>
    <LabelWithTooltip :label="label" :tooltip="tooltip" />

    <input
        :type="props.type ? props.type : typeof props.value === 'number' ? 'number' : 'string'"
        :name="label"
        :placeholder="props.placeholder"
        :min="props.min"
        :max="props.max"
        :disabled="props.disabled"
        :class="props.fill ? ['fill'] : []"
        v-model="inputData"
        @input="update"
    />
</template>

<style scoped>
input {
    background: var(--vp-c-bg);
    border: 1px solid var(--vp-c-border-color);
    padding: 12px;
    box-sizing: border-box;
    font-size: 14px;
    border-radius: 3px;
    flex-grow: 1;
}

.fill {
    width: 100%;
}

input:focus {
    outline: none;
    border-color: var(--vp-c-brand);
}

label {
    padding-left: 2px;
    font-size: 12px;
    margin-top: 12px;
}
</style>
