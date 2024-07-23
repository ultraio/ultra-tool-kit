<template>
    <div
        class="fixed top-0 left-0 w-screen h-screen flex items-start justify-center backdrop-blur-sm bg-black bg-opacity-80 z-10"
    >
        <div
            style="max-height: 90vh; max-width: 800px"
            class="mt-12 flex flex-col bg-neutral-800 p-6 rounded-lg drop-shadow-lg border border-neutral-700 min-w-min w-2/3 animate-slide-down"
        >
            <div class="flex justify-between items-center border-b-2 border-neutral-700 pb-4">
                <div class="text-md font-bold" v-if="props.title">
                    {{ title }}
                </div>
                <div
                    class="bg-neutral-700 p-2 pl-3 pr-3 rounded-sm border border-neutral-600 hover:border-neutral-500 hover:bg-neutral-600 hover:text-neutral-100 cursor-pointer"
                    @click="emits('close')"
                >
                    <Icon icon="fa-times" />
                </div>
            </div>
            <div class="flex flex-col pt-6 gap-4 p-6 rounded overflow-y-auto">
                <slot></slot>
            </div>
        </div>
    </div>
</template>

<script lang="ts" setup>
const props = defineProps<{ title?: string }>();
const emits = defineEmits<{ (e: 'close'): void }>();
</script>
