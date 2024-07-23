<template>
    <div class="flex flex-col mt-4 border border-neutral-700 pl-4 pr-4 pt-2 pb-2 rounded bg-neutral-800">
        <div class="flex flex-row items-center gap-4">
            <LabelWithTooltip :label="props.title ? props.title : 'Expand'" :tooltip="tooltip" :isHeading="true" />
            <Button v-if="hasAdd" @click="emit('added')"> Add </Button>
            <Button v-if="deleteIndex" @click="emit('deleted', props.deleteIndex)">
                <Icon icon="fa-trash" size="sm" />
            </Button>
            <Button @click="isExpanded = !isExpanded" class="w-14">
                <Icon :icon="isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'" />
            </Button>
        </div>
        <div class="pb-2" v-if="isExpanded">
            <slot></slot>
        </div>
    </div>
</template>

<script lang="ts" setup>
import { ref, onMounted } from 'vue';
import { AuthState } from '../../../interfaces';

defineOptions({
    inheritAttrs: false,
});

const props = defineProps<{
    title?: string;
    expanded?: boolean;
    deleteIndex?: number;
    hasAdd?: boolean;
    tooltip?: string;
    state?: AuthState;
}>();

const emit = defineEmits<{
    (e: 'added'): void;
    (e: 'deleted', value: number): void;
}>();

let isExpanded = ref<boolean>(false);

onMounted(() => {
    if (props.expanded) {
        isExpanded.value = true;
    }
});
</script>
