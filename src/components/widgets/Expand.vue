<template>
    <div class="flex flex-col items-center justify-center rounded w-full gap-4">
        <Button @onClick="isExpanded = !isExpanded" class="w-full">
            <div class="flex flex-row items-center justify-center w-full">
                <span class="flex-grow text-left">
                    {{ props.title ? props.title : isExpanded ? 'Collapse' : 'Expand' }}
                </span>
                <Icon :icon="isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'" />
            </div>
        </Button>
        <div class="w-full" v-if="isExpanded">
            <slot></slot>
        </div>
    </div>
</template>

<script lang="ts" setup>
import { ref, onMounted } from 'vue';

defineOptions({
    inheritAttrs: false,
});

const props = defineProps<{ title?: string; expanded?: boolean }>();

let isExpanded = ref<boolean>(false);

onMounted(() => {
    if (props.expanded) {
        isExpanded.value = true;
    }
});
</script>
