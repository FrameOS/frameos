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

## Next up (small, actionable)
1. Produce a minimal “parity map” between existing FrameOS features and planned Rust modules.
2. Define external interfaces for the Rust runtime (CLI/server lifecycle/log stream contract).
3. Evaluate when to introduce a top-level Cargo workspace once more crates are needed.
4. Define migration strategy notes (phased rollout, feature flags, shadow mode).

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
- [ ] Define external interfaces (CLI/API/event streams/filesystem).
- [ ] Create a parity map: legacy behavior → Rust module.
- [ ] Define migration strategy (phased rollout, feature flags, shadow mode).

### Implementation (incremental)
- [x] Add Cargo workspace entry (if needed) and create crate skeleton.
- [x] Implement config loading and validation.
- [x] Implement core domain models.
- [x] Implement I/O adapters (file/network/queue/etc.).
- [ ] Implement main application loop / services.
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
