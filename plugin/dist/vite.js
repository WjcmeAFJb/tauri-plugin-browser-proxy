// vite/index.ts
var BOOTSTRAP_ID = "virtual:tauri-plugin-browser-proxy/bootstrap";
var BOOTSTRAP_RESOLVED = `\0${BOOTSTRAP_ID}`;
function browserProxy(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 1421;
  const url = options.url ?? `http://${host}:${port}`;
  const inject = options.inject !== false;
  const mode = options.mode ?? "dev-only";
  return {
    name: "tauri-plugin-browser-proxy",
    apply: mode === "dev-only" ? "serve" : void 0,
    enforce: "pre",
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
        return `import { installShim } from 'tauri-plugin-browser-proxy-js/shim';
window.__BROWSER_PROXY_URL__ = ${JSON.stringify(url)};
installShim({ url: ${JSON.stringify(url)} });
`;
      }
      return null;
    },
    config() {
      return {
        optimizeDeps: {
          include: ["tauri-plugin-browser-proxy-js/shim"]
        }
      };
    },
    transformIndexHtml() {
      if (!inject) return;
      return [
        {
          tag: "script",
          attrs: { type: "module", src: `/@id/${BOOTSTRAP_ID}` },
          injectTo: "head-prepend"
        }
      ];
    },
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        const addr = server.httpServer?.address();
        if (addr && typeof addr === "object") {
          const viteUrl = `http://${addr.address === "::" ? "localhost" : addr.address}:${addr.port}`;
          console.log(
            `
  \x1B[36m\u25B6 browser-proxy\x1B[0m  open ${viteUrl} after \`pnpm tauri dev\` starts the app on ${url}
`
          );
        }
      });
    }
  };
}
var vite_default = browserProxy;
export {
  browserProxy,
  vite_default as default
};
//# sourceMappingURL=vite.js.map