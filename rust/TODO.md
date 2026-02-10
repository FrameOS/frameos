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



## Next up (small, actionable)
1. Add parity/golden tests that compare Nim vs Rust manifest/event outputs for known fixtures.
2. Start server transport implementation (HTTP health endpoint + websocket event fanout stub).
3. Define top-level Cargo workspace timing once a second Rust crate is introduced.
4. Extend runtime loop with periodic metrics ticks + heartbeat events so shutdown-safe long-running behavior can be verified.

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
- [ ] Add parity tests or golden tests.
- [x] Run necessary linters/tests.
- [ ] Document usage and migration steps.

## Notes / decisions
- Use conventional commits and PR titles.
- Keep each iteration small and explicitly update this file.
- Continue using JSON + `serde` as the initial serialization format for manifests/state payloads.
