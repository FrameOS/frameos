# FrameOS Test Generation Memory

Last updated: 2026-03-05
Source audit: deep manual audit of `src/frameos/*`, `src/system/*`, and `src/apps/*` on 2026-03-05
Scope: `frameos/src/*`

## Purpose

This file is the persistent memory for generating and improving tests in `frameos/`.
Each agent run should complete at least one small batch of tasks, update this file, and commit.

## How To Use This File On Every Run

1. Pick 1-2 `READY` tasks from the backlog (prefer highest priority and smallest scope).
2. Implement tests only (or tiny testability refactors if absolutely required).
3. Run `cd frameos && nimble test` (or targeted testament pattern while iterating, then full run before commit).
4. Update this file:
- Move completed tasks to `DONE LOG` with date + commit hash.
- Add follow-up tasks if new gaps are discovered.
- Update `NEXT RUN PICK`.
5. Commit code + this file in the same commit.

## Rules

- Do not change production behavior unless required to make code testable.
- Prefer deterministic tests over `sleep(...)` based assertions.
- Keep task size small enough for one run (roughly 30-120 minutes).
- If a task needs deeper refactor, split it and create child tasks.

## Status Legend

- `READY`: can be picked immediately
- `BLOCKED`: waiting on prerequisite or design choice
- `DONE`: completed and logged

## Priority Backlog (Run-Sized)

## P0 Runtime/Core

- [x] `FTEST-002` (`DONE`): Add interpreter error-path tests.
  Target: `src/frameos/interpreter.nim`
  New test file: `src/frameos/tests/test_interpreter_errors.nim`
  Acceptance:
  - Invalid node references and malformed state paths are asserted.
  - Error propagation/log signaling behavior is verified.

- [x] `FTEST-003` (`DONE`): Add runner loop safety test.
  Target: `src/frameos/runner.nim`
  New test file: `src/frameos/tests/test_runner_loop.nim`
  Acceptance:
  - Render/message loop can start and process one controlled cycle.
  - Test exits deterministically without hangs.

- [x] `FTEST-004` (`DONE`): Add startup fallback test.
  Target: `src/frameos/frameos.nim`, `src/frameos/boot_guard.nim`
  New test file: `src/frameos/tests/test_frameos_startup.nim`
  Acceptance:
  - Simulate crash-count threshold and verify fallback scene selection behavior.

## P1 Server/System

- [x] `FTEST-006` (`DONE`): Add system index scene text/list generation tests.
  Target: `src/system/index/scene.nim`
  New test file: `src/system/index/tests/test_scene.nim`
  Acceptance:
  - Scene list includes expected interpreted + system scenes.
  - Output text formatting assertions cover stable structure.

- [x] `FTEST-007` (`DONE`): Add bootGuard system scene rendering tests.
  Target: `src/system/bootGuard/scene.nim`
  New test file: `src/system/bootGuard/tests/test_scene.nim`
  Acceptance:
  - Failure details mapping to rendered text is verified.
  - Safe behavior when fields are missing.

- [x] `FTEST-008` (`DONE`): Add wifiHotspot system scene state transition tests.
  Target: `src/system/wifiHotspot/scene.nim`
  New test file: `src/system/wifiHotspot/tests/test_scene.nim`
  Acceptance:
  - Node/event flow changes expected state.
  - Rendering path works with minimal mocked context.

## P1 Apps

- [x] `FTEST-009` (`DONE`): Add tests for `apps/apps.nim` app dispatch.
  Target: `src/apps/apps.nim`
  New test file: `src/apps/tests/test_apps_dispatch.nim`
  Acceptance:
  - `initApp`, `setAppField`, `runApp`, `getApp` route correctly for known app types.
  - Unknown keywords fail predictably.

- [x] `FTEST-010` (`DONE`): Add tests for render split math helpers.
  Target: `src/apps/render/split/app.nim`
  New test file: `src/apps/render/split/tests/test_split_math.nim`
  Acceptance:
  - Ratios/margins/gaps parsing and computed dimensions asserted across edge cases.

- [x] `FTEST-011` (`DONE`): Add tests for calendar grouping/sorting helpers.
  Target: `src/apps/render/calendar/app.nim`
  New test file: `src/apps/render/calendar/tests/test_grouping.nim`
  Acceptance:
  - All-day vs timed ordering rules validated.
  - Multi-day and malformed input edge cases covered.

## P2 Utilities/Hardening

- [x] `FTEST-013` (`DONE`): De-duplicate server cache-header assertions.
  Target: `src/frameos/server/tests/test_server.nim`, `src/frameos/server/tests/test_api.nim`
  Acceptance:
  - Single canonical test owner for shared cache semantics.
  - Keep coverage, reduce overlap noise.

- [x] `FTEST-014` (`DONE`): Add URL helper tests for auth/public URL behavior.
  Target: `src/frameos/utils/url.nim`
  New test file: `src/frameos/utils/tests/test_url.nim`
  Acceptance:
  - `publicScheme/publicHost/publicPort/publicBaseUrl` behavior is asserted for proxy and fallback paths.
  - `authenticatedFrameUrl` query/key rules are asserted for public/private + read/write modes.
  - `hotspotSetupPort` fallback behavior is covered when no setup proxy port is active.

- [x] `FTEST-015` (`DONE`): Add scene helper tests for upload normalization + path sanitization.
  Target: `src/frameos/scenes.nim`
  New test file: `src/frameos/tests/test_scenes_helpers.nim`
  Acceptance:
  - `sanitizePathString` normalizes invalid characters, trims, and length-limits output.
  - `normalizeUploadedScenePayload` prefixes uploaded IDs.
  - Cross-node scene references are rewritten only for in-payload scene IDs.

- [x] `FTEST-016` (`DONE`): Add app utility tests for filename cleanup and render dimension helpers.
  Target: `src/frameos/apps.nim`
  New test file: `src/frameos/tests/test_apps_helpers.nim`
  Acceptance:
  - `renderWidth/renderHeight` assertions for rotations 0/90/180/270.
  - `cleanFilename` behavior for invalid chars and duplicate spaces.
  - `saveAsset` early-return behavior for disabled `saveAssets` settings.

- [x] `FTEST-017` (`DONE`): Add channels behavior tests.
  Target: `src/frameos/channels.nim`
  New test file: `src/frameos/tests/test_channels.nim`
  Acceptance:
  - `sendEvent` overloads push expected tuples to `eventChannel`.
  - `log` writes to main log channel and non-blocking broadcast channel.
  - `triggerServerRender` uses bounded channel semantics (`trySend`).

- [x] `FTEST-018` (`DONE`): Add setup proxy lifecycle tests with fake caddy process.
  Target: `src/frameos/setup_proxy.nim`
  New test file: `src/frameos/tests/test_setup_proxy.nim`
  Acceptance:
  - Starting proxy with expose-only mode sets an active port.
  - Re-starting proxy stops previously spawned process.
  - Disabled proxy configuration does not keep an active port.

- [x] `FTEST-019` (`DONE`): Expand scene persistence tests.
  Target: `src/frameos/scenes.nim`
  New test file: `src/frameos/tests/test_scenes_persistence.nim`
  Acceptance:
  - `setPersistedStateFromPayload` writes and merges persisted JSON.
  - `loadPersistedState/loadLastScene` handle invalid/missing files safely.
  - `getFirstSceneId` fallback behavior is asserted for persisted uploaded IDs.

## P1 Runtime/Server

- [x] `FTEST-020` (`DONE`): Add lightweight route helper coverage for frame API match logic.
  Target: `src/frameos/server/routes/common.nim`
  Acceptance:
  - `requestedFrameMatches` true/false behavior for valid and invalid IDs.
  - `frameWebHtml` scaling substitution behavior for known scaling modes.

- [x] `FTEST-021` (`DONE`): Add time utility conversion tests.
  Target: `src/frameos/utils/time.nim`
  New test file: `src/frameos/utils/tests/test_time.nim`
  Acceptance:
  - `durationToMilliseconds` and `durationToSeconds` convert common durations exactly.
  - Zero and sub-second durations are asserted.

- [ ] `FTEST-022` (`BLOCKED`): Metrics logger deterministic tests.
  Target: `src/frameos/metrics.nim`
  Blocker:
  - Current implementation hardcodes `/proc` + `sleep` loop without injection hooks.
  Proposed split:
  - Add minimal test seam for metric providers/clock.
  - Then add assertions for disabled/enabled/error branches.

## P1 Apps

- [x] `FTEST-023` (`DONE`): Add tests for pure logic apps with parsing/format transforms.
  Target: `src/apps/data/parseJson/app.nim`, `src/apps/data/prettyJson/app.nim`, `src/apps/data/xmlToJson/app.nim`
  Acceptance:
  - Valid/invalid payload handling is asserted.
  - Output format invariants are checked (stable key handling, error fields).

- [x] `FTEST-024` (`DONE`): Add tests for logic control apps.
  Target: `src/apps/logic/ifElse/app.nim`, `src/apps/logic/nextSleepDuration/app.nim`, `src/apps/logic/setAsState/app.nim`
  Acceptance:
  - Branch behavior, state updates, and next-sleep calculations are covered with deterministic inputs.

## NEXT RUN PICK

Pick in this order unless blocked:
1. `FTEST-022` split step 1: add minimal metrics seams for `/proc` + clock injection.
2. `FTEST-022` split step 2: add deterministic disabled/enabled/error-path tests.
3. Audit for any newly added pure helper modules lacking direct unit coverage.

## DONE LOG

- 2026-03-05: Completed `FTEST-001` (interpreter smoke test for data + render node execution in `test_interpreter_smoke.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-005` (route composition assertions in `test_routes.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-012` (logger polling-based checks, removed fixed sleeps). (commit: TBD)
- 2026-03-05: Completed `FTEST-006` (system index scene list/text assertions in `src/system/index/tests/test_scene.nim`). (commit: 1dc51c7b)
- 2026-03-05: Completed `FTEST-002` (interpreter error-path coverage for missing nodes, runtime error logging, and malformed field paths in `src/frameos/tests/test_interpreter_errors.nim`). (commit: 760e70e9)
- 2026-03-05: Completed `FTEST-003` (runner render/message loop one-cycle safety test in `src/frameos/tests/test_runner_loop.nim`, with bounded loop test hook). (commit: 8dbc65b1)
- 2026-03-05: Completed `FTEST-007` (bootGuard system scene failure-text rendering assertions in `src/system/bootGuard/tests/test_scene.nim`). (commit: 0894b31e)
- 2026-03-05: Completed `FTEST-008` (wifiHotspot scene render + event-flow assertions in `src/system/wifiHotspot/tests/test_scene.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-004` (startup fallback scene selection helper coverage in `src/frameos/tests/test_frameos_startup.nim`, including threshold and override behavior). (commit: 76895e74)
- 2026-03-05: Completed `FTEST-009` (apps dispatch coverage for known app routes and unknown keyword failures in `src/apps/tests/test_apps_dispatch.nim`). (commit: ae1f06e2)
- 2026-03-05: Completed `FTEST-010` (split helper math coverage for margins/gaps/ratios and dimension rounding in `src/apps/render/split/tests/test_split_math.nim`). (commit: ae1f06e2)
- 2026-03-05: Completed `FTEST-011` (calendar event grouping/sorting coverage for all-day ordering, multi-day expansion, and malformed inputs in `src/apps/render/calendar/tests/test_grouping.nim`). (commit: 663e1bb3)
- 2026-03-05: Completed `FTEST-013` (deduplicated If-Modified-Since cache semantics by keeping canonical coverage in `test_server.nim` and compatibility coverage in `test_api.nim`). (commit: 663e1bb3)
- 2026-03-05: Completed `FTEST-014` (URL helper coverage for public/authenticated URL composition and setup-port fallback in `src/frameos/utils/tests/test_url.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-015` (scene helper coverage for path sanitization and uploaded scene-reference rewriting in `src/frameos/tests/test_scenes_helpers.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-016` (app helper coverage for render dimensions, filename cleanup, and auto-save early returns in `src/frameos/tests/test_apps_helpers.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-017` (channel behavior coverage for event/log/server channel semantics in `src/frameos/tests/test_channels.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-018` (setup proxy lifecycle coverage with fake caddy process in `src/frameos/tests/test_setup_proxy.nim`; start assertions degrade safely when socket bind is not permitted). (commit: TBD)
- 2026-03-05: Completed `FTEST-019` (scene persistence coverage for merge/write, invalid-file fallback, and uploaded-scene fallback in `src/frameos/tests/test_scenes_persistence.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-020` (route helper coverage for frame ID matching and scaling mode substitution in `src/frameos/server/tests/test_common.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-021` (duration conversion coverage in `src/frameos/utils/tests/test_time.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-023` (parse/pretty/XML transform app coverage in `src/apps/data/parseJson/tests/test_app.nim`, `src/apps/data/prettyJson/tests/test_app.nim`, and `src/apps/data/xmlToJson/tests/test_app.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-024` (logic control app coverage for branching, sleep duration, and state updates in `src/apps/logic/ifElse/tests/test_app.nim`, `src/apps/logic/nextSleepDuration/tests/test_app.nim`, and `src/apps/logic/setAsState/tests/test_app.nim`). (commit: TBD)
- 2026-03-05: Initialized backlog from audit. (commit: TBD)

## Commit Message Convention

Use one of:
- `test(frameos): complete FTEST-XYZ <short summary>`
- `test(frameos): partial FTEST-XYZ <short summary>`

Always include task IDs in commit body when multiple tasks are touched.
