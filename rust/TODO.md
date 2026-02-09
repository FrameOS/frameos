# FrameOS → Rust conversion TODO (agent loop)

> This file is designed for iterative LLM execution. Each loop should:
> 1) Read this file fully.
> 2) Update the **Iteration log** with actions and decisions.
> 3) Update **Checklist** status markers.
> 4) Keep **Next up** to a small, actionable set (3-7 items).
> 5) Add citations to files touched in the PR summary.

## Context
- Goal: start a conversion of FrameOS into Rust within this repo.
- Repo root: `/workspace/posthog`.
- Working area: `rust/frameos/`.

## Current state
- A new working directory exists: `rust/frameos/`.
- This TODO file exists: `rust/TODO.md`.

## Iteration log

### Iteration 1 (bootstrap)
- Created `rust/frameos/` to host the new Rust conversion work.
- Added this TODO file with loop structure and initial plan.

## Next up (small, actionable)
1. Identify FrameOS source location(s) and entrypoints (search for FrameOS name, binaries, or docs).
2. Capture scope: what FrameOS does, required behaviors, dependencies, and interfaces.
3. Define initial Rust crate layout in `rust/frameos/` (Cargo.toml, src/, module skeletons).
4. Decide integration strategy with existing Rust workspace (e.g., workspace member vs standalone crate).
5. Produce a minimal “parity map” between existing FrameOS features and planned Rust modules.

## Checklist

### Discovery & scope
- [x] Create `rust/frameos/` working directory.
- [x] Create `rust/TODO.md` with loop format.
- [ ] Locate FrameOS source/docs in repo or external refs.
- [ ] List entrypoints, binaries, services, and configs for FrameOS.
- [ ] Document current language/runtime, dependencies, and build steps.

### Architecture & planning
- [ ] Define target Rust crate(s) and module boundaries.
- [ ] Decide data models and serialization format(s).
- [ ] Define external interfaces (CLI/API/event streams/filesystem).
- [ ] Create a parity map: legacy behavior → Rust module.
- [ ] Define migration strategy (phased rollout, feature flags, shadow mode).

### Implementation (incremental)
- [ ] Add Cargo workspace entry (if needed) and create crate skeleton.
- [ ] Implement config loading and validation.
- [ ] Implement core domain models.
- [ ] Implement I/O adapters (file/network/queue/etc.).
- [ ] Implement main application loop / services.
- [ ] Add logging, metrics, and error handling.
- [ ] Add tests for core logic and adapters.

### Validation & rollout
- [ ] Add parity tests or golden tests.
- [ ] Run necessary linters/tests.
- [ ] Document usage and migration steps.

## Notes / decisions
- Use conventional commits and PR titles.
- Keep each iteration small and explicitly update this file.

