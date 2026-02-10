# Nim runtime scope (discovery notes)

This document captures the current Nim runtime build/runtime surface so the Rust port can target equivalent behavior.

## Entrypoint and runtime model
- Runtime entrypoint is `frameos/src/frameos.nim`, which imports `frameos/frameos` and waits on `startFrameOS()`.
- Main runtime modules currently include config loading/validation, rendering runner loop, server/websocket interfaces, and app loading under `frameos/src/frameos/`.

## Language/runtime and dependency inventory
- Primary language/runtime: Nim `>= 2.2.4`.
- Core Nim dependencies listed in `frameos/frameos.nimble`:
  - `chrono`, `checksums`, `pixie`, `jester`, `linuxfb`, `psutil`, `ws`, `QRgen`, `jsony`.
- Build-time dependency for embedded assets: `nimassets` task dependency.
- QuickJS JavaScript engine is bootstrapped on first build through `nimble build_quickjs`.

## Build and test steps in current Nim flow
- Local build path:
  - `make build` → runs app loader generation and `nimble build` with tracing flags.
- Run locally:
  - `make run` executes `./build/frameos --verbose`.
- Test suite:
  - `make test` / `nimble test` runs `testament` patterns for nested `tests/*.nim` files.
- Cross-build path:
  - `make cross-<target>` delegates to backend cross-build tooling.
- Nix build paths:
  - `make nix-bin`, `make nix-sdcard`, and related targets for ARM artifacts/system images.

## Porting implications for Rust
- We should preserve config field compatibility first (frame/server settings, dimensions, asset paths, rendering mode flags).
- Asset pipeline must eventually replace `nimassets`-generated modules with Rust-idiomatic embedding or filesystem layout guarantees.
- QuickJS integration should remain optional for early milestones and be treated as a later adapter milestone.
