<template>
    <div class="flex flex-col gap-4">
        <Expand :title="'Authorizers for ' + props.action.contract + '::' + props.action.action">
            <div class="flex flex-col p-4 border rounded border-neutral-600 bg-neutral-950 gap-4">
                <div v-for="(authorizer, index) in authorizers" :key="index" class="flex flex-col gap-2">
                    <div class="flex flex-row gap-2">
                        <select
                            v-if="walletAccounts.length > 0"
                            :value="matchOption(authorizer)"
                            @change="(e) => onPickOption(index, (e.target as HTMLSelectElement).value)"
                            class="rounded bg-neutral-950 text-neutral-200 pl-2 pr-2 border border-neutral-700 focus:outline-none"
                            :title="'Pick an account from the connected wallet'"
                        >
                            <option value="">— Custom —</option>
                            <option v-for="opt in walletAccounts" :key="opt.accountName" :value="opt.accountName">
                                {{ opt.accountName }}
                            </option>
                        </select>
                        <input
                            placeholder="actor"
                            v-model="authorizer.actor"
                            :list="'auth-actor-options-' + props.index + '-' + index"
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
                        <datalist :id="'auth-actor-options-' + props.index + '-' + index">
                            <option v-for="opt in walletAccounts" :key="opt.accountName" :value="opt.accountName" />
                        </datalist>
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
import { useWalletAccounts } from '../../wallets/wallet-accounts';

const props = defineProps<{
    action: I.Action;
    index: number;
    authorizers: Array<{ actor: string; permission: string }>;
}>();

const emits = defineEmits<{
    (e: 'set-authorizer', index: number, authorizers: Array<{ actor: string; permission: string }>): void;
}>();

// Deduplicated, network-filtered list (one entry per account on the current chain).
const { validatedAccounts: walletAccounts } = useWalletAccounts();

let authorizers = ref<Array<{ actor: string; permission: string }>>([]);

function matchOption(authorizer: { actor: string; permission: string }) {
    return walletAccounts.value.some((a) => a.accountName === authorizer.actor)
        ? authorizer.actor
        : '';
}

function onPickOption(rowIndex: number, accountName: string) {
    if (!accountName) return;
    const opt = walletAccounts.value.find((a) => a.accountName === accountName);
    if (!opt) return;
    authorizers.value[rowIndex].actor = opt.accountName;
    if (!authorizers.value[rowIndex].permission) {
        authorizers.value[rowIndex].permission = opt.permission;
    }
    updateAuthorizers();
}

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
