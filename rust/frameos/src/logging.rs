use serde_json::json;
use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
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

#[derive(Debug)]
pub struct FileJsonLineSink {
    file: Mutex<File>,
}

impl FileJsonLineSink {
    pub fn append(path: impl AsRef<Path>) -> io::Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path.as_ref())?;
        Ok(Self {
            file: Mutex::new(file),
        })
    }
}

impl JsonLineSink for FileJsonLineSink {
    fn write_line(&self, line: &str) -> io::Result<()> {
        let mut file = self
            .file
            .lock()
            .expect("file sink lock should not be poisoned");
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.flush()
    }
}

#[derive(Clone)]
pub struct MultiJsonLineSink {
    sinks: Vec<Arc<dyn JsonLineSink>>,
}

impl MultiJsonLineSink {
    pub fn new(sinks: Vec<Arc<dyn JsonLineSink>>) -> Self {
        Self { sinks }
    }
}

impl JsonLineSink for MultiJsonLineSink {
    fn write_line(&self, line: &str) -> io::Result<()> {
        for sink in &self.sinks {
            sink.write_line(line)?;
        }
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
    use std::fs;
    use tempfile::tempdir;

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

    #[test]
    fn file_sink_appends_json_lines() {
        let directory = tempdir().expect("tempdir should be created");
        let log_path = directory.path().join("events.jsonl");
        let sink = FileJsonLineSink::append(&log_path).expect("file sink should be created");

        emit_event_to_sink(&sink, json!({"event": "runtime:start"}))
            .expect("first write should succeed");
        emit_event_to_sink(&sink, json!({"event": "runtime:stop"}))
            .expect("second write should succeed");

        let file_contents = fs::read_to_string(log_path).expect("log file should be readable");
        let lines: Vec<&str> = file_contents.lines().collect();
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn multi_sink_writes_to_all_destinations() {
        let primary = Arc::new(MemoryJsonLineSink::default());
        let secondary = Arc::new(MemoryJsonLineSink::default());
        let sink = MultiJsonLineSink::new(vec![
            Arc::clone(&primary) as Arc<dyn JsonLineSink>,
            Arc::clone(&secondary) as Arc<dyn JsonLineSink>,
        ]);

        emit_event_to_sink(&sink, json!({"event": "runtime:ready"}))
            .expect("multi sink write should succeed");

        assert_eq!(primary.lines().len(), 1);
        assert_eq!(secondary.lines().len(), 1);
    }
}
