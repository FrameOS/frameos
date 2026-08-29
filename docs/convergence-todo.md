# FrameOS convergence — the cloud becomes the backend

*Written 2026-08-29 against `main` at `ea5efa8e`. Companion to
`docs/deep-analysis-brutal.md` (the diagnosis) — this is the treatment, in
stages. Read cold: each stage says what exists before it says what to do.
When an item ships, delete it.*

## The decision, in one paragraph

FrameOS is **one binary per platform** — Linux (Pi and x86, the eleven
release targets) and ESP32 — that you download, run, and update over signed
OTA. It runs **interpreted scenes**: a node graph, with JavaScript apps and
code nodes executed by QuickJS, and the built-in app catalog carried inside
the binary. It is managed by **one control plane, the cloud** — hosted at
`cloud.frameos.net`, or the same stack self-hosted — over the outbound-only
hub protocol (`docs/cloud-frames.md`, `docs/cloud-frames-contract.json`). The
Python backend, per-frame Nim compilation, cross-compilation on the user's
behalf, SSH deploys and FrameOS Remote are retired. Nim development of new
apps goes to the back burner: the 40 built-ins stay as binary features,
new loadable software is JavaScript.

## Where we are (measured)

Numbers from the surveys behind this document (2026-08-29, `main`).

| Plane | Size | Role today | Role at the end |
|---|---|---|---|
| `backend/` | ~86k LOC Python (`api/` 13.2k, `tasks/` 15.0k, `codegen/` 4.4k, `utils/` 9.7k, `models/` 2.3k, `ws/` 1.0k) | control plane #1, compiler, image builder, SSH operator | **deleted**, except image builders extracted to `tools/` |
| `cloud/` | 15.2k LOC of routes (126 files) + frame-hub 5.5k + `packages/mcp` 3.4k + AI lib ~4k + evals 2.9k | control plane #2, store, AI, MCP | **the** control plane, hosted and self-hosted |
| `frameos/` | ~90k Nim | runtime + a compile target | the binary; interpreter + JS + built-ins + drivers + hub client |
| `embedded/esp32/` | ~30k C | firmware | firmware; `fos_cloud.c` is transport, verbs validated by the shared contract |
| `frontend/` | ~100k TS | three modes (backend / cloud / frame-admin) | two modes (cloud / frame-admin), backend-only surfaces deleted |

**What the backend does that nothing else does** (backend survey §6):
Nim scene codegen (`codegen/`, 4,367 LOC); Nim→C→binary orchestration
(`binary_builder.py`, `utils/cross_compile.py` 1,261, `build_executor.py`
668, `build_host.py`, `modal_sandbox.py` 734); SSH device management
(`ssh_utils.py`, `remote_exec.py` 757, `frame_deploy_helpers.py`); Buildroot
image *building* (`buildroot_image.py`, 4,265 — the largest module in the
backend); ESP-IDF per-frame firmware *building* (`embedded_firmware.py`,
2,801); frame↔backend config diff/merge (`api/frame_sync.py` 1,438); the curl
bootstrap installer (`api/frame_bootstrap.py` 527); the SSH terminal
(`ws/terminal_ws.py`); Home Assistant integration (`app/ha/`); virtual frames
(`api/virtual_frame.py`); server-side rendering for thin clients
(`api/embedded_device.py` `/embedded/render`); app-source validate/enhance
(`api/apps.py`); the arq deploy job lifecycle; TLS cert generation for
frames.

**What the cloud cannot do yet** (cloud survey §1, §6): adopt or import an
existing frame (`POST /api/frames/adopt|import|new` exist only in the
backend); `GET /api/frames/:id/{ping,state,states,uploaded_scenes}`;
`/event/setSceneState`; an apps catalog (`/api/apps` is a client-side empty
stub) and the app-source helpers; templates (superseded by the store); an SD
image *builder* (it patches a prebuilt image in the browser —
`cloud-frontend/src/lib/sd-image-patch.ts`); a firmware *builder* (it flashes
published releases — `Esp32CloudFlasher.tsx`); rendering for thin clients
(ESP32-C3, Pico); Home Assistant; virtual frames. Its README says
"self-hosting is not recommended": no releases, no migration guarantees,
three hard-coded `frameos.net` origins, no docker-compose, R2 with a
local-directory fallback, ~56 env vars, single-instance hub.

**What a frame needs from a control plane** (runtime survey §6): scene
payloads, settings, service settings, assets, OTA, telemetry. The hub
protocol delivers every one of them. The last hard dependency on the
backend is `logger.nim:127` `POST /api/log`. The local admin server already
serves the canonical `/api/frames/1` adapter with no control plane at all.

**Binary-only distribution is nearly there** (runtime survey §3–4): the
release job builds tarballs for 11 targets, Buildroot images, ESP32/Pico
firmware, and `frameos-wasm`; `upgrade.nim` verifies minisign over
BLAKE2b-512 before untarring; release builds already carry all 99 driver
`.so`s. The one gap: `driverSpecs` is a build-time constant and
`precompiled_frameos.py` copies only the frame's driver subset onto the
device. Runtime selection from `frame.json` `device` is a small change.

**JavaScript apps cannot yet replace the Nim built-ins** (migration survey
§2): 40 built-ins, all Nim, zero JS; 7 JS template apps in
`repo/apps/code/`. The JS bridge (`app_runtime.nim:1208-1290`) has no
drawing primitives, no font/text layout, no dither/EXIF/resize, no process
spawning, a strict SVG subset, synchronous single-shot HTTP. Porting the
catalog is not a Stage-1 task — keeping it *inside the binary* is.

## Reading of the request

"Get the backend working as is" is read as: **make the cloud do what the
backend does today for the frames people actually run** — interpreted scenes
on released binaries — so the backend can be switched off, and give the few
users on compiled scenes a paved road out. Not: re-implement the compiler in
TypeScript.

## Stage 0 — Decide and announce (days)

No code. Everything below assumes these are settled.

- [ ] **Announce.** README, `docs/todo.md`, the store site and the release
  notes say: cloud is canonical; the backend enters maintenance (bugfixes
  only, no new features) as of the next release; compiled scenes, FrameOS
  Remote, SSH deploys and self-built firmware are deprecated with a date.
  Give the date: one release cycle after Stage 1 ships (the migration must
  exist before the deadline does).
- [ ] **Thin clients.** ESP32-C3, Pico W, "embedded Pi" render on the
  backend today (`/embedded/render`, FOSB bitmaps). The binary story has no
  place for a device that cannot run the interpreter. Decide: (a) the hub
  renders for them (the parked "free cloud rendering forever" question in
  `docs/todo.md`), or (b) they leave the product (the cloud flasher already
  keeps C3 out). This document assumes **(b)** unless overruled; (a) is a
  separate design.
- [ ] **Home Assistant.** `backend/app/ha/` and the HA add-on ship the Python
  backend. Decide whether the add-on becomes "the self-hosted cloud stack in
  a container" (Stage 4) or is retired in favour of the HA *app* nodes
  scenes already use. Assumed: the add-on is rebased on Stage 4's compose
  bundle if and only if Stage 4 lands; otherwise retired.
- [ ] **Virtual frames** (`api/virtual_frame.py`, server-rendered kiosk
  pages, "self-hosted only"). Assumed: retired with the backend; the wasm
  preview and `/api/scenes/render` cover the use case in the browser.
- [ ] **Self-hosting scope.** Decide whether the self-hosted cloud is a
  supported product (Stage 4 in full) or a "run it if you can" bundle
  (Stage 4 minus releases/migration guarantees). Everything else in this
  plan works either way; the answer changes how much of Stage 4 is owed.
- [ ] **Nim app catalog policy.** Frozen: no new Nim apps, bug fixes only,
  ports to JS welcome one app at a time once Stage 2c gives JS the
  primitives. Say it in `frameos/src/apps/README` and the store's app docs.

## Stage 1 — The migration path for compiled scenes (first, because it has a deadline)

Goal: any scene that needs compilation today can be turned into an
interpreted scene with one click, the AI does the porting, we pay for it,
and the result lands where the user can install it. Everything a compiled
scene can contain is one of three things (`backend/app/utils/
scene_execution.py:41-72`, twin `frontend/src/utils/sceneApps.ts:26-58`):
a scene-local app with `app.nim`/`config.nim` and no JS sibling, a `code`
node with `data.code` and no `data.codeJS`, or a `source` node. Built-in
apps referenced by keyword are **not** a problem — the interpreter
dispatches them to the compiled catalog (`interpreter.nim:137-160`), so a
migrated scene keeps every `data/*`, `logic/*`, `render/*` node as is.

### 1a. Know who is affected
- [ ] Backend: a one-off report and a `GET /api/frames` field —
  `scenes_requiring_compilation` per frame (count + names), computed with
  `scene_requires_compilation()`. The SPA shows a banner on those frames.
- [ ] Cloud: `publishStoreScene` and `assignScenesToFrame` currently never
  check interpretability (migration survey §4). Port
  `sceneRequiresCompilation` to `cloud/apps/auth-web/src/lib/` and refuse
  at publish/assign with `not_interpreted` — the same token the device
  answers with. Count refusals in PostHog.

### 1b. The importer on scenes.frameos.net
- [ ] `POST /api/account/scenes/import` (sibling of `upload`): accepts scene
  JSON (paste), a template zip (`validateSceneZip` already handles the
  shape), or a URL carrying `<meta name="frameos:zip">` (the backend's
  `templates.py:52` convention, absent on the cloud). Response: the list
  of offenders per scene, and a job id.
- [ ] `app/my-scenes/import/page.tsx` next to `my-scenes/new`: paste/drop,
  "what will change" summary, one button. Login-safe like `?prompt=`.
- [ ] The porting job — a variant of `evals/build-todo-scenes.ts` running
  server-side (`turn-runner.ts` detached turns, 15-min ceiling):
  1. For each Nim app: `app-chat.ts`-style loop with `write_app_files`,
     input `config.json` + `app.nim` (+ the generated Nim from
     `/scene_source` when the user came from a backend, as context only),
     output `config.json` + `app.ts`. New prompt in `prompts.ts` — the
     existing ones are deliberately Nim-free.
  2. `data.code` → `data.codeJS` per code node; `source` nodes refused with
     a clear message (nothing can run them).
  3. Rewrite the scene: drop `.nim` sources, keep keywords, set
     `settings.execution = "interpreted"`, stamp `settings.importedFrom =
     "nim"` and a fresh `origin`.
  4. `lintScenes` + `lintJsAppSource` + `lintAppImports`, then
     `HeadlessRenderer.render()` (`eval/render-check.ts`), feed logs/errors
     back to the loop like the harness's `[Automatic render check]`,
     `judgeRender` against a baseline.
  5. Baseline: the wasm build cannot render a Nim-source scene, so the
     baseline is the frame's current image (`/api/frames/{id}/image` on
     either plane) or a screenshot the user drops in. Without one, the
     judge scores blankness/errors only.
  6. Land as a private account scene (`createAccountScene`), open it in the
     editor with the diff summary.
- [ ] Fix the AI's view of the JS API first: `src/generated/ai-context.json`
  `jsTypeDeclarations` omits `httpRequest`, every asset/stream call and
  `getSetting` (migration survey §2). Regenerate via
  `scripts/generate-ai-context.mjs`; add the SVG-subset rules to the docs
  the model reads.
- [ ] Cost: the job uses the platform OpenAI key, not the account's; per
  account a cap (N imports/day) and a PostHog span per port. Say "on us" in
  the UI.

### 1c. One click from where the user already is
- [ ] Backend/frame-admin SPA: the compiled-content warning box in
  `SceneSettings.tsx:145-160` gets the button ("Convert to JavaScript on
  scenes.frameos.net"); `WorkspaceSceneDropDown.tsx` gets the menu item;
  `EditApp.tsx:106` `ReadOnlyNimAppNotice` gets the per-app variant. The
  click POSTs the scene JSON to a one-time upload on the cloud and opens
  `/my-scenes/import?job=…` (no account yet → the page keeps the job across
  login, like `?prompt=` does).
- [ ] Round trip: from the import result, "Download zip" (exists) and, for a
  backend-managed frame, "Install on my frame" by pasting the store URL into
  the existing Templates/URL install path — until Stage 3 removes the
  backend from the loop.
- [ ] Bulk: "Migrate all" on a backend frame with several offenders runs
  the job per scene and reports.

### 1d. Exit criteria
- Every scene in `repo/scenes` and the e2e corpus that carries Nim
  sources round-trips through the importer and renders in headless wasm
  without errors.
- The deprecation date is published with the importer already live.

## Stage 2 — The binary is the product

Goal: a user with a Pi, an x86 box or an ESP32 gets a release, runs it,
enrolls it, and updates it — with no compiler anywhere.

### 2a. One archive per platform, every driver inside
- [ ] `driverSpecs` from `frame.json` at runtime: populate
  `frameos/src/drivers/drivers.nim`'s spec table from `DriverFrameConfig.
  device` instead of the generated build-time list
  (`availableDriverNames()`/`setupDriverNames()` are the hook;
  `display_detect.nim` / `frameos set-display` already select at runtime).
- [ ] Ship all 99 `.so`s in every release tarball (`install_all_drivers`
  becomes the only mode); delete the driver-subset copying in
  `precompiled_frameos.py:101`.
- [ ] `frameos setup` / `scripts/frameos-setup.sh` install a *release*, never
  build: download the tarball for the detected target
  (`upgrade.nim`'s `detectUpgradeTarget`), verify the minisign signature,
  stage, write the systemd unit, enroll with a claim token. This is the
  replacement for `api/frame_bootstrap.py` and for the whole full-deploy
  path; the cloud already serves the one-liner (`app/install.sh/route.ts`).
- [ ] Stop shipping `frameos_remote` in releases; drop its line from
  `versions.json`.

### 2b. Cut the last backend threads in the runtime
- [ ] `logger.nim` `POST /api/log`: the hub's `log_batch` replaces it;
  `serverHost/serverPort/serverApiKey` become unused and leave `frame.json`
  (with a migration that ignores them).
- [ ] Delete the compiled-scene registry: `frameos/src/scenes/` (the codegen
  slot), `js_app_runtime.nim`, `compiledScenes` + `registerCompiledScene`
  (`interpreter.nim:355`, `scenes.nim:54`), and repoint
  `src/system/index/scene.nim:18,81` at `getDynamicSceneOptions()`. The
  interpreter refuses `source` nodes already (`interpreter.nim:707`).
- [ ] The frame's local admin keeps working with no control plane
  (`frame_api_routes.nim`); it is also where "Connect to cloud" lives
  (`cloud_api_routes.nim`), which Stage 3a builds adoption on.

### 2c. Give JavaScript the primitives the built-ins have
Not a blocker for Stage 1 or 3, but the precondition for ever porting a
render app, and for imported scenes that manipulated pixels in Nim.
- [ ] Expose to the JS bridge, behind the same `frameos.*` object: image
  compositing (`drawImage`, resize, crop, rotate), text measurement and
  layout (`utils/text.nim` — wrapping, overflow, borders), dithering,
  EXIF orientation. Each becomes a documented call in
  `docs/js-apps-and-code-nodes.md` and a `since` line in the contract-style
  feature table (Stage 2d).
- [ ] Port one render app end to end as the proof (`render/text` is the
  reference: it uses all of the above).

### 2d. Version skew is a contract too
- [ ] The wasm preview and a frame can run different interpreters (runtime
  survey §7: browser = main, frame = last OTA). Add a feature table with
  `since` versions for interpreter/app-node semantics — the mechanism
  `docs/cloud-frames-contract.json` already uses for settings — and have
  the editor warn when a scene uses a feature the target frame's reported
  `frameos_version` predates.

### 2e. Exit criteria
- A fresh Pi and a fresh ESP32 go from "nothing" to "rendering a store
  scene, cloud-managed" using only release assets and the installer.
- `versions.json` has no `remote`; a release tarball contains every driver.

## Stage 3 — The cloud absorbs what the backend still does for frames

Goal: nothing a backend-managed *interpreted* frame does today is lost when
the backend goes. Cloud survey §1/§6 is the checklist.

### 3a. Bring existing frames across (adoption)
- [ ] **Adopt from the frame's own admin UI**: the frame already implements
  the device flow (`cloud_api_routes.nim` `/api/cloud/connect|poll|enroll`).
  Make the "Connect to FrameOS Cloud" path the adoption path: on first
  `hello` after enrolling, a frame with resident scenes offers them; add a
  `get_scenes` verb (device → provider payload of its `scenes.json`, same
  shape `set_scenes` pushes) so the cloud can import them as private
  account scenes and assign them — the backend's `adopt_standalone_frame`
  without SSH.
- [ ] **Bulk from a backend**: a backend-side "Move to cloud" that, per
  frame, exports scenes to the account (Stage 1b's importer, minus the
  porting when nothing needs it) and hands the frame a claim token. The
  backend↔cloud promotion ceremony in `docs/todo.md`'s parking lot is
  exactly this; it stops being parked.
- [ ] Settings parity for Linux frames: the cloud renders only
  `defaults, error-behavior, qr, power, ssh` sections
  (`workspaceSurfaces.ts`). Device/network/mountpoints/palette/gpio/logs/
  reboot are already contract keys or belong in the device's local admin;
  decide per section: contract key (cloud) or local-only (frame admin), and
  wire the missing contract keys.

### 3b. Canonical routes the SPA still expects
- [ ] `GET /api/frames/:id/{ping,state,states,uploaded_scenes}` on the cloud
  (from `last_state` and the assignment table; `ping` = hub connected),
  `POST /event/setSceneState`, `/assets/upload_image`.
- [ ] `GET /api/apps` served from the bundled catalog (`frontend/src/
  generated/builtinApps.ts` + `repoApps.ts`) instead of the empty stub in
  `apiFetch.ts:89`; `/api/apps/source` from the same. `validate_source` /
  `enhance_source` are replaced by the AI lint (`scene-lint.ts`) — no Nim
  to validate any more.
- [ ] Templates: delete the "My local scenes" half of the Templates panel
  (`Templates.tsx` says the store/cloud drive *is* the library on the
  cloud); URL install goes through the store importer (Stage 1b's URL path).
- [ ] Frame sync diff/merge (`api/frame_sync.py`): not carried. The cloud is
  the source of truth; the frame's local edits are `uploaded/` scenes the
  owner promotes via 3a's `get_scenes`.
- [ ] Fonts: the cloud's asset sync pushes the bundled catalogue; project
  font uploads become account assets (`/api/frames/:id/assets/sync` exists).

### 3c. Exit criteria
- A backend user with N interpreted frames moves them all to the cloud in
  an afternoon without SSH, keeps their scenes, and the SPA shows no
  disabled-with-tooltip surface they used before.

## Stage 4 — The self-hosted product is the cloud stack

Goal: `docker compose up` on a LAN box gives the same control plane as
`cloud.frameos.net`, for frames on that LAN, with no external service
required. Scope per Stage 0's decision.

- [ ] **Single-origin mode.** `FRAMEOS_{CLOUD,ACCOUNT,SCENES}_APP_URL` and
  the cookie domain collapse to one origin behind a flag; the hub shares
  the port or a path. The three-origin layout is a hosting choice, not a
  product one.
- [ ] **No external providers required.** Password auth only when Postmark/
  Google/Turnstile are unset; first-run creates the admin account; email
  verification off; the store's public repository is optional (the
  self-hosted instance can point at `scenes.frameos.net`'s
  `repository.json` for browsing, like backends do today).
- [ ] **Compose bundle**: Postgres, auth-web (standalone Next), frame-hub,
  and the local-directory object store (`FRAMEOS_OBJECT_STORE_DIR`, already
  the dev default) — no R2, no MinIO unless the user wants it.
  `pnpm db:cleanup` as a compose cron sidecar.
- [ ] **Versioned releases and migrations.** Tag the cloud with the FrameOS
  version, publish the compose file + images from the release job, promise
  forward-only SQL migrations (41 exist, hand-written), and write the
  upgrade runbook. This is the line between "bundle" and "product".
- [ ] LAN frames: the hub's transport rule already allows plaintext
  `ws://` to private-network literals and `.local`; document the
  `set cloud_url http://frameos-cloud.local:3000` path for ESP32 and the
  installer flag for Pi.
- [ ] Home Assistant add-on = this bundle (if Stage 0 decided so), with
  ingress mapped onto the single origin.

### Exit criteria
- The e2e suite (`cloud/scripts/e2e-frameos.sh`) runs against the compose
  bundle on a laptop with no network egress and a real ESP32 on the LAN.

## Stage 5 — Delete the compilation system

Goal: the repo no longer contains a way to compile a scene or build a
per-frame binary. Ordered so every step keeps `main` releasable.

### 5a. Backend
- [ ] `backend/app/codegen/` (4,367 LOC) entirely; `tasks/frame_deploy_
  workflow.py` (2,106), `_frame_deployer.py` (1,013), `deploy_frame.py`,
  `fast_deploy_frame.py`, `deploy_remote.py` (855), `restart_remote.py`,
  `binary_builder.py`, `precompiled_frameos.py`, `precompiled_remote.py`,
  `prebuilt_deps.py`; `utils/cross_compile.py` (1,261), `build_executor.py`,
  `build_host.py`, `modal_sandbox.py`, `remote_exec.py`, `ssh_*.py`,
  `tls.py`; `ws/remote_ws.py`, `remote_bridge.py`, `terminal_ws.py`;
  `api/frame_bootstrap.py`, `api/ssh.py`, `api/frame_sync.py`; the deploy/
  build routes in `api/frames.py:1520-3536`; `utils/scene_execution.py`'s
  compiled half; `utils/legacy_app_migration.py`.
- [ ] The backend↔cloud link (`api/cloud.py`, `cloud_backups.py`,
  `cloud_store.py`, `models/cloud.py`, `utils/cloud_link.py`,
  `app/cloud/sync.py`): meaningless once the cloud *is* the control plane.
- [ ] Settings that only configured builds (`buildHost`, `modalSandbox`,
  cross toolchain digests in `settings`).

### 5b. Runtime and tooling
- [ ] `frameos/remote/` (786 LOC + Makefile + service), `frameos/src/
  scenes/`, `js_app_runtime.nim`; `make cross-%`, `make drivers`
  (per-frame `generate_driver_sources.py --config frame.json`),
  `build_driver_libraries.py --only-if-shared`; `frameos-cross.yml`'s
  driver-variant builds. **Keep** `backend/bin/cross release` (renamed out
  of `backend/`), `nimc.Makefile`, the cross-toolchain image workflow, and
  the release job — those build *the* binary.

### 5c. Image builders become tools
- [ ] `buildroot_image.py` (4,265), `buildroot_platforms.py`,
  `sd_image_blob_patch.py`, `setup_json_reset.py`, `postboot_log.py`,
  `embedded_firmware.py` (2,801) reduce to "config JSON in, image out"
  and already have siblings in `tools/buildroot-images/`, `tools/
  prebuilt-deps/`, `embedded/esp32/ci_build_image.sh`. Move the pure
  functions to `tools/`, keep them as CI/release steps. Per-frame
  personalization (`generated_config.h`, Wi-Fi baked into an image) is
  replaced by what the cloud already does: NVS provisioning over serial
  (`Esp32CloudFlasher.tsx`) and the 4 KB boot-partition patch
  (`sd-image-patch.ts`).

### 5d. Frontend
- [ ] Delete the backend-only surfaces (frontend survey §6): `NewFrame.tsx`
  (1,617) + `newFrameForm.tsx`, `Terminal/` (639), `Ping/` (690),
  `SceneSource/` (209), `Templates/` local half, `EmbeddedWebFlasher.tsx`
  (943, the per-frame-build flasher — the release flasher stays), the
  backend halves of `FrameDeployPlanDrawer.tsx` (3,668), `Settings.tsx`
  sections `account/defaults/ssh/build-environment/fonts/posthog/system`,
  `CloudSettings.tsx` + `cloudLogic.tsx` (the backend's link *to* the
  cloud), `sshKeys/` private-key generation, `projectApi.ts` scoping, the
  backend login/signup halves. `workspaceMode()` drops `'backend'`.
- [ ] The execution toggle (`sceneExecution.ts`, `SceneSettings.tsx`
  advanced section) and every `codeJS`-vs-`code` fallback: interpreted is
  the only mode; `data.code` without `codeJS` is a lint error the importer
  fixes.

### 5e. Exit criteria
- `grep -r "nim compile\|write_scene_nim\|frameos_remote\|/ws/remote"`
  returns nothing outside `docs/`.
- CI has no job that compiles Nim on a user's behalf; it has the release
  job, the cross-toolchain image job, and the ESP32/Pico/Buildroot jobs.

## Stage 6 — Retire `backend/`

- [ ] What is left after 3–5: Home Assistant sync, virtual frames, thin-
  client rendering — each already decided in Stage 0. Move survivors, then
  `git rm -r backend/ docker-compose.yml` and the `docker-publish-multi.yml`
  backend image jobs; `versions.json` loses `docker`.
- [ ] `docs/api-triality.md` becomes `docs/api-duality.md`: cloud and frame
  local admin, one canonical contract, the ESP32 as a profile of it.
- [ ] `frontend/` loses its third mode; `cloud-frontend/` stops being a
  wrapper and becomes the frontend's home.

## Cross-cutting, throughout

- **Hardware-in-the-loop bench** (`deep-analysis-brutal.md` §5): one Pi,
  one E1004, one 7-colour Waveshare, running on every release tag — a
  release, a signed OTA, a `set_scenes` push, an `image_get`. Stages 2–5
  each ship things that today are "hardware unverified"; the bench is what
  lets the deletions be safe.
- **The contract stays the seam.** New verbs (`get_scenes`), new settings
  keys and new JS primitives go into `docs/cloud-frames-contract.json` (or
  its Stage-2d sibling) first, tables generated, fixtures added, then code.
- **Delete as you go.** `docs/todo.md`'s "Both control planes" rule is
  repealed by Stage 0; every item in this file is removed when it ships.

## What this plan does not do

- It does not port the 40 Nim built-ins to JavaScript. They stay in the
  binary; Stage 2c makes porting *possible*, one app at a time, when
  someone wants a version they can edit.
- It does not decide the hub-renders-for-thin-clients question; it assumes
  the answer is no and flags where a yes would land (Stage 0, 5c).
- It does not touch the ESP32's C↔Nim split beyond what the contract
  already did: the firmware is a binary too, and the review's item 4 was
  measured and settled (PR #412 scrapped, #413 merged).
