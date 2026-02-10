# FrameOS Zig Runtime (WIP)

This directory contains the initial Zig-based runtime scaffolding intended to
mirror the existing Nim runtime under `frameos/src/`. The current implementation
is a stub meant to establish project layout, build plumbing, and the entrypoint
parity flow.

## Layout
- `build.zig`: Zig build definition for the runtime stub.
- `src/main.zig`: CLI entrypoint; mirrors `frameos/src/frameos.nim` behavior.
- `src/frameos.zig`: Stubbed runtime boot flow placeholder.

## Nim → Zig mapping (initial)
- `frameos/src/frameos.nim` → `zig/src/main.zig` + `zig/src/frameos.zig`
- `frameos/src/frameos/` modules (config/logger/metrics/runner/etc.) → future
  `zig/src/runtime/` submodules (TBD).
- `frameos/src/apps/`, `frameos/src/drivers/`, `frameos/src/system/` → future
  `zig/src/apps/`, `zig/src/drivers/`, `zig/src/system/`.

## Build & run
```bash
cd zig
zig build
zig build run
zig build run -- check
```
