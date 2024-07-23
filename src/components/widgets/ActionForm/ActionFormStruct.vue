<template>
    <template v-if="props.type.metadata.isExpandable">
        <ActionFormExpand
            :title="getInputLabel()"
            :deleteIndex="props.deleteIndex"
            @deleted="deleteEntry"
            :expanded="isExpanded"
            :tooltip="props.type.metadata.description"
            :key="expandUpdateKey"
        >
            <div v-for="(param, paramIndex) in props.type.children" :key="paramIndex">
                <ActionFormField :data="props.data" :type="param" :path="[...path, param.name]" :state="props.state" />
            </div>
        </ActionFormExpand>
    </template>
    <template v-else>
        <div v-for="(param, paramIndex) in props.type.children" :key="paramIndex">
            <ActionFormField :data="props.data" :type="param" :path="[...path, param.name]" :state="props.state" />
        </div>
    </template>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ABI, FieldData } from '../../../utilities/abi';
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
        deleteIndex?: number;
        state: AuthState;
    }>(),
    {}
);

const emit = defineEmits<{ (e: 'deleted', value: number): void }>();
const isExpanded = ref(false);
let expandUpdateKey = ref<number>(1);

const deleteEntry = () => {
    emit('deleted', props.deleteIndex);
};

const getInputLabel = () => {
    if (props.deleteIndex) {
        return `${props.type.metadata.friendlyName} [${props.deleteIndex - 1}]`;
    }
    return props.type.metadata.friendlyName;
};

onMounted(() => {
    let t = props.data.getAtPath(props.path);
    if (props.type.isBinaryExtension) {
        // no need to set anything
    } else if (props.type.isOptional) {
        // for optional values must specify at least null
        if (t === undefined) props.data.setAtPath(props.path, null);
    } else {
        // for mandatory values expand automatically to show all required fields
        isExpanded.value = true;
        expandUpdateKey.value++;
        if (t === undefined) props.data.setAtPath(props.path, props.type.getDefaultValue());
    }
});
</script>
