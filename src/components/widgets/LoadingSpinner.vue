<script lang="ts" setup></script>

<template>
    <p class="split-center animate-spin">
        <Icon icon="fa-spinner" size="2x" spin />
    </p>
    <p class="split-center animate-pulse">Loading...</p>
</template>

<style scoped>
.split-center {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
}
</style>
