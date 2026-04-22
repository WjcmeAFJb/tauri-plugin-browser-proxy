import type { Plugin } from 'vite';

export interface BrowserProxyViteOptions {
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

const BOOTSTRAP_ID = 'virtual:tauri-plugin-browser-proxy/bootstrap';
const BOOTSTRAP_RESOLVED = `\0${BOOTSTRAP_ID}`;

/**
 * Vite plugin that installs the browser-proxy shim into the dev HTML.
 * Usage (vite.config.ts):
 *
 * ```ts
 * import { browserProxy } from 'tauri-plugin-browser-proxy-js/vite';
 * export default defineConfig({ plugins: [browserProxy()] });
 * ```
 */
export function browserProxy(options: BrowserProxyViteOptions = {}): Plugin {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 1421;
  const url = options.url ?? `http://${host}:${port}`;
  const inject = options.inject !== false;
  const mode = options.mode ?? 'dev-only';

  return {
    name: 'tauri-plugin-browser-proxy',
    apply: mode === 'dev-only' ? 'serve' : undefined,
    enforce: 'pre',
    // The shim is imported via a virtual module so Vite's bare-specifier
    // resolver has a chance to rewrite `tauri-plugin-browser-proxy-js/shim`
    // into a real URL. Inline `import()` calls in raw HTML don't get that
    // rewrite — hence the indirection.
    resolveId(id) {
      if (id === BOOTSTRAP_ID) return BOOTSTRAP_RESOLVED;
      return null;
    },
    load(id) {
      if (id === BOOTSTRAP_RESOLVED) {
        return (
          `import { installShim } from 'tauri-plugin-browser-proxy-js/shim';\n` +
          `window.__BROWSER_PROXY_URL__ = ${JSON.stringify(url)};\n` +
          `installShim({ url: ${JSON.stringify(url)} });\n`
        );
      }
      return null;
    },
    config() {
      return {
        optimizeDeps: {
          include: ['tauri-plugin-browser-proxy-js/shim'],
        },
      };
    },
    transformIndexHtml() {
      if (!inject) return;
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: `/@id/${BOOTSTRAP_ID}` },
          injectTo: 'head-prepend',
        },
      ];
    },
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address();
        if (addr && typeof addr === 'object') {
          const viteUrl = `http://${addr.address === '::' ? 'localhost' : addr.address}:${addr.port}`;
          // eslint-disable-next-line no-console
          console.log(
            `\n  \x1b[36m▶ browser-proxy\x1b[0m  open ${viteUrl} after \`pnpm tauri dev\` ` +
              `starts the app on ${url}\n`
          );
        }
      });
    },
  };
}

export default browserProxy;
