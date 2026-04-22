use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no tauri webview is registered with the proxy; did init() run before webviews were created?")]
    NoWebview,
    #[error("pending invoke {0} was never claimed — webview likely returned no response")]
    PendingMissing(String),
    #[error("relayed invoke returned error: {0}")]
    RelayedError(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
