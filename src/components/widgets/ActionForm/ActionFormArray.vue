<template>
    <div :key="arrayRefreshCount">
        <ActionFormExpand
            :title="props.type.metadata.friendlyName + ` (${totalEntries} entries)`"
            :expanded="totalEntries > 0"
            :hasAdd="true"
            :tooltip="props.type.metadata.description"
            :state="props.state"
            @added="addEntry"
        >
            <div v-for="i in totalEntries" :key="i">
                <ActionFormField
                    :data="props.data"
                    :type="props.type.children[0]"
                    :path="[...path, i - 1]"
                    :deleteIndex="i"
                    :state="props.state"
                    @deleted="onDeleteEntry"
                />
            </div>
        </ActionFormExpand>
    </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { FieldData } from '../../../utilities/abi';
import { MutableObject, ObjectPath } from '../../../utilities/mutableObject';
import { AuthState } from '../../../interfaces';

defineOptions({
    inheritAttrs: false,
});

const props = withDefaults(
    defineProps<{
        data: MutableObject;
        type: FieldData;
        path: ObjectPath;
        state: AuthState;
    }>(),
    {}
);

const totalEntries = ref<number>(0);
const arrayRefreshCount = ref<number>(0);

const addEntry = () => {
    totalEntries.value++;
    arrayRefreshCount.value++;
};

const onDeleteEntry = (index: number) => {
    index--;
    props.data.setAtPath([...props.path, index], undefined);
    if (totalEntries.value > 0) totalEntries.value--;
    arrayRefreshCount.value++;
};

onMounted(() => {
    let t = props.data.getAtPath(props.path);
    if (t === undefined) props.data.setAtPath(props.path, props.type.getDefaultValue());
    else if (Array.isArray(t)) {
        totalEntries.value = t.length;
    }
});
</script>

<style scoped>
input {
    background: var(--vp-c-bg);
    border: 1px solid var(--vp-c-border-color);
    padding: 12px;
    box-sizing: border-box;
    font-size: 14px;
    border-radius: 3px;
    flex-grow: 1;
}

.fill {
    width: 100%;
}

input:focus {
    outline: none;
    border-color: var(--vp-c-brand);
}

label {
    padding-left: 2px;
    padding-bottom: 6px;
    font-size: 12px;
    margin-top: 12px;
}
</style>
