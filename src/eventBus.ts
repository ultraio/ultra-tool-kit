import mitt from 'mitt';
export const emitter = mitt();

// Expose emitter for E2E testing (Playwright can trigger transactions via window.__emitter)
if (typeof window !== 'undefined') {
    (window as any).__emitter = emitter;
}
