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


### Iteration 16 (durable event-log sink + stdout/ws compatibility checks)
- Added durable JSON-lines event logging support in `src/logging.rs` via `FileJsonLineSink` and `MultiJsonLineSink`, enabling runtime events to be written to both stdout and an append-only file without changing envelope shape.
- Extended CLI parsing and contract metadata with a new `--event-log <path>` flag for both `run` and `check`, and wired `main.rs` to build composite sinks so check/run/failure events all flow through the selected sink set.
- Added parity-oriented tests: contract/CLI coverage for the new flag, runtime parity coverage asserting `check --event-log` writes `runtime:check_ok` JSON lines to disk, and a runtime unit test that verifies emitted event fields match between stdout envelopes and websocket fanout payload fields.
- Updated external interface and CLI usage docs to include durable event-log workflows for service supervision and post-mortem debugging.


### Iteration 17 (full lifecycle transport parity assertions + config-driven sink routing)
- Added deterministic runtime transport tests that assert stdout JSON-line payload fields remain exactly aligned with websocket envelope `fields` across the full lifecycle event set (`runtime:start`, `runtime:ready`, `runtime:heartbeat`, `runtime:metrics_tick`, `runtime:stop`).
- Implemented config-driven sink routing in `src/main.rs`: `config.log_to_file` now enables durable event logging without CLI flags, while `--event-log` cleanly overrides the config default.
- Extended parity tests with fixture-backed checks for `config.log_to_file` behavior and CLI-over-config precedence, plus contract metadata/docs updates describing event-log routing semantics.


### Iteration 18 (renderer/driver parity command + supervision runbooks)
- Added a new `parity` CLI command and machine-readable contract metadata to execute renderer/driver stub checks via `--renderer-contract` + `--driver-contract` JSON inputs, emitting `runtime:parity_ok` and `runtime:parity_failed` events.
- Implemented `src/parity.rs` with typed renderer/driver contract models, disk loaders, and executable invariants (API version alignment, required format coverage, partial-refresh device-kind guards, and positive fps checks).
- Added fixture-backed parity smoke coverage in `tests/runtime_parity.rs` plus parser/contract assertions in `tests/interfaces_cli.rs` and module-level validation tests in `src/parity.rs`.
- Updated parity/external-interface/CLI docs with daemonized supervision examples (systemd/OpenRC + health probe retry loop) and promoted renderer/driver parity status from documentation-only to executable in-progress checks.


### Iteration 19 (deterministic timestamp providers for logging + server transport)
- Added a reusable `TimestampProvider` abstraction in `src/logging.rs` with `SystemTimestampProvider` (production default) plus `FixedTimestampProvider` to enable deterministic JSON-line envelope assertions in unit/integration tests.
- Extended event emission with `emit_event_to_sink_with_timestamp_provider` so sinks can receive stable timestamps independent of wall-clock jitter when tests need exact parity checks.
- Updated `src/server.rs` event fanout/transport startup to support timestamp-provider injection (`EventFanout::with_timestamp_provider`, `ServerTransport::start_with_timestamp_provider`) while keeping production defaults unchanged.
- Added deterministic parity tests covering both logging envelopes and websocket event payload timestamps, confirming transport events can be asserted with exact timestamp equality.


### Iteration 20 (parity scheduling invariants + failure-mode fixtures)
- Extended renderer/driver parity contracts with scheduling/backpressure sections, including checks for target FPS bounds, tick budget vs frame budget, supported drop/backpressure policies, queue-depth consistency, and renderer/driver drop-compatibility constraints.
- Expanded parity success payloads (`runtime:parity_ok`) to include scheduling fields so downstream tooling can inspect negotiated runtime behavior.
- Added fixture coverage for scheduling failure modes (`renderer-invalid-scheduling.json`) and updated parity smoke tests to assert failing command output includes invariant diagnostics.
- Updated CLI/external-interface docs and contract field assertions to reflect the new scheduling parity surface.


### Iteration 21 (probe-based parity sources + source metadata events)
- Added discovery-ready parity source adapters in `src/parity.rs` via `ContractSource` so parity checks can load contracts from fixture files or shell probe commands that emit JSON.
- Extended parity command plumbing in `src/main.rs` + `src/interfaces.rs` with `--renderer-probe-cmd` and `--driver-probe-cmd`, including strict mutually-exclusive source validation per side.
- Expanded `runtime:parity_ok` payload fields with `renderer_contract_source` and `driver_contract_source` so telemetry can track fixture vs discovered parity checks during rollout.
- Added coverage in `tests/runtime_parity.rs` and `tests/interfaces_cli.rs` for probe-flag parsing, contract metadata updates, successful probe-mode parity execution, and mixed-source argument rejection.
- Updated CLI/external-interface/parity-map docs to document probe-driven parity workflows and source metadata semantics.



### Iteration 22 (initial app behavior ports from Nim)
- Replaced the Rust-side app placeholder with a concrete app execution layer in `src/apps.rs`, including `AppExecutionContext`, typed outputs/errors, and keyword dispatch via `execute_ported_app`.
- Ported the first set of executable Nim app behaviors: `data/parseJson`, `data/prettyJson`, `logic/setAsState`, `logic/ifElse`, `logic/nextSleepDuration`, and `logic/breakIfRendering`.
- Preserved core parity semantics for the above apps (JSON parsing/formatting, state writes with exclusive value sources, branch-node selection, sleep-duration mutation, and abort-on-render guard).
- Added focused unit + integration coverage for success and failure paths in app execution, including pretty-print output, branch selection, context mutation, and invalid dual-source state updates.


### Iteration 23 (scene-runner scaffold + deterministic graph execution)
- Added a first executable scene-runner scaffold in `rust/frameos/src/scenes.rs` by introducing typed `SceneGraph` and `SceneNode` models plus a deterministic `run` loop that chains `execute_ported_app` calls.
- Added explicit scene-run diagnostics (`SceneRunError`) for missing/duplicate nodes, loop detection, and per-node app execution failures so manifest graph issues are surfaced with stable error messages.
- Implemented branch-aware traversal semantics where `AppOutput::BranchNode` overrides static edge flow and normal app outputs fall back to `next_node`, matching intended graph behavior for interpreted app chains.
- Added unit tests that cover linear state mutation, branch routing, and cycle detection for regression safety as additional app keywords are ported.


### Iteration 24 (scene-graph manifest adapters + xmlToJson app port)
- Added manifest adapters that load executable `SceneGraph` payloads directly from JSON manifests (`load_scene_graph_manifest`) with typed graph-adapter errors for malformed entries and missing IDs.
- Implemented `SceneGraph::from_json_value` so scene descriptors/payloads can bootstrap deterministic graph execution using either `entry_node`/`next_node` or camelCase aliases from fixture/manifests.
- Ported Nim app behavior for `data/xmlToJson`, including document/element/text/comment/cdata conversion semantics and parse failures surfaced as app field validation errors.
- Added regression coverage for scene-graph manifest loading, JSON-to-graph adaptation, and xml-to-json success/failure paths in the ported app test suite.

### Iteration 25 (eventsToAgenda app port + prettyJson ident parity)
- Ported `data/eventsToAgenda` into `rust/frameos/src/apps.rs` with deterministic event sorting, caret-format agenda rendering, start-with-today behavior, timezone resolution, and all-day vs timed/multi-day output branches aligned to Nim behavior.
- Extended `AppExecutionContext` with optional `time_zone` support so app execution can consume frame-level timezone fallback data when event payloads omit explicit timezone entries.
- Upgraded `data/prettyJson` to honor the Nim `ident` option during prettified output, including validation for non-negative indent width and serializer-based custom spacing control.
- Added focused regression coverage in `rust/frameos/tests/ported_apps.rs` for `eventsToAgenda` golden-ish output scenarios (sorted mixed events, multi-day "Until" rendering, startWithToday ongoing events) plus `prettyJson` ident success/failure behavior.
- Updated Cargo dependencies with `chrono` + `chrono-tz` to support timezone-aware date handling for newly ported agenda formatting logic.


### Iteration 26 (discovery adapters + parity diagnostics + timezone edge tests)
- Replaced shell-based parity probe execution with first-class discovery adapters in a dedicated `src/discovery.rs` module, supporting discovery payload loading from filesystem files or inline JSON while avoiding command execution.
- Updated parity CLI/source wiring to accept `--*-discovery-file` and `--*-discovery-json` flags, with strict mutual-exclusion validation against `--*-contract` file sources.
- Expanded `runtime:parity_failed` diagnostics to include elapsed check duration plus source metadata (`renderer_contract_source`, `driver_contract_source`, and source labels/fingerprints) without logging raw discovery payload contents.
- Added events-to-agenda timezone edge-case tests covering DST boundary formatting and precedence of event-level timezone data over invalid frame fallback timezone values.


## Next up (small, actionable)
1. Add CI-oriented daemon smoke script that boots `frameos run`, probes `/healthz`, then sends SIGINT and validates `runtime:stop` in the event log.
2. Port the next deterministic data app from Nim (for example `data/icalJson` export shaping or `data/clock`) and wire scene-runner coverage around it.
3. Add discovery payload schema validation helpers so malformed discovered contracts fail with field-specific diagnostics before parity checks run.
4. Emit discovery-source metadata in `runtime:parity_ok` beyond source-kind (for example hashed source labels) to improve rollout observability.
5. Add parity integration tests that exercise inline JSON discovery inputs directly for both renderer and driver sides.

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
