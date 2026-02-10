# FrameOS → Zig Conversion TODO

> **Audience:** LLM/agent running in a loop. Keep updates short, append-only in the *Iteration Log*, and maintain the *Next Actions* list in priority order.

## Loop Instructions (read every run)
1. Read this file top-to-bottom.
2. Update **Iteration Log** with what you did this run (date/time optional).
3. Move items between **Next Actions** and **Completed** as appropriate.
4. Keep items small and verifiable; prefer checkboxes.
5. If you discover new work, add it to **Next Actions** or **Backlog**.

---

## Status Snapshot
- **Current goal:** Bootstrap a Zig-based runtime alongside the existing Nim runtime, with clear parity milestones.
- **Scope (initial):** `frameos/` device runtime only.
- **Non-goals (initial):** Backend (`backend/`), frontend (`frontend/`), or e2e tooling.

---

## Iteration Log (append-only)
- **Iteration 1:**
  - [x] Created `zig/` directory and initialized this `zig/TODO.md` plan.
- **Iteration 2:**
  - [x] Inventoried Nim runtime structure and boot flow in `zig/INVENTORY.md`.
- **Iteration 3:**
  - [x] Added Zig project scaffolding (`build.zig`, `src/`, `README.md`) and a stubbed boot entrypoint.
- **Iteration 4:**
  - [x] Ported first runtime primitives in Zig: config loading, startup/boot logging, driver boundary stub, and a no-op runtime event loop.
  - [x] Wired `startFrameOS` to mirror Nim order at high level: config → logger → drivers boundary → event loop.
- **Iteration 5:**
  - [x] Added `runtime/metrics.zig` and `runtime/scheduler.zig` stubs to extend boot-sequence parity.
  - [x] Wired `startFrameOS` to initialize metrics and scheduler before entering the event loop.

- **Iteration 6:**
  - [x] Added `runtime/server.zig` startup interface stub for host/port/network-check wiring.
  - [x] Wired `startFrameOS` to initialize server boundary after scheduler startup.

- **Iteration 7:**
  - [x] Added `runtime/health.zig` with a minimal health-check contract (`ok`/`degraded`) and startup snapshot logging.
  - [x] Wired `startFrameOS` to initialize health immediately after server startup and capture network-check intent.
  - [x] Added `zig/MIGRATION_PLAN.md` documenting Zig stdlib selection, parity checkpoints, and subsystem migration checklists.
- **Iteration 8:**
  - [x] Added `runtime/runner.zig` and wired it between driver init and scheduler startup to match Nim startup order.
  - [x] Extended `runtime/server.zig` with a stubbed `/health` route payload contract and logged route/payload wiring from boot.
  - [x] Created `zig/src/apps/mod.zig` and `zig/src/drivers/mod.zig` with placeholder module contracts.
  - [x] Added Zig unit tests for health snapshot behavior, `/health` payload rendering, and config parsing defaults.
- **Iteration 9:**
  - [x] Added `runtime/scenes.zig` with a lightweight scene-registry boundary, built-in scene list, and startup-scene resolution fallback.
  - [x] Wired `startFrameOS` to initialize the scene registry before runner startup and passed resolved scene intent into runner logging.
  - [x] Extended runtime config/logging with `FRAME_STARTUP_SCENE` / `startupScene` wiring and updated dependent unit-test fixtures.

- **Iteration 10:**
  - [x] Added `zig/src/system/` placeholder contracts (`portal.zig`, `device_utils.zig`, `mod.zig`) for hotspot/portal and device utilities boundaries.
  - [x] Wired `startFrameOS` to initialize `SystemServices` between scene registry startup and runner startup to mirror system-scene/device boot intent.
  - [x] Added Zig unit tests for captive-portal URL rendering and device summary formatting in the new system module.

---

- **Iteration 11:**
  - [x] Added `zig/src/drivers/simulator.zig` with a stub simulator startup contract and unit test for default simulator capabilities.
  - [x] Extended `zig/src/drivers/mod.zig` with device-to-driver config mapping and startup dispatch that routes simulator devices through the simulator module.
  - [x] Wired `runtime/platform.zig` + `startFrameOS` to initialize drivers via the new mapping, including simulator-specific startup logging fields.

## Completed
- [x] Create `zig/` directory.
- [x] Create `zig/TODO.md` with loop structure and initial plan.
- [x] **Inventory Nim runtime**: list key entrypoints, modules, and subsystems under `frameos/src/` (apps, drivers, system, runtime boot).
- [x] **Define Zig project layout** inside `zig/` (e.g., `src/`, `build.zig`, `README.md`) and mapping from Nim modules.
- [x] **Establish build + run scaffolding**: create a minimal Zig `main` that mirrors `frameos/src/frameos.nim` boot flow (stubbed).
- [x] **Port config/runtime primitives**: identify async/event loop equivalents and hardware abstraction boundaries.
- [x] Add `runtime/metrics.zig` + `runtime/scheduler.zig` stubs to mirror Nim startup sequence more closely.
- [x] Introduce `runtime/server.zig` interface stub and call it after scheduler wiring.
- [x] Define a minimal runtime health-check contract (`runtime/health.zig`) and wire it after server startup.
- [x] Select/document Zig library strategy for async/filesystem/networking + driver boundaries (current stdlib-first plan).
- [x] Decide/document parity checkpoints and subsystem migration checklist.
- [x] Add `runtime/runner.zig` lifecycle boundary and wire it between drivers and scheduler.
- [x] Add stubbed `/health` server route contract that emits runtime health snapshots.
- [x] Create initial `zig/src/apps/` and `zig/src/drivers/` placeholder module contracts from `MIGRATION_PLAN.md`.
- [x] Add Zig tests for health snapshot logic and config parsing defaults.
- [x] Add `zig/src/system/` placeholder contracts for portal/hotspot and device utilities.
- [x] Add a stub simulator driver module under `zig/src/drivers/` and connect it to `runtime/platform.zig`.

---

## Next Actions (priority order)
1. [ ] Expand `/health` route payload with scheduler/runner readiness booleans.
2. [ ] Add scene-registry-to-apps boundary methods for listing and loading scene manifests.
3. [ ] Add `system` scene-default helpers that map startup-state decisions (index vs wifi hotspot) from boot config.

---

## Backlog / Later
- [ ] Port individual apps incrementally (start with simplest).
- [ ] Port device drivers with hardware abstraction (SPI/I2C/GPIO). 
- [ ] Add tests or harnesses for parity (unit + integration).
- [ ] Update CI to build Zig runtime artifact(s).
- [ ] Determine deployment strategy for Zig binary (cross-compile for Pi).

---

## Notes / Discoveries
- No external Zig package dependency is required yet for the initial runtime primitives; current implementation relies on Zig stdlib only.
