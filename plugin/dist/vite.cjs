"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// vite/index.ts
var vite_exports = {};
__export(vite_exports, {
  browserProxy: () => browserProxy,
  default: () => vite_default
});
module.exports = __toCommonJS(vite_exports);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  browserProxy
});
//# sourceMappingURL=vite.cjs.map