# FrameOS → Rust conversion TODO (agent loop)

> This file is designed for iterative LLM execution. Each loop should:
> 1) Read this file fully.
> 2) Update the **Iteration log** with actions and decisions.
> 3) Update **Checklist** status markers.
> 4) Keep **Next up** to a small, actionable set (3-7 items).
> 5) Add citations to files touched in the PR summary.

## Context
- Goal: start a conversion of FrameOS into Rust within this repo.
- Repo root: `/workspace/frameos`.
- Working area: `rust/frameos/`.

## Current state
- A new working directory exists: `rust/frameos/`.
- This TODO file exists: `rust/TODO.md`.

## Iteration log

### Iteration 1 (bootstrap)
- Created `rust/frameos/` to host the new Rust conversion work.
- Added this TODO file with loop structure and initial plan.

### Iteration 2 (scaffold runtime)
- Located the Nim runtime entrypoint and core module set under `frameos/src/`.
- Sketched a standalone Rust crate with module placeholders and a CLI `check` mode to mirror the Nim entrypoint.
- Decided to keep the Rust crate standalone for now (no workspace at repo root yet).

### Iteration 3 (config + logging scaffolding)
- Added JSON-backed config loading with defaults, validation, and `FRAMEOS_CONFIG` path handling.
- Captured a Rust config struct aligned with the Nim defaults for ports, dimensions, and assets path.
- Added structured logging helpers that emit timestamped JSON events to mirror Nim's log channel.

### Iteration 4 (scope capture + config fixture tests)
- Documented Nim runtime scope, dependency inventory, and current build/test flow in `rust/frameos/docs/nim_runtime_scope.md`.
- Added `FrameOSConfig::load_from_path` to make config parsing testable without global environment mutation.
- Added fixture-backed Rust tests for successful config parsing and validation failure on relative `assets_path`.

### Iteration 5 (core domain models + JSON contracts)
- Introduced core domain models for frame state, scene descriptors, and app descriptors under `src/models.rs`.
- Standardized JSON serialization contracts via `serde` for status values and scene source tagging (`type` + `snake_case` values).
- Wired placeholder scene/app registries to typed descriptors to reduce future refactors when loading manifests and scene catalogs.
- Added unit tests that exercise serialization of scene descriptors and deserialization of frame state payloads.

### Iteration 6 (descriptor validation + manifest fixtures)
- Added explicit validation helpers for `SceneDescriptor` and `AppDescriptor`, covering required fields, semver-like version format, and source invariants (`asset_path` absolute paths, `remote_url` scheme checks).
- Introduced a shared `ModelValidationError` type with friendly error messages for future CLI/API surfacing.
- Added JSON fixture manifests for valid/invalid app and scene payloads and contract tests that deserialize and validate each fixture entry.


### Iteration 7 (manifest loading adapters)
- Added manifest loading adapters in `rust/frameos/src/manifests.rs` to read app/scene JSON files from disk, deserialize payloads, and run model validation with typed error reporting.
- Added adapter helpers returning `SceneCatalog` and `AppRegistry` directly so runtime boot logic can consume validated manifests without duplicate conversion code.
- Added filesystem-backed integration tests that cover successful loads plus parse/validation failure paths.

### Iteration 8 (CLI/event contracts + planning docs)
- Added explicit external runtime interfaces in Rust via `src/interfaces.rs`, including a typed CLI parser (`run`, `check`, `contract`) and a machine-readable command/event contract JSON payload.
- Wired `main.rs` + `runtime.rs` to support config override paths, manifest preloading during `check/run`, and lifecycle events (`runtime:start`, `runtime:ready`, `runtime:check_ok`, `runtime:check_failed`).
- Expanded runtime scaffolding by connecting server/metrics placeholders to config-derived state so lifecycle checks report endpoint and interval values.
- Documented parity mapping, external interface contracts, and phased migration strategy in `rust/frameos/docs/` so architecture/planning checklist items are now concretely tracked.
- Added CLI/contract tests to lock parser behavior and reserved contract surface for follow-up iterations.


### Iteration 9 (graceful shutdown loop wiring)
- Reworked the runtime lifecycle to run in a shutdown-aware loop (`run_until_stopped`) and emit `runtime:stop` as part of the actual lifecycle path rather than only via static contract docs.
- Added Ctrl+C signal handling in `main.rs` via `ctrlc` so `frameos run` now transitions through `runtime:start` → `runtime:ready` → `runtime:stop` under a real termination signal.
- Added runtime tests that exercise both explicit shutdown signaling and the temporary scaffolding `start()` path so lifecycle behavior remains regression-tested as server transport work lands.



### Iteration 10 (runtime ticks + parity-oriented CLI golden tests)
- Extended the shutdown-aware runtime loop to emit periodic `runtime:heartbeat` and `runtime:metrics_tick` events with uptime and manifest-load counters, preserving stop behavior.
- Added dedicated tick-state unit tests for heartbeat and metrics interval boundaries so loop timing logic is regression-tested without long sleeps.
- Added integration-style parity tests that execute the built `frameos` binary for `check`/`contract` commands and assert golden event output contracts against fixture manifests.
- Updated interface/parity docs to include the newly implemented lifecycle events and metrics-loop progress.


### Iteration 11 (server transport scaffold: health + event fanout stub)
- Implemented `src/server.rs` transport scaffolding with a lightweight HTTP listener that serves `/healthz` and `/health` JSON snapshots containing runtime counters and manifest load state.
- Added an in-memory websocket fanout stub (`EventFanoutStub`) that tracks published lifecycle event names and exposes bounded event history for future websocket broadcast wiring.
- Wired `runtime::run_until_stopped` to boot/stop the server transport, publish lifecycle/tick events into fanout state, and include the discovered health endpoint in the `runtime:ready` payload.
- Added unit coverage for fanout accounting, loopback bind fallback behavior, and health endpoint responses over a real TCP request.


### Iteration 12 (websocket broadcast transport + health contract updates)
- Replaced the in-memory websocket fanout stub with a lightweight websocket broadcaster in `src/server.rs`, including RFC6455 handshake handling for `/ws/events` and JSON text-frame fanout of lifecycle/tick events.
- Updated health payload metadata to report websocket transport details (`transport`, `path`, `connected_clients`) while preserving published event counters/history for parity tracking.
- Added server tests covering websocket upgrade + broadcast delivery and updated runtime/docs contract strings from `websocket_stub` to `websocket`.


### Iteration 13 (websocket control-frame hardening + CLI usage docs)
- Hardened websocket transport in `src/server.rs` with control-frame support: server now responds to ping frames with pong payload echoes, acknowledges close frames, and tracks client liveness for cleanup.
- Added bounded backpressure handling for websocket clients by dropping clients whose outbound queue is saturated, preventing slow consumers from stalling broadcaster behavior.
- Added focused server tests for ping/pong behavior, close-frame cleanup reflected in `/healthz`, and backpressure-based client eviction.
- Added `rust/frameos/docs/rust_cli_usage.md` with concrete build/run/check/contract commands and migration guidance for shadow validation and phased adoption.
- Updated external interface docs to reflect implemented websocket control-frame behavior and narrowed next transport/documentation steps.



### Iteration 14 (enriched websocket payloads + JSON-lines log sink)
- Expanded websocket event payloads in `src/server.rs` from name-only messages to additive envelopes: `{ "event": <name>, "timestamp": <epoch_secs>, "fields": { ... } }`.
- Added `EventFanout::publish_with_fields` and wired `runtime::run_until_stopped` to include selected lifecycle/tick context (server endpoint, uptime, manifest counters, metrics interval) in websocket event fields while keeping the `event` key unchanged for compatibility.
- Introduced a JSON-lines sink abstraction in `src/logging.rs` (`JsonLineSink`) with `StdoutJsonLineSink` and test-friendly `MemoryJsonLineSink`, plus `emit_event_to_sink` for deterministic event assertions without stdout substring matching.
- Added/updated tests to validate enriched websocket message shape and memory sink JSON capture behavior.


### Iteration 15 (contract field map + sink-injected runtime traces + production fixtures)
- Extended `command_contract_json()` with explicit per-command event field maps under `command_event_fields`, so downstream consumers can discover websocket payload keys by command/event without scraping prose docs.
- Refactored runtime/check emission paths to support sink injection (`check_with_sink`, `run_until_stopped_with_sink`) and centralized event emission through a shared helper that writes to JSON-line sinks while publishing websocket fanout events.
- Added runtime unit coverage asserting deterministic lifecycle trace ordering (`runtime:start` → `runtime:ready` → `runtime:stop`) and `runtime:check_ok` sink output without stdout capture.
- Added production-like fixture manifests/config under `tests/fixtures/production/` plus parity smoke coverage that executes `frameos check` against that layout.
- Updated CLI/external interface docs to include the production fixture smoke workflow and document the new contract-field discovery surface.
## Next up (small, actionable)
1. Start scoping renderer/device-driver parity slices so migration cutover gates can move from documentation into executable checks.
2. Add contract tests that assert event field compatibility between stdout envelopes and websocket fanout messages for each lifecycle event.
3. Add CLI/docs examples for daemonized `run` supervision (service manager integration, health probe retries, shutdown signaling).
4. Evaluate whether websocket/event sinks should support optional durable persistence (file sink) for post-mortem debugging in production.

## Checklist

### Discovery & scope
- [x] Create `rust/frameos/` working directory.
- [x] Create `rust/TODO.md` with loop format.
- [x] Locate FrameOS source/docs in repo or external refs.
- [x] List entrypoints, binaries, services, and configs for FrameOS.
- [x] Document current language/runtime, dependencies, and build steps.

### Architecture & planning
- [x] Define target Rust crate(s) and module boundaries.
- [x] Decide data models and serialization format(s).
- [x] Define external interfaces (CLI/API/event streams/filesystem).
- [x] Create a parity map: legacy behavior → Rust module.
- [x] Define migration strategy (phased rollout, feature flags, shadow mode).

### Implementation (incremental)
- [x] Add Cargo workspace entry (if needed) and create crate skeleton.
- [x] Implement config loading and validation.
- [x] Implement core domain models.
- [x] Implement I/O adapters (file/network/queue/etc.).
- [x] Implement main application loop / services.
- [x] Add logging and error handling scaffolding.
- [x] Add tests for core logic and adapters.

### Validation & rollout
- [x] Add parity tests or golden tests.
- [x] Run necessary linters/tests.
- [x] Document usage and migration steps.

## Notes / decisions
- Use conventional commits and PR titles.
- Keep each iteration small and explicitly update this file.
- Continue using JSON + `serde` as the initial serialization format for manifests/state payloads.
