use tauri::{AppHandle, Emitter, Listener};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! — from Tauri 2 via the browser proxy.")
}

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_browser_proxy::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|app| {
            // ping → pong roundtrip demo.
            let handle: AppHandle = app.handle().clone();
            app.listen_any("ping", move |event| {
                log::info!("got ping event: {}", event.payload());
                let _ = handle.emit("pong", serde_json::json!({
                    "payload": event.payload(),
                    "receivedAt": chrono_now_rfc3339(),
                }));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn chrono_now_rfc3339() -> String {
    // Keep the example free of the chrono dependency — hand-roll a good-enough ISO string.
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let millis = d.subsec_millis();
    format!("unix:{secs}.{millis:03}")
}
