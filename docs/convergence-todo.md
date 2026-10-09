# FrameOS convergence — the work that reduces the count of parallel systems

*Written 2026-08-30, from the re-run of `docs/convergence-brutal-analysis.md`
(the diagnosis; read it first). This file carries only open work — history
lives in git. Read cold: each item says what exists before what to do.
When an item ships, delete it. Content, cloud services, manual test
sweeps and repo-wide odds and ends live in `docs/todo.md`,
`docs/scenes-todo.md` and `docs/manual-testing-todo.md`; this file is only
the work that makes the architecture smaller or decided.*

## Standing decisions (context, not work)

- **The backend converges onto the cloud's model** (decided 2026-09-07,
  after the first real adoption of a generic Buildroot card into a
  self-hosted backend). A frame gets one "server to connect to" — a
  self-hosted backend or FrameOS Cloud — and both speak the same
  provider protocol: outbound-only management WebSocket, the limited verb
  set, the same enrollment. The backend's unique parts (SSH deploys of
  unsigned builds, the terminal, FrameOS Remote's shell) are deprecated
  as the provider path covers their real uses; the end state replaces
  `backend/` with a self-hostable build of the cloud. Backports the other
  way stay possible — SSH access as an opt-in in the cloud is the obvious
  candidate. Item 7 below is the staged work; "two products" is no longer
  the standing decision.
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

Gated on nothing; gates everything else in practice. The server planes, the
shared SPA and the firmware's portable modules all have unit suites and the
ESP32 boots under QEMU, but no CI ever lights a panel, and the open boxes in
`docs/manual-testing-todo.md` shrink only when a person sits at a bench.

- [ ] One shelf: a Pi (HDMI + one SPI e-ink), a Seeed E1004, one 7-colour
  Waveshare, on a self-hosted runner with power control.
- [ ] On every release tag (not every PR): flash/deploy the release,
  render a known scene, photograph or read back the framebuffer, diff.
- [ ] Fold the recurring checks from `docs/manual-testing-todo.md` (flash,
  first boot, OTA, display power) into its suite one by one; that file
  shrinks to zero and stays there.
- [ ] Exit: "shipped" and "renders on hardware" mean the same thing for
  at least one board per architecture.

## 3. Thin vs fat rendering — ruled and enforced, the hub renderer is missing

Both architectures exist and work: `localRenderSupported` forks esp32-s3
(local-render C) from esp32-c3/Pico (the backend FOSB path). The policy is
settled: a hub rendering a whole *scene* for a board below the capability
line is the thin-client design, not an image proxy
(`docs/cloud-principles.md`), and on the cloud it is a paid-plan entitlement
— N frames *and* a 300 s minimum refresh interval, none on the free tier —
which both enrollment flows and the settings push enforce
(`cloud/docs/accounting-todo.md` §0.2). What is left is code:

- [ ] The frame hub renders for thin clients. Until it does, C3 and Pico
  boards stay out of the cloud flasher and cannot link to the cloud at all;
  the self-hosted backend is their only control plane.
- [ ] The capability line is data, not per-board fights. New boards declare
  PSRAM and get a renderer assigned; the fat path stops being re-earned
  8 MB board by 8 MB board.
- [ ] Exit: a new panel bring-up touches a board table and a driver, not
  the rendering architecture.

## 4. Preview / firmware version skew

The wasm renderer is a signed release artifact the cloud pins from
`versions.json`, and the preview says which runtime it runs. The skew is one
direction only — preview = last release, frame = whatever it runs:

- [ ] Every release note lists interpreter changes since the last; that is
  the only skew document.

## 5. Grow the loadable catalog toward the built-in one

40 apps exist only as Nim in the firmware; 7 as loadable JS. The
converter's misses are the roadmap, not a porting program:

- [ ] Instrument: `scene_convert` telemetry carries only a
  `needs_manual_port` *count* today. Every converter "no JS equivalent" and
  every `needsManualPort` reason has to land there, aggregated by missing
  primitive (drawing, text metrics, dither, shell, EXIF, …).
- [ ] Each primitive that clears a real cluster gets a bridge call or a
  JS port of the built-ins it unblocks — demand-ordered, one at a time,
  never a bulk port.
- [ ] Exit is directional, not total: the next ten scenes people actually
  convert or build need zero Nim changes.

## 6. Keep the contract discipline ahead of the drift

The cloud-frames contract works (20 verbs on both device planes, one
generated table, shared fixtures, three thin validators). The
scene-execution rule is pinned the same way
(`docs/scene-execution-fixtures.json`; new cases go in the JSON first), and
so is the settings-key split: every single-plane key in
`docs/cloud-frames-contract.json` carries `parity: {only, why}`, and the
tests cap the count at 10 linux-only / 7 esp32-only — the cap can only go
down (it went up twice: 8 → 9 for the Linux display-driver key `device`,
2026.9.22, so cloud Pi frames could switch drivers at all; 9 → 10 for
`input_settings`, 2026.9.23, keyboard layout + grab, which is not a gap to
close — the chip has no keyboard or pointer, every `key*`/`pointer*` event
in `docs/events-contract.json` is `hosts.esp32: false`). Standing rule
rather than a task:

- [ ] ESP32 `device`: the firmware already switches panels at runtime
  (`set panel <key>`, fos_console.c), but a panel key pushed without the
  board's matching pins would drive a display that is not there. Needs the
  compiled panel list in the SPA (per board, from the release metadata) and
  `ws_handle_set_settings` refusing a panel the board's preset cannot drive;
  then drop the parity entry and the cap back to 9.

- [ ] `fos_cloud.c` beside `hub_client.nim` is the accepted cost of the C
  decision — hold the line: new verbs land as contract entry + fixtures +
  both walkers in one PR, and any helper that can live in a generated table
  (not hand C and hand Nim) does.

## 7. The backend becomes a provider (the cloud model)

What exists: the runtime's in-binary cloud client (`hub_client.nim`,
`fos_cloud.c`) is already the "remote lite" — outbound-only, enum verbs,
no shell, signed self-upgrade on a nudge, scenes/settings/schedule/assets/
logs/metrics/reboot/restart — with the contract in `docs/cloud-frames.md`
and fixtures every device walker runs. The privileged door does the
root-only work. What is missing is the provider side on the self-hosted
backend: it manages Buildroot frames over SSH and the Remote's `shell`,
which is why backend-personalized images still run as root and why an
adopted generic card (no Remote, no SSH) could not be deployed to at all.

Stage 0 is in place ("remote lite", `docs/api-triality.md` "Admin-API-only
frames"): a frame the backend only reaches over its admin API gets scenes,
settings, assets, fonts, service keys, scene activation, snapshots and the
device's own signed self-upgrade, with the shell verbs refused and hidden.
Deliberately NOT an escalation path: nothing installs a Remote or an SSH key
on such a card.

- [ ] Stage 1: the backend hosts the management WebSocket. Either port
  `cloud/apps/frame-hub` (~3.7k lines of TS: session auth, protocol,
  queue, rate limits) into the FastAPI app or run the hub as a sidecar
  the add-on ships; either way it passes the contract fixtures as the
  fourth walker. Exit: a cloud-enrolled frame pointed at a backend URL
  behaves identically.
- [ ] Stage 2: adoption is enrollment. The device mints its keypair, the
  backend mints the token, the write-back sets the provider URL — the
  same write-back adoption does today with `serverHost`. The setup portal,
  SD-image personalization and the flasher get one "server to connect to"
  field; the `controlMode` cloud/backend/none choice goes.
- [ ] Stage 3: the deploy drawer for Buildroot frames is provider verbs
  only (`set_scenes`, `set_settings`, `set_schedule`, assets,
  `notify_update_available`); backend-managed frames stay on the
  unprivileged unit; backend-personalized images stop shipping the
  Remote (`docs/buildroot-privileges.md` §4 "backend-personalized images
  stay root" ends here).
- [ ] Stage 4: deprecate the Remote and the backend-only surfaces with the
  legacy source-build path (item 1): unsigned custom builds over SSH, the
  terminal, `shell`. Before each goes, decide whether the cloud wants it
  back as an opt-in (SSH access first; the HA add-on packaging and
  virtual frames are the other candidates).
- [ ] Stage 5: `backend/` is replaced by a self-hostable build of the
  cloud; the HA add-on ships that. `docs/api-triality.md`'s three planes
  become one protocol on two hosts.
- Idea to evaluate on the way (2026-09-07): the backend's per-frame UI is
  the frame's own admin SPA; for a shell-less frame, proxying the frame's
  admin page through the backend may replace most per-frame backend
  routes rather than re-implementing them.

## Parked — decided later, deliberately

Roughly in the order they would come back, all after item 1:

- **Canonical `/api/frames/:id/*` routes everywhere / settings parity** —
  the contract stays the seam; the four control planes (155 backend
  routes, 74 Pi paths, 27 ESP32 paths, 120 cloud routes;
  `docs/api-triality.md`) shrink through item 7, not through a rewrite.
- **SSH / terminal in the cloud** — a backport candidate once item 7
  stage 4 retires them from the backend (opt-in, never a default verb).
- **Porting the Nim built-ins wholesale** — item 5 is the demand-driven
  version; wholesale stays parked.
- **The cloud's scope** (is this a canvas or a company) — restated by the
  analysis, unanswered; no new cloud surface until it is.
