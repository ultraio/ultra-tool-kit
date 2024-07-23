<template>
    <div class="flex flex-col flex-grow w-full gap-4">
        <template v-if="mediaData.length >= 1">
            <div class="text-1xl font-bold" v-if="!isResource">Content</div>
            <div class="grid grid-cols-3 gap-4">
                <div v-for="(data, paramIndex) in mediaData" :key="paramIndex">
                    <Media :data="data" />
                </div>
            </div>
        </template>
        <template v-if="!isResource">
            <div class="text-1xl font-bold">Source(s)</div>
            <div class="grid grid-cols-3 gap-4">
                <Media v-if="media.cachedSource" :data="{ ...props.media.cachedSource, title: 'Cached Source' }" />
                <Media v-if="media.source" :data="{ ...props.media.source, title: 'Source' }" />
            </div>
        </template>
    </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { DefaultUniqMetadata, Metadata } from '../../utilities/nftapi/schemas/uniqResponse';
import { MediaDataWithIntegrity } from '../../interfaces';
import * as uniqFactoryResponse from '../../utilities/nftapi/schemas/uniqFactoryResponse';
import * as I from '../../interfaces/index';

defineOptions({
    inheritAttrs: false,
});

const props = withDefaults(
    defineProps<{
        media?: Metadata | DefaultUniqMetadata;
        collapsible?: boolean;
        isResource?: boolean;
    }>(),
    {}
);

let mediaData = ref<MediaDataWithIntegrity[]>([]);

function getMediaDataFromMetadata(data: uniqFactoryResponse.Metadata | uniqFactoryResponse.DefaultUniqMetadata) {
    const media: I.MediaDataWithIntegrity[] = [];

    if (!data.content) {
        return media;
    }

    const keyName = props.isResource ? 'resources' : 'medias';
    for (let key of Object.keys(data.content[keyName])) {
        if (!data.content[keyName][key]) {
            continue;
        }

        if (Array.isArray(data.content[keyName][key])) {
            let index = 0;
            const images = data.content[keyName][key] as I.MediaDataWithIntegrity[];
            for (let image of images) {
                media.push({ title: `${key} (${index})`, ...image });
                index += 1;
            }
        } else {
            const image = data.content[keyName][key] as I.MediaDataWithIntegrity;
            media.push({ title: `${key}`, ...image });
        }
    }

    return media;
}

onMounted(() => {
    mediaData.value = getMediaDataFromMetadata(props.media);
});
</script>
