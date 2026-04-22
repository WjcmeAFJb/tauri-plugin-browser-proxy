use crate::state::{RelayOutcome, SharedState};
use axum::{
    extract::{Query, State},
    http::{Method, StatusCode},
    response::{sse::Event as SseEvent, sse::KeepAlive, IntoResponse, Sse},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{convert::Infallible, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tokio::time::timeout;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

#[derive(Debug, Deserialize)]
pub struct InvokeRequest {
    pub cmd: String,
    #[serde(default)]
    pub args: Value,
    #[serde(default)]
    pub options: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct InvokeResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SubscribeRequest {
    pub event: String,
}

#[derive(Debug, Deserialize)]
pub struct EventsQuery {
    #[serde(default)]
    pub since: Option<u64>,
}

/// App-side context bundled with the shared plugin state. Axum wants a
/// single state value, so we pack both through a newtype.
pub struct AppCtx<R: Runtime> {
    pub app: AppHandle<R>,
    pub state: SharedState,
}

impl<R: Runtime> Clone for AppCtx<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            state: Arc::clone(&self.state),
        }
    }
}

impl<R: Runtime> AppCtx<R> {
    async fn bridge(&self) -> crate::error::Result<WebviewWindow<R>> {
        let label = self.state.bridge_label().await;
        let webview = match label {
            Some(l) => self.app.get_webview_window(&l),
            None => self.app.webview_windows().values().next().cloned(),
        };
        webview.ok_or(crate::error::Error::NoWebview)
    }
}

pub async fn serve<R: Runtime>(app: AppHandle<R>, state: SharedState) -> crate::error::Result<()> {
    let ctx = AppCtx { app, state: state.clone() };
    let cors_origins = state
        .config
        .allowed_origins
        .clone()
        .unwrap_or_else(default_origins);
    let cors = build_cors(cors_origins);

    let router = Router::new()
        .route("/health", get(health))
        .route("/invoke", post(invoke::<R>))
        .route("/events", get(events::<R>))
        .route("/subscribe", post(subscribe::<R>))
        .route("/unsubscribe", post(unsubscribe::<R>))
        .route("/config", get(config::<R>))
        .with_state(ctx)
        .layer(cors);

    let bind = format!("{}:{}", state.config.host, state.config.port);
    log::info!("browser-proxy: listening on http://{bind}");
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    axum::serve(listener, router)
        .await
        .map_err(std::io::Error::other)?;
    Ok(())
}

fn default_origins() -> Vec<String> {
    (5170..=5180)
        .chain([3000u16, 3001, 4173, 8080, 8000])
        .flat_map(|p| {
            [
                format!("http://localhost:{p}"),
                format!("http://127.0.0.1:{p}"),
            ]
        })
        .collect()
}

fn build_cors(origins: Vec<String>) -> CorsLayer {
    let origin_matcher = if origins.iter().any(|o| o == "*") {
        AllowOrigin::any()
    } else {
        AllowOrigin::list(
            origins
                .into_iter()
                .filter_map(|o| o.parse().ok())
                .collect::<Vec<_>>(),
        )
    };
    CorsLayer::new()
        .allow_origin(origin_matcher)
        .allow_methods(AllowMethods::list([
            Method::GET,
            Method::POST,
            Method::OPTIONS,
        ]))
        .allow_headers(AllowHeaders::mirror_request())
        .allow_credentials(false)
        .max_age(Duration::from_secs(86400))
}

async fn health() -> &'static str {
    "ok"
}

async fn config<R: Runtime>(State(ctx): State<AppCtx<R>>) -> Json<Value> {
    Json(serde_json::json!({
        "host": ctx.state.config.host,
        "port": ctx.state.config.port,
        "url": ctx.state.config.public_url(),
    }))
}

async fn invoke<R: Runtime>(
    State(ctx): State<AppCtx<R>>,
    Json(req): Json<InvokeRequest>,
) -> axum::response::Response {
    let id = uuid::Uuid::new_v4().to_string();
    let rx = ctx.state.register_pending(id.clone()).await;

    let args_literal = serde_json::to_string(&req.args).unwrap_or_else(|_| "null".into());
    let opts_literal = req
        .options
        .as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "undefined".into()))
        .unwrap_or_else(|| "undefined".into());
    let cmd_literal = serde_json::to_string(&req.cmd).unwrap();
    let id_literal = serde_json::to_string(&id).unwrap();

    let script = format!(
        r#"(function() {{
            try {{
                var reply = function(ok, data, error) {{
                    window.__TAURI_INTERNALS__.invoke('plugin:browser-proxy|relay_result', {{
                        id: {id},
                        ok: ok,
                        data: data,
                        error: error,
                    }});
                }};
                var args = window.__browser_proxy_decode__({args});
                Promise.resolve()
                    .then(function() {{
                        return window.__TAURI_INTERNALS__.invoke({cmd}, args, {opts});
                    }})
                    .then(function(result) {{
                        return window.__browser_proxy_encode__(result);
                    }})
                    .then(function(encoded) {{ reply(true, encoded, null); }})
                    .catch(function(err) {{
                        reply(false, null, (err && err.message) || String(err));
                    }});
            }} catch (e) {{
                window.__TAURI_INTERNALS__.invoke('plugin:browser-proxy|relay_result', {{
                    id: {id},
                    ok: false,
                    data: null,
                    error: (e && e.message) || String(e),
                }});
            }}
        }})();"#,
        id = id_literal,
        args = args_literal,
        cmd = cmd_literal,
        opts = opts_literal,
    );

    let bridge = match ctx.bridge().await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(InvokeResponse {
                    ok: false,
                    data: None,
                    error: Some(e.to_string()),
                }),
            )
                .into_response()
        }
    };

    if let Err(e) = bridge.eval(&script) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(InvokeResponse {
                ok: false,
                data: None,
                error: Some(format!("eval failed: {e}")),
            }),
        )
            .into_response();
    }

    let outcome = match timeout(Duration::from_secs(ctx.state.config.invoke_timeout_secs), rx).await
    {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => RelayOutcome::Err("relay channel closed".into()),
        Err(_) => RelayOutcome::Err("invoke timed out waiting for webview relay".into()),
    };

    let resp = match outcome {
        RelayOutcome::Ok(data) => InvokeResponse {
            ok: true,
            data: Some(data),
            error: None,
        },
        RelayOutcome::Err(e) => InvokeResponse {
            ok: false,
            data: None,
            error: Some(e),
        },
    };
    Json(resp).into_response()
}

async fn subscribe<R: Runtime>(
    State(ctx): State<AppCtx<R>>,
    Json(req): Json<SubscribeRequest>,
) -> axum::response::Response {
    let bridge = match ctx.bridge().await {
        Ok(b) => b,
        Err(e) => {
            return (StatusCode::SERVICE_UNAVAILABLE, e.to_string()).into_response();
        }
    };
    let id = uuid::Uuid::new_v4().to_string();
    let rx = ctx.state.register_pending(id.clone()).await;
    let event = serde_json::to_string(&req.event).unwrap();
    let id_literal = serde_json::to_string(&id).unwrap();
    let script = format!(
        "window.__browser_proxy_subscribe__({event}, {id});",
        event = event,
        id = id_literal
    );
    if let Err(e) = bridge.eval(&script) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    match timeout(Duration::from_secs(ctx.state.config.invoke_timeout_secs), rx).await {
        Ok(Ok(RelayOutcome::Ok(_))) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(RelayOutcome::Err(e))) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        _ => (StatusCode::GATEWAY_TIMEOUT, "subscribe timed out").into_response(),
    }
}

async fn unsubscribe<R: Runtime>(
    State(ctx): State<AppCtx<R>>,
    Json(req): Json<SubscribeRequest>,
) -> axum::response::Response {
    let bridge = match ctx.bridge().await {
        Ok(b) => b,
        Err(e) => {
            return (StatusCode::SERVICE_UNAVAILABLE, e.to_string()).into_response();
        }
    };
    let event = serde_json::to_string(&req.event).unwrap();
    let script = format!("window.__browser_proxy_unsubscribe__({event});");
    if let Err(e) = bridge.eval(&script) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn events<R: Runtime>(
    State(ctx): State<AppCtx<R>>,
    Query(query): Query<EventsQuery>,
) -> axum::response::Response {
    let mut rx = ctx.state.subscribe_events();
    let since = query.since.unwrap_or(0);
    let stream = async_stream::stream! {
        yield Ok::<_, Infallible>(
            SseEvent::default()
                .event("hello")
                .data(serde_json::to_string(&serde_json::json!({
                    "since": since,
                })).unwrap())
        );
        loop {
            match rx.recv().await {
                Ok(frame) => {
                    if frame.seq < since { continue; }
                    let data = match serde_json::to_string(&frame) {
                        Ok(d) => d,
                        Err(_) => continue,
                    };
                    yield Ok(SseEvent::default()
                        .event("tauri")
                        .id(frame.seq.to_string())
                        .data(data));
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            }
        }
    };

    Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response()
}
