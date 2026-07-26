<template>
    <div class="flex flex-col mt-3 gap-2">
        <LabelWithTooltip :label="getInputLabel()" :tooltip="props.type.metadata.description" />
        <div class="flex flex-row h-12 gap-4">
            <input
                :placeholder="props.type.type"
                v-model="inputValue"
                @input="() => onUpdate(inputValue)"
                :list="accountListId"
                class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
            />

            <datalist v-if="isNameField && walletAccountNames.length > 0" :id="accountListId">
                <option v-for="name in walletAccountNames" :key="name" :value="name" />
            </datalist>

            <div v-if="isNameField && walletAccountNames.length > 1" class="relative h-12">
                <select
                    :value="''"
                    @change="(e) => onPickAccount((e.target as HTMLSelectElement).value)"
                    class="appearance-none h-full rounded bg-neutral-700 text-neutral-200 pl-4 pr-8 border border-neutral-600 focus:outline-none cursor-pointer"
                    :title="'Pick a wallet account'"
                >
                    <option value="" disabled>{{ inputValue || 'Wallet account' }}</option>
                    <option v-for="name in walletAccountNames" :key="name" :value="name">{{ name }}</option>
                </select>
                <Icon
                    icon="fa-chevron-down"
                    size="xs"
                    class="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-neutral-400"
                />
            </div>

            <Button
                v-else-if="
                    isNameField &&
                    props.state.accountName &&
                    props.state.accountName !== '' &&
                    inputValue !== props.state.accountName
                "
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
import { onMounted, ref, computed } from 'vue';
import { FieldData } from '../../../utilities/abi';
import { MutableObject, ObjectPath } from '../../../utilities/mutableObject';
import { AuthState } from '../../../interfaces';
import { useWalletAccounts } from '../../../wallets/wallet-accounts';

defineOptions({
    inheritAttrs: false,
});

const props = withDefaults(
    defineProps<{ data: MutableObject; type: FieldData; path: ObjectPath; deleteIndex?: number; state: AuthState }>(),
    {}
);
const emit = defineEmits<{ (e: 'deleted', value: number): void }>();
const inputValue = ref('');

const { validatedAccounts } = useWalletAccounts();

const isNameField = computed(() => props.type.type.includes('name'));

const walletAccountNames = computed(() => validatedAccounts.value.map((a) => a.accountName));

const accountListId = computed(() => `accounts-${props.path.join('-') || 'root'}-${props.deleteIndex ?? 'x'}`);

function onPickAccount(value: string) {
    if (!value) return;
    setValue(value);
}

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
