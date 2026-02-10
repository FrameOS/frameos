# Rust runtime external interface contract (draft)

This document defines the first stable contract for interacting with the Rust runtime.

## CLI contract

Current commands are implemented in `src/interfaces.rs` and exercised by `src/main.rs`.

### Commands
- `frameos run [--config <path>] [--scenes <path>] [--apps <path>] [--event-log <path>]`
  - Loads config and optional manifests, then emits `runtime:start` + `runtime:ready` events.
- `frameos check [--config <path>] [--scenes <path>] [--apps <path>] [--event-log <path>]`
  - Validates config/manifest loading and emits `runtime:check_ok` or `runtime:check_failed`.
- `frameos parity (--renderer-contract <path> | --renderer-probe-cmd <shell command>) (--driver-contract <path> | --driver-probe-cmd <shell command>) [--event-log <path>]`
  - Validates renderer/driver contracts against executable parity invariants (API version match, required format coverage, partial-refresh/device-kind guardrails, and scheduling/backpressure compatibility checks).
  - Exactly one source flag per side is required (`--*-contract` and `--*-probe-cmd` are mutually exclusive).
- `frameos contract`
  - Prints machine-readable JSON describing command and event contracts.

### Flags
- `--config <path>`: overrides `FRAMEOS_CONFIG` and default `./frame.json` lookup.
- `--scenes <path>`: preloads and validates a scene manifest.
- `--apps <path>`: preloads and validates an app manifest.
- `--event-log <path>`: appends the same JSON-line event envelopes emitted to stdout into a durable file sink for post-mortem analysis.
- `--renderer-probe-cmd <shell command>`: executes a shell command and parses stdout as renderer-contract JSON.
- `--driver-probe-cmd <shell command>`: executes a shell command and parses stdout as driver-contract JSON.
- `config.log_to_file`: optional config-level default file sink path used when `--event-log` is omitted.
- Precedence: `--event-log` overrides `config.log_to_file` when both are supplied.

## Event stream contract

Events currently go to stdout as JSON via `logging::log_event`.

Envelope shape:
- `timestamp`: UNIX epoch seconds as float.
- `event`: event payload object.

Event names currently reserved:
- `runtime:start`
- `runtime:ready`
- `runtime:stop`
- `runtime:check_ok`
- `runtime:check_failed`
- `runtime:parity_ok` (includes `renderer_contract_source` and `driver_contract_source`)
- `runtime:parity_failed`
- `runtime:heartbeat`
- `runtime:metrics_tick`

## Server/API contract status

Implemented in the current scaffold:
- local HTTP health endpoints at `/healthz` (and alias `/health`) served by `src/server.rs` once `frameos run` starts;
- health payload includes manifest-load counters, heartbeat/metrics tick counters, and event transport metadata;
- websocket event stream available at `/ws/events` using a text-frame broadcaster that emits additive JSON envelopes of shape `{ "event": "<name>", "timestamp": <epoch_secs>, "fields": { ... } }`; the top-level `event` key remains stable for compatibility.
- websocket transport now handles ping/pong frames, replies to close frames, and enforces bounded sender queues by dropping backpressured clients.

Next transport steps:
- keep `command_event_fields` updated as websocket envelopes gain additive field keys, preserving stable event names.
- extend contract coverage as future renderer/device-driver events are added for parity gates.

## Compatibility rules

- New fields in event payloads should be additive.
- Existing event names should remain stable once marked "implemented" in the parity map.
- Any breaking CLI changes require a TODO iteration note and migration strategy update.


## Renderer/driver parity stub contract

The `parity` command introduces an executable gate for migration slices that were previously documentation-only:

- renderer contract JSON fields: `api_version`, `supports_layers`, `supported_color_formats`, `max_fps`, `scheduling.target_fps`, `scheduling.tick_budget_ms`, `scheduling.drop_policy`;
- driver contract JSON fields: `api_version`, `device_kind`, `required_renderer_formats`, `supports_partial_refresh`, `scheduling.backpressure_policy`, `scheduling.max_queue_depth`;
- invariants enforced: matching API versions, non-empty format sets, driver-required formats must be provided by renderer, partial refresh allowed only for `eink`/`epd`, `max_fps > 0`, `target_fps <= max_fps`, tick budget must fit inside the target frame budget, allowed drop/backpressure policies, queue-depth/backpressure consistency, and drop-policy compatibility when driver backpressure policy is `drop`.

This command is intentionally stub-oriented and designed to evolve into concrete renderer/driver adapter probes without breaking existing event names. The success payload also carries source metadata (`fixture` vs `discovered`) for migration-progress dashboards.
