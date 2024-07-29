import tailwindcss from 'tailwindcss'
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import VueRouter from 'unplugin-vue-router/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import SSL from '@vitejs/plugin-basic-ssl';

const args = process.argv;
const isPages = args.includes('--pages');

const defaultPlugins = [VueRouter(), vue(), nodePolyfills({ protocolImports: true })];

if (process.argv.includes('--dev')) {
    defaultPlugins.push(SSL());
}

// https://vitejs.dev/config/
export default defineConfig({
    base: isPages ? '/tool-kit' : '',
    plugins: defaultPlugins,
    optimizeDeps: {
        esbuildOptions: {
            define: {
                global: 'globalThis',
            },
        },
    },
    resolve: {
        alias: {
            vue: 'vue/dist/vue.esm-bundler.js'
        }
    },
    css: {
        postcss: {
          plugins: [tailwindcss],
        },
    },
});
