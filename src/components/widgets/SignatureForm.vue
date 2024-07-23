<template>
    <div class="flex flex-col gap-4">
        <div class="flex flex-col p-4 border rounded border-neutral-600 bg-neutral-950 gap-4">
            <div v-for="(signature, index) in signatures" :key="index" class="flex flex-col">
                <div class="flex flex-row gap-2">
                    <input
                        placeholder="actor"
                        v-model="signature.actor"
                        class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                        @input="updateSignatures"
                    />
                    <input
                        placeholder="permission"
                        v-model="signature.permission"
                        class="flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4"
                        @input="updateSignatures"
                    />
                    <Button @click="removeSignatureRequest(index)">
                        <Icon icon="fa-trash" size="sm" />
                    </Button>
                </div>
            </div>
            <Button @click="addSignatureRequest">Add New Signature Request</Button>
            <div class="text-sm font-bold">Quick Add</div>
            <div class="flex flex-row gap-4">
                <Button class="flex-grow" @click="quickAdd('self')">{{ props.state.accountName }}</Button>
                <Button v-if="showUltraAccountsInQuickAdd()" class="flex-grow" @click="quickAdd('admins')">Admins</Button>
                <Button v-if="showUltraAccountsInQuickAdd()" class="flex-grow" @click="quickAdd('props')">Props</Button>
                <Button class="flex-grow" @click="quickAdd('producers')">Producers</Button>
                <Button v-if="showUltraAccountsInQuickAdd()" class="flex-grow" @click="quickAdd('techops')">TechOps</Button>
            </div>
        </div>
    </div>
</template>

<script lang="ts" setup>
import * as UltraAPI from '@ultraos/ultra-api-lib';
import { ref, onMounted } from 'vue';
import { AuthState } from '../../interfaces';

const props = defineProps<{ signatures: Array<{ actor: string; permission: string }>; state: AuthState }>();

const emits = defineEmits<{
    (e: 'set-signatures', signatures: Array<{ actor: string; permission: string }>): void;
}>();

let signatures = ref<Array<{ actor: string; permission: string }>>([]);

function updateSignatures() {
    emits('set-signatures', JSON.parse(JSON.stringify(signatures.value)));
}

function addSignatureRequest() {
    signatures.value.push({ actor: '', permission: 'active' });
    updateSignatures();
}

function removeSignatureRequest(index: number) {
    const auths = [...signatures.value];
    auths.splice(index, 1);
    signatures.value = auths;
    updateSignatures();
}

function showUltraAccountsInQuickAdd() {
    return props.state.accountName.startsWith('ultra') || props.state.accountName.startsWith('uad');
}

function addSignatureIfMissing(actor: string, permission: string) {
    let existing = signatures.value.find((s) => s.actor == actor && s.permission == permission);
    if (!existing) {
        signatures.value.push({ actor: actor, permission: permission });
    }
}

async function quickAdd(type: 'self' | 'admins' | 'props' | 'producers' | 'techops') {

    if (type === 'self') {
        addSignatureIfMissing(props.state.accountName, props.state.accountPerm);
    }

    if (type === 'admins') {
        const adminAbbrev = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        for (let letter of adminAbbrev) {
            addSignatureIfMissing(`uad${letter}`, 'active');
        }

        return;
    }

    if (type === 'props') {
        // generates 1-5
        for (let i = 1; i <= 5; i++) {
            addSignatureIfMissing(`ultra.prop${i}`, 'active');
        }
    }

    if (type === 'producers') {
        const api = await UltraAPI.connect(props.state.endpoint);
        if (!api) {
            return;
        }

        try {
            const result = await api.chain.getProducers();
            for (let prod of result.rows) {
                addSignatureIfMissing(prod.owner, 'active');
            }
        } catch (err) {}
    }

    if (type === 'techops') {
        const techops = ['ultra.supa', 'ultra.supb'];
        for (let i = 0; i < techops.length; i++) {
            addSignatureIfMissing(techops[i], 'active');
        }
    }
}

onMounted(() => {
    if (props.signatures) {
        signatures.value = props.signatures;
    }
});
</script>
