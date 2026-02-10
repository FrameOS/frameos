use crate::config::FrameOSConfig;

/// Metrics hooks placeholder.
#[derive(Debug, Clone)]
pub struct Metrics {
    interval_seconds: u64,
}

impl Metrics {
    pub fn from_config(config: &FrameOSConfig) -> Self {
        Self {
            interval_seconds: config.metrics_interval_seconds,
        }
    }

    pub fn interval_seconds(&self) -> u64 {
        self.interval_seconds
    }
}
