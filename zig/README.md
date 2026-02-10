# FrameOS Zig Runtime (WIP)

This directory contains the initial Zig-based runtime scaffolding intended to
mirror the existing Nim runtime under `frameos/src/`. The current implementation
now includes basic runtime primitives for configuration, logging, metrics,
driver boundaries, scheduler startup, server boundary, and a no-op event loop.

## Layout
- `build.zig`: Zig build definition for the runtime stub.
- `src/main.zig`: CLI entrypoint; mirrors `frameos/src/frameos.nim` behavior.
- `src/frameos.zig`: Boot sequence wiring for runtime primitives.
- `src/runtime/config.zig`: Environment-backed config loading and defaults.
- `src/runtime/logger.zig`: Structured startup + boot logging.
- `src/runtime/metrics.zig`: Metrics startup boundary (stub).
- `src/runtime/platform.zig`: Driver boundary interface (stub init).
- `src/runtime/scheduler.zig`: Scheduler startup boundary (stub).
- `src/runtime/server.zig`: Server startup boundary (stub).
- `src/runtime/event_loop.zig`: No-op render/event loop primitive.

## Nim → Zig mapping (initial)
- `frameos/src/frameos.nim` → `zig/src/main.zig` + `zig/src/frameos.zig`
- `frameos/src/frameos/` modules (config/logger/metrics/runner/etc.) →
  `zig/src/runtime/` submodules (in progress).
- `frameos/src/apps/`, `frameos/src/drivers/`, `frameos/src/system/` → future
  `zig/src/apps/`, `zig/src/drivers/`, `zig/src/system/`.

## Build & run
```bash
cd zig
zig build
zig build run
zig build run -- check
```

## Runtime environment knobs (current)
- `FRAME_HOST` (default: `127.0.0.1`)
- `FRAME_PORT` (default: `8787`)
- `FRAME_DEVICE` (default: `simulator`)
- `FRAME_DEBUG` (default: `false`)
- `FRAME_METRICS_INTERVAL` (default: `60`)
- `FRAME_NETWORK_CHECK` (default: `true`)
