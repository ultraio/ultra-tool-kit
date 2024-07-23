<template>
    <label
        v-if="props.label"
        @mouseenter="showToolTip = true"
        @mouseleave="showToolTip = false"
        class="flex flex-row items-center h-8 w-full"
    >
        <span :class="!showToolTip && props.tooltip ? ['border-b border-dotted cursor-pointer'] : ['w-full']">
            {{ showToolTip && props.tooltip ? props.tooltip : props.label }}
        </span>
    </label>
</template>

<script setup lang="ts">
import { ref } from 'vue';

defineOptions({
    inheritAttrs: false,
});

const props = withDefaults(defineProps<{ label?: string; tooltip?: string; isHeading?: boolean }>(), {});
let showToolTip = ref(false);
</script>
