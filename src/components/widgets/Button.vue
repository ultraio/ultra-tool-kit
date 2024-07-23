<template>
    <template v-if="props.primary">
        <button
            @click="update"
            type="button"
            class="p-4 pt-3 pb-3 bg-purple-400 rounded border border-neutral-600 text-sm h-12"
            :class="
                disabled
                    ? ['text-neutral-500 cursor-default']
                    : ['hover:border-neutral-500 hover:bg-neutral-600 hover:text-neutral-100 cursor-pointer']
            "
        >
            <slot></slot>
        </button>
    </template>
    <template v-else>
        <button
            @click="update"
            type="button"
            class="p-4 pt-3 pb-3 bg-neutral-700 rounded border border-neutral-600 text-sm h-12"
            :class="
                disabled
                    ? ['text-neutral-500 cursor-default']
                    : ['hover:border-neutral-500 hover:bg-neutral-600 hover:text-neutral-100 cursor-pointer']
            "
        >
            <slot></slot>
        </button>
    </template>
</template>

<script setup lang="ts">
const emit = defineEmits<{ (e: 'onClick'): void }>();
const props = defineProps<{ disabled?: boolean; pressed?: boolean; primary?: boolean }>();

function update() {
    if (props.disabled) {
        return;
    }

    emit('onClick');
}
</script>
