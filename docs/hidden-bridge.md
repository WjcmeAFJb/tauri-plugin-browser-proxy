# Hiding the bridge window

The default config shows the normal Tauri window next to your browser tab.
If you prefer a "browser-only" dev experience, make the Tauri window
invisible. It still needs to exist — that is where the JS runtime dispatches
events — but it can be off-screen.

## Option A: move it off-screen

```json
// src-tauri/tauri.conf.json
{
  "app": {
    "windows": [
      {
        "title": "browser-proxy-bridge",
        "label": "bridge",
        "width": 100, "height": 100,
        "x": -10000, "y": -10000,
        "decorations": false,
        "skipTaskbar": true,
        "visible": true
      }
    ]
  }
}
```

Pin the bridge label explicitly in Rust:

```rust
tauri_plugin_browser_proxy::ProxyBuilder::new()
    .pinned_webview("bridge")
    .build()
```

## Option B: invisible window

```json
{
  "windows": [{
    "label": "bridge",
    "visible": false,   // ← works on macOS + Windows; Linux may still flash briefly
    "decorations": false,
    "skipTaskbar": true
  }]
}
```

## Option C: eject to conditional compilation

```rust
#[cfg(feature = "browser-proxy")]
fn with_proxy(b: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    b.plugin(tauri_plugin_browser_proxy::init())
}
#[cfg(not(feature = "browser-proxy"))]
fn with_proxy(b: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> { b }

pub fn run() {
    let builder = tauri::Builder::default();
    let builder = with_proxy(builder);
    builder
        .plugin(tauri_plugin_fs::init())
        // …
        .run(tauri::generate_context!())
        .unwrap();
}
```

Then `cargo tauri dev --features browser-proxy` for the proxied workflow,
vanilla `cargo tauri dev` for the normal one.

## Caveats

- On Linux/GTK a 0-size or off-screen window can still briefly flash on
  creation; this is a windowing-system issue, not a plugin issue.
- WebKitGTK will refuse to process `eval` if the webview is suspended.
  Keep the window technically alive (visible: false is fine; `minimized:
  true` is *not* — minimized WebKit webviews can be paused).
- Hot-reload: Vite's HMR reconnect works from the bridge webview too. If
  you change `src-tauri/src/**/*.rs`, the Rust side rebuilds and Vite
  doesn't notice — reload the browser tab manually after Tauri restarts.
