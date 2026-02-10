# Rust CLI usage and migration notes

This guide describes how to run the Rust `frameos` binary during the conversion period and how to map current workflows from the Nim runtime.

## Build and run

From `rust/frameos/`:

- Build once:
  - `cargo build`
- Validate config/manifests without starting the server loop:
  - `cargo run -- check --config ./tests/fixtures/frame-valid.json --scenes ./tests/fixtures/scenes-valid.json --apps ./tests/fixtures/apps-valid.json`
- Persist emitted JSON-line events while checking/running:
  - `cargo run -- check --config ./tests/fixtures/frame-valid.json --event-log ./runtime-events.jsonl`
- Config-driven event logs (no CLI flag) using `frame.json`:
  - set `"log_to_file": "/var/log/frameos/runtime-events.jsonl"` and run `cargo run -- check --config ./frame.json`
- CLI `--event-log` takes precedence over `config.log_to_file` when both are set.
- Print machine-readable command/event contract JSON:
  - `cargo run -- contract`
- Start runtime (Ctrl+C to stop):
  - `cargo run -- run --config ./tests/fixtures/frame-valid.json --event-log ./runtime-events.jsonl`

## Production-like config examples and CI smoke checks

A production-style fixture set is available under `tests/fixtures/production/`:

- `frame.json`: host/device dimensions + non-debug runtime options
- `scenes.json`: absolute-path scene source descriptors
- `apps.json`: executable descriptors with entry scene + env

Smoke-check command:

- `cargo test --test runtime_parity check_command_supports_production_like_fixture_layout`

This keeps a realistic config layout under test so migration progress does not regress toward test-only fixtures.

## Runtime endpoints and events

When `run` starts successfully:

- health endpoint is available at `/healthz` (`/health` alias);
- websocket event stream is available at `/ws/events`;
- lifecycle and periodic events are emitted to stdout and websocket clients.

Current websocket behavior includes:

- RFC6455 upgrade handshake;
- text-frame broadcast of runtime events as additive envelopes (`{"event":"runtime:...","timestamp":...,"fields":{...}}`);
- ping/pong handling (server replies to ping payloads);
- close-frame acknowledgement and client cleanup;
- bounded sender queues with drop-on-backpressure semantics for slow clients.

## Migration strategy (Nim -> Rust)

Use this phased approach while parity is still in progress:

1. **Contract-first validation**: use `check` in CI/dev scripts to validate config and manifest compatibility before attempting runtime boot.
2. **Shadow runtime checks**: run Rust `check` next to Nim deployments to compare manifest and config acceptance behavior.
3. **Operational probing**: for `run`, monitor `/healthz` and websocket event counters to verify lifecycle progression (`runtime:start`, `runtime:ready`, heartbeat, metrics ticks, stop).
4. **Incremental consumer adoption**: point internal tools that consume event streams to `/ws/events`; keep compatibility by depending only on currently documented event names.
5. **Cutover readiness gate**: only promote Rust `run` into primary deployment flow once renderer/device-driver parity items in `parity_map.md` are implemented.
