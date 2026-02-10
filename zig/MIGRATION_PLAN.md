# Zig Runtime Migration Plan (Checkpointed)

## Selected Zig libraries (current)
- **Core runtime, allocator, I/O, filesystem, and networking:** Zig `std`.
  - `std.fs` for filesystem traversal/config and asset loading.
  - `std.net` for TCP/HTTP primitives required by device API and cloud callbacks.
  - `std.posix` for Linux-level device boundaries when needed.
- **Async model:** begin with Zig `std` + explicit scheduler/loop abstraction in `src/runtime/`.
- **GPIO/display drivers:** no external packages selected yet; defer until driver parity starts and evaluate whether direct Linux interfaces are enough versus a dedicated library.

## Parity checkpoints
1. ✅ Boot sequence scaffolding (config → logger → metrics → platform → scheduler → server).
2. ✅ No-op render/event loop with structured startup logs.
3. ✅ Health contract stub after server startup.
4. ✅ Runner contract + app registry boundary stubs.
5. ✅ Minimal server endpoint parity (`/health`, static status payload).
6. ⏳ First device driver parity slice (simulator).

## Subsystem migration checklist

### Runtime core (`zig/src/runtime`)
- [x] Config
- [x] Logger
- [x] Metrics boundary
- [x] Scheduler boundary
- [x] Server boundary
- [x] Health contract
- [x] Runner lifecycle
- [ ] Scene registry
- [ ] Script/interpreter boundary

### Apps (`zig/src/apps`)
- [x] Define app interface traits/types
- [ ] Port simplest app as reference
- [ ] Add app loading/selection flow

### Drivers (`zig/src/drivers`)
- [ ] Simulator driver
- [x] GPIO/display/transport contract placeholders
- [ ] Framebuffer output boundary implementation
- [ ] I2C/SPI adapters

### System services (`zig/src/system`)
- [ ] Wi-Fi hotspot/network portal boundary
- [ ] System scene defaults
- [ ] Device management utilities
