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


- **Iteration 12:**
  - [x] Expanded runtime health snapshot + `/health` payload to include scheduler/runner readiness booleans, and wired readiness state updates during boot.
  - [x] Added scene-registry-to-apps boundary methods for listing scene IDs and loading built-in scene manifests.
  - [x] Added `system` startup-scene default helpers (`index` vs `wifi-hotspot`) derived from boot config and logged selected default scene during boot.
  - [x] Wired runner startup to resolve scene manifests via apps boundary and include app entrypoint intent in runtime startup behavior.
  - [x] Added a stub `/scenes` route payload contract backed by scene registry manifests and logged route payload during boot.
  - [x] Introduced a `system` hotspot activation stub boundary that consumes startup-scene defaults and reports activation intent.

- **Iteration 13:**
  - [x] Added `SceneManifestResult` and `/scenes/:id` server-route payload contract to surface explicit `scene_not_found` error payloads for unknown scene IDs.
  - [x] Added `renderBootRoutePayloads` wiring + integration-style Zig test that validates boot snapshot payloads for `/health`, `/scenes`, and startup `/scenes/:id` lookup behavior.
  - [x] Extended `system` startup-state mapping with explicit `booting` and `degraded-network` transitional states and threaded state through hotspot activation + boot logging.


- **Iteration 14:**
  - [x] Added `/system/hotspot` server-route payload contract that reports startup-state, hotspot activation intent, and captive-portal URL.
  - [x] Threaded runtime health startup-state progression (`booting` -> `ready`) through readiness gates and surfaced `startupState` in `/health` payloads.
  - [x] Added successful `/scenes/:id` payload tests plus extended boot-route integration coverage for `/system/hotspot` and startup-state-ready health snapshots.

- **Iteration 15:**
  - [x] Added `/system/device` server-route payload contract in `runtime/server.zig` to externalize `system/device_utils` state (name/kind/resolution/rotation/summary).
  - [x] Wired boot payload rendering/logging to include `/system/device` payload snapshots and added route-level Zig tests for the new contract.
  - [x] Threaded failed network-probe handling into `runtime/health.zig` startup-state reconciliation so `networkOk=false` forces `degraded-network`.
  - [x] Extended boot integration tests to assert degraded startup-state behavior under failed probes and `/scenes/:id` success payload selection when the configured startup scene exists.

- **Iteration 16:**
  - [x] Added `runtime/network_probe.zig` with a dedicated stubbed probe boundary (`startup` + target probe outcomes) and unit tests for skipped/failed probe behavior.
  - [x] Wired `startFrameOS` to use the new probe boundary so health network state comes from probe results instead of hardcoded boot logic.
  - [x] Extended `/system/device` payload contract with `startupScene` + `startupState` context and threaded these fields through boot payload rendering.
  - [x] Added route-level test coverage for degraded `/health` payload JSON (`networkOk=false`, `startupState=degraded-network`) plus updated device route and boot integration assertions.

- **Iteration 17:**
  - [x] Added `FRAME_NETWORK_PROBE_MODE` config parsing (`auto` / `force-ok` / `force-failed`) and threaded probe mode labels through boot/startup logging.
  - [x] Extended `runtime/network_probe.zig` with explicit probe-mode behavior so deterministic success/failure simulation no longer depends on host-name heuristics.
  - [x] Added boot-level `boot.network_probe` log payload fields (target host/port, mode, outcome) and expanded `/system/hotspot` route payload with `startupScene` context.

- **Iteration 18:**
  - [x] Added `/system/hotspot` route-level JSON coverage for both `startupScene=wifi-hotspot` and `startupScene=index` variants so startup-scene diagnostics are validated across both expected boot paths.
  - [x] Threaded network-probe mode/outcome metadata into `/health` payload JSON via a `networkProbe` object and updated boot integration coverage to assert successful and failed probe summaries.
  - [x] Added config-level tests that exercise `loadConfig` parsing behavior for `FRAME_NETWORK_PROBE_MODE` (valid and invalid values).

- **Iteration 19:**
  - [x] Tightened `/health` disabled-network coverage with an exact JSON assertion that locks `networkProbe.outcome="unknown"` when checks are off.
  - [x] Added `renderBootNetworkProbePayload` plus an integration-style test that asserts `boot.network_probe` mode/outcome fields stay aligned with `/health` diagnostics.
  - [x] Ported the first concrete app boundary via `apps/clock.zig` and wired `apps/mod.zig` + `runtime/runner.zig` to use clock lifecycle startup summaries.


- **Iteration 20:**
  - [x] Extended `/scenes/:id` payloads to include optional `appLifecycle` metadata (`appId`, `lifecycle`, `frameRateHz`) when a lifecycle boundary is registered, and explicit `null` when missing.
  - [x] Added runner-level fallback coverage proving manifest-present scenes without a registered lifecycle boundary resolve to `missing` startup summaries.
  - [x] Ported a second concrete app boundary via `apps/weather.zig` and wired weather scene startup summaries through `apps/mod.zig`, runner wiring, and route payload assertions.

- **Iteration 15:**
  - [x] Added `/scenes` route lifecycle summaries so list payloads now include per-scene `appLifecycle` metadata (including `null` for scenes with no registered lifecycle boundary).
  - [x] Threaded lifecycle assertions through boot-route integration tests for both registered (`clock`/`weather`) and missing (`news`) boundaries.
  - [x] Ported a third concrete app boundary via `zig/src/apps/calendar.zig` and wired calendar lifecycle startup through `apps/mod.zig`.

- **Iteration 21:**
  - [x] Added `/scenes/:id/settings` route contract in `runtime/server.zig`, including `scene_not_found` error payloads and nullable `settings` fallback for scenes without app settings contracts.
  - [x] Added weather app settings stubs (`location`, `units`, `refreshIntervalMin`) in `apps/weather.zig` and wired `apps/mod.zig` scene settings resolution for both weather and calendar scenes.
  - [x] Extended runner startup diagnostics with app-settings availability (`present`/`missing`) and added unit coverage in `runtime/runner.zig`.
  - [x] Threaded startup-scene settings payload snapshots into `renderBootRoutePayloads` + boot logging so `/scenes/:id/settings` is emitted during startup diagnostics.

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
- [x] Add `system` scene-default helpers that map startup-state decisions (index vs wifi hotspot) from boot config.
- [x] Add scene-registry-to-apps boundary methods for listing and loading scene manifests.
- [x] Expand `/health` route payload with scheduler/runner readiness booleans.
- [x] Add a server stub route for scene-registry discovery payload (`/scenes`) backed by the scene registry boundary.
- [x] Wire scene manifest selection into `runtime/runner.zig` startup logging so app entrypoint intent is explicit.
- [x] Introduce a `system` hotspot activation stub boundary that consumes the startup-scene decision helper.
- [x] Add scene-manifest error payloads for unknown scene IDs and thread them into server-route contracts.
- [x] Add a runtime integration test that exercises boot wiring and validates both `/health` and `/scenes` payload snapshots.
- [x] Extend `system` startup-state mapping to include explicit `booting`/`degraded-network` transitional states.
- [x] Add a stub server route contract for hotspot/portal status payloads so transitional startup state is externally visible.
- [x] Thread startup-state progression (`booting` -> `ready`) into runtime health snapshots once scheduler/runner/server readiness gates are satisfied.
- [x] Add richer scene route tests for successful `/scenes/:id` payload rendering in addition to unknown-scene error payloads.
- [x] Add a dedicated route contract for device-summary payloads (resolution/rotation/kind) to externalize `system/device_utils` state.
- [x] Thread live network probe outcomes (`networkOk=false`) into startup-state transitions so degraded readiness is explicit when probes fail.
- [x] Add a boot integration assertion for `/scenes/:id` success payload selection when configured startup scene exists.

- [x] Add boot-level logging fields for network-probe target/outcome so startup diagnostics can correlate `/health` degradation with probe metadata.
- [x] Add a probe-mode config toggle (stub strategy) to support deterministic success/failure simulation without encoding host-name heuristics.
- [x] Extend `/system/hotspot` payload contract with startup-scene context to align diagnostics shape with `/system/device`.

- [x] Add route-level JSON coverage for `/system/hotspot` startup-scene context under both index and wifi-hotspot startup-scene variants.
- [x] Thread network-probe mode and probe outcome summary into `/health` payload metadata for at-a-glance diagnostics.
- [x] Add config-level tests that exercise `loadConfig` parsing for `FRAME_NETWORK_PROBE_MODE` environment values.

- [x] Add route-level JSON coverage for `/health` when network checks are disabled so `networkProbe.outcome=unknown` is explicitly locked in.
- [x] Introduce a dedicated boot log payload test that validates `boot.network_probe` mode/outcome fields remain aligned with `/health` diagnostics.
- [x] Start porting one concrete Zig app boundary implementation (first target: clock app lifecycle stub) behind `apps/mod.zig`.

- [x] Extend `/scenes/:id` payload contract with optional app lifecycle metadata so route diagnostics can reflect boundary startup intent.
- [x] Add runner-level tests that validate fallback behavior when a scene manifest exists but no app boundary is registered.
- [x] Start porting a second concrete app boundary (next target: weather lifecycle stub) behind `apps/mod.zig`.
- [x] Add `/scenes` route payload lifecycle summaries so list diagnostics mirror `/scenes/:id` app-lifecycle metadata.
- [x] Thread per-scene lifecycle availability into boot-route integration payload assertions (registered + missing boundaries).
- [x] Port a third concrete app boundary (next target: calendar lifecycle stub) behind `apps/mod.zig`.
- [x] Extend route coverage with a dedicated `/scenes` assertion that validates ordering + lifecycle shape across all built-ins (including nullable boundaries).
- [x] Add startup-scene integration coverage for a configured scene that exists but has no registered app lifecycle boundary (`news`) to lock fallback runner diagnostics.
- [x] Start porting app-specific configuration contracts (next target: calendar scene settings payload stub) behind `apps/mod.zig`.

---

## Next Actions (priority order)
1. [ ] Add explicit boot integration assertions for `/scenes/:id/settings` under both success and unknown-scene startup paths (full JSON shape, not substring checks).
2. [ ] Expose `settingsAvailable` metadata on `/scenes` list payload entries so list diagnostics mirror `/scenes/:id/settings` route availability.
3. [ ] Add server startup logging assertions that cover registration of the `/scenes/:id/settings` route alongside existing route diagnostics.

## Backlog / Later
- [ ] Port individual apps incrementally (start with simplest).
- [ ] Port device drivers with hardware abstraction (SPI/I2C/GPIO). 
- [ ] Add tests or harnesses for parity (unit + integration).
- [ ] Update CI to build Zig runtime artifact(s).
- [ ] Determine deployment strategy for Zig binary (cross-compile for Pi).

---

## Notes / Discoveries
- No external Zig package dependency is required yet for the initial runtime primitives; current implementation relies on Zig stdlib only.
