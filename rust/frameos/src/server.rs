use base64::Engine;
use serde_json::json;
use sha1::{Digest, Sha1};
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::config::FrameOSConfig;

const EVENT_HISTORY_LIMIT: usize = 256;
const WEBSOCKET_MAGIC_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WEBSOCKET_PATH: &str = "/ws/events";

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
pub struct EventFanout {
    state: Arc<Mutex<EventFanoutState>>,
    broadcaster: EventBroadcaster,
}

#[derive(Debug)]
struct EventBroadcaster {
    next_client_id: Arc<AtomicU64>,
    clients: Arc<Mutex<Vec<WebSocketClient>>>,
}

impl Clone for EventBroadcaster {
    fn clone(&self) -> Self {
        Self {
            next_client_id: Arc::clone(&self.next_client_id),
            clients: Arc::clone(&self.clients),
        }
    }
}

#[derive(Debug)]
struct WebSocketClient {
    sender: SyncSender<String>,
    alive: Arc<AtomicBool>,
}

#[derive(Debug, Default)]
struct EventFanoutState {
    published_total: u64,
    recent_events: VecDeque<String>,
}

impl EventBroadcaster {
    fn new() -> Self {
        Self {
            next_client_id: Arc::new(AtomicU64::new(1)),
            clients: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn add_client(&self, stream: TcpStream) {
        self.next_client_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::sync_channel::<String>(64);
        let alive = Arc::new(AtomicBool::new(true));

        self.clients
            .lock()
            .expect("websocket clients lock should not be poisoned")
            .push(WebSocketClient {
                sender,
                alive: Arc::clone(&alive),
            });

        let mut reader_stream = match stream.try_clone() {
            Ok(stream) => stream,
            Err(_) => return,
        };

        let writer_stream = Arc::new(Mutex::new(stream));
        let writer_stream_for_pong = Arc::clone(&writer_stream);
        let alive_for_reader = Arc::clone(&alive);

        thread::spawn(move || {
            let _ = handle_client_control_frames(
                &mut reader_stream,
                &writer_stream_for_pong,
                &alive_for_reader,
            );
        });

        let alive_for_writer = Arc::clone(&alive);
        let writer_stream_for_writer = Arc::clone(&writer_stream);

        thread::spawn(move || {
            while alive_for_writer.load(Ordering::SeqCst) {
                let message = match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok(message) => message,
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => break,
                };

                let mut client_stream = writer_stream_for_writer
                    .lock()
                    .expect("writer stream lock should not be poisoned");

                if write_ws_text_frame(&mut client_stream, &message).is_err() {
                    alive_for_writer.store(false, Ordering::SeqCst);
                    break;
                }
            }
        });
    }

    fn broadcast(&self, payload: &str) {
        let mut clients = self
            .clients
            .lock()
            .expect("websocket clients lock should not be poisoned");

        clients.retain(|client| match client.sender.try_send(payload.to_string()) {
            Ok(()) => client.alive.load(Ordering::SeqCst),
            Err(TrySendError::Full(_)) => {
                client.alive.store(false, Ordering::SeqCst);
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        });
    }

    fn prune_dead_clients(&self) {
        let mut clients = self
            .clients
            .lock()
            .expect("websocket clients lock should not be poisoned");
        clients.retain(|client| client.alive.load(Ordering::SeqCst));
    }

    fn client_count(&self) -> usize {
        self.prune_dead_clients();
        self.clients
            .lock()
            .expect("websocket clients lock should not be poisoned")
            .len()
    }
}

impl EventFanout {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(EventFanoutState::default())),
            broadcaster: EventBroadcaster::new(),
        }
    }

    pub fn publish(&self, event_name: &str) {
        self.publish_with_fields(
            event_name,
            serde_json::Value::Object(serde_json::Map::new()),
        );
    }

    pub fn publish_with_fields(&self, event_name: &str, fields: serde_json::Value) {
        let payload = json!({
            "event": event_name,
            "timestamp": unix_timestamp_seconds(),
            "fields": fields,
        })
        .to_string();

        let mut state = self
            .state
            .lock()
            .expect("event fanout state lock should not be poisoned");
        state.published_total += 1;
        state.recent_events.push_back(event_name.to_string());
        if state.recent_events.len() > EVENT_HISTORY_LIMIT {
            state.recent_events.pop_front();
        }

        drop(state);
        self.broadcaster.broadcast(&payload);
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

    pub fn websocket_client_count(&self) -> usize {
        self.broadcaster.client_count()
    }

    fn register_websocket_client(&self, stream: TcpStream) {
        self.broadcaster.add_client(stream);
    }
}

fn unix_timestamp_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
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
    fanout: EventFanout,
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

        let fanout = EventFanout::new();
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

    pub fn fanout(&self) -> EventFanout {
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
    stream: TcpStream,
    health: &Arc<Mutex<HealthState>>,
    fanout: &EventFanout,
) -> io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;

    let mut websocket_key: Option<String> = None;
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 || line == "\r\n" {
            break;
        }
        let trimmed = line.trim();
        headers.push(trimmed.to_string());
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("Sec-WebSocket-Key") {
                websocket_key = Some(value.trim().to_string());
            }
        }
    }

    let mut stream = reader.into_inner();

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
                "transport": "websocket",
                "path": WEBSOCKET_PATH,
                "connected_clients": fanout.websocket_client_count(),
                "published_total": fanout.published_total(),
                "recent_events": fanout.recent_events(),
            },
        })
    };

    if request_line.starts_with("GET /healthz ") || request_line.starts_with("GET /health ") {
        let body = status_payload.to_string();
        write_http_response(&mut stream, "200 OK", "application/json", &body)
    } else if request_line.starts_with(&format!("GET {WEBSOCKET_PATH} "))
        && headers
            .iter()
            .any(|line| line.to_ascii_lowercase().contains("upgrade: websocket"))
    {
        let key = websocket_key.ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "missing websocket key header")
        })?;

        let accept_key = websocket_accept_key(&key);
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept_key}\r\n\r\n"
        );
        stream.write_all(response.as_bytes())?;
        fanout.register_websocket_client(stream);
        Ok(())
    } else {
        write_http_response(
            &mut stream,
            "404 Not Found",
            "application/json",
            &json!({ "error": "not_found" }).to_string(),
        )
    }
}

fn websocket_accept_key(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{key}{WEBSOCKET_MAGIC_GUID}").as_bytes());
    let digest = hasher.finalize();
    base64::engine::general_purpose::STANDARD.encode(digest)
}

fn handle_client_control_frames(
    reader_stream: &mut TcpStream,
    writer_stream: &Arc<Mutex<TcpStream>>,
    alive: &Arc<AtomicBool>,
) -> io::Result<()> {
    loop {
        let frame = read_client_frame(reader_stream)?;
        match frame.opcode {
            0x8 => {
                alive.store(false, Ordering::SeqCst);
                let mut stream = writer_stream
                    .lock()
                    .expect("writer stream lock should not be poisoned");
                let _ = write_ws_control_frame(&mut stream, 0x8, &[]);
                return Ok(());
            }
            0x9 => {
                let mut stream = writer_stream
                    .lock()
                    .expect("writer stream lock should not be poisoned");
                write_ws_control_frame(&mut stream, 0xA, &frame.payload)?;
            }
            _ => {
                if !frame.fin {
                    alive.store(false, Ordering::SeqCst);
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "fragmented websocket frames are not supported",
                    ));
                }
            }
        }
    }
}

#[derive(Debug)]
struct ClientFrame {
    fin: bool,
    opcode: u8,
    payload: Vec<u8>,
}

fn read_client_frame(stream: &mut TcpStream) -> io::Result<ClientFrame> {
    let mut header = [0u8; 2];
    stream.read_exact(&mut header)?;

    let fin = header[0] & 0x80 != 0;
    let opcode = header[0] & 0x0F;
    let masked = header[1] & 0x80 != 0;
    if !masked {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "client frames must be masked",
        ));
    }

    let payload_len = match header[1] & 0x7F {
        len @ 0..=125 => len as usize,
        126 => {
            let mut extended = [0u8; 2];
            stream.read_exact(&mut extended)?;
            u16::from_be_bytes(extended) as usize
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsupported websocket frame size",
            ));
        }
    };

    let mut mask = [0u8; 4];
    stream.read_exact(&mut mask)?;

    let mut payload = vec![0u8; payload_len];
    stream.read_exact(&mut payload)?;

    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }

    Ok(ClientFrame {
        fin,
        opcode,
        payload,
    })
}

fn write_ws_text_frame(stream: &mut TcpStream, message: &str) -> io::Result<()> {
    write_ws_control_frame(stream, 0x1, message.as_bytes())
}

fn write_ws_control_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> io::Result<()> {
    if payload.len() > 125 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "websocket frame too large for simple sender",
        ));
    }

    let mut frame = Vec::with_capacity(payload.len() + 2);
    frame.push(0x80 | (opcode & 0x0F));
    frame.push(payload.len() as u8);
    frame.extend_from_slice(payload);
    stream.write_all(&frame)
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
    use std::time::Duration;

    fn write_masked_client_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) {
        let mask = [0x11, 0x22, 0x33, 0x44];
        let mut frame = Vec::with_capacity(payload.len() + 6);
        frame.push(0x80 | (opcode & 0x0F));
        frame.push(0x80 | (payload.len() as u8));
        frame.extend_from_slice(&mask);
        for (index, byte) in payload.iter().enumerate() {
            frame.push(*byte ^ mask[index % 4]);
        }
        stream
            .write_all(&frame)
            .expect("masked frame write should work");
    }

    #[test]
    fn event_fanout_tracks_publish_counts() {
        let fanout = EventFanout::new();
        fanout.publish("runtime:start");
        fanout.publish_with_fields("runtime:ready", json!({"server": "127.0.0.1:8787"}));

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
        assert_eq!(payload["event_stream"]["transport"], json!("websocket"));
        assert_eq!(payload["event_stream"]["published_total"], json!(1));

        transport.stop().expect("transport should stop cleanly");
    }

    #[test]
    fn websocket_upgrade_receives_broadcast_event() {
        let server = Server {
            host: "127.0.0.1".to_string(),
            port: 0,
        };
        let transport = ServerTransport::start(
            &server,
            ServerHealthSnapshot {
                apps_loaded: 0,
                scenes_loaded: 0,
                metrics_interval_seconds: 60,
            },
        )
        .expect("server should start");

        let mut stream = TcpStream::connect(transport.local_addr()).expect("connect should work");
        let handshake = format!(
            "GET {WEBSOCKET_PATH} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        stream
            .write_all(handshake.as_bytes())
            .expect("handshake write should work");

        let mut reader = BufReader::new(stream.try_clone().expect("clone should work"));
        let mut status = String::new();
        reader
            .read_line(&mut status)
            .expect("status should be readable");
        assert!(status.starts_with("HTTP/1.1 101"));

        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .expect("header line should be readable");
            if line == "\r\n" || line.is_empty() {
                break;
            }
        }

        let fanout = transport.fanout();
        fanout.publish_with_fields("runtime:ready", json!({"server": "127.0.0.1:8787"}));

        let mut header = [0u8; 2];
        stream
            .read_exact(&mut header)
            .expect("frame header should be readable");
        assert_eq!(header[0], 0x81);

        let payload_len = (header[1] & 0x7F) as usize;
        let mut payload = vec![0u8; payload_len];
        stream
            .read_exact(&mut payload)
            .expect("payload should be readable");

        let payload_text = String::from_utf8(payload).expect("payload should be utf8");
        let message: serde_json::Value =
            serde_json::from_str(&payload_text).expect("payload should be json");
        assert_eq!(message["event"], json!("runtime:ready"));
        assert!(message["timestamp"].as_f64().is_some());
        assert_eq!(message["fields"]["server"], json!("127.0.0.1:8787"));

        transport.stop().expect("transport should stop cleanly");
    }

    #[test]
    fn websocket_ping_receives_pong_with_same_payload() {
        let server = Server {
            host: "127.0.0.1".to_string(),
            port: 0,
        };
        let transport = ServerTransport::start(
            &server,
            ServerHealthSnapshot {
                apps_loaded: 0,
                scenes_loaded: 0,
                metrics_interval_seconds: 60,
            },
        )
        .expect("server should start");

        let mut stream = TcpStream::connect(transport.local_addr()).expect("connect should work");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set read timeout should work");
        let handshake = format!(
            "GET {WEBSOCKET_PATH} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        stream
            .write_all(handshake.as_bytes())
            .expect("handshake write should work");

        let mut reader = BufReader::new(stream.try_clone().expect("clone should work"));
        let mut status = String::new();
        reader
            .read_line(&mut status)
            .expect("status should be readable");
        assert!(status.starts_with("HTTP/1.1 101"));
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .expect("header line should be readable");
            if line == "\r\n" || line.is_empty() {
                break;
            }
        }

        write_masked_client_frame(&mut stream, 0x9, b"abc");

        let mut header = [0u8; 2];
        stream
            .read_exact(&mut header)
            .expect("pong header should be readable");
        assert_eq!(header[0], 0x8A);
        let payload_len = (header[1] & 0x7F) as usize;
        let mut payload = vec![0u8; payload_len];
        stream
            .read_exact(&mut payload)
            .expect("pong payload should be readable");
        assert_eq!(&payload, b"abc");

        transport.stop().expect("transport should stop cleanly");
    }

    #[test]
    fn websocket_close_frame_removes_client_from_health_state() {
        let server = Server {
            host: "127.0.0.1".to_string(),
            port: 0,
        };
        let transport = ServerTransport::start(
            &server,
            ServerHealthSnapshot {
                apps_loaded: 0,
                scenes_loaded: 0,
                metrics_interval_seconds: 60,
            },
        )
        .expect("server should start");

        let mut stream = TcpStream::connect(transport.local_addr()).expect("connect should work");
        let handshake = format!(
            "GET {WEBSOCKET_PATH} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        stream
            .write_all(handshake.as_bytes())
            .expect("handshake write should work");
        let mut reader = BufReader::new(stream.try_clone().expect("clone should work"));
        let mut status = String::new();
        reader
            .read_line(&mut status)
            .expect("status should be readable");
        assert!(status.starts_with("HTTP/1.1 101"));
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .expect("header line should be readable");
            if line == "\r\n" || line.is_empty() {
                break;
            }
        }

        let fanout = transport.fanout();
        for _ in 0..20 {
            if fanout.websocket_client_count() == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(fanout.websocket_client_count(), 1);
        write_masked_client_frame(&mut stream, 0x8, &[]);
        thread::sleep(Duration::from_millis(100));

        let mut health =
            TcpStream::connect(transport.local_addr()).expect("health connect should work");
        health
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .expect("request write should work");
        let mut response = String::new();
        BufReader::new(health)
            .read_to_string(&mut response)
            .expect("response read should work");
        let body = response
            .split("\r\n\r\n")
            .nth(1)
            .expect("http body should be present");
        let payload: serde_json::Value = serde_json::from_str(body).expect("body should be json");
        assert_eq!(payload["event_stream"]["connected_clients"], json!(0));

        transport.stop().expect("transport should stop cleanly");
    }

    #[test]
    fn broadcast_drops_slow_clients_when_queue_is_full() {
        let fanout = EventFanout::new();
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener bind should work");
        let addr = listener.local_addr().expect("local addr should work");

        let accept_handle = thread::spawn(move || listener.accept().expect("accept should work"));
        let client = TcpStream::connect(addr).expect("client connect should work");
        let (server_stream, _) = accept_handle.join().expect("accept thread should join");

        fanout.register_websocket_client(server_stream);
        drop(client);

        for index in 0..128 {
            fanout.publish(&format!("runtime:heartbeat:{index}"));
        }

        thread::sleep(Duration::from_millis(50));
        fanout.publish("runtime:final");

        assert_eq!(fanout.websocket_client_count(), 0);
    }
}
