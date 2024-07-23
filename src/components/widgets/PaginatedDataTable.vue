<template>
    <div class="flex flex-col gap-4">
        <div class="text-2xl font-bold">
            {{ title }}
        </div>
        <div v-if="paginatedData.data.length == 0">
            <p class="text-sm">No {{ title }} found</p>
        </div>
        <Expand v-if="paginatedData.data.length >= 1" :expanded="true">
            <div class="bg-neutral-800 p-4 rounded border border-neutral-700">
                <div :class="`grid grid-cols-1 gap-4 text-left p-4 bg-neutral-800 rounded`">
                    <div :class="`grid grid-cols-${columns.length} gap-4 col-span-4 border-b pb-2 border-neutral-600`">
                        <template v-for="row in columns">
                            <div class="text-sm font-bold">{{ row }}</div>
                        </template>
                    </div>
                    <div
                        v-for="data in paginatedData.data"
                        :class="`grid gap-4 grid-cols-${columns.length} col-span-4 pb-4 border-b border-neutral-600`"
                    >
                        <slot :data="data"></slot>
                    </div>
                </div>
                <Button
                    :disabled="paginatedData.totalCount == paginatedData.data.length || isLoading"
                    @onClick="update"
                    class="w-full mt-6"
                >
                    {{
                        isLoading ? 'Loading...' : `Load More (${paginatedData.totalCount - paginatedData.data.length})`
                    }}
                </Button>
            </div>
        </Expand>
    </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { PaginationResponse } from '../../utilities/nftapi/schemas/paginationResponse';

defineOptions({
    inheritAttrs: false,
});
const emit = defineEmits<{ (e: 'onClick'): void }>();

const props = withDefaults(
    defineProps<{
        title: string;
        paginatedData: PaginationResponse<any>;
        isLoading: boolean;
        columns: string[];
    }>(),
    {}
);

onMounted(() => {});

function update() {
    emit('onClick');
}
</script>
