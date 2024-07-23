<template>
    <template v-if="props.type.isProxyStruct">
        <ActionFormField
            :data="props.data"
            :type="props.type.children[0]"
            :path="[...props.path, props.type.children[0].name]"
            :deleteIndex="props.deleteIndex"
            :state="props.state"
            @deleted="deleteEntry"
        />
    </template>
    <template v-else>
        <template v-if="props.type.isPrimitive && !props.type.isArray">
            <ActionFormPrimitive
                :data="props.data"
                :type="props.type"
                :path="props.path"
                :deleteIndex="props.deleteIndex"
                :state="props.state"
                @deleted="deleteEntry"
            />
        </template>
        <template v-if="props.type.isArray">
            <ActionFormArray
                :data="props.data"
                :type="props.type"
                :path="props.path"
                :deleteIndex="props.deleteIndex"
                :state="props.state"
                @deleted="deleteEntry"
            />
        </template>
        <template v-if="props.type.isStruct && !props.type.isArray">
            <ActionFormStruct
                :data="props.data"
                :type="props.type"
                :path="props.path"
                :deleteIndex="props.deleteIndex"
                :state="props.state"
                @deleted="deleteEntry"
            />
        </template>
    </template>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { FieldData } from '../../../utilities/abi';
import ActionFormStruct from './ActionFormStruct.vue';
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

const emit = defineEmits<{
    (e: 'deleted', value: number): void;
}>();

const deleteEntry = () => {
    emit('deleted', props.deleteIndex);
};

onMounted(() => {});
</script>
