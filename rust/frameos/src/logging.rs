use serde_json::json;
use serde_json::Value;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Sink abstraction for JSON-lines logging output.
pub trait JsonLineSink: Send + Sync {
    fn write_line(&self, line: &str) -> io::Result<()>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct StdoutJsonLineSink;

impl JsonLineSink for StdoutJsonLineSink {
    fn write_line(&self, line: &str) -> io::Result<()> {
        let mut stdout = io::stdout().lock();
        stdout.write_all(line.as_bytes())?;
        stdout.write_all(b"\n")?;
        stdout.flush()
    }
}

#[derive(Debug, Clone, Default)]
pub struct MemoryJsonLineSink {
    lines: Arc<Mutex<Vec<String>>>,
}

impl MemoryJsonLineSink {
    pub fn lines(&self) -> Vec<String> {
        self.lines
            .lock()
            .expect("memory sink lock should not be poisoned")
            .clone()
    }
}

impl JsonLineSink for MemoryJsonLineSink {
    fn write_line(&self, line: &str) -> io::Result<()> {
        self.lines
            .lock()
            .expect("memory sink lock should not be poisoned")
            .push(line.to_string());
        Ok(())
    }
}

fn event_envelope(event: Value) -> Value {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0);

    json!({
        "timestamp": timestamp,
        "event": event,
    })
}

pub fn emit_event_to_sink(sink: &dyn JsonLineSink, event: Value) -> io::Result<()> {
    sink.write_line(&event_envelope(event).to_string())
}

pub fn log_event_with_sink(sink: &dyn JsonLineSink, event: Value) -> io::Result<()> {
    emit_event_to_sink(sink, event)
}

/// Logging scaffolding that mirrors FrameOS's structured event logs.
pub fn log_event(event: Value) {
    let _ = log_event_with_sink(&StdoutJsonLineSink, event);
}

/// Convenience helper for debug messages.
pub fn debug(message: &str) {
    log_event(json!({
        "event": "debug",
        "message": message,
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_sink_captures_json_lines() {
        let sink = MemoryJsonLineSink::default();
        emit_event_to_sink(&sink, json!({"event": "runtime:test"}))
            .expect("write to memory sink should succeed");

        let lines = sink.lines();
        assert_eq!(lines.len(), 1);

        let payload: Value = serde_json::from_str(&lines[0]).expect("captured line should be json");
        assert_eq!(payload["event"]["event"], json!("runtime:test"));
        assert!(payload["timestamp"].as_f64().is_some());
    }
}
