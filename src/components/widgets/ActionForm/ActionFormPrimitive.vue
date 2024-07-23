<template>
    <div class="flex flex-col mt-3 gap-2">
        <LabelWithTooltip :label="getInputLabel()" :tooltip="props.type.metadata.description" />
        <div class="flex flex-row h-12 gap-4">
            <input
                :placeholder="props.type.type"
                v-model="inputValue"
                @input="() => onUpdate(inputValue)"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
            />

            <Button
                v-if="props.type.type.includes('name') && props.state.accountName && props.state.accountName !== '' && inputValue !== props.state.accountName"
                @click="setValue(props.state.accountName)"
            >
                {{ props.state.accountName }}
            </Button>

            <Button v-if="deleteIndex" @click="deleteEntry">
                <Icon icon="fa-trash" size="sm" />
            </Button>
        </div>
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
    defineProps<{ data: MutableObject; type: FieldData; path: ObjectPath; deleteIndex?: number; state: AuthState }>(),
    {}
);
const emit = defineEmits<{ (e: 'deleted', value: number): void }>();
const inputValue = ref('');

const deleteEntry = () => {
    emit('deleted', props.deleteIndex);
};

const setValue = (value: string) => {
    inputValue.value = value;
    onUpdate(value);
};

const onUpdate = (text: string) => {
    if (text.length == 0) {
        props.data.setAtPath(props.path, props.type.getDefaultValue());
    } else {
        props.data.setAtPath(props.path, text);
    }
};

const getInputLabel = () => {
    if (props.deleteIndex) {
        return `${props.type.metadata.friendlyName} [${props.deleteIndex - 1}]`;
    }
    return props.type.metadata.friendlyName;
};

const getInputCurrentValue = () => {
    let t = props.data.getAtPath(props.path);
    if (t === undefined) {
        t = props.type.getDefaultValue();
    }
    return t;
};

onMounted(() => {
    props.data.setAtPath(props.path, getInputCurrentValue());
    inputValue.value = getInputCurrentValue();
});
</script>
