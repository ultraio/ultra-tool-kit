// @ts-ignore
import { createRouter, createWebHistory } from 'vue-router/auto';

export function getRouter() {
    return createRouter({ history: createWebHistory(import.meta.env.BASE_URL) });
}
