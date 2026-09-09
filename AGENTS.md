# FrameOS Repository Guide

## Project overview
- FrameOS is an "operating system for single-function smart frames" designed to run on Raspberry Pi–class hardware with a mix of e-ink and standard displays. The ecosystem includes a backend control plane, a frontend web UI, and firmware/runtime components for the frames themselves. 【F:README.md†L1-L40】
- Typical usage: run the backend service to manage frames, configure hardware-specific scenes, and deploy code or prebuilt scenes to devices over SSH.

## Cloud/backend parity (working rule)
- There are TWO control planes for frames: the self-hosted backend (`backend/` + `frontend/`) and FrameOS Cloud (`cloud/` + `cloud-frontend/`). **Any frame-facing feature or fix must land on both, or explicitly note why it's one-sided** — unless the task says otherwise. When you touch frame panels, frame APIs, device verbs, or provisioning/flashing, check the other control plane before calling the work done. Neither plane builds ESP32 firmware: both flash the signed generic release image, provision over the USB console, and offer the release OTA (`docs/todo.md`, `embedded/esp32/README.md`).
- The frame workspace UI is SHARED code (`frontend/src`), wrapped for cloud by `cloud-frontend/`. A fix that "doesn't show on cloud" is usually NOT a fork — check the `workspaceSurfaces` gating (`frontend/src/scenes/workspace/`) and remember the cloud serves a PREBUILT bundle: auth-web's predev rebuilds it via turbo (`scripts/build-frames-app.mjs`), but a long-running `pnpm dev` session keeps serving the bundle from its start.

## Cloud tests before you push (`verify` is the gate)

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

## AI scene chat: change the prompt/linter, then run the evals

- The cloud AI (`cloud/apps/auth-web/src/lib/ai/`) builds and edits scenes on
  the frames workspace AND on the scene store (`SceneAiPanel`). Every delivered
  scene passes `scene-lint.ts` (catalog-aware structural lint) before reaching
  the editor. When you touch `prompts.ts`, the linter, the app catalog or
  `docs/js-apps-and-code-nodes.md`, run the evals against real OpenAI and
  compare with the previous report: `pnpm --filter @frameos-cloud/auth-web
  ai:eval --compare evals/results/<prev>/report.json` (needs the dev server on
  :3000, the local DB filled by `scripts/import-store-scenes.mjs`, and
  `OPENAI_API_KEY`). See `cloud/apps/auth-web/evals/README.md`.

## Top-level layout
- `backend/` – Python FastAPI application that exposes REST/WS APIs, schedules background jobs, and manages persistence via SQLAlchemy. Includes Alembic migrations, ARQ worker tasks, and pytest suites. 【F:backend/app/fastapi.py†L1-L101】【F:backend/app/tasks/worker.py†L1-L64】【F:backend/app/models/user.py†L1-L16】
- `frontend/` – React + TypeScript single-page application built with esbuild, Tailwind, and kea state management. Compiled assets live in `frontend/dist` and are served by the backend when present. 【F:frontend/package.json†L1-L66】【F:backend/app/fastapi.py†L38-L86】
- `frameos/` – Nim-based runtime for devices, containing system drivers, Nim app definitions, and assets compiled into the on-device application. Nim apps live in `src/apps`; repo-provided JavaScript app templates live outside the runtime under `repo/apps/code` (with the general repo app layout still `repo/apps/<folder>/<app>`). Entry point `src/frameos.nim` is a small CLI (see "Device runtime" below); `make build` writes the binary to the gitignored `frameos/build/frameos`.
- `e2e/` – The end-to-end suites: the scene-renderer snapshot harness (`e2e/run`, `e2e/snapshots`), the Playwright frontend suite (`e2e/frontend-visual`, incl. the cloud `/frames` specs) and the opt-in real-SSH deploy test (`e2e/deploy`). `e2e/README.md` describes each, how CI runs them and which snapshots CI commits itself.
- `embedded/` – The ESP32 firmware (`embedded/esp32`, ESP-IDF + the Nim runtime compiled to C) and the Pico W thin client (`embedded/pico`). Neither control plane builds firmware: both flash signed release images. The IDF-free modules have host tests (`embedded/esp32/main/tests`, see that README's Layout).
- `cloud/` – FrameOS Cloud: the hosted service (Next.js + Drizzle/Postgres) behind `cloud.frameos.net` and `scenes.frameos.net` (legacy `account.frameos.net` redirects) — accounts, device/backend linking, and the scene store. Part of the monorepo's single pnpm workspace (one root lockfile, Turborepo builds); run pnpm commands from `cloud/`, see `cloud/README.md` and `cloud/docs/cloud-frames.md`. CI runs via `.github/workflows/cloud-ci.yml`.
- Supporting files at the root include Docker configuration, Procfile, install scripts, and version metadata for packaging and deployment. 【F:docker-compose.yml†L1-L14】

## Backend notes
- Environment configuration uses `Config` classes driven by env vars such as `SECRET_KEY`, `DATABASE_URL`, `REDIS_URL`, `HASSIO_RUN_MODE`, and debug/test toggles. During development (`DEBUG=1`) it autogenerates a `.env` with a fallback `SECRET_KEY`. 【F:backend/app/config.py†L1-L86】
- FastAPI application wiring (in `app/fastapi.py`):
  - Registers gzip middleware, websocket routers, and routes grouped by auth level (`api_public`, `api_open`, `api_user`, `api_project` — see `backend/app/api/__init__.py` for what each means with and without Home Assistant ingress).
  - Serves compiled frontend assets (or source HTML during tests) unless running in Home Assistant public ingress mode.
  - Initializes a shared `httpx.AsyncClient`, Redis listener, and PostHog analytics integration during startup.
  - Custom exception handlers degrade gracefully to JSON for API calls and reuse the SPA shell for 404/validation errors in non-test scenarios. 【F:backend/app/fastapi.py†L1-L112】
- Persistence uses SQLAlchemy ORM models (e.g., `User` with hashed passwords) and Alembic migrations (see `migrations/`). Session factory exposed from `app/database.py`. 【F:backend/app/models/user.py†L1-L16】
- Background jobs run through `arq` with Redis: worker defined in `app/tasks/worker.py` loads tasks for deploying/resetting frames, building SD images, and controlling agents. Startup hooks share HTTP, Redis, and DB clients. Run via `arq app.tasks.worker.WorkerSettings`. 【F:backend/app/tasks/worker.py†L1-L64】
- Tests rely on pytest + pytest-asyncio fixtures defined in `app/conftest.py`; there is broad coverage across API, websocket, and model layers under `app/api/tests` and `app/models/tests`. 【F:backend/app/conftest.py†L1-L65】【F:backend/app/api/tests/test_frames.py†L1-L183】
- Common local workflows:
  - Install dependencies: `pip install -r requirements.txt` (generated from `requirements.in`).
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
- `frameos/src` houses the on-device runtime written in Nim with asyncdispatch (`frameos/frameos` and `frameos/build` are untracked build outputs, not sources).
- Entry point `src/frameos.nim` is the runtime's CLI, not a bare `waitFor startFrameOS()`: `start` (the default, also for any unrecognised `--flag`) runs `startFrameOS()` in a retry loop with the boot guard; `version` / `--version` / `-v` prints the compiled version and exits — it used to fall through to `start` and boot a second runtime next to the service, which is how release 9.2 shipped a 9.1 runtime, so keep that branch first; `check` verifies the binary starts; `setup` (`--with-setup=/boot/frameos-setup.json[.gz]`, `--reboot-if-required`) runs first-boot device setup; `driver-setup` and `set-display` (`--device`, `--width`, `--height`, `--rotate`, `--vcom`, `--upload-url`) patch and apply the display; `upgrade` (`--dry-run`, `--no-reboot`) pulls the latest GitHub release; `privileged-worker` is the root side of the privileged door on Buildroot frames; `help` lists them. Drivers, system integrations, and Nim app implementations live in nested directories (`src/apps`, `src/drivers`, `src/system`, `src/frameos`); JavaScript example app sources/configs live under `repo/apps/<folder>/<app>`.
- JavaScript repo apps under `repo/apps/code` are catalog templates for custom code apps. Do not generate or commit Nim wrappers inside `repo/apps`; compiled scenes that use them copy their sources into generated `src/apps/sceneapp_*` folders during build/deploy.
- `frameos/Makefile` is the build entry: `make build` (app loaders → driver sources → shared driver libraries → assets → `nim c src/frameos.nim` into `build/frameos`), `make run`, `make test` (`nimble test`), `make test-shard SHARD=n` (what CI's "FrameOS Nim Tests" shards run, via `tools/run_test_shard.sh`), `make cross-<target>` / `make release-<target>` / `make release-all` (`backend/bin/cross`, the Docker cross-toolchain builds). `frameos.nimble` holds the dependencies and the `build_quickjs` task; `nimble build` itself can crash the compiler on macOS, so prefer `make build` / `nim c` directly.

## End-to-end tooling
- `e2e/README.md` is the map of every end-to-end suite: the scene-renderer snapshot harness (`e2e/run`, `makescenes.py`, `makesnapshots.py`, baselines in `e2e/snapshots`; `./run dataGradient` renders one scene), the Playwright frontend + cloud-workspace suite (`e2e/frontend-visual`), the opt-in real-SSH deploy test (`e2e/deploy`) and the Docker/ESP32 image jobs. It also carries the local-run recipes (port overrides, `FRONTEND_VISUAL_MAX_DIFF=1`, why a reused server drifts).
- Do not run frontend visual regression tests (`e2e/frontend-visual`, Playwright screenshots, or snapshot updates) during normal iteration. Only run them when the user explicitly asks for visual tests or asks to commit changes.
- Never commit visual regression snapshot updates produced by a backend/frontend stack running locally. Local macOS font rendering and browser rasterization differ from CI's Linux environment, so CI is the source of truth for both snapshot sets: same-repo pull requests run with `--update-snapshots` and the "Commit Visual Regression Snapshots" / "Commit Frontend Visual Snapshots" jobs push the result to the PR branch as "FrameOS Bot" (so `git pull --rebase` before pushing again). A visual job that fails on CI is therefore never a pixel diff — read the log for the frontend-error assertion or the failing `prepare` step.

## Deployment & operations
- Docker support: top-level `docker-compose.yml` builds the full stack (backend plus dependencies) exposing port 8989 and persisting SQLite DB under a named volume. PostgreSQL works via `DATABASE_URL=postgresql+psycopg://…` (psycopg ships in the image); the backend pytest suite runs on both in CI, so keep column widths honest — SQLite does not enforce them, Postgres does.
- The root `Dockerfile` is multi-stage: `runtime` is the published backend image (`docker build --target runtime -t frameos .`, what `README.md` and CI's "Build Docker Image" job build), `esp32-ci` is the ESP-IDF + Nim toolchain image the ESP32 firmware job builds in, and `app-builder` / `nim-toolchain` / `python-deps` are its intermediate stages. The plain runtime container is all a normal install needs; the Docker socket + `--privileged` variant in `README.md` exists only for the deprecated per-frame source build (`docs/legacy-source-builds.md`). Watchtower example commands in `README.md` show daily update flows.
- Environment variables documented in backend config govern integration with Home Assistant (HASSIO), Redis, PostHog analytics, and secret management. 【F:README.md†L24-L71】【F:backend/app/config.py†L1-L86】

## Getting started quickly
1. Install JS deps once from the repo root (`pnpm install`) and build the frontend (`pnpm --dir frontend run build`).
2. Install backend deps (`cd backend && pip install -r requirements.txt`).
3. Launch the local development stack with `pnpm dev`, or run the API (`uvicorn app.fastapi:app --reload`) and background worker (`arq app.tasks.worker.WorkerSettings`) separately if needed.
4. Optionally bring up the stack via Docker (`docker compose up --build`).
5. Use the backend UI/API to manage frames, deploy scenes, and monitor logs.

Keep this file updated as architecture or workflows change so future agents have an accurate snapshot of the repository.
