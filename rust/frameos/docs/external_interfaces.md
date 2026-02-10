# Rust runtime external interface contract (draft)

This document defines the first stable contract for interacting with the Rust runtime.

## CLI contract

Current commands are implemented in `src/interfaces.rs` and exercised by `src/main.rs`.

### Commands
- `frameos run [--config <path>] [--scenes <path>] [--apps <path>]`
  - Loads config and optional manifests, then emits `runtime:start` + `runtime:ready` events.
- `frameos check [--config <path>] [--scenes <path>] [--apps <path>]`
  - Validates config/manifest loading and emits `runtime:check_ok` or `runtime:check_failed`.
- `frameos contract`
  - Prints machine-readable JSON describing command and event contracts.

### Flags
- `--config <path>`: overrides `FRAMEOS_CONFIG` and default `./frame.json` lookup.
- `--scenes <path>`: preloads and validates a scene manifest.
- `--apps <path>`: preloads and validates an app manifest.

## Event stream contract

Events currently go to stdout as JSON via `logging::log_event`.

Envelope shape:
- `timestamp`: UNIX epoch seconds as float.
- `event`: event payload object.

Event names currently reserved:
- `runtime:start`
- `runtime:ready`
- `runtime:stop` (reserved for upcoming lifecycle shutdown wiring)
- `runtime:check_ok`
- `runtime:check_failed`

## Planned server/API contract

Short-term target:
- keep the event stream transport-agnostic (stdout now; file/socket later);
- expose a local status endpoint mirroring runtime health and loaded manifest counts;
- add websocket broadcast support for lifecycle events once server wiring exists.

## Compatibility rules

- New fields in event payloads should be additive.
- Existing event names should remain stable once marked "implemented" in the parity map.
- Any breaking CLI changes require a TODO iteration note and migration strategy update.
