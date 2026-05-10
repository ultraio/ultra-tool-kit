import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
        // Don't inherit the frontend's vite config (which adds polyfills + node-stream
        // shims that break createRequire / fs imports in this Node-only backend).
        root: __dirname,
    },
});
