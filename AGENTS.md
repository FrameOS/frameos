# FrameOS Repository Guide

## Project overview
- FrameOS is an "operating system for single-function smart frames" designed to run on Raspberry Pi–class hardware with a mix of e-ink and standard displays. The ecosystem includes a backend control plane, a frontend web UI, and firmware/runtime components for the frames themselves. 【F:README.md†L1-L40】
- Typical usage: run the backend service to manage frames, configure hardware-specific scenes, and deploy code or prebuilt scenes to devices over SSH.

## Cloud/backend parity (working rule)
- There are TWO control planes for frames: the self-hosted backend (`backend/` + `frontend/`) and FrameOS Cloud (`cloud/` + `cloud-frontend/`). **Any frame-facing feature or fix must land on both, or explicitly note why it's one-sided** — unless the task says otherwise. When you touch frame panels, frame APIs, device verbs, or provisioning/flashing, check the other control plane before calling the work done. Neither plane builds ESP32 firmware: both flash the signed generic release image, provision over the USB console, and offer the release OTA (`docs/todo.md`, `embedded/esp32/README.md`).
- The frame workspace UI is SHARED code (`frontend/src`), wrapped for cloud by `cloud-frontend/`. A fix that "doesn't show on cloud" is usually NOT a fork — check the `workspaceSurfaces` gating (`frontend/src/scenes/workspace/`) and remember the cloud serves a PREBUILT bundle: auth-web's predev rebuilds it via turbo (`scripts/build-frames-app.mjs`), but a long-running `pnpm dev` session keeps serving the bundle from its start.

## Cloud tests before you commit (`verify` is the gate)

- **Before committing anything under `cloud/`, `cloud-frontend/` OR
  `frontend/src` — including a test file under
  `cloud/apps/auth-web/src/test/shared-spa/` — run `pnpm verify` from
  `cloud/` and read its summary.** This is the single most common way a PR
  goes red: the cloud CI job is failing "all the time" because people run
  one vitest file, or the frontend's `tsc`, and call it done. `verify` runs
  lint + **typecheck** + test + build for every cloud package, and the
  auth-web typecheck covers the shared-spa test files themselves (a fixture
  that vitest happily executed failed `tsc` in CI on 2026-09-12, PR #485)
  and the whole shared SPA the cloud bundle is built from. Running the
  frontend's own `tsc` does NOT cover it: the cloud has its own tsconfig
  and build. Takes a few minutes; do it once at the end, not never.
- The cloud CI job named **`verify`** (`.github/workflows/cloud-ci.yml`) runs
  `turbo run lint typecheck test build --filter='@frameos-cloud/*' --filter=@frameos/cloud-frontend` and then
  THREE integration suites against a real Postgres: `@frameos-cloud/auth-web`,
  `@frameos-cloud/frame-hub` and `@frameos-cloud/ledger` (the accounting
  kernel — the module whose own todo records a shipped billing bypass, so do
  not skip it). Run the same four locally from `cloud/` before pushing — a
  green `pnpm test` alone proves little, because the integration suites are
  where the interesting failures live (`pnpm verify` is the first line):

  ```
  pnpm verify
  pnpm --filter @frameos-cloud/auth-web test:integration
  pnpm --filter @frameos-cloud/frame-hub test:integration
  pnpm --filter @frameos-cloud/ledger test:integration
  ```

- **Never run two copies of one integration suite at once.** All of a suite's
  files share ONE database and truncate between files (`fileParallelism: false`
  exists for exactly this), so a background loop plus a foreground run will
  produce unrelated "failures" in both. The two suites use different databases
  and may run side by side. If tests you did not touch fail, check what else
  was running before you believe the result.
- **A `verify` failure is often not a type error.** Read the log before
  concluding: the frame/device suites drive fake devices over the real command
  queue with `setTimeout` poll loops, so they are timing-sensitive, and a
  loaded CI runner surfaces races that a developer laptop never does — the
  chunked-upload assertion in `frame-assets.integration.test.ts` failed on CI
  and passed 15/15 locally.
- **When one of those races bites, fix what the assertion measures — do not
  add a retry, a sleep, or a widened tolerance.** The pattern that has already
  caught us: asserting on *all* pending commands for a frame when the claim was
  about one verb. Every asset write also queues an `assets_list` refresh, so a
  frame legitimately has unrelated commands in flight; count per type
  (`fakeDevice().maxPendingOfType(...)`) and record which commands were in
  flight together, so the next failure explains itself instead of printing
  `expected 2 to be 1`.

## Scene events: the contract is `docs/events-contract.json`

- Event names, payloads, who may emit what (`origins`, an allow-list), the log
  / coalesce / render-after policy and which host has an event all live in
  **`docs/events-contract.json`**; `docs/events.md` is the prose and
  `docs/event-fixtures.json` the conformance corpus. **Never add an event name
  to a list of your own** — not in Nim, C, TypeScript or Python. Edit the
  contract, run `python3 frameos/tools/generate_events_contract.py`, add a
  fixture. `frontend/schema/events.json` is one of the generated files.
- The generator's `--check` runs in the backend test suite
  (`test_esp32_events_contract.py`), so a stale table is a red PR. The fixture
  runners are listed at the top of `docs/events.md`; the Nim one is
  `frameos/src/frameos/tests/test_event_fixtures.nim`.
- Both control planes read the same tables (the backend's
  `events_contract_gen.py`, the cloud's `events-contract.gen.ts`): an event the
  cloud should be able to send needs a `cloud.verb` in the contract, not a new
  `case` alone.
- **One dispatcher, `frameos/src/frameos/event_loop.nim`, for Linux, the ESP32
  and the wasm preview.** It owns the queue, the origin allow-list, the
  command/event split and the render rule (`renderAfter`); a host supplies an
  `EventHost` and no opinions. `sendEvent(event, payload, origin)` has no
  default origin on purpose: the producer's entry point says who is talking
  (`eoHttpWrite`, `eoSchedule`, `eoCloud`, `eoScene`, …), never the payload. Do
  not add a `case event` to a host — add a contract column, or a callback to
  `EventHost`. The ESP32 runtime and the wasm preview share their host
  (`frameos/single_scene_host.nim`: scene lifetime, lifecycle events, the
  EventHost): a fix there is a fix for both, and a copy in either file is how
  the two drift. wasm does not trap on a nil dereference (address 1 is
  readable) — a green preview check says nothing about one. On the ESP32 the C edge is `embedded/esp32/main/fos_events.c`
  (one function for HTTP, schedule, cloud, console and buttons). New behaviour
  gets a case in the `dispatcher` section of `docs/event-fixtures.json`
  (`test_event_loop.nim` runs it). **Input** (pointers, keys, buttons) goes
  through `frameos/src/frameos/input_state.nim` — the cursor, the modifiers,
  the keyboard layout, the gestures, the button holds — and reaches a scene only
  under the names it listens for, old names (`mouseMove`) included as contract
  aliases; the driver side is a struct (`driver_abi.nim`), never JSON per motion
  report. `docs/events.md` "Input" is the spec; `test_input_state.nim` and the
  evdev translator's `test_translate.nim` are where a rule gets its test.

## Deploy progress: the contract is `docs/deploy-progress-contract.json`

- Every deploy, update, restart and reboot of a frame, on every frame type and
  on both control planes, keeps ONE record on the frame row
  (`deploy_progress`): its kind, its stage, `at`. The workspace draws the bar
  from it (`frameDeployProgress` in `frontend/src/decorators/frame.tsx`) in
  place of "last seen", and the deploy tile spins on it. `docs/deploy-progress.md`
  is the per-frame-type spec (which kind, which stage, which signal moves it);
  `docs/deploy-progress-fixtures.json` is the corpus the backend
  (`app/utils/deploy_progress.py`) and the cloud (`lib/deploy-progress.ts`)
  both replay.
- **Never decide "how far is this deploy" from `frame.status` or a log
  regex.** A new step is `advance(record, stage)` from the plane that does it;
  a new device signal is a contract `signals` entry plus the stages whose
  `on` table lists it. Edit the contract, run
  `python3 frameos/tools/generate_deploy_progress_contract.py` (the backend
  suite runs `--check`), add a fixture.
- Records move forward only and only on what their current stage lists — that
  is what keeps the old runtime's last `render:done`, or a late ack of an
  older push, from finishing a deploy. Nothing expires a record; readers
  compare `at` with the stage's `staleAfterSeconds`.
- A route starts the record BEFORE it enqueues the job (the worker's first
  step must find it) and fails it when the enqueue throws. On the cloud,
  `enqueueFrameCommand` starts it for `set_scenes`, `notify_update_available`,
  `reboot` and `restart_runtime`; the hub moves it.

## AI scene chat: change the prompt/linter, then run the evals

- The cloud AI (`cloud/apps/auth-web/src/lib/ai/`) builds and edits scenes on
  the frames workspace AND on the scene store (`SceneAiPanel`). Every delivered
  scene passes `scene-lint.ts` (catalog-aware structural lint) before reaching
  the editor. When you touch `prompts.ts`, the linter, the app catalog,
  `docs/scene-guide.md` or `docs/js-apps-and-code-nodes.md`, run the evals against real OpenAI and
  compare with the previous report: `pnpm --filter @frameos-cloud/auth-web
  ai:eval --compare evals/results/<prev>/report.json` (needs the dev server on
  :3000, the local DB filled by `scripts/import-store-scenes.mjs`, and
  `OPENAI_API_KEY`). See `cloud/apps/auth-web/evals/README.md`.
- The chat can see: `render_scene` renders the scene it holds with the
  server's wasm runtime (`scene-render.ts`, as `POST /api/scenes/render`) at
  the client's preview size (`renderSize` in the request) and returns the PNG
  inside the tool result. Renders never carry the account's service keys and
  spend the account's `scenes:render` budget.

## The AI chat is one thing on both planes: `docs/ai-chat.md`

- Every AI chat in the workspace (the frames home's AI box, the box above a
  frame's scenes, the editors' chat drawer) is ONE agent loop with the SAME
  NDJSON events on both planes: the cloud's `src/lib/ai/loop.ts` and its port
  `backend/app/utils/ai_chat_agent.py`, read by one `chatLogic`. An event,
  rule or editor tool added on one plane is added on the other.
- On an ESP32 frame the render check and `render_scene` run the scene in that
  frame's memory (`esp32DeviceLimits`; `docs/device-limits-fixtures.json`
  pins the TS copy and the Python port), so a scene that would abort the
  device goes back to the model first. `docs/ai-chat.md` "Renders run in the
  frame's memory".
- Its tools are its plane's MCP tools, run in-process with the chat request's
  own credential (`ai_chat_tools.py`, `mcp-tools.ts`), plus the editor tools.
  A new MCP tool is automatically a chat tool; keep `EXCLUDED_MCP_TOOLS` in
  step on both planes. `patch_scene` / `edit_app_source` replay
  `docs/ai-scene-patch-fixtures.json` on both.

## Writing scenes: `docs/scene-guide.md` is what every author reads

- How a scene is written — its JSON, the node types and edges, fields and
  state, code nodes, JS apps and the `frameos` API, where an app keeps its
  values, SVG, layout, small devices, events — is `docs/scene-guide.md`. The
  scene AI and the app AI on both control planes read it in their prompts,
  and both MCP servers serve it as `scene_guide`. A rule a scene author must
  follow goes there, not into one prompt: each consumer adds only what is its
  own (its tool names, its output format).
- After editing it, run `python3 frameos/tools/generate_scene_guide.py`. It
  fills the events table from `docs/events-contract.json` and the JS API from
  `frontend/src/utils/appTypeDeclarations.ts`, refuses when the runtime's
  `frameos` object or `app.frame` keys disagree with those declarations, and
  writes the backend and cloud copies (the backend suite runs `--check`). Then
  run the AI evals above. Keep it free of Nim: the cloud prompt is tested for
  that.

## Scenes inside scenes: `docs/scene-rhythm.md`

- A scene drawn through a scene node (a split's panel) renders on its own
  `refreshInterval`; one that is not due puts back a copy of what it drew
  last time (`frameos/src/frameos/scene_rhythm.nim`, one module for the Pi,
  the ESP32 and the preview). Copies are capped at a quarter of free render
  memory (1 MiB at most on an ESP32); without one the panel runs again with
  `FrameScene.repainting` set, which is the hook for exact repaints (#555).
- A generated split's own interval is the fastest it renders, and it waits
  longer when no panel is due. A `render` from outside the scene (API, cloud,
  schedule, button, console, preview) redraws every panel: `event_loop.nim`
  on Linux and in the preview, `fos_events.c` on the ESP32. Keep the two
  rules alike.

## Retiring a built-in Nim app: `docs/retired-apps.json` is the contract

- A Nim app that gets a repo JavaScript replacement (`data/immich` →
  `repo/apps/image/immich`) is deleted in the same change and listed in
  `docs/retired-apps.json`. Stored scenes become the JS app (backend alembic
  migration + import doors; the cloud converts at read time, its zips are
  immutable), every path to a device sends what that runtime reads (older
  firmware gets the Nim keyword back), and the Linux runtime runs the
  replacement for a scene still on disk. `docs/retired-apps.md` has the
  steps; run `python3 frameos/tools/generate_retired_apps.py` after touching
  the contract or a replacement's files (`test_retired_apps.py` checks it).
- A port must behave like the Nim app on an ESP32 too: the runtime tears
  every idle JS interpreter down after each render, so state that outlives a
  render goes through `frameos.remember` / `recall`, not module variables; a
  throw in `get()` fails the node like a raising Nim app (defaulted args, no
  cache entry). Port the Nim tests to `js_runtime/tests/test_<app>_js_app.nim`
  with `jsHttpRequestHook` / `contextDownloadHook`, and give the contract the
  first runtime with every bridge call the port makes (2026.10.13 for
  `remember`, `app.frame.embedded`, `fetchImage` `exif`).

## Per-photo colour profiles: `docs/asset-color-profiles.md` is the contract

- A photo may carry a `<image>.frameos.json` sidecar (exposure, white point,
  tonal tints, per-hue HSL, an optional
  dither palette). `frameos/src/frameos/utils/asset_colors.nim` applies it on
  every runtime; `frontend/src/utils/assetColors/` previews it with a port of
  the panel dither. The two are pinned to the same parity vectors
  (`test_asset_colors.nim`, `shared-spa/asset-colors.test.ts`): change the
  arithmetic on one side and the other, and refresh both vectors. The name
  is deliberately not dot-prefixed (device write paths refuse hidden names).
- The frame itself fits every drawn image into its palette's range by default
  (frame.json `colors.autoFit`, applied by the CONSUMER — `apps/render/image`
  and the JS draw call — on the rectangle it drew, never by the producer, whose
  output is cached) and runs a frame-wide `colors.global` correction on the
  finished canvas. A new control-plane key goes through the cloud contract
  (`docs/cloud-frames-contract.json` + generator), the backend column, the SPA
  key lists AND the settings nav list in `FrameWorkspace.tsx`.

## Photos: `docs/photos.md` is the contract

- Photos (the rail button after Apps) is a library of albums on the control
  plane, played by frames through share links. One HTTP contract
  (`/api/photos/...`, `docs/photos.md`) for both planes, and one data model:
  the backend keeps the cloud's tables in SQLite (`photo_entry`,
  `photo_share`) and the bytes in an object store under `photos/<sha256>`
  (`backend/app/utils/photos.py`, `object_store.py`: a directory under
  `FRAMEOS_PHOTOS_DIR` by default, an S3/R2 bucket when the
  `FRAMEOS_PHOTOS_S3_*` keys are set); the cloud keeps rows in Postgres and
  bytes in R2 under random keys (`cloud/apps/auth-web/src/lib/photos/`). A
  change to a route, shape or status code lands on both and in the doc.
- Frames never get the owner's credentials: a scene carries a share link
  (`pk_...`) in the `repo/apps/image/photoAlbum` node's config and asks for
  one photo per render (`/shared/{token}/photo?index=`), keeping its place in
  a disk-persisted state field. The share routes are on the backend's public
  router and are rate limited.
- A photo's color profile (the asset sidecar's `colors`, docs "Colors") is a
  `<photo>.frameos.json` sidecar on the backend (the path rules refuse the
  suffix, so it is never listed and travels with its photo) and the `colors`
  column on the cloud. Frames get it in the share JSON and hand it to
  `frameos.fetchImage(url, {colors})`. The editor is the Assets panel's
  (`ColorEditorModal`, preview math in `utils/assetColors/preview.ts`).
- The album scene has three builders (the SPA's, and `POST /api/photos/scene`
  on each plane); `docs/photo-album-scene.json` is the scene they all must
  build, and all three tests compare with it. Change one, change all three.
  The photos MCP tools (same names on both servers) gate every write on
  `confirm`: a frame playing a shared album shows the change.
- Thumbnails are made on the server on both planes (backend Pillow, cloud
  sharp at upload), so every upload gets one, MCP and API ones included.
  sharp is the cloud's one native dependency: `next.config.ts` traces its
  libvips in (the tracer misses it) and `cloud/scripts/stage-sharp.sh` gives
  a laptop-built release the box's linux-x64 build, or refuses it.
- Cloud uploads are scanned before anything is stored (hash list,
  PhotoDNA), and a configured scanner that fails stores nothing. Not OpenAI
  moderation: it scores `sexual/minors` on text only. Any new table holding photo objects goes into
  `cloud/scripts/object-store-sweep.sh`, or the sweep deletes the photos
  (it runs weekly with `--apply` now). Account deletion removes the
  account's photo and snapshot objects itself (`src/lib/account-erasure.ts`),
  and the object backup keeps deleted `photos/` and `frames/` 30 days only.
- **Photo bytes are private on the cloud.** The share `/file` route
  redirects to a ten-minute presigned R2 GET, `publicUrl` refuses
  `photos/` keys and a Cloudflare rule blocks the prefix on the CDN alias
  (the `/admin` check "Photos off the public CDN" fails without it). Never
  hand a photo out by a public URL again.
- **Photo metadata: inform, don't punish** (the owner's rule, 2026-10-18).
  Uploads are stored exactly as sent; never strip or rewrite a photo the
  owner did not ask to change. The library reads its metadata instead (a
  location pin on the card, the viewer's Info panel, `GET
  /api/photos/metadata`) and removes the location or everything only when
  asked (`POST /api/photos/metadata`, one photo or a selection). The reader
  and both removers are `app/utils/photo_metadata.py` and
  `src/lib/photos/metadata.ts`, which must agree byte for byte, pinned by
  `docs/photo-metadata-fixtures.json`: change one, change both and run
  `tools/generate_photo_metadata_fixtures.py`.
- **A share link inside a scene is the owner's alone.** The cloud store
  refuses to make a scene that holds one public or shared, and the scene
  AIs on both planes show the model a placeholder and restore the link in
  what comes back (`share-links-in-scenes.ts`, `photo_share_links.py`). On
  frames, errors and logs name a request URL only as `scheme://host[:port]`
  (`frameos/src/frameos/utils/redacted_url.nim`, `fos_netguard_url_origin`).

## Local network access: cloud frames only, `docs/lan-access.md`

- On a cloud-managed frame (or one still running cloud-pushed scenes) scenes
  may not reach the LAN (Home Assistant, a NAS, `192.168.x.x`) unless the
  frame's **Local network access** is on; the provider's own endpoint is exempt
  by exact `host:port`. Standalone and self-hosted backend frames have no
  block and no switch: their access is the network's call (the owner's
  decision, 2026-10-18). Never make it a permission apps or scenes declare
  (2026-10-17).
- Turning it **on** takes the six-digit code the frame draws on its panel
  (cloud `lan_access_challenge` / `lan_access_set`, or the Pi's
  `/api/network/local-access*` with an admin session). Off is free. The device
  holds the truth (`state/local_access.json`; ESP32 NVS `allow_lan`, off when
  absent) and reports it as `hardware.lanAccess`; the cloud keeps no copy.
- **A presence code must never leave the device in an image.** Draw it after
  the stored image (Pi: after `setLastImage`; ESP32: restore the rectangle
  before `store_snapshot`). Keep it away from every sink: `GET /image` (incl.
  e-ink drivers' own `toPng`), `image_get`, scene snapshots, the ESP32 BMP push,
  the `http.upload` driver.
- A check must pin the connect to the address it checked: the Pi connects by
  address, the ESP32 through `fos_netguard_pin_t` and lwIP's resolve hook.
  Checking a name and letting the client resolve it again is a DNS-rebinding
  hole.
- The blocked-request text starts with `Local network access is off for this
  frame`. The SPA's logs panel matches that prefix, so keep it on both
  runtimes.

## Top-level layout
- `backend/` – Python FastAPI application that exposes REST/WS APIs, schedules background jobs, and manages persistence via SQLAlchemy. Includes Alembic migrations, ARQ worker tasks, and pytest suites. 【F:backend/app/fastapi.py†L1-L101】【F:backend/app/tasks/worker.py†L1-L64】【F:backend/app/models/user.py†L1-L16】
- `frontend/` – React + TypeScript single-page application built with esbuild, Tailwind, and kea state management. Compiled assets live in `frontend/dist` and are served by the backend when present. 【F:frontend/package.json†L1-L66】【F:backend/app/fastapi.py†L38-L86】
- `frameos/` – Nim-based runtime for devices, containing system drivers, Nim app definitions, and assets compiled into the on-device application. Nim apps live in `src/apps`; repo-provided JavaScript app templates live outside the runtime under `repo/apps/<folder>/<app>`, the folder naming what the app returns (`image`, `text`, `json`, `logic`). Entry point `src/frameos.nim` is a small CLI (see "Device runtime" below); `make build` writes the binary to the gitignored `frameos/build/frameos`.
- `e2e/` – The end-to-end suites: the scene-renderer snapshot harness (`e2e/run`, `e2e/snapshots`), the Playwright frontend suite (`e2e/frontend-visual`, incl. the cloud `/frames` specs) and the opt-in real-SSH deploy test (`e2e/deploy`). `e2e/README.md` describes each, how CI runs them and which snapshots CI commits itself.
- `embedded/` – The ESP32 firmware (`embedded/esp32`, ESP-IDF + the Nim runtime compiled to C) and the Pico W thin client (`embedded/pico`). Neither control plane builds firmware: both flash signed release images. The IDF-free modules have host tests (`embedded/esp32/main/tests`, see that README's Layout).
- `cloud/` – FrameOS Cloud: the hosted service (Next.js + Drizzle/Postgres) behind `cloud.frameos.net` and `scenes.frameos.net` (legacy `account.frameos.net` redirects) — accounts, device/backend linking, and the scene store. Part of the monorepo's single pnpm workspace (one root lockfile, Turborepo builds); run pnpm commands from `cloud/`, see `cloud/README.md` and `cloud/docs/cloud-frames.md`. CI runs via `.github/workflows/cloud-ci.yml`.
- Supporting files at the root include the Docker configuration (`Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`), the install/setup scripts under `scripts/`, and the version metadata (`versions.json`, `project-folders.json`, `buildroot-images.json`, `cross-toolchain-images.json`) for packaging and deployment. There is no Procfile any more.

## Backend notes
- Environment configuration uses `Config` classes driven by env vars such as `SECRET_KEY`, `DATABASE_URL`, `REDIS_URL`, `HASSIO_RUN_MODE`, and debug/test toggles. During development (`DEBUG=1`) it autogenerates a `.env` with a fallback `SECRET_KEY`. 【F:backend/app/config.py†L1-L86】
- FastAPI application wiring (in `app/fastapi.py`):
  - Registers gzip middleware, websocket routers, and routes grouped by auth level (`api_public`, `api_open`, `api_user`, `api_project` — see `backend/app/api/__init__.py` for what each means with and without Home Assistant ingress).
  - Serves compiled frontend assets (or source HTML during tests) unless running in Home Assistant public ingress mode.
  - Initializes a shared `httpx.AsyncClient`, Redis listener, and PostHog analytics integration during startup.
  - Custom exception handlers degrade gracefully to JSON for API calls and reuse the SPA shell for 404/validation errors in non-test scenarios. 【F:backend/app/fastapi.py†L1-L112】
- Persistence uses SQLAlchemy ORM models (e.g., `User` with hashed passwords) and Alembic migrations (see `migrations/`). Session factory exposed from `app/database.py`. 【F:backend/app/models/user.py†L1-L16】
- Background jobs run through `arq` with Redis: worker defined in `app/tasks/worker.py` loads tasks for deploying/resetting frames, building SD images, and controlling agents. Startup hooks share HTTP, Redis, and DB clients. Run via `arq app.tasks.worker.WorkerSettings`. 【F:backend/app/tasks/worker.py†L1-L64】
- API tokens (`app/models/api_token.py`, `fb_api_…` / read-only `fb_apiro_…`) are accepted by `get_current_user` wherever a login JWT is; the MCP server at `POST /api/mcp` (`app/api/mcp.py`, `app/mcp/`) wraps the backend's own routes in-process over ASGI — a new tool is one HTTP call to an existing route, never new behaviour (the photos tools' URL download and scene install are the two noted exceptions in `docs/mcp.md`), and one that changes a physical frame takes `confirm` (the gated list is pinned by `test_mcp.py`). A string argument that lands in a route path needs a `pattern` (the registry enforces it): httpx normalizes `..`, so a free string could name another route. `docs/mcp.md` is the contract; the cloud's `cloud/packages/mcp` is the sibling to keep tool names in step with.
- **Fetching a URL a user or a page supplied, on either plane: the check goes in the connect.** Checking a name and letting the HTTP client resolve it again is a DNS-rebinding hole (the second answer can be private). Backend: an `httpx.AsyncClient(transport=guarded_transport(...))` (`app/utils/network.py`), with the same policy as the route's up-front `assert_url_target_allowed`. Cloud: `guardedFetch` / `pinnedFetch` (`cloud/apps/auth-web/src/lib/ssrf.ts`, undici with a guarded `lookup`). The child-process fetchers (`scene-render.ts`, `backend/tools/embedded_wasm_render.mjs`) put the check in the socket's `lookup` via `node:http`.
- Tests rely on pytest + pytest-asyncio fixtures defined in `app/conftest.py`; there is broad coverage across API, websocket, and model layers under `app/api/tests` and `app/models/tests`. 【F:backend/app/conftest.py†L1-L65】【F:backend/app/api/tests/test_frames.py†L1-L183】
- Common local workflows:
  - Install dependencies: `pip install -r requirements.txt`. The lock carries a `--hash` for every file and is a *universal* resolution (it is compiled on macOS and installed on Linux); CI and the Docker image install it with `--require-hashes`. Regenerate it ONLY with `backend/bin/compile-requirements` (`--upgrade-package <name>` to bump one package) — a plain `pip-compile` drops the hashes and the Linux-only packages, and every CI install fails. After it, refresh `tools/buildroot-images/requirements-upload.txt` (recipe in its `.in`).
  - Run the web server: `uvicorn app.fastapi:app --reload` (ensuring `frontend/dist` exists or `TEST=1` to use source HTML).
  - Start worker: `arq app.tasks.worker.WorkerSettings`.
  - Execute tests: `pytest` (optionally via `backend/bin/tests` helper). 【F:backend/bin/tests†L1-L3】

## Frontend notes
- Built as an ESM React app with TypeScript; kea manages state and type generation (`kea-typegen`).
- Build pipeline orchestrated by `build.mjs` using esbuild, with Tailwind/PostCSS for styling and optional bundle analysis via `vite-bundle-visualizer`.
- Development: `pnpm install` followed by `pnpm --dir frontend run dev` (spawns kea typegen watch and esbuild dev build concurrently).
- Repo-level local development runner: `pnpm dev` starts `mprocs` (`mprocs.yaml` is the process list). Panes that autostart: `backend` (FastAPI, `DEBUG=1`), `worker` (ARQ), `vite` and `kea` (the main frontend's dev server and its typegen watcher), `redis`, `postgres` (the Flox-provided Postgres on port 55432, via `cloud/scripts/db-run.sh`) and `wasm` — which runs `frameos/tools/build_wasm.sh`, a Nim → emscripten build of the interpreted-scene runtime for the browser preview, on every `pnpm dev`. Panes that do not autostart (select them in mprocs): `frameos` (`make` in `frameos/`, the native runtime), `cloud` (the FrameOS Cloud Next.js dev server; it first runs `cloud/scripts/db-setup.sh` to apply migrations), `cloud-hub` (the frame hub, `pnpm run dev:hub` in `cloud/`), `backend-docker` (`scripts/backend-docker.sh`, which persists a generated Docker `SECRET_KEY` in the gitignored `.env.docker.local`) and `migrate` (alembic upgrade for the backend). There is no pane for the on-frame admin frontend; run `pnpm dev:frame-frontend` (its watcher in `frameos/frontend`) by hand when working on it.
- Production build: `pnpm --dir frontend run build` which chains kea codegen, schema generation (`ts-json-schema-generator`), TypeScript type-checking, and final bundling to `dist/`. 【F:frontend/package.json†L6-L66】
- The published `frameos-editor` package has its own `editor` component hash/version in `versions.json`; `project-folders.json` includes shared frontend sources so frontend-only editor changes receive a new npm version during release.
- Output folder is consumed by the backend’s static file mounts; ensure `frontend/dist` exists (e.g., via `pnpm --dir frontend run build`) before running the Python app outside of test mode. 【F:backend/app/fastapi.py†L38-L86】
- UI copy follows `docs/ui-vocabulary.md`: scenes are **pushed**, settings and FrameOS **deployed**, a show-for-now is a **preview**, a scene going on the list is **installed**. `frame-vocabulary.test.ts` (cloud shared-spa) scans `frontend/src` for the banned words; a new verb goes in the doc first.
- ALWAYS prefer writing frontend business logic in kea logic files over using effects like `useState` or `useEffect`.
- This includes small functions and callbacks inside components. Prefer to keep as much code as possible in logic files, treating React as a templating layer.
- When adding a frame model key that is tracked for deploy changes in `frontend/src/scenes/frame/frameLogic.ts`, also add a marker to `FRAME_KEY_INTRODUCED_FRAMEOS_VERSION`. For unreleased work, use the next patch after the current `versions.json` FrameOS base version.

## Device runtime (Nim) notes
- **HARD RULE — no image proxies for frames, EVER.** Frames download and render
  images directly from their sources; never route a frame's image fetches
  through the backend (or any other middleman) to resize or fetch on its
  behalf, and don't paper over device limits with host-side resize params
  either. When a source serves images too large for a device, THE fix is
  better on-device streaming decode (incremental inflate, row-by-row
  unfilter/scale into the target — a multi-MB PNG should need its compressed
  body plus a few rows, not a full-resolution RGBA buffer). Proxies are fine
  for in-browser previews only. Proxying has been implemented and reverted
  before — do not implement it again.
- **Refs do not cross threads.** The frame's web server runs up to four mummy
  worker threads next to the runner, the logger, the hub client and the
  scheduler, and ORC refcounts are not atomic: a `ref` (JsonNode, FrameConfig,
  StateField, ExportedScene, Logger…) that two threads hold is freed under one
  of them sooner or later, and a type with closures also lands in the wrong
  thread's cycle roots. This has crashed frames twice (the auth cache,
  2026-09-06; `getLastPublicState`, found 2026-09-19 — four threads segfault
  in a second). A global that crosses threads holds VALUES (strings, plain
  objects) or is only read under the lock that writes it; hand out copies;
  never write `let x = globalFrameConfig` (or `.settings`, `.network`, …) on
  a worker — use `liveConfigValue(field)` (`server/state.nim`) for one string
  or number, `requestFrameConfig()` / `readConfig()` for a private config,
  `getLastPublicSceneState()` / `publicStateFieldsCopy()` for scene state. A
  thread that lives long keeps its own copy and refreshes it when
  `currentFrameConfigGeneration()` moves (the hub client does). A `Channel` MOVES its message under ORC, so `sendEvent` copies the
  payload; `sendEventOwned(name, move(payload))` is for a fresh parse too big
  to copy. New shared state gets a four-thread test built with
  `-d:useMalloc` (`test_public_state_threads.nim` is the template).
  A proc that can run on more than one thread takes the config it reads as
  an argument (the portal's `startAp`, `attemptConnect`): the caller hands in
  the runtime's own on the runtime's thread and a `portalRequestConfig` /
  `requestFrameConfig()` anywhere else, and a thread it spawns gets values.
- `frameos/src` houses the on-device runtime written in Nim with asyncdispatch (`frameos/frameos` and `frameos/build` are untracked build outputs, not sources).
- Entry point `src/frameos.nim` is the runtime's CLI, not a bare `waitFor startFrameOS()`: `start` (the default, also for any unrecognised `--flag`) runs `startFrameOS()` in a retry loop with the boot guard; `version` / `--version` / `-v` prints the compiled version and exits — it used to fall through to `start` and boot a second runtime next to the service, which is how release 9.2 shipped a 9.1 runtime, so keep that branch first; `check` verifies the binary starts; `setup` (`--with-setup=/boot/frameos-setup.json[.gz]`, `--reboot-if-required`) runs first-boot device setup; `driver-setup` and `set-display` (`--device`, `--width`, `--height`, `--rotate`, `--vcom`, `--upload-url`) patch and apply the display; `upgrade` (`--dry-run`, `--no-reboot`) pulls the latest GitHub release; `privileged-worker` is the root side of the privileged door on Buildroot frames; `help` lists them. Drivers, system integrations, and Nim app implementations live in nested directories (`src/apps`, `src/drivers`, `src/system`, `src/frameos`); JavaScript example app sources/configs live under `repo/apps/<folder>/<app>`.
- JavaScript repo apps under `repo/apps/<image|text|json|logic>/<app>` are catalog templates for custom code apps; a scene copies one into its own `apps` map, with `origin` naming the template (until 2026.10.13 they all sat under `repo/apps/code`, and readers match an old origin by the app's name). Do not generate or commit Nim wrappers inside `repo/apps`; compiled scenes that use them copy their sources into generated `src/apps/sceneapp_*` folders during build/deploy.
- `frameos/Makefile` is the build entry: `make build` (app loaders → driver sources → shared driver libraries → assets → `nim c src/frameos.nim` into `build/frameos`), `make run`, `make test` (`nimble test`), `make test-shard SHARD=n` (what CI's "FrameOS Nim Tests" shards run, via `tools/run_test_shard.sh`), `make cross-<target>` / `make release-<target>` / `make release-all` (`backend/bin/cross`, the Docker cross-toolchain builds). `frameos.nimble` holds the dependencies and the `build_quickjs` task; `nimble build` itself can crash the compiler on macOS, so prefer `make build` / `nim c` directly.
- **Nim test cost is compile cost.** Every test file is its own binary and compiles most of the tree (a server or interpreter test is ~6 s of Nim frontend plus 300 C files; the 45 MB `src/assets/repo_scenes.nim` string-literal module is NOT the problem, it compiles in under 2 s). `config.nims` builds `-d:testing` binaries with `--opt:none`, which halves a cold C compile; CI's warm nimcache skips gcc entirely, so what you can still make slower is the frontend (imports) and the run. A test must never wait out a real runtime interval: stub the hook instead (`setMetricsHooksForTest(sleepHook = …)`, the chromium app's `chromiumSettleHook` is already a no-op under `-d:testing`, `RunnerThread.stopMessageLoop` ends `startMessageLoop` instead of letting `maxIterations` run out at 200 ms a pass). Before that, three tests were 140 s of the suite's 240 s of run time (2026-10-11).

## End-to-end tooling
- `e2e/README.md` is the map of every end-to-end suite: the scene-renderer snapshot harness (`e2e/run`, `makescenes.py`, `makesnapshots.py`, baselines in `e2e/snapshots`; `./run dataGradient` renders one scene), the Playwright frontend + cloud-workspace suite (`e2e/frontend-visual`), the opt-in real-SSH deploy test (`e2e/deploy`) and the Docker/ESP32 image jobs. It also carries the local-run recipes (port overrides, `FRONTEND_VISUAL_MAX_DIFF=1`, why a reused server drifts).
- Do not run frontend visual regression tests (`e2e/frontend-visual`, Playwright screenshots, or snapshot updates) during normal iteration. Only run them when the user explicitly asks for visual tests or asks to commit changes.
- Never commit visual regression snapshot updates produced by a backend/frontend stack running locally. Local macOS font rendering and browser rasterization differ from CI's Linux environment, so CI is the source of truth for both snapshot sets: same-repo pull requests run with `--update-snapshots` and the "Commit Visual Regression Snapshots" / "Commit Frontend Visual Snapshots" jobs push the result to the PR branch as "FrameOS Bot" (so `git pull --rebase` before pushing again). A visual job that fails on CI is therefore never a pixel diff — read the log for the frontend-error assertion or the failing `prepare` step.

## Deployment & operations
- Docker support: top-level `docker-compose.yml` builds the full stack (backend plus dependencies) exposing port 8989 and persisting SQLite DB under a named volume. SQLite is the self-hosted backend's only supported database: `DATABASE_URL` is settable because the backend uses SQLAlchemy, but no other engine is tested and no other driver ships. (The cloud's Postgres is a separate stack under `cloud/`.) Backend Postgres support was briefly documented in September 2026 and withdrawn — do not re-add it without someone who actually needs it.
- The root `Dockerfile` is multi-stage: `runtime` is the published backend image (`docker build --target runtime -t frameos .`, what `README.md` and CI's "Build Docker Image" job build), `esp32-ci` is the ESP-IDF + Nim toolchain image the ESP32 firmware job builds in, and `app-builder` / `nim-toolchain` / `python-deps` are its intermediate stages. The plain runtime container is all a normal install needs; the Docker socket + `--privileged` variant in `README.md` exists only for the deprecated per-frame source build (`docs/legacy-source-builds.md`). Watchtower example commands in `README.md` show daily update flows.
- Environment variables documented in backend config govern integration with Home Assistant (HASSIO), Redis, PostHog analytics, and secret management. 【F:README.md†L24-L71】【F:backend/app/config.py†L1-L86】

## Getting started quickly
1. Install JS deps once from the repo root (`pnpm install`) and build the frontend (`pnpm --dir frontend run build`).
2. Install backend deps (`cd backend && pip install -r requirements.txt`).
3. Launch the local development stack with `pnpm dev`, or run the API (`uvicorn app.fastapi:app --reload`) and background worker (`arq app.tasks.worker.WorkerSettings`) separately if needed.
4. Optionally bring up the stack via Docker (`docker compose up --build`).
5. Use the backend UI/API to manage frames, deploy scenes, and monitor logs.

Keep this file updated as architecture or workflows change so future agents have an accurate snapshot of the repository.
