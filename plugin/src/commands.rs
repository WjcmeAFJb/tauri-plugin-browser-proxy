use crate::state::{RelayOutcome, SharedState};
use serde_json::Value;
use tauri::{Runtime, State, Webview};

#[tauri::command]
pub async fn relay_result(
    id: String,
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let outcome = if ok {
        RelayOutcome::Ok(data.unwrap_or(Value::Null))
    } else {
        RelayOutcome::Err(error.unwrap_or_else(|| "unknown error".into()))
    };
    state
        .complete_pending(&id, outcome)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn relay_event(
    event: String,
    payload: Value,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    state.push_event(event, payload);
    Ok(())
}

#[tauri::command]
pub async fn register_bridge<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    state.set_bridge(webview.label().to_string()).await;
    log::info!("browser-proxy: bridge registered as {}", webview.label());
    Ok(())
}

#[tauri::command]
pub fn proxy_url(state: State<'_, SharedState>) -> String {
    state.config.public_url()
}
