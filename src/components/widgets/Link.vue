<script lang="ts" setup>
const props = defineProps<{ link?: string }>();

function open() {
    window.open(props.link);
}
</script>

<template>
    <div class="link" @click="open">
        <div class="split">
            <span>View in Explorer</span>
            <Icon icon="fa-external-link" />
        </div>
    </div>
</template>

<style scoped>
.split {
    display: flex;
    flex-direction: row;
    align-items: center;
    width: 100%;
    justify-content: space-between;
    box-sizing: border-box;
}

.link {
    width: 100%;
    border: 1px solid var(--vp-c-border-color);
    border-radius: 6px;
    padding: 12px;
    box-sizing: border-box;
    margin-top: 12px;
    margin-bottom: 12px;
}

.link:hover {
    border-color: var(--vp-c-brand-dark);
    cursor: pointer;
}
</style>
