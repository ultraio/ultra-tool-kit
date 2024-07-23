<script setup lang="ts">
import { ref, computed } from 'vue';

const emit = defineEmits<{ (e: 'onClick'): void }>();
const props = defineProps<{ disabled?: boolean; pressed?: boolean; selected?: boolean }>();

function update() {
    if (props.disabled) {
        return;
    }

    emit('onClick');
}

const getClasses = computed(() => {
    const classes = [];

    if (props.disabled) {
        classes.push('disabled');
    }

    if (props.pressed) {
        classes.push('pressed');
    }

    if (props.selected) {
        classes.push('selected');
    }

    return classes;
});
</script>

<template>
    <button @click="update" :class="getClasses" type="button">
        <slot></slot>
    </button>
</template>

<style scoped>
button {
    display: flex;
    gap: 12px;
    justify-content: center;
    align-items: center;
    outline: none;
    width: 95%;
    background: #0000;
    border: #0000;
    border-bottom: #0000;
    font-family: 'Inter';
    font-size: 14px;
    font-weight: 400;
    padding: 12px;
    box-sizing: border-box;
    border-radius: 3px;
    cursor: pointer;
    margin-top: 12px;
    user-select: none !important;
}

button:hover {
    border-color: var(--vp-c-brand);
}

button.selected {
    border-radius: 5px 5px 0 0;
    border-bottom: 2px solid var(--vp-c-brand-dark);
    z-index: 2;
}

button:active {
    transform: scale(0.98);
    transition: all 0.1s;
}

.disabled {
    cursor: unset;
}

.disabled:hover {
    cursor: unset;
}

.disabled:active {
    transform: unset !important;
    transition: unset !important;
}

.pressed {
    background: var(--vp-c-brand-darker);
}
</style>
