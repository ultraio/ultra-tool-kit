/// <reference types="vite/client" />

// Module augmentation: vue3-easy-data-table ships a default export at runtime
// (its ESM bundle re-exports the Vue component) but its `types/main.d.ts`
// declares only type aliases — no `export default`. Without this shim,
// `vue-tsc` fails the build with TS1192. We don't need any of its type
// aliases in app code, so a minimal default-only declaration is enough.
declare module 'vue3-easy-data-table' {
    import type { DefineComponent } from 'vue';
    const Vue3EasyDataTable: DefineComponent;
    export default Vue3EasyDataTable;
}
