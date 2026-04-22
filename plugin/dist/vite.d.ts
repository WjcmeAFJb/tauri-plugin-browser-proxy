import { Plugin } from 'vite';

interface BrowserProxyViteOptions {
    /** URL of the Tauri-side proxy. Defaults to `http://127.0.0.1:1421`. */
    url?: string;
    /** Port of the Tauri-side proxy. If `url` is not given, combined with host. */
    port?: number;
    /** Host. Defaults to `127.0.0.1`. */
    host?: string;
    /** If `false`, do not inject the shim automatically. */
    inject?: boolean;
    /** Control when the shim is active. Defaults to `'dev-only'`. */
    mode?: 'dev-only' | 'always';
}
/**
 * Vite plugin that installs the browser-proxy shim into the dev HTML.
 * Usage (vite.config.ts):
 *
 * ```ts
 * import { browserProxy } from 'tauri-plugin-browser-proxy-js/vite';
 * export default defineConfig({ plugins: [browserProxy()] });
 * ```
 */
declare function browserProxy(options?: BrowserProxyViteOptions): Plugin;

export { type BrowserProxyViteOptions, browserProxy, browserProxy as default };
