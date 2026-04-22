use crate::error::{Error, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, oneshot, Mutex};

/// Outcome of a relayed invoke.
#[derive(Debug, Clone)]
pub enum RelayOutcome {
    Ok(Value),
    Err(String),
}

/// Event broadcast to every connected browser tab.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EventFrame {
    pub event: String,
    pub payload: Value,
    /// Monotonically increasing id — useful for SSE clients to detect gaps.
    pub seq: u64,
}

type PendingMap = HashMap<String, oneshot::Sender<RelayOutcome>>;

/// Plugin state. Deliberately non-generic so `tauri::generate_handler!` can
/// infer `R` from command parameters without us having to annotate it on
/// the state type — the invoke handler macro stumbles on `State<'_, Thing<R>>`.
///
/// If a command needs the actual `AppHandle<R>` (e.g. to eval into a
/// webview), it takes that as its own parameter.
pub struct ProxyState {
    pub(crate) pending: Mutex<PendingMap>,
    pub(crate) event_tx: broadcast::Sender<EventFrame>,
    pub(crate) event_seq: std::sync::atomic::AtomicU64,
    pub(crate) bridge_label: Mutex<Option<String>>,
    pub(crate) config: super::ProxyConfig,
}

impl ProxyState {
    pub fn new(config: super::ProxyConfig) -> Self {
        let (event_tx, _) = broadcast::channel(2048);
        Self {
            pending: Mutex::new(HashMap::new()),
            event_tx,
            event_seq: std::sync::atomic::AtomicU64::new(0),
            bridge_label: Mutex::new(config.pinned_webview.clone()),
            config,
        }
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<EventFrame> {
        self.event_tx.subscribe()
    }

    pub async fn bridge_label(&self) -> Option<String> {
        self.bridge_label.lock().await.clone()
    }

    pub async fn set_bridge(&self, label: impl Into<String>) {
        *self.bridge_label.lock().await = Some(label.into());
    }

    pub async fn register_pending(&self, id: String) -> oneshot::Receiver<RelayOutcome> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        rx
    }

    pub async fn complete_pending(&self, id: &str, outcome: RelayOutcome) -> Result<()> {
        if let Some(tx) = self.pending.lock().await.remove(id) {
            let _ = tx.send(outcome);
            Ok(())
        } else {
            Err(Error::PendingMissing(id.to_string()))
        }
    }

    pub fn push_event(&self, event: String, payload: Value) {
        let seq = self
            .event_seq
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let frame = EventFrame { event, payload, seq };
        let _ = self.event_tx.send(frame);
    }
}

pub type SharedState = Arc<ProxyState>;
