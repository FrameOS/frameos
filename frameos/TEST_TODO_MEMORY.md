# FrameOS Test Generation Memory

Last updated: 2026-03-05
Source audit: `/test-audit.md`
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

- [ ] `FTEST-003` (`READY`): Add runner loop safety test.
  Target: `src/frameos/runner.nim`
  New test file: `src/frameos/tests/test_runner_loop.nim`
  Acceptance:
  - Render/message loop can start and process one controlled cycle.
  - Test exits deterministically without hangs.

- [ ] `FTEST-004` (`READY`): Add startup fallback test.
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

- [ ] `FTEST-007` (`READY`): Add bootGuard system scene rendering tests.
  Target: `src/system/bootGuard/scene.nim`
  New test file: `src/system/bootGuard/tests/test_scene.nim`
  Acceptance:
  - Failure details mapping to rendered text is verified.
  - Safe behavior when fields are missing.

- [ ] `FTEST-008` (`READY`): Add wifiHotspot system scene state transition tests.
  Target: `src/system/wifiHotspot/scene.nim`
  New test file: `src/system/wifiHotspot/tests/test_scene.nim`
  Acceptance:
  - Node/event flow changes expected state.
  - Rendering path works with minimal mocked context.

## P1 Apps

- [ ] `FTEST-009` (`READY`): Add tests for `apps/apps.nim` app dispatch.
  Target: `src/apps/apps.nim`
  New test file: `src/apps/tests/test_apps_dispatch.nim`
  Acceptance:
  - `initApp`, `setAppField`, `runApp`, `getApp` route correctly for known app types.
  - Unknown keywords fail predictably.

- [ ] `FTEST-010` (`READY`): Add tests for render split math helpers.
  Target: `src/apps/render/split/app.nim`
  New test file: `src/apps/render/split/tests/test_split_math.nim`
  Acceptance:
  - Ratios/margins/gaps parsing and computed dimensions asserted across edge cases.

- [ ] `FTEST-011` (`READY`): Add tests for calendar grouping/sorting helpers.
  Target: `src/apps/render/calendar/app.nim`
  New test file: `src/apps/render/calendar/tests/test_grouping.nim`
  Acceptance:
  - All-day vs timed ordering rules validated.
  - Multi-day and malformed input edge cases covered.

## P2 Utilities/Hardening

- [ ] `FTEST-013` (`READY`): De-duplicate server cache-header assertions.
  Target: `src/frameos/server/tests/test_server.nim`, `src/frameos/server/tests/test_api.nim`
  Acceptance:
  - Single canonical test owner for shared cache semantics.
  - Keep coverage, reduce overlap noise.

## NEXT RUN PICK

Pick in this order unless blocked:
1. `FTEST-003`
2. `FTEST-007`
3. `FTEST-004`

## DONE LOG

- 2026-03-05: Completed `FTEST-001` (interpreter smoke test for data + render node execution in `test_interpreter_smoke.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-005` (route composition assertions in `test_routes.nim`). (commit: TBD)
- 2026-03-05: Completed `FTEST-012` (logger polling-based checks, removed fixed sleeps). (commit: TBD)
- 2026-03-05: Completed `FTEST-006` (system index scene list/text assertions in `src/system/index/tests/test_scene.nim`). (commit: 1dc51c7b)
- 2026-03-05: Completed `FTEST-002` (interpreter error-path coverage for missing nodes, runtime error logging, and malformed field paths in `src/frameos/tests/test_interpreter_errors.nim`). (commit: TBD)
- 2026-03-05: Initialized backlog from audit. (commit: TBD)

## Commit Message Convention

Use one of:
- `test(frameos): complete FTEST-XYZ <short summary>`
- `test(frameos): partial FTEST-XYZ <short summary>`

Always include task IDs in commit body when multiple tasks are touched.
