interface ShimOptions {
    /** Base URL of the Tauri proxy server. Defaults to reading
     *  `window.__BROWSER_PROXY_URL__` then `http://127.0.0.1:1421`. */
    url?: string;
    /** Called when the SSE connection opens. */
    onOpen?: () => void;
    /** Called when the SSE connection errors out — you may want to show
     *  a "Tauri app not running" banner. */
    onError?: (err: unknown) => void;
    /** If `true`, overwrite any pre-existing `__TAURI_INTERNALS__`. Default
     *  `false` — the shim detects the real Tauri webview and becomes a no-op
     *  there, so you usually want the default. */
    force?: boolean;
}
declare function installShim(options?: ShimOptions): void;

export { type ShimOptions, installShim };
