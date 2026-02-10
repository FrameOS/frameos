# FrameOS Zig Runtime (WIP)

This directory contains the initial Zig-based runtime scaffolding intended to
mirror the existing Nim runtime under `frameos/src/`. The current implementation
now includes basic runtime primitives for configuration, logging, metrics,
driver boundaries, runner startup, scheduler startup, server boundary,
a runtime health contract, and a no-op event loop.

## Layout
- `build.zig`: Zig build definition for the runtime stub.
- `src/main.zig`: CLI entrypoint; mirrors `frameos/src/frameos.nim` behavior.
- `src/frameos.zig`: Boot sequence wiring for runtime primitives.
- `src/runtime/config.zig`: Environment-backed config loading and defaults.
- `src/runtime/logger.zig`: Structured startup + boot logging.
- `src/runtime/metrics.zig`: Metrics startup boundary (stub).
- `src/runtime/platform.zig`: Driver boundary interface (stub init).
- `src/runtime/runner.zig`: Runner startup boundary (stub).
- `src/runtime/scheduler.zig`: Scheduler startup boundary (stub).
- `src/runtime/server.zig`: Server startup boundary + `/health` route contract.
- `src/runtime/health.zig`: Runtime health-check contract and startup snapshot.
- `src/runtime/event_loop.zig`: No-op render/event loop primitive.
- `src/apps/mod.zig`: Placeholder app lifecycle and registration contracts.
- `src/drivers/mod.zig`: Placeholder driver lifecycle and registration contracts.
- `src/system/`: Placeholder system-service contracts (Wi-Fi portal/hotspot + device utilities).

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
zig build test
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

See `MIGRATION_PLAN.md` for selected Zig stdlib boundaries, parity checkpoints, and a subsystem migration checklist.
