<template>
    <div class="flex flex-col gap-4">
        <Expand :title="'Authorizers for ' + props.action.contract + '::' + props.action.action">
            <div class="flex flex-col p-4 border rounded border-neutral-600 bg-neutral-950 gap-4">
                <div v-for="(authorizer, index) in authorizers" :key="index" class="flex flex-col">
                    <div class="flex flex-row gap-2">
                        <input
                            placeholder="actor"
                            v-model="authorizer.actor"
                            class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                            @input="updateAuthorizers"
                        />
                        <input
                            placeholder="permission"
                            v-model="authorizer.permission"
                            class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                            @input="updateAuthorizers"
                        />
                        <Button @click="removeAuthorizer(index)">
                            <Icon icon="fa-trash" size="sm" />
                        </Button>
                    </div>
                </div>
                <Button @click="addAuthorizer"> Add Authorizer </Button>
            </div>
        </Expand>
    </div>
</template>

<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import * as I from '../../interfaces/index';

const props = defineProps<{
    action: I.Action;
    index: number;
    authorizers: Array<{ actor: string; permission: string }>;
}>();

const emits = defineEmits<{
    (e: 'set-authorizer', index: number, authorizers: Array<{ actor: string; permission: string }>): void;
}>();

let authorizers = ref<Array<{ actor: string; permission: string }>>([]);

function updateAuthorizers() {
    emits('set-authorizer', props.index, JSON.parse(JSON.stringify(authorizers.value)));
}

function addAuthorizer() {
    authorizers.value.push({ actor: '', permission: '' });
}

function removeAuthorizer(index: number) {
    const auths = [...authorizers.value];
    auths.splice(index, 1);
    authorizers.value = auths;
    updateAuthorizers();
}

onMounted(() => {
    if (props.authorizers) {
        authorizers.value = props.authorizers;
    }
});
</script>
