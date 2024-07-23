<template>
    <div class="flex flex-col h-full">
        <Modal v-if="isContentBoxOpen" :title="data.title" @close="isContentBoxOpen = false">
            <div class="flex flex-col gap-8">
                <img :src="data.uri" v-if="mediaType == 'image'" class="rounded" />
                <video controls v-if="mediaType == 'video'">
                    <source :src="data.uri" type="video/mp4" />
                    {{ data.uri }}
                </video>

                <div class="grid grid-cols-4 gap-6 items-center">
                    <span>Content Type</span>
                    <div class="flex flex-row justify-between col-span-3 items-center gap-4">
                        <span>{{ data.contentType }}</span>
                        <Button>
                            <Icon icon="fa-copy" size="lg" @click="copyContent(data.contentType)" />
                        </Button>
                    </div>

                    <span>Integrity Type</span>
                    <div class="flex flex-row justify-between col-span-3 items-center gap-4">
                        <span>{{ data.integrity.type }}</span>
                        <Button>
                            <Icon icon="fa-copy" size="lg" @click="copyContent(data.integrity.type)" />
                        </Button>
                    </div>

                    <span>Integrity Hash</span>
                    <div class="flex flex-row justify-between col-span-3 items-center gap-4">
                        <span class="truncate">{{ data.integrity.hash }}</span>
                        <Button>
                            <Icon icon="fa-copy" size="lg" @click="copyContent(data.integrity.hash)" />
                        </Button>
                    </div>

                    <span>URI</span>
                    <div class="flex flex-row justify-between col-span-3 items-center gap-4">
                        <span class="truncate">{{ data.uri }}</span>
                        <Button>
                            <Icon icon="fa-copy" size="lg" @click="copyContent(data.uri)" />
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>

        <div class="flex flex-col items-stretch h-full gap-4">
            <div v-if="mediaType !== 'link'" class="h-full">
                <img
                    v-bind:src="data.uri"
                    :placeholder="data.uri"
                    v-if="mediaType === 'image'"
                    class="object-cover h-full rounded"
                />
                <video width="320" height="240" controls v-else-if="mediaType === 'video'">
                    <source :src="data.uri" type="video/mp4" />
                    {{ data.uri }}
                </video>
            </div>
            <div class="action" :class="mediaType === 'link' ? [] : ['mt-1']">
                <Button @click="isContentBoxOpen = true" class="flex flex-row gap-4 items-center w-full">
                    <Icon icon="fa-image" />
                    <span>{{ data.title }}</span>
                </Button>
            </div>
        </div>
    </div>
</template>

<script lang="ts" setup>
import { ref, onMounted } from 'vue';
import { MediaDataWithIntegrity } from '../../interfaces';

defineOptions({
    inheritAttrs: false,
});

const props = defineProps<{
    data: MediaDataWithIntegrity;
}>();

const mediaType = ref<string>();

const imageTypes: string[] = ['.png', '.jpg', '.jpeg', '.gif'];

const videoTypes: string[] = ['.mp4'];

let isContentBoxOpen = ref(false);

function isOfType(u: string, types: string[]) {
    const lowerCase = u.toLowerCase();
    for (let i = 0; i < types.length; i++) {
        if (lowerCase.endsWith(types[i])) {
            return true;
        }
    }
    return false;
}

function copyContent(data: string) {
    navigator.clipboard.writeText(data);
}

onMounted(() => {
    if (isOfType(props.data.uri, imageTypes)) {
        mediaType.value = 'image';
    } else if (isOfType(props.data.uri, videoTypes)) {
        mediaType.value = 'video';
    } else {
        mediaType.value = 'link';
    }
});
</script>
