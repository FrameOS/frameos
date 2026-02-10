use serde_json::json;
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::config::FrameOSConfig;

const EVENT_HISTORY_LIMIT: usize = 256;

/// Server runtime placeholder.
#[derive(Debug, Clone)]
pub struct Server {
    host: String,
    port: u16,
}

#[derive(Debug, Clone)]
pub struct ServerHealthSnapshot {
    pub apps_loaded: usize,
    pub scenes_loaded: usize,
    pub metrics_interval_seconds: u64,
}

#[derive(Debug, Clone)]
pub struct EventFanoutStub {
    state: Arc<Mutex<EventFanoutState>>,
}

#[derive(Debug, Default)]
struct EventFanoutState {
    published_total: u64,
    recent_events: VecDeque<String>,
}

impl EventFanoutStub {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(EventFanoutState::default())),
        }
    }

    pub fn publish(&self, event_name: &str) {
        let mut state = self
            .state
            .lock()
            .expect("event fanout state lock should not be poisoned");
        state.published_total += 1;
        state.recent_events.push_back(event_name.to_string());
        if state.recent_events.len() > EVENT_HISTORY_LIMIT {
            state.recent_events.pop_front();
        }
    }

    pub fn published_total(&self) -> u64 {
        self.state
            .lock()
            .expect("event fanout state lock should not be poisoned")
            .published_total
    }

    pub fn recent_events(&self) -> Vec<String> {
        self.state
            .lock()
            .expect("event fanout state lock should not be poisoned")
            .recent_events
            .iter()
            .cloned()
            .collect()
    }
}

#[derive(Debug)]
struct HealthState {
    started_at: SystemTime,
    running: bool,
    heartbeats: u64,
    metrics_ticks: u64,
    apps_loaded: usize,
    scenes_loaded: usize,
    metrics_interval_seconds: u64,
}

#[derive(Debug)]
pub struct ServerTransport {
    fanout: EventFanoutStub,
    shutdown: Arc<AtomicBool>,
    health: Arc<Mutex<HealthState>>,
    handle: Option<JoinHandle<io::Result<()>>>,
    local_addr: String,
}

impl ServerTransport {
    pub fn start(server: &Server, snapshot: ServerHealthSnapshot) -> io::Result<Self> {
        let listener = TcpListener::bind(server.bind_addr())?;
        listener.set_nonblocking(true)?;
        let local_addr = listener.local_addr()?.to_string();

        let fanout = EventFanoutStub::new();
        let shutdown = Arc::new(AtomicBool::new(false));
        let health = Arc::new(Mutex::new(HealthState {
            started_at: SystemTime::now(),
            running: true,
            heartbeats: 0,
            metrics_ticks: 0,
            apps_loaded: snapshot.apps_loaded,
            scenes_loaded: snapshot.scenes_loaded,
            metrics_interval_seconds: snapshot.metrics_interval_seconds,
        }));

        let shutdown_signal = Arc::clone(&shutdown);
        let health_state = Arc::clone(&health);
        let fanout_state = fanout.clone();

        let handle = thread::spawn(move || loop {
            if shutdown_signal.load(Ordering::SeqCst) {
                return Ok(());
            }

            match listener.accept() {
                Ok((stream, _)) => {
                    handle_request(stream, &health_state, &fanout_state)?;
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(err) => return Err(err),
            }
        });

        Ok(Self {
            fanout,
            shutdown,
            health,
            handle: Some(handle),
            local_addr,
        })
    }

    pub fn local_addr(&self) -> &str {
        &self.local_addr
    }

    pub fn fanout(&self) -> EventFanoutStub {
        self.fanout.clone()
    }

    pub fn record_heartbeat(&self) {
        let mut health = self
            .health
            .lock()
            .expect("health state lock should not be poisoned");
        health.heartbeats += 1;
    }

    pub fn record_metrics_tick(&self) {
        let mut health = self
            .health
            .lock()
            .expect("health state lock should not be poisoned");
        health.metrics_ticks += 1;
    }

    pub fn mark_stopped(&self) {
        let mut health = self
            .health
            .lock()
            .expect("health state lock should not be poisoned");
        health.running = false;
    }

    pub fn stop(mut self) -> io::Result<()> {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            match handle.join() {
                Ok(result) => result,
                Err(_) => Err(io::Error::other("server thread panicked")),
            }
        } else {
            Ok(())
        }
    }
}

fn handle_request(
    mut stream: TcpStream,
    health: &Arc<Mutex<HealthState>>,
    fanout: &EventFanoutStub,
) -> io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;

    let status_payload = {
        let state = health
            .lock()
            .expect("health state lock should not be poisoned");
        json!({
            "status": if state.running { "ok" } else { "stopping" },
            "server_time": SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_secs_f64()).unwrap_or(0.0),
            "started_at": state.started_at.duration_since(UNIX_EPOCH).map(|value| value.as_secs_f64()).unwrap_or(0.0),
            "apps_loaded": state.apps_loaded,
            "scenes_loaded": state.scenes_loaded,
            "metrics_interval_seconds": state.metrics_interval_seconds,
            "heartbeats": state.heartbeats,
            "metrics_ticks": state.metrics_ticks,
            "event_stream": {
                "transport": "websocket_stub",
                "published_total": fanout.published_total(),
                "recent_events": fanout.recent_events(),
            },
        })
    };

    if request_line.starts_with("GET /healthz ") || request_line.starts_with("GET /health ") {
        let body = status_payload.to_string();
        write_http_response(&mut stream, "200 OK", "application/json", &body)
    } else {
        write_http_response(
            &mut stream,
            "404 Not Found",
            "application/json",
            &json!({ "error": "not_found" }).to_string(),
        )
    }
}

fn write_http_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
) -> io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())
}

impl Server {
    pub fn from_config(config: &FrameOSConfig) -> Self {
        Self {
            host: config.server_host.clone(),
            port: config.server_port,
        }
    }

    pub fn endpoint(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    pub fn bind_addr(&self) -> String {
        let host = if self.host.trim().is_empty() {
            "127.0.0.1"
        } else {
            self.host.as_str()
        };
        format!("{}:{}", host, self.port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn event_fanout_tracks_publish_counts() {
        let fanout = EventFanoutStub::new();
        fanout.publish("runtime:start");
        fanout.publish("runtime:ready");

        assert_eq!(fanout.published_total(), 2);
        assert_eq!(
            fanout.recent_events(),
            vec!["runtime:start", "runtime:ready"]
        );
    }

    #[test]
    fn bind_addr_falls_back_to_loopback_when_host_missing() {
        let server = Server {
            host: String::new(),
            port: 8989,
        };

        assert_eq!(server.bind_addr(), "127.0.0.1:8989");
    }

    #[test]
    fn health_endpoint_reports_runtime_state_and_fanout() {
        let server = Server {
            host: "127.0.0.1".to_string(),
            port: 0,
        };
        let transport = ServerTransport::start(
            &server,
            ServerHealthSnapshot {
                apps_loaded: 2,
                scenes_loaded: 3,
                metrics_interval_seconds: 60,
            },
        )
        .expect("server should start");

        let fanout = transport.fanout();
        fanout.publish("runtime:start");
        transport.record_heartbeat();

        let mut stream = TcpStream::connect(transport.local_addr()).expect("connect should work");
        stream
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .expect("request write should work");

        let mut response = String::new();
        BufReader::new(stream)
            .read_to_string(&mut response)
            .expect("response read should work");

        let body = response
            .split("\r\n\r\n")
            .nth(1)
            .expect("http body should be present");
        let payload: serde_json::Value = serde_json::from_str(body).expect("body should be json");

        assert_eq!(payload["status"], json!("ok"));
        assert_eq!(payload["apps_loaded"], json!(2));
        assert_eq!(payload["scenes_loaded"], json!(3));
        assert_eq!(payload["heartbeats"], json!(1));
        assert_eq!(payload["event_stream"]["published_total"], json!(1));

        transport.stop().expect("transport should stop cleanly");
    }
}
