<template>
    <div class="flex flex-col justify-center w-full gap-4">
        <!-- Description & Documentation Link -->
        <template v-if="actionField">
            <div v-if="actionField.metadata.description" class="flex flex-col w-full gap-4">
                <span class="text-xl font-bold"> Description </span>
                {{ actionField.metadata.description }}
            </div>
            <a
                target="_blank"
                :href="actionField.metadata.documentation"
                v-if="actionField.metadata.documentation"
                class="hover:text-purple-400"
            >
                <span class="underline pr-2">Documentation</span>
                <Icon icon="fa-solid fa-up-right-from-square" />
            </a>
        </template>

        <!-- Form Field -->
        <div v-if="actionField && actionField.children">
            <ActionFormField
                :data="data"
                :propertyName="props.name"
                :type="actionField"
                :path="[actionField.name]"
                :state="props.state"
            />
        </div>
        <div v-else>No parameters required for this action.</div>

        <!-- Authorization -->
        <AuthorizerForm
            :authorizers="[{actor: props.state.accountName, permission: props.state.accountPerm}]"
            :index="1"
            :action="action"
            @set-authorizer="setAuthorizer"
        />

        <!-- Action Buttons -->
        <div class="flex flex-row flex-grow w-full gap-4">
            <Button :disabled="props.state.accountName ? false : true" @onClick="addAction(true)" class="flex-grow">
                {{ userActions.length === 0 ? 'Send 1 Action' : `Send ${userActions.length + 1} Actions` }}
            </Button>
            <Button :disabled="props.state.accountName ? false : true" @onClick="addAction" class="flex-grow">
                Add Action
            </Button>
        </div>
    </div>
</template>

<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import { AuthState } from '../../../interfaces';
import { ABI, FieldData } from '../../../utilities/abi';
import { MutableObject } from '../../../utilities/mutableObject';
import * as I from '../../../interfaces/index';

const props = defineProps<{
    account: string;
    name: string;
    abi: ABI;
    state: AuthState;
    userActions: I.Action[];
}>();

const emits = defineEmits<{
    (e: 'add-action', action: I.Action, submit: boolean): void;
}>();

const data = ref<MutableObject>(new MutableObject());
const actionField = ref<FieldData>();
const action = ref<I.Action>({contract: '', action: '', data: {}, authorization: []});
let authorizers = ref<Array<{ actor: string; permission: string }>>([]);

function addAction(submit = false) {
    // Must not pass object/arrays by reference
    // https://stackoverflow.com/a/65712327/9376397
    action.value.data = { ...data.value.data[props.name] };
    emits('add-action', {...action.value}, submit);
}

function setAuthorizer(index: number, newAuths: Array<{ actor: string; permission: string }>) {
    action.value.authorization = newAuths;
}

onMounted(() => {
    actionField.value = props.abi.getActionType(props.name);
    action.value = {contract: props.account, action: props.name, data: {}, authorization: [{actor: props.state.accountName, permission: props.state.accountPerm}]};
});
</script>
