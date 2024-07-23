<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router/auto';
import { BlockchainService } from '../../utilities/blockchain';
import * as I from '../../interfaces/index';

const route = useRoute('/blacklist/');
const props = defineProps<{ state: I.AuthState; metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();
const blacklistedAccounts = ref<I.BlacklistedAccount[]>([]);
const searchText = ref<string>('');
const loading = ref<boolean>(false);
const updatedBanLevel = ref<string>('0');
const newBanLevel = ref<string>('1');
const accountToBan = ref<string>('');
const banLevels = [
    { text: '0 (Unban)', value: '0' },
    { text: '1 (Greylist)', value: '1' },
    { text: '2 (Blacklist)', value: '2' },
];

async function getBlacklist() {
    if (!props.state.isAdmin) {
        return;
    }

    loading.value = true;
    blacklistedAccounts.value = await BlockchainService.getBlackList();
    loading.value = false;
}

const updateSearch = async (text: string) => {
    searchText.value = text;
};

const filteredBlacklistedAccs = computed(() => {
    if (!searchText.value || searchText.value === '') {
        return blacklistedAccounts.value;
    }

    return blacklistedAccounts.value.filter((x) => x.account.includes(searchText.value));
});

const handleUpdate = (acc: I.BlacklistedAccount) => {
    const action = [
        {
            contract: 'eosio',
            action: 'setacblcklst',
            data: {
                account: acc.account,
                level: updatedBanLevel.value,
            },
            authorization: [
                {
                    actor: 'ultra.eosio',
                    permission: 'active',
                },
            ],
        },
    ];

    emits('transact', action);
};

const handleSubmit = () => {
    const action = [
        {
            contract: 'eosio',
            action: 'setacblcklst',
            data: {
                account: accountToBan,
                level: newBanLevel.value,
            },
            authorization: [
                {
                    actor: 'ultra.eosio',
                    permission: 'active',
                },
            ],
        },
    ];

    emits('transact', action);
};

// Listens to any changes in the AuthState from parent component (App.vue);
// Will trigger when a user logs in
watch(
    () => props.state,
    (currentValue, oldValue) => {
        console.log('Watch props.state function called with args:', oldValue.accountName, currentValue.accountName);
        if (currentValue.accountName && currentValue.isAdmin) {
            getBlacklist();
        }
    },
    {
        deep: true,
    }
);

onMounted(async () => {
    // Only get blacklistedAccs after user logs in
    if (props.state.accountName && props.state.isAdmin) {
        getBlacklist();
    }
});
</script>

<template>
    <h2>Blacklist</h2>
    <div v-if="props.state.accountName">
        <!-- New blacklist section -->
        <Expand :title="`Blacklist New Account`" :icon="`fa-add`">
            <form @submit.prevent="handleSubmit">
                <div class="split-grid">
                    <label>Account</label>
                    <input type="string" placeholder="1aa2aa3aa4aa" v-model="accountToBan" />
                    <label>Ban Level</label>
                    <div class="selection">
                        <select v-model="newBanLevel">
                            <option
                                v-for="(banLevel, index) in banLevels.filter((l) => l.value != '0')"
                                :key="index"
                                :value="banLevel.value"
                            >
                                {{ banLevel.text }}
                            </option>
                        </select>
                    </div>
                </div>
                <Button type="submit">Submit</Button>
            </form>
        </Expand>
        <br />

        <!-- Search section -->
        <div class="search-container">
            <Input type="text" placeholder="Search..." :value="searchText" @updated="updateSearch" />
            <Icon v-if="searchText !== ''" icon="fa-close" class="clear-search" @click="updateSearch('')" />
        </div>

        <!-- Black/greylisted accounts section -->
        <div>
            <div v-for="acc in filteredBlacklistedAccs" class="mt-2">
                <Expand :title="`${acc.account} - ${acc.level == '1' ? '[Greylisted]' : '[Blacklisted]'}`">
                    <div class="container">
                        <form @submit.prevent="handleUpdate(acc)">
                            <h4>Update Ban Level</h4>
                            <div class="split-grid">
                                <Input
                                    type="text"
                                    :name="`account`"
                                    :placeholder="`1aa2aa3aa4aa`"
                                    :value="acc.account"
                                    :disabled="true"
                                    :label="`Account`"
                                />
                                <label>Ban Level</label>
                                <div class="selection">
                                    <select v-model="updatedBanLevel">
                                        <option
                                            v-for="(banLevel, index) in banLevels.filter((l) => l.value != acc.level)"
                                            :key="index"
                                            :value="banLevel.value"
                                        >
                                            {{ banLevel.text }}
                                        </option>
                                    </select>
                                </div>
                            </div>
                            <Button type="submit">Update</Button>
                        </form>
                    </div>
                </Expand>
            </div>
            <p v-if="filteredBlacklistedAccs.length == 0 && !loading">No blacklist/greylist accounts found.</p>
            <LoadingSpinner v-if="loading"></LoadingSpinner>
        </div>
    </div>
    <div v-else>
        <p>You are not currently logged in, please log in to view blacklist.</p>
    </div>
</template>

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

input:focus {
    outline: none;
    border-color: var(--vp-c-brand);
}
.selection {
    position: relative;
    font-family: 'Inter';
}

.selection select {
    display: grid;
    outline: none;
    width: 100%;
    background: var(--vp-c-bg);
    border: 1px solid var(--vp-c-border-color);
    padding: 12px;
    box-sizing: border-box;
    border-radius: 3px;
    cursor: pointer;
}

.selection select option {
    padding: 12px;
}

.selection select::-ms-expand {
    display: none;
}

form {
    padding: 24px;
    box-sizing: border-box;
    background: var(--vp-c-bg-alt);
    border: 1px solid var(--vp-c-border-color);
    border-radius: 6px;
    margin-top: 12px;
}

label {
    padding-left: 2px;
    padding-bottom: 6px;
    font-size: 12px;
    margin-top: 12px;
}

.split-grid {
    display: grid;
    grid-template-columns: 1fr 2fr;
    width: 100%;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    box-sizing: border-box;
    margin-right: 12px;
}

.stack {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    width: 100%;
}

.stack:deep(input) {
    width: 100%;
}

.action-overview {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--vp-c-border-color);
    box-sizing: border-box;
    border-radius: 6px;
    user-select: none;
}

.proposal .key-values {
    margin-top: 20px;
}

.proposal .key-values .key-value {
    border-radius: 6px;
    display: flex;
    justify-content: space-between;
}

.proposal .key-values .key-value:nth-child(odd) {
    background: rgba(255, 255, 255, 0.05);
}

.proposal .key-values .key-value > figure:nth-child(1) {
    text-align: left;
    font-size: 13px;
}

.proposal .key-values .key-value > figure:nth-child(2) {
    text-align: right;
    font-size: 12px;
    font-weight: 800;
}

.split {
    display: flex;
    flex-direction: row;
    gap: 12px;
}

.search-container {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    background: var(--vp-c-bg-alt);
    border: 1px solid var(--vp-c-border-color);
    padding: 12px;
    box-sizing: border-box;
    border-radius: 3px;
    margin-top: 6px;
}

.search-container:deep(input) {
    width: 100%;
    flex-grow: 1 !important;
}

.clear-search {
    padding-left: 12px;
    padding-right: 12px;
    box-sizing: border-box;
    cursor: pointer;
    transition: all 0.1s;
}

.clear-search:hover {
    transform: scale(1.1);
}
</style>
