import fs from 'node:fs';
import path from 'node:path';

export const LOCAL_DAPP_EXTENSION_BUILD_COMMAND = 'npx nx build browser-extension-wallet -c=production --skip-nx-cache';

/**
 * Local-dapp suites need production bundles without the CWS manifest strip.
 *
 * The packaged production command removes loopback matches, while the normal
 * development build prepends hot-reload code to the MAIN-world inject script.
 * Either artifact prevents window.ultra from being installed on localhost and
 * otherwise makes every downstream event assertion fail misleadingly.
 */
export function assertLocalDappExtensionBuild(extensionPath: string): void {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    const injectPath = path.join(extensionPath, 'inject.js');

    if (!fs.existsSync(manifestPath) || !fs.existsSync(injectPath)) {
        throw new Error(
            `Local-dapp extension build not found at ${extensionPath}. Run "${LOCAL_DAPP_EXTENSION_BUILD_COMMAND}" in web-app.`
        );
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        content_scripts?: Array<{ js?: string[]; matches?: string[] }>;
    };
    const requiredScripts = new Set(['content.js', 'inject.js']);
    for (const script of manifest.content_scripts ?? []) {
        if (script.js?.some((entry) => requiredScripts.has(entry)) && script.matches?.includes('http://localhost/*')) {
            script.js.forEach((entry) => requiredScripts.delete(entry));
        }
    }

    if (requiredScripts.size > 0) {
        throw new Error(
            `The extension build is CWS-stripped and cannot inject ${[...requiredScripts].join(', ')} on localhost. ` +
                `Run "${LOCAL_DAPP_EXTENSION_BUILD_COMMAND}" directly; do not use the packaged production script.`
        );
    }

    const injectSource = fs.readFileSync(injectPath, 'utf8');
    if (injectSource.includes('Start of Webpack Hot Extension Middleware')) {
        throw new Error(
            `The extension build contains hot-reload middleware that cannot run in the MAIN world. ` +
                `Run "${LOCAL_DAPP_EXTENSION_BUILD_COMMAND}" instead of the development build.`
        );
    }
}
