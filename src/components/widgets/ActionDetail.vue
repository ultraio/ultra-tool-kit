<script lang="ts" setup></script>

<template>
    <div class="flex flex-row w-full items-center justify-between bg-neutral-900 rounded p-4">
        <div class="flex flex-row gap-4 items-center">
            <Icon icon="fa-file-contract" />
            <div class="w-24 tex-left">
                <slot name="contract"></slot>
            </div>
        </div>
        <Icon icon="fa-arrow-right" />
        <div class="flex flex-row gap-4 items-center">
            <Icon icon="fa-bolt-lightning" />
            <div class="min-w-24 text-left">
                <slot name="action"></slot>
            </div>
        </div>
        <slot name="delete"></slot>
    </div>
</template>
