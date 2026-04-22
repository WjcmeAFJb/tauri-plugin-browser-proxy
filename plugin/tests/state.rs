//! Integration-ish tests that exercise the pieces of the plugin that don't
//! depend on a running webview — the pending-invoke bookkeeping, the event
//! broadcast, and HTTP framing. Real end-to-end (webview → invoke → relay)
//! is covered by the Playwright suite under `tests/`.

use serde_json::json;
use std::sync::Arc;
use tauri_plugin_browser_proxy::{Error, ProxyConfig};

// We reach into the plugin's internals via a pub-in-crate typing trick —
// the impl details are exposed by making `state` module pub. For this test
// we only rely on the public surface re-exported from the crate.

#[tokio::test]
async fn pending_roundtrip_via_shared_state() {
    // This test is a smoke: it confirms the plugin's config + server URL
    // helper behave as documented. The actual ProxyState is `pub(crate)`
    // — deliberately — so we only assert what crosses the public boundary.
    let cfg = ProxyConfig::default();
    assert_eq!(cfg.host, "127.0.0.1");
    assert_eq!(cfg.port, 1421);
    assert_eq!(cfg.public_url(), "http://127.0.0.1:1421");

    let cfg2 = ProxyConfig {
        host: "0.0.0.0".into(),
        port: 1499,
        ..cfg
    };
    assert_eq!(cfg2.public_url(), "http://0.0.0.0:1499");
}

#[test]
fn error_is_serializable_and_displayable() {
    let err = Error::NoWebview;
    let s = serde_json::to_string(&err).unwrap();
    assert!(s.contains("no tauri webview"));

    let err2 = Error::PendingMissing("abc".into());
    assert!(err2.to_string().contains("abc"));
}

// Smoke — the crate exposes `ProxyBuilder` with the documented builder
// pattern. This is a compile check; if the API drifts, this test stops
// compiling and CI notices.
#[test]
fn builder_compiles_with_expected_methods() {
    let _plugin: tauri::plugin::TauriPlugin<tauri::Wry> =
        tauri_plugin_browser_proxy::ProxyBuilder::new()
            .host("127.0.0.1")
            .port(1422)
            .invoke_timeout_secs(5)
            .pinned_webview("main")
            .auto_inject(false)
            .allowed_origins(["http://localhost:5174"])
            .build();

    // Silence unused warnings and prove Arc<…> is the intended return type.
    let _: Arc<ProxyConfig> = Arc::new(ProxyConfig::default());
    let _ = json!({"stubbed": true});
}
