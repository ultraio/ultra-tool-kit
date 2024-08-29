<template>
    <div :key="navRefreshCount" class="flex flex-col select-none text-neutral-400 font-semibold">
        <div v-for="option of links" class="pb-2 pt-2" :class="props.nested ? ['pl-6'] : []">
            <template v-if="!option.isAdmin || (option.isAdmin && props.state.isAdmin)">
                <a
                    @click="handleClick(option)"
                    :class="updateActiveLink(option)"
                    class="flex flex-row gap-3 items-center cursor-pointer hover:text-neutral-100 transition-all"
                >
                    <Icon
                        icon="fa-chevron-down"
                        class="icon w-3"
                        size="xs"
                        v-if="option.nestedOptions && expandedOptionNames.includes(option.name)"
                    />
                    <Icon
                        icon="fa-chevron-right"
                        class="icon w-3"
                        size="xs"
                        v-if="option.nestedOptions && !expandedOptionNames.includes(option.name)"
                    />
                    <span v-if="option.nestedOptions" class="flex-grow">{{ option.name }}</span>
                    <span v-else class="flex-grow" :class="activeName == option.name ? ['text-purple-400'] : []">{{
                        option.name
                    }}</span>
                </a>
                <template v-if="option.nestedOptions && expandedOptionNames.includes(option.name)">
                    <Navigation
                        :state="props.state"
                        :options="option.nestedOptions"
                        :nested="true"
                        @refresh-links="propagateRefresh()"
                        class="pt-2"
                    />
                </template>
            </template>

            <!-- Dirty hack to ensure all grid-cols-* styles are generated -->
            <div class="grid grid-cols-1"></div>
            <div class="grid grid-cols-2"></div>
            <div class="grid grid-cols-3"></div>
            <div class="grid grid-cols-4"></div>
            <div class="grid grid-cols-5"></div>
            <div class="grid grid-cols-6"></div>
            <div class="grid grid-cols-7"></div>
            <div class="grid grid-cols-8"></div>
            <div class="grid grid-cols-9"></div>
            <div class="grid grid-cols-10"></div>
            <div class="grid grid-cols-11"></div>
            <div class="grid grid-cols-12"></div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { NavigationOption } from '../interfaces';
import * as I from '../interfaces/index';
import { useRouter } from 'vue-router/auto';

const activeName = ref<string>();
const expandedOptionNames = ref<string[]>([]);
const router = useRouter();
const props = defineProps<{ state: I.AuthState; options?: NavigationOption[]; topLevel?: boolean; nested?: boolean }>();

const referenceLinks: NavigationOption[] = [
    { name: 'Home', link: '/' },
    { name: 'Transaction Builder', link: '/builder' },
    {
        name: 'Search',
        nestedOptions: [
            { name: 'Account', link: '/search/account' },
            { name: 'Table', link: '/search/table' },
        ],
    },
    {
        name: 'Uniq Actions',
        nestedOptions: [
            { name: 'Factory', link: '/factoryManagement' },
            { name: 'Uniq', link: '/uniqManagement' },
            { name: 'Factory Group', link: '/factoryGroupManagement' },
        ],
    },
    {
        name: 'Uniq Explorer',
        nestedOptions: [
            { name: 'Factory', link: '/uniqFactory' },
            { name: 'Uniq', link: '/uniq' },
            { name: 'User Uniqs', link: '/user' },
        ],
    },
    {
        name: 'Bulk Tools',
        nestedOptions: [
            { name: 'Airdrop', link: '/airdrop' },
            { name: 'Bulk Factory Creation', link: '/bulkFactoryCreation' },
            { name: 'UOS Mass Transfer', link: '/uosMassTransfer' },
        ],
    },
    { name: 'Proposals', link: '/proposals' },
    { name: 'Schema Validator', link: '/schemaValidator' },

    // Admin Links
    { name: 'Blacklist', link: '/blacklist', isAdmin: true },
];

const links = ref<NavigationOption[]>([]);
const navRefreshCount = ref<number>(0);
const emit = defineEmits<{
    (e: 'refresh-links'): void;
}>();

function removeExpandedOption(option: NavigationOption) {
    if (!option.nestedOptions) return;
    var index = expandedOptionNames.value.indexOf(option.name);
    if (index !== -1) {
        expandedOptionNames.value.splice(index, 1);
    }
}

function addExpandedOption(option: NavigationOption) {
    if (!option.nestedOptions) return;
    if (!expandedOptionNames.value.includes(option.name)) expandedOptionNames.value.push(option.name);
}

async function handleClick(option: NavigationOption) {
    if (!option.link) {
        if (expandedOptionNames.value.includes(option.name)) removeExpandedOption(option);
        else addExpandedOption(option);
        return;
    }
    // this is needed to reset the selection of a previous navigation option
    // without this the highlight is not removed correctly
    expandedOptionNames.value = [];
    activeName.value = option.name;
    router.push(option.link).then(() => {
        emit('refresh-links');
        updateActiveLink();
    });
}

function propagateRefresh() {
    if (props.topLevel) {
        navRefreshCount.value++;
        return;
    }
    emit('refresh-links');
}

/**
 * Obtain current navigation option from the list of possible options
 * based on the current document location provided in path
 *
 * @param path
 * @param optionsToCheck
 */
function findNavigationPath(path: string, optionsToCheck: NavigationOption[]) {
    for (let opt of optionsToCheck) {
        if (path === '/') {
            if (opt.link === path) return opt;
        } else if (opt.link && opt.link == path) return opt;
        else if (opt.nestedOptions) {
            let nestedOption = findNavigationPath(path, opt.nestedOptions);
            if (nestedOption) return opt;
        }
    }
    return undefined;
}

/**
 * Updates the name of the current active navigation option and
 * returns a CSS style for highlight. Effectively hacks in property
 * recalculation on component refresh
 *
 * @param option
 */
function updateActiveLink(option: NavigationOption = undefined) {
    const pathname = document.location.pathname.split('?')[0];
    let active = findNavigationPath(pathname, links.value);
    if (active) {
        activeName.value = active.name;
    }

    if (!option) {
        return;
    }

    return activeName.value === option.name && !option.nestedOptions ? ['active'] : [];
}

onMounted(() => {
    const pathname = document.location.pathname.split('?')[0];
    if (!pathname) {
        return;
    }

    if (props.options) {
        links.value = props.options;
    } else {
        links.value = referenceLinks;
    }

    updateActiveLink();

    // ensure that after page reload the active option that is under expand is visible
    let active = findNavigationPath(pathname, links.value);
    if (active) {
        addExpandedOption(active);
    }
});
</script>
