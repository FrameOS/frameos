use serde_json::json;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

/// Logging scaffolding that mirrors FrameOS's structured event logs.
pub fn log_event(event: Value) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0);
    let payload = json!({
        "timestamp": timestamp,
        "event": event,
    });
    println!("{}", payload);
}

/// Convenience helper for debug messages.
pub fn debug(message: &str) {
    log_event(json!({
        "event": "debug",
        "message": message,
    }));
}
