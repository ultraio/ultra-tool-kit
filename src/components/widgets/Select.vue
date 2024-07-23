<script setup lang="ts">
import { onMounted, ref } from 'vue';

const props = defineProps<{ value?: string; options: Array<{ text: string; value: string }> }>();
const emit = defineEmits<{ (e: 'updated', value: string): void }>();

let selectedData = ref<string>('');

function update() {
    emit('updated', selectedData.value);
}

onMounted(() => {
    selectedData.value = props.value ? props.value : props.options[0].value;
});
</script>

<template>
    <div class="selection">
        <select v-model="selectedData" @change="update">
            <option v-for="(data, index) in options" :key="index" :value="data.value">
                {{ data.text }}
            </option>
        </select>
    </div>
</template>

<style scoped>
.selection {
    position: relative;
    font-family: 'Inter';
}

.selection select {
    display: grid;
    outline: none;
    width: 100%;
    background: var(--vp-c-bg);
    border: 1px solid var(--vp-c-border-color);
    padding: 12px;
    box-sizing: border-box;
    border-radius: 3px;
    cursor: pointer;
}

.selection select option {
    padding: 12px;
}

.selection select::-ms-expand {
    display: none;
}
</style>
