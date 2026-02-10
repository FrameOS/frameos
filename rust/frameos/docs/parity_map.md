# FrameOS parity map (Nim → Rust)

This map tracks concrete behavior in the existing Nim runtime and where it lands in the Rust conversion.

| Legacy behavior area | Nim location | Rust module/plan | Status |
| --- | --- | --- | --- |
| Runtime entrypoint and boot flow | `frameos/src/frameos.nim`, `frameos/src/frameos/frameos.nim` | `src/main.rs`, `src/runtime.rs` | In progress (basic lifecycle events + startup checks) |
| Config loading and defaults | `frameos/src/frameos/config.nim` | `src/config.rs` | Implemented for JSON file loading and validation parity subset |
| Structured logging/event stream | `frameos/src/frameos/utils/logging.nim` | `src/logging.rs` + event contract in `src/interfaces.rs` | In progress (JSON events established, sinks pending) |
| Scene catalog and scene manifest validation | app/scene loader modules under `frameos/src/frameos/apps/` | `src/models.rs`, `src/scenes.rs`, `src/manifests.rs` | Implemented for typed manifest adapters |
| App registry and executable metadata | app modules under `frameos/src/frameos/apps/` | `src/models.rs`, `src/apps.rs`, `src/manifests.rs` | Implemented for typed manifest adapters |
| HTTP/WebSocket runtime server | `jester` + `ws` usage in runtime modules | `src/server.rs` | Planned (endpoint contract modeled, transport server pending) |
| Renderer loop and device drivers | `frameos/src/frameos/runner*`, `drivers/` | Planned crate modules (likely `renderer`, `drivers`) | Not started |
| Metrics and telemetry loop | runtime metrics modules | `src/metrics.rs` | In progress (interval config modeled; collectors pending) |
| Embedded/static assets (`nimassets`) | Nimble task + generated modules | Planned Rust asset strategy (include bytes/build-script or filesystem contract) | Not started |
| QuickJS integration for JS scenes/apps | `build_quickjs` and JS modules | Planned optional adapter crate | Not started |

## Notes
- This is intentionally module-oriented so each future iteration can mark rows as implemented with tests.
- Keep this file in sync with any scope changes reflected in `nim_runtime_scope.md`.
