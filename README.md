# tauri-plugin-browser-proxy

Mirror a Tauri 2 webview to an ordinary browser tab over HTTP + SSE. Your
frontend still uses `@tauri-apps/api` — `invoke`, `listen`, `emit`, the
`fs`, `notification`, `dialog`, `http` plugins, etc. — unchanged. The
difference is that when you `pnpm tauri dev`, you can open
<http://localhost:5173> in Chrome/Firefox/Safari, use their DevTools, their
React/Vue/Svelte/Solid inspectors, their performance panels, and your Tauri
IPC still works.

## Install in a Tauri project

The Rust plugin is consumed as a Cargo **git dependency** (no crates.io
account needed); the JS package is published as a tarball on every
GitHub release.

### 1. Cargo (Rust) — git dependency

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-browser-proxy = { git = "https://github.com/WjcmeAFJb/tauri-plugin-browser-proxy", tag = "v0.1.0" }
```

Cargo clones the repo, walks its workspace, and picks the
`tauri-plugin-browser-proxy` crate automatically. Pin by `tag`, `branch`,
or `rev` — whichever you prefer:

```toml
# track a branch
tauri-plugin-browser-proxy = { git = "https://github.com/WjcmeAFJb/tauri-plugin-browser-proxy", branch = "main" }

# pin an exact commit
tauri-plugin-browser-proxy = { git = "https://github.com/WjcmeAFJb/tauri-plugin-browser-proxy", rev = "…commit sha…" }
```

### 2. npm — install from the release tarball

```bash
pnpm add https://github.com/WjcmeAFJb/tauri-plugin-browser-proxy/releases/latest/download/tauri-plugin-browser-proxy-js-0.1.0.tgz
# or:  npm install <same URL>
# or:  yarn add <same URL>
```

The `releases/latest/download/…` URL always redirects to the current
release, so you don't need to bump it on every upgrade — change the
filename version when you want a specific version.

### 3. Register the plugin

```rust
// src-tauri/src/lib.rs
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_browser_proxy::init())   // ← here
        .run(tauri::generate_context!())
        .unwrap();
}
```

### 4. Wire up the Vite plugin

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { browserProxy } from 'tauri-plugin-browser-proxy-js/vite';

export default defineConfig({
  plugins: [browserProxy()],
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
});
```

### 5. Grant the capability

```json
// src-tauri/capabilities/default.json
{
  "permissions": ["core:default", "browser-proxy:default"]
}
```

### 6. Run

```bash
pnpm tauri dev
```

Open **<http://localhost:5173>** in any browser. The Tauri window and the
browser tab render the same frontend; `invoke`, `listen`, `emit`, and all
first-party Tauri plugins work in both.

### Keep it dev-only

Don't ship this plugin in release builds — gate it behind debug assertions
or a cargo feature:

```rust
#[cfg(debug_assertions)]
{
    builder = builder.plugin(tauri_plugin_browser_proxy::init());
}
```

## What works

| Thing                                             | Status |
|---                                                |---     |
| Regular `invoke` (strings, numbers, JSON)         | ✅     |
| Binary args and results (`Uint8Array`, `ArrayBuffer`, typed arrays) | ✅ base64-framed |
| `listen` / `emit` — both directions                | ✅     |
| `@tauri-apps/plugin-fs` — read, write, **watch**   | ✅     |
| `@tauri-apps/plugin-notification`                  | ✅     |
| `@tauri-apps/plugin-dialog`                        | ✅     |
| `@tauri-apps/plugin-http`                          | ✅ (uses normal fetch in browser, or proxy through Tauri) |
| `convertFileSrc` / `asset://` URLs                 | ⚠ returns a placeholder URL; use `fs.readFile` instead |
| `Channel<T>` streams                               | ⚠ basic — buffered events, no backpressure |
| Isolation pattern                                  | ❌ brownfield only |
| Multi-webview apps                                 | ✅ — pin a bridge label with `ProxyBuilder::pinned_webview` |

## Why

Tauri's WebKit/WebView2 browser is fine for shipping, but rough for
iteration. You don't get the same DevTools, extensions, or perf tooling as
Chrome. The workaround developers reach for — "just open it in a browser" —
is broken by IPC: `window.__TAURI_INTERNALS__` doesn't exist in Chrome, so
every `invoke` throws and every `listen` silently never fires.

This plugin bridges that gap at the HTTP layer:

```
┌─── browser tab (Chrome @ :5173) ────────┐         ┌── Tauri app ───────────────┐
│                                         │  POST   │  HTTP server (axum, :1421) │
│  @tauri-apps/api → fake __TAURI__  ─────┼─/invoke─►  eval in bridge webview    │
│                                         │         │  ↓                         │
│                                         │  SSE    │  relay_result → oneshot    │
│  listeners  ◄──────────────────────────┼─/events─┤  Tauri core / plugins      │
│                                         │         │  ↑                         │
│                                         │         │  relay_event ◄ interceptor │
└─────────────────────────────────────────┘         └────────────────────────────┘
```

The Rust plugin `eval`s invokes in the real webview so every side effect,
permission check, and plugin hook runs exactly as it would in production.

## How it works

Three moving pieces:

**Rust plugin** — Spawns an axum HTTP server on a deterministic port (default
`127.0.0.1:1421`). Two endpoints matter:

- `POST /invoke { cmd, args }` — generates a pending id, builds a JS snippet
  that calls `__TAURI_INTERNALS__.invoke(cmd, args)` inside the bridge
  webview, waits on a oneshot channel for `relay_result` to fire.
- `GET /events` — an SSE stream. Every `relay_event` from the bridge webview
  is broadcast to every connected tab.

**Interceptor script** (auto-injected into every Tauri webview via
`Builder::js_init_script`) — exposes `__browser_proxy_encode__`,
`__browser_proxy_decode__`, `__browser_proxy_subscribe__`,
`__browser_proxy_unsubscribe__`, and registers the webview as "the bridge"
with `plugin:browser-proxy|register_bridge`.

**Browser shim** — Replaces `window.__TAURI_INTERNALS__` with a fake that
POSTs invokes to `/invoke`, opens an `EventSource` against `/events`, and
intercepts `plugin:event|listen` + `unlisten` so it can tell the Tauri side
"please subscribe to event X" before passing events back to local listeners.

Binary values (`ArrayBuffer`, typed arrays, `Date`, `Map`, `Set`) are wrapped
in tagged objects on the way out and unwrapped on the way in. The codec
lives in `plugin/src-js/binary.ts` and the same logic is mirrored in
`plugin/dist/interceptor.bundle.js`.

## FAQ

### Is this safe?

The server binds to `127.0.0.1`. Nothing on your LAN can hit it. Every
`/invoke` runs through Tauri's real permission checks (via `eval` inside the
actual webview), so commands your capabilities deny are still denied.
**Don't ship this plugin in release builds** — see the `#[cfg(...)]`
snippet above.

### Why not use `tauri-plugin-localhost` or the official http plugin?

`tauri-plugin-localhost` serves *assets* over HTTP — it doesn't forward IPC.
The official `@tauri-apps/plugin-http` is a client, not a server; it gives
your frontend `fetch` capability from inside the Tauri webview, but doesn't
help a browser tab reach Tauri commands.

This plugin does the opposite direction: *browser → Tauri invoke* over HTTP,
with events streamed back. It also sidesteps the CORS pitfalls you hit if
you try to wire up the HTTP plugin yourself — the server uses a deterministic
bound address (`127.0.0.1:$port`), pre-allows every dev server port, and
mirrors request headers via `AllowHeaders::mirror_request`.

### Why is there a Tauri window at all?

Because events are dispatched Rust → webview through the JS runtime, not a
Rust-side broadcast. We need *a* webview to catch them. The bridge webview
can be tiny and hidden — see [`docs/hidden-bridge.md`](docs/hidden-bridge.md).

### Multiple Tauri webviews?

Pin the bridge by label:

```rust
tauri_plugin_browser_proxy::ProxyBuilder::new()
    .pinned_webview("main")
    .build()
```

Only the pinned webview will register; other webviews' events flow through
it because the Tauri event system is global by default (target `Any`).

## Development

```bash
# enter the nix shell (Rust toolchain, node, pnpm, webkit deps, Playwright)
nix develop

# build the JS package once
pnpm install
pnpm --filter tauri-plugin-browser-proxy-js build

# run the example (opens Tauri window + starts Vite on :5173)
pnpm tauri:example

# in another shell, open a browser tab
xdg-open http://localhost:5173

# run the E2E suite
pnpm test:e2e

# pack the npm tarball locally (same artifact GH Actions publishes)
bash scripts/pack-release.sh
```

### Cutting a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` builds the npm tarball and publishes it to
the GitHub release page with ready-to-copy install instructions. The Rust
crate is consumed directly from git by tag — no Cargo artifact is uploaded.

## License

GNU Lesser General Public License v3.0 or later (`LGPL-3.0-or-later`).
The full text is in [`LICENSE`](LICENSE).
