# Getting started

This walks through a new Tauri + Vite + pnpm project from zero to "open
the app in Chrome and it still works".

## Prerequisites

- Rust stable (2021 edition)
- Node 20+, pnpm 9+
- Tauri 2 system deps (on Linux: `webkit2gtk-4.1`, `libsoup3`, `gtk3`)
- Optional: Nix. The `flake.nix` at the repo root pins every version.

```bash
# On NixOS / with Nix installed:
nix develop
# — Otherwise install the toolchain your way and keep reading.
```

## 1. Scaffold

```bash
pnpm create tauri-app my-app --template vanilla-ts
cd my-app
```

Answer: `pnpm` for package manager, `vanilla-ts` or whichever framework you
use. When done you will have:

```
my-app/
├── src/            # frontend (Vite)
├── src-tauri/      # backend (Rust)
├── package.json
└── vite.config.ts
```

## 2. Add the Rust plugin

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-browser-proxy = { git = "https://github.com/WjcmeAFJb/tauri-plugin-browser-proxy", tag = "v0.1.0" }
```

Register it in `src-tauri/src/lib.rs` **before** any plugin you want
proxied:

```rust
pub fn run() {
    tauri::Builder::default()
        // Put browser-proxy first so its webview init script runs before
        // any other plugin's init script mutates __TAURI_INTERNALS__.
        .plugin(tauri_plugin_browser_proxy::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![/* your commands */])
        .run(tauri::generate_context!())
        .unwrap();
}
```

## 3. Grant capabilities

Add `browser-proxy:default` to `src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["*"],
  "permissions": [
    "core:default",
    "browser-proxy:default",
    "fs:default",
    "notification:default"
  ]
}
```

## 4. Add the JS package

```bash
pnpm add tauri-plugin-browser-proxy-js
```

## 5. Install the Vite plugin

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { browserProxy } from 'tauri-plugin-browser-proxy-js/vite';

export default defineConfig({
  plugins: [browserProxy()],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
});
```

Defaults:

- Proxy URL: `http://127.0.0.1:1421`
- `mode: 'dev-only'` — the shim is **not** injected into production builds.
- `inject: true` — the HTML transform adds the shim script tag automatically.

If you need different defaults:

```ts
browserProxy({
  port: 1499,
  host: '127.0.0.1',
  mode: 'dev-only', // 'always' to inject in prod too (not recommended)
  inject: true,
})
```

## 6. Tauri config — point at Vite

```json
// src-tauri/tauri.conf.json
{
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://127.0.0.1:5173",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  }
}
```

## 7. Run

```bash
pnpm tauri dev
```

What happens:

1. Tauri runs `pnpm dev` (your Vite dev server) on port 5173.
2. The Vite plugin prints a banner with the Tauri proxy URL.
3. Tauri launches the native window and loads <http://127.0.0.1:5173>.
4. Inside the window: the interceptor boots, registers itself as the
   bridge, `__TAURI_INTERNALS__` is the real one.
5. The browser-proxy HTTP server listens on `127.0.0.1:1421`.

Now open <http://localhost:5173> in Chrome. The shim boots, replaces
`__TAURI_INTERNALS__` with an HTTP-backed one, and every Tauri API works.

## 8. Verify

Open Chrome DevTools → Network and click something that triggers an
`invoke`. You should see a POST to `http://127.0.0.1:1421/invoke`. Then
click DevTools → Application → Event Stream to watch SSE frames flow in
from `/events`.

## Troubleshooting

**"not connected — is the Tauri app running?"**
The Tauri window hasn't booted yet, or the bridge webview hasn't registered.
Wait a couple of seconds. If it persists, check:
- `curl http://127.0.0.1:1421/health` — should return `ok`.
- The Tauri window's web console — look for `[browser-proxy] register_bridge failed`.

**CORS errors in the browser tab console**
Your Vite dev server is on a port outside the curated default list
(5170..5180, 3000, 3001, 4173, 8080, 8000). Extend the plugin config:

```rust
tauri_plugin_browser_proxy::ProxyBuilder::new()
    .allowed_origins(["http://localhost:5174", "http://127.0.0.1:5174"])
    .build()
```

Or allow everything (dev-only, of course):

```rust
tauri_plugin_browser_proxy::ProxyBuilder::new()
    .allowed_origins(["*"])
    .build()
```

**`Error: invoke timed out waiting for webview relay`**
The bridge webview hit a runtime error before `relay_result` fired. Check
the Tauri window's web console — the original error will be there.

**"permission X not allowed"**
Capabilities are enforced exactly as in production. You still need to
grant every permission your commands need.

**`subscribe timed out`**
The event plugin isn't registered, or the event name is malformed (Tauri
restricts event names to `[A-Za-z0-9/_:-]`). Check that `tauri::Builder`
isn't missing a plugin the event is routed through.

## Ejecting to a hidden bridge window

If you don't want the Tauri native window showing up next to your browser
tab during development, see [`hidden-bridge.md`](hidden-bridge.md) for the
pattern that creates an off-screen, no-decorations window that exists only
to host the interceptor.
