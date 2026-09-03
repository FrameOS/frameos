# FrameOS convergence — the work that reduces the count of parallel systems

*Written 2026-08-30, from the re-run of `docs/convergence-brutal-analysis.md`
(the diagnosis; read it first). This file carries only open work — history
lives in git. Read cold: each item says what exists before what to do.
When an item ships, delete it. Content, cloud services, manual test
sweeps and repo-wide odds and ends live in `docs/todo.md`,
`docs/scenes-todo.md` and `docs/manual-testing-todo.md`; this file is only
the work that makes the architecture smaller or decided.*

## Standing decisions (context, not work)

- Backend (Python, self-hosted, SSH/terminal/Remote) and cloud (TS,
  hosted) are **two products**. Implementation convergence, SSH-in-cloud,
  retiring `backend/`: all parked, revisited after item 1 lands.
- Compiled scenes are **deprecated** (2026-08-30): no editor action
  produces Nim, every surface warns, the converter is live
  (scenes.frameos.net/nim-converter, editor button, MCP `scene_convert`,
  CLI), deploys install release binaries, and the legacy source-build
  path keeps **working** until deleted — a shipped path is never
  disabled-but-present. `docs/legacy-source-builds.md` is its one page.
- A scene `.so` mechanism is a settled **no** (built and deleted 2026-08:
  Nim refs across a `.so` under ORC crash the host).
- An ESP32 verb layer in Nim is a settled **no** (+57 KB flash, measured);
  the shared generated contract + fixtures is the dedup mechanism.
- "Both control planes" and "the cloud has no shell verbs, on purpose"
  (`docs/todo.md`) both stand.

## 1. Delete the compiler (the dated debt)

**Gate (restated 2026-09-03): not before October 2026, and possibly
much later or never.** The source-build path is the deprecated,
not-recommended way to run scenes, and it keeps working as long as it is
there; nothing else on this list waits for its deletion, and its security
findings (`docs/security-todo.md`, "deprecated path") are accepted rather
than scheduled. Concretely: one full release cycle in which `build_kind`
shows no source builds outside frames that chose `static`. The gate is
blind (each backend's `last_successful_deploy` is private), so the
observable signals are the
calendar, the cloud's `scene_convert` telemetry, and issues — put the
deprecation + converter link in **every** release note until this ships,
so the deletion is not the first anyone hears of it.

Ordered so `main` stays releasable at every step. Touches nothing about
SSH, deploys, Remote, image builders, HA, virtual frames or thin clients.

- [ ] Data first: scenes with `settings.convertedFrom` lose their Nim
  siblings (`data.code`, `app.nim`, `config.nim`) in a backend migration;
  scenes still `compiled` are stamped `interpreted` with
  `data.needsConversion` notes on their Nim nodes — they render what the
  interpreter can and log the rest.
- [ ] Backend: `codegen/` (4,367 LOC — keep `release_drivers_nim.py` and
  the driver half of `drivers_nim.py`, the release job uses them),
  `binary_builder.py`'s source branch, `utils/cross_compile.py` (1,261),
  `build_executor.py`, `build_host.py`, `modal_sandbox.py`,
  `prebuilt_deps.py`, the compiled half of `utils/scene_execution.py`,
  `frames.py` `/scene_source`, `apps.py` `validate_nim`, settings
  `buildHost` / `modalSandbox` / `buildEnvironment` / toolchain digests,
  `_frame_deployer.py`'s codegen-writes; the deployer copies a release
  and its drivers, nothing else.
- [ ] Runtime: `frameos/src/scenes/` (the codegen slot), `scenes.nim`'s
  `compiledScenes` + `registerCompiledScene`, `js_app_runtime.nim`,
  `src/system/index/scene.nim` repointed at dynamic scene options; the
  per-frame `make cross-%`, `generate_driver_sources.py --config`,
  `build_driver_libraries.py --only-if-shared`. **Keep** `bin/cross
  release`, `nimc.Makefile`, the toolchain image, the release job.
- [ ] Frontend: `SceneSource/` (209), the execution Select +
  `sceneExecution.ts`, `CompiledSceneTag`, the Nim textarea in `CodeNode`,
  `EditApp`'s Nim branches, `frameDeployUtils`' precompiled-skip logic,
  Settings' legacy-builds section. `sceneRequiresCompilation` survives as
  a lint ("this scene carries Nim that nothing runs") on all planes.
- [ ] CI + docs: `frameos-cross.yml` goes entirely; the `deploy-e2e`
  compile phases go with the path they test;
  `docs/legacy-source-builds.md` is deleted with them.
- [ ] The cloud: `/api/scenes/convert` stops being public/unauthenticated
  once the window closes — CLI and signed-in only.
- [ ] Exit: `grep -rn "write_scene_nim\|compilationMode\|nim check"
  backend frontend frameos` returns nothing outside `docs/`; CI has no
  job that compiles Nim on a user's behalf.

Worth doing while waiting, none of it blocking: converter baseline image +
judge loop, detached conversion jobs, zip input on the page, `via: "cli"`
and server-side "Convert all" on the backend route, a `scenes:convert`
link scope, nginx `proxy_read_timeout` checked against the route's 300 s.

## 2. The hardware-in-the-loop bench

Gated on nothing; gates everything else in practice. Today: 420 unit-test
files on the server planes, six C unit tests and QEMU on the ESP32, zero
frontend tests, no CI that ever lights a panel, and a standing list of
open boxes in `docs/manual-testing-todo.md` that shrinks only when a
person sits at a bench.

- [ ] One shelf: a Pi (HDMI + one SPI e-ink), a Seeed E1004, one 7-colour
  Waveshare, on a self-hosted runner with power control.
- [ ] On every release tag (not every PR): flash/deploy the release,
  render a known scene, photograph or read back the framebuffer, diff.
- [ ] Fold the standing items from `docs/manual-testing-todo.md` §2/§4
  into its suite one by one; that file shrinks to zero and stays there.
- [ ] Exit: "shipped" and "renders on hardware" mean the same thing for
  at least one board per architecture.

## 3. Thin vs fat rendering — ruled, not yet enforced

Both architectures exist and work: `localRenderSupported` already forks
esp32-s3 (17.5k lines of local-render C) from esp32-c3/Pico (539-line
backend FOSB path + 2k Pico C). The two decisions that make the fork
policy instead of accretion are taken: the "no image proxies, ever"
principle is bounded in `CLOUD-TODO.md` (a hub rendering a whole *scene*
for a board below the capability line is the thin-client design, not a
proxy), and the money question is answered in
`cloud/docs/accounting-todo.md` §0.2 — cloud rendering is a paid-plan
entitlement, N frames *and* a minimum refresh interval (proposal 5 min),
none on the free tier. What is left is code:

- [ ] Enforce the entitlement: a count check at frame creation plus the
  refresh-interval floor (the plan row already carries the number,
  enforced nowhere). Until it exists, C3 boards stay out of the cloud
  flasher — decide, don't drift.
- [ ] Then: the capability line is data, not per-board fights. New boards
  declare PSRAM and get a renderer assigned; the fat path stops being
  re-earned 8 MB board by 8 MB board.
- [ ] Exit: a new panel bring-up touches a board table and a driver, not
  the rendering architecture.

## 4. The wasm renderer is a release artifact, not a side-load

`scene-render.ts` expects `public/frameos-wasm/frameos.wasm` installed on
the server; the repo ships none, the browser preview runs `main` while
frames run the last release, and one skew already shipped a visible lie
(radialGradient → "No image provided").

- [x] Built and installed (PR #444): the release job attaches a signed
  `frameos-<version>-wasm.tar.gz`; the cloud pins it from `versions.json`,
  verifies the minisign signature on every build and installs it
  (`FRAMEOS_WASM_SOURCE=local` for runtime development); the npm package
  ships the same bytes. The preview shows "runtime <version>", the render
  route returns `runtime_version`. Release 2026.9.2 proved the job.
- [ ] The skew is now one direction only — preview = last release, frame =
  whatever it runs — so the table this bullet wanted collapses to the
  release notes: every release note lists interpreter changes since the
  last, and that is the only skew document.

## 5. Grow the loadable catalog toward the built-in one

40 apps exist only as Nim in the firmware; 7 as loadable JS. The
converter's misses are the roadmap, not a porting program:

- [ ] Instrument: every converter "no JS equivalent" and every
  `needsManualPort` reason lands in telemetry, aggregated by missing
  primitive (drawing, text metrics, dither, shell, EXIF, …).
- [ ] Each primitive that clears a real cluster gets a bridge call or a
  JS port of the built-ins it unblocks — demand-ordered, one at a time,
  never a bulk port.
- [ ] Exit is directional, not total: the next ten scenes people actually
  convert or build need zero Nim changes.

## 6. Keep the contract discipline ahead of the drift

The cloud-frames contract works (20 verbs on both device planes, one
generated table, shared fixtures, three thin validators). The same rule
is *not* pinned elsewhere it already matters:

- [ ] The scene-execution rule (`scene_requires_compilation` /
  `sceneRequiresCompilation` / cloud `compiledSceneNames`, plus
  `frame_compilation_mode` and its TS mirror): one fixture file of
  scenes/frames with expected outcomes, run by pytest, the frontend tests
  and the cloud tests — the `cloud-frames-fixtures.json` pattern applied
  to this rule, so drift is a test failure, not a bug report.
- [ ] The 8-both / 8-linux / 7-esp32 settings-key split is the measured
  parity gap between the device planes. Each key that goes
  both-planes deletes a row; no new key ships single-plane without a
  contract entry saying so.
- [ ] `fos_cloud.c` (3,259) beside `hub_client.nim` (2,049) is the
  accepted cost of the C decision — hold the line: new verbs land as
  contract entry + fixtures + both walkers in one PR, and any helper
  that can live in a generated table (not hand C and hand Nim) does.

## Parked — decided later, deliberately

Roughly in the order they would come back, all after item 1:

- **Implementation convergence** (cloud absorbs adoption, canonical
  `/api/frames/:id/*` routes everywhere, settings parity); the contract
  stays the seam. The four control planes (155 backend routes, 74 Pi
  paths, 27 ESP32 paths, 120 cloud routes; `docs/api-triality.md`) shrink
  through it, not through a rewrite.
- **SSH / terminal / Remote in the cloud** — stays backend-only.
- **Retiring `backend/`** / hosted backends / the HA add-on's future.
- **Porting the Nim built-ins wholesale** — item 5 is the demand-driven
  version; wholesale stays parked.
- **The cloud's scope** (is this a canvas or a company) — restated by the
  analysis, unanswered; no new cloud surface until it is.
