//! `tauri-plugin-browser-proxy` — forward IPC between a Tauri webview and
//! an ordinary browser tab.
//!
//! Architecture overview (see README for diagrams):
//!
//!   - The plugin spawns an HTTP + SSE server (axum) on a deterministic port.
//!   - A tiny "bridge" script is auto-injected into every Tauri webview via
//!     [`tauri::WebviewWindowBuilder::initialization_script`]. That script
//!     registers itself with the plugin (`register_bridge`) and exposes
//!     `window.__browser_proxy_subscribe__` / `__unsubscribe__`.
//!   - When the browser tab calls `invoke`, the plugin POSTs it to `/invoke`,
//!     which `eval`s the invoke inside the bridge webview, and relays the
//!     result back through a oneshot channel — preserving binary data via
//!     an `encode` hook the bridge owns.
//!   - When the bridge sees a Tauri event, it calls `relay_event`, which
//!     broadcasts the event to every SSE client.
//!
//! This keeps us out of the Tauri core: no fork, no patched bindings.

mod commands;
mod error;
mod server;
mod state;

use std::sync::Arc;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

pub use error::{Error, Result};
use state::ProxyState;

/// Inline JavaScript injected into every Tauri webview. Implemented in
/// `plugin/src-js/interceptor.ts` and bundled to `plugin/dist/interceptor.js`
/// by the JS package's build. We `include_str!` the bundled file so the
/// Rust crate is self-contained.
const INTERCEPTOR_SCRIPT: &str = include_str!("../dist/interceptor.bundle.js");

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub host: String,
    pub port: u16,
    /// Allowed CORS origins. `None` uses a curated default covering
    /// common Vite/dev-server ports on `localhost` and `127.0.0.1`.
    pub allowed_origins: Option<Vec<String>>,
    /// Max time to wait for an `/invoke` result before returning a 504-like error.
    pub invoke_timeout_secs: u64,
    /// If `Some(label)`, only that webview is used as a bridge. If `None`,
    /// the first webview to call `register_bridge` wins.
    pub pinned_webview: Option<String>,
    /// Whether to auto-inject the interceptor script at webview creation.
    /// Disable if you want to inject manually (e.g. behind a dev-only flag).
    pub auto_inject: bool,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 1421,
            allowed_origins: None,
            invoke_timeout_secs: 30,
            pinned_webview: None,
            auto_inject: true,
        }
    }
}

impl ProxyConfig {
    pub fn public_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }
}

pub struct ProxyBuilder {
    config: ProxyConfig,
}

impl ProxyBuilder {
    pub fn new() -> Self {
        Self {
            config: ProxyConfig::default(),
        }
    }
    pub fn host(mut self, host: impl Into<String>) -> Self {
        self.config.host = host.into();
        self
    }
    pub fn port(mut self, port: u16) -> Self {
        self.config.port = port;
        self
    }
    pub fn allowed_origins(mut self, origins: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.config.allowed_origins = Some(origins.into_iter().map(Into::into).collect());
        self
    }
    pub fn invoke_timeout_secs(mut self, s: u64) -> Self {
        self.config.invoke_timeout_secs = s;
        self
    }
    pub fn pinned_webview(mut self, label: impl Into<String>) -> Self {
        self.config.pinned_webview = Some(label.into());
        self
    }
    pub fn auto_inject(mut self, yes: bool) -> Self {
        self.config.auto_inject = yes;
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        build_plugin(self.config)
    }
}

impl Default for ProxyBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// Convenience: `tauri::Builder::default().plugin(tauri_plugin_browser_proxy::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    ProxyBuilder::new().build()
}

fn build_plugin<R: Runtime>(config: ProxyConfig) -> TauriPlugin<R> {
    let auto_inject = config.auto_inject;
    let bootstrap_script = bootstrap_script(&config);

    let mut builder = Builder::<R>::new("browser-proxy")
        .invoke_handler(tauri::generate_handler![
            commands::relay_result,
            commands::relay_event,
            commands::register_bridge,
            commands::proxy_url,
        ])
        .setup(move |app, _api| {
            let handle: AppHandle<R> = app.clone();
            let state = Arc::new(ProxyState::new(config.clone()));
            app.manage(state.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::serve(handle, state).await {
                    log::error!("browser-proxy server exited: {e}");
                }
            });
            Ok(())
        });

    if auto_inject {
        builder = builder.js_init_script(bootstrap_script);
    }
    builder.build()
}

fn bootstrap_script(config: &ProxyConfig) -> String {
    format!(
        "(function(){{\n\
            window.__BROWSER_PROXY_CONFIG__ = {{ host: {h:?}, port: {p}, url: {url:?} }};\n\
            {body}\n\
        }})();",
        h = config.host,
        p = config.port,
        url = config.public_url(),
        body = INTERCEPTOR_SCRIPT,
    )
}
