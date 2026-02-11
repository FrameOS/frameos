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
- Run renderer/driver contract parity checks from fixture files:
  - `cargo run -- parity --renderer-contract ./tests/fixtures/parity/renderer-valid.json --driver-contract ./tests/fixtures/parity/driver-valid.json`
- Run parity checks from discovery probe commands (stdout must be JSON):
  - `cargo run -- parity --renderer-probe-cmd 'cat ./tests/fixtures/parity/renderer-valid.json' --driver-probe-cmd 'cat ./tests/fixtures/parity/driver-valid.json'`
- Exercise scheduling failure fixtures (should emit `runtime:parity_failed`):
  - `cargo run -- parity --renderer-contract ./tests/fixtures/parity/renderer-invalid-scheduling.json --driver-contract ./tests/fixtures/parity/driver-valid.json`
- Run Rust e2e snapshot parity and emit generated PNGs under `e2e/rust-output`:
  - `cargo run -- e2e`
- Override e2e IO directories explicitly (useful for CI temp dirs):
  - `cargo run -- e2e --e2e-scenes ../../e2e/scenes --e2e-snapshots ../../e2e/snapshots --e2e-assets ../../e2e/assets --e2e-output ../../e2e/rust-output-ci`
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


## Daemonized run supervision examples

Use these as migration-time templates while `run` parity is still maturing:

### systemd unit (example)

```ini
[Unit]
Description=FrameOS Rust runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/frameos/rust/frameos
ExecStart=/opt/frameos/rust/frameos/target/release/frameos run --config /etc/frameos/frame.json --event-log /var/log/frameos/runtime-events.jsonl
Restart=on-failure
RestartSec=2
KillSignal=SIGINT
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

### OpenRC service command sketch

```sh
command="/opt/frameos/rust/frameos/target/release/frameos"
command_args="run --config /etc/frameos/frame.json --event-log /var/log/frameos/runtime-events.jsonl"
command_background="yes"
pidfile="/run/frameos-rust.pid"
retry="SIGINT/20/SIGKILL/5"
```

### Health probe retry suggestion

After booting the service, retry `/healthz` before declaring startup success:

```sh
for i in $(seq 1 20); do
  curl -fsS http://127.0.0.1:8787/healthz && break
  sleep 1
done
```

This mirrors migration cutover checks by waiting for `runtime:ready` and a healthy HTTP endpoint before promoting traffic.


Parity success events (`runtime:parity_ok`) now include `renderer_contract_source` and `driver_contract_source` (`fixture` or `discovered`) so rollout dashboards can distinguish static-fixture vs probe-based checks.

E2E parity command emits `runtime:e2e_ok` on success and `runtime:e2e_failed` on threshold mismatch/errors, including scene counts and failure diagnostics suitable for CI gate parsing.
