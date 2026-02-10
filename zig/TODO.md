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

---

## Completed
- [x] Create `zig/` directory.
- [x] Create `zig/TODO.md` with loop structure and initial plan.
- [x] **Inventory Nim runtime**: list key entrypoints, modules, and subsystems under `frameos/src/` (apps, drivers, system, runtime boot).
- [x] **Define Zig project layout** inside `zig/` (e.g., `src/`, `build.zig`, `README.md`) and mapping from Nim modules.
- [x] **Establish build + run scaffolding**: create a minimal Zig `main` that mirrors `frameos/src/frameos.nim` boot flow (stubbed).
- [x] **Port config/runtime primitives**: identify async/event loop equivalents and hardware abstraction boundaries.
- [x] Add `runtime/metrics.zig` + `runtime/scheduler.zig` stubs to mirror Nim startup sequence more closely.
- [x] Introduce `runtime/server.zig` interface stub and call it after scheduler wiring.

---

## Next Actions (priority order)
1. [ ] **Select and document Zig libs** needed for async I/O, filesystem, networking, and GPIO/display drivers (if any).
2. [ ] **Decide parity checkpoints**: e.g., boot → logging → config load → no-op render loop.
3. [ ] **Add a migration checklist** per subsystem (apps, drivers, system services).
4. [ ] Define a minimal runtime health-check contract (`runtime/health.zig`) and wire it after server startup.

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
