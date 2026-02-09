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

---

## Completed
- [x] Create `zig/` directory.
- [x] Create `zig/TODO.md` with loop structure and initial plan.

---

## Next Actions (priority order)
1. [ ] **Inventory Nim runtime**: list key entrypoints, modules, and subsystems under `frameos/src/` (apps, drivers, system, runtime boot).
2. [ ] **Define Zig project layout** inside `zig/` (e.g., `src/`, `build.zig`, `README.md`) and mapping from Nim modules.
3. [ ] **Establish build + run scaffolding**: create a minimal Zig `main` that mirrors `frameos/src/frameos.nim` boot flow (stubbed).
4. [ ] **Port config/runtime primitives**: identify async/event loop equivalents and hardware abstraction boundaries.
5. [ ] **Select and document Zig libs** needed for async I/O, filesystem, networking, and GPIO/display drivers (if any).
6. [ ] **Decide parity checkpoints**: e.g., boot → logging → config load → no-op render loop.
7. [ ] **Add a migration checklist** per subsystem (apps, drivers, system services).

---

## Backlog / Later
- [ ] Port individual apps incrementally (start with simplest).
- [ ] Port device drivers with hardware abstraction (SPI/I2C/GPIO). 
- [ ] Add tests or harnesses for parity (unit + integration).
- [ ] Update CI to build Zig runtime artifact(s).
- [ ] Determine deployment strategy for Zig binary (cross-compile for Pi).

---

## Notes / Discoveries
- None yet.

