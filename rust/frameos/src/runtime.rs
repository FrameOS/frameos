use crate::apps::AppRegistry;
use crate::config::{ConfigError, FrameOSConfig};
use crate::logging;
use crate::manifests::{load_app_registry, load_scene_catalog, ManifestLoadError};
use crate::metrics::Metrics;
use crate::scenes::SceneCatalog;
use crate::server::{Server, ServerHealthSnapshot, ServerTransport};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const LOOP_SLEEP: Duration = Duration::from_millis(200);

#[derive(Debug)]
pub enum RuntimeError {
    Config(ConfigError),
    Manifest(ManifestLoadError),
    Io(io::Error),
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Config(source) => write!(f, "config error: {source}"),
            Self::Manifest(source) => write!(f, "manifest error: {source}"),
            Self::Io(source) => write!(f, "runtime io error: {source}"),
        }
    }
}

impl std::error::Error for RuntimeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Config(source) => Some(source),
            Self::Manifest(source) => Some(source),
            Self::Io(source) => Some(source),
        }
    }
}

impl From<io::Error> for RuntimeError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

#[derive(Debug)]
pub struct Runtime {
    config: FrameOSConfig,
    server: Server,
    metrics: Metrics,
    scenes: Option<SceneCatalog>,
    apps: Option<AppRegistry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TickState {
    started_at: Instant,
    last_heartbeat_at: Instant,
    last_metrics_at: Instant,
}

impl TickState {
    fn new(now: Instant) -> Self {
        Self {
            started_at: now,
            last_heartbeat_at: now,
            last_metrics_at: now,
        }
    }

    fn should_emit_heartbeat(&self, now: Instant) -> bool {
        now.duration_since(self.last_heartbeat_at) >= Duration::from_secs(1)
    }

    fn should_emit_metrics_tick(&self, now: Instant, metrics_interval: Duration) -> bool {
        now.duration_since(self.last_metrics_at) >= metrics_interval
    }
}

impl Runtime {
    pub fn new(config: FrameOSConfig) -> Self {
        let server = Server::from_config(&config);
        let metrics = Metrics::from_config(&config);
        Self {
            config,
            server,
            metrics,
            scenes: None,
            apps: None,
        }
    }

    pub fn with_scene_manifest(mut self, path: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        self.scenes = Some(load_scene_catalog(path).map_err(RuntimeError::Manifest)?);
        Ok(self)
    }

    pub fn with_app_manifest(mut self, path: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        self.apps = Some(load_app_registry(path).map_err(RuntimeError::Manifest)?);
        Ok(self)
    }

    pub fn check(&self) {
        logging::log_event(serde_json::json!({
            "event": "runtime:check_ok",
            "server": self.server.endpoint(),
            "metrics_interval_seconds": self.metrics.interval_seconds(),
            "apps_loaded": self.apps.as_ref().map(|apps| apps.apps().len()).unwrap_or(0),
            "scenes_loaded": self.scenes.as_ref().map(|scenes| scenes.scenes().len()).unwrap_or(0),
        }));
    }

    pub fn run_until_stopped(&self, shutdown: Arc<AtomicBool>) -> io::Result<()> {
        logging::log_event(serde_json::json!({
            "event": "runtime:start",
            "config": {
                "name": self.config.name,
                "mode": self.config.mode,
                "server_host": self.config.server_host,
                "server_port": self.config.server_port,
                "frame_host": self.config.frame_host,
                "frame_port": self.config.frame_port,
                "width": self.config.width,
                "height": self.config.height,
                "device": self.config.device,
                "assets_path": self.config.assets_path,
            }
        }));
        let apps_loaded = self
            .apps
            .as_ref()
            .map(|apps| apps.apps().len())
            .unwrap_or(0);
        let scenes_loaded = self
            .scenes
            .as_ref()
            .map(|scenes| scenes.scenes().len())
            .unwrap_or(0);

        let transport = ServerTransport::start(
            &self.server,
            ServerHealthSnapshot {
                apps_loaded,
                scenes_loaded,
                metrics_interval_seconds: self.metrics.interval_seconds(),
            },
        )?;
        let event_fanout = transport.fanout();
        event_fanout.publish("runtime:start");

        logging::log_event(serde_json::json!({
            "event": "runtime:ready",
            "server": self.server.endpoint(),
            "health_endpoint": format!("http://{}/healthz", transport.local_addr()),
            "event_stream_transport": "websocket_stub",
            "metrics_interval_seconds": self.metrics.interval_seconds(),
            "apps_loaded": apps_loaded,
            "scenes_loaded": scenes_loaded,
        }));
        event_fanout.publish("runtime:ready");

        let mut tick_state = TickState::new(Instant::now());
        let metrics_interval = Duration::from_secs(self.metrics.interval_seconds().max(1));

        while !shutdown.load(Ordering::SeqCst) {
            let now = Instant::now();
            if tick_state.should_emit_heartbeat(now) {
                tick_state.last_heartbeat_at = now;
                logging::log_event(serde_json::json!({
                    "event": "runtime:heartbeat",
                    "uptime_seconds": now.duration_since(tick_state.started_at).as_secs_f64(),
                    "server": self.server.endpoint(),
                }));
                event_fanout.publish("runtime:heartbeat");
                transport.record_heartbeat();
            }

            if tick_state.should_emit_metrics_tick(now, metrics_interval) {
                tick_state.last_metrics_at = now;
                logging::log_event(serde_json::json!({
                    "event": "runtime:metrics_tick",
                    "uptime_seconds": now.duration_since(tick_state.started_at).as_secs_f64(),
                    "metrics_interval_seconds": self.metrics.interval_seconds(),
                    "apps_loaded": apps_loaded,
                    "scenes_loaded": scenes_loaded,
                }));
                event_fanout.publish("runtime:metrics_tick");
                transport.record_metrics_tick();
            }

            thread::sleep(LOOP_SLEEP);
        }

        logging::log_event(serde_json::json!({
            "event": "runtime:stop",
            "server": self.server.endpoint(),
            "metrics_interval_seconds": self.metrics.interval_seconds(),
            "apps_loaded": apps_loaded,
            "scenes_loaded": scenes_loaded,
        }));
        event_fanout.publish("runtime:stop");
        transport.mark_stopped();
        transport.stop()?;
        Ok(())
    }

    pub fn start(&self) -> io::Result<()> {
        let shutdown = Arc::new(AtomicBool::new(false));
        shutdown.store(true, Ordering::SeqCst);
        self.run_until_stopped(shutdown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_config() -> FrameOSConfig {
        let mut config = FrameOSConfig::default();
        config.server_host = "127.0.0.1".to_string();
        config.server_port = 0;
        config
    }

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn run_until_stopped_returns_after_shutdown_signal() {
        let runtime = Runtime::new(test_config());
        let shutdown = Arc::new(AtomicBool::new(false));
        let signal = Arc::clone(&shutdown);

        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            signal.store(true, Ordering::SeqCst);
        });

        runtime
            .run_until_stopped(shutdown)
            .expect("runtime loop should exit cleanly");

        handle.join().expect("shutdown thread should join");
    }

    #[test]
    fn start_completes_for_scaffolding_mode() {
        let runtime = Runtime::new(test_config());
        runtime.start().expect("start should return for now");
    }

    #[test]
    fn tick_state_reports_heartbeat_at_one_second_boundary() {
        let now = Instant::now();
        let tick_state = TickState::new(now);

        assert!(!tick_state.should_emit_heartbeat(now + Duration::from_millis(900)));
        assert!(tick_state.should_emit_heartbeat(now + Duration::from_secs(1)));
    }

    #[test]
    fn tick_state_reports_metrics_on_interval() {
        let now = Instant::now();
        let tick_state = TickState::new(now);
        let interval = Duration::from_secs(5);

        assert!(!tick_state.should_emit_metrics_tick(now + Duration::from_secs(4), interval));
        assert!(tick_state.should_emit_metrics_tick(now + Duration::from_secs(5), interval));
    }
}
