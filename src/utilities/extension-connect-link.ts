export function consumeExtensionConnectLink(): boolean {
    const url = new URL(window.location.href);
    if (url.searchParams.get('connect') !== 'extension') return false;
    url.searchParams.delete('connect');
    window.history.replaceState(window.history.state, '', url);
    return true;
}

export async function waitForExtension(isAvailable: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 3000;
    while (!isAvailable() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return isAvailable();
}
