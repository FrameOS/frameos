# FrameOS Repository Guide

## Project overview
- FrameOS is an "operating system for single-function smart frames" designed to run on Raspberry Pi–class hardware with a mix of e-ink and standard displays. The ecosystem includes a backend control plane, a frontend web UI, and firmware/runtime components for the frames themselves. 【F:README.md†L1-L40】
- Typical usage: run the backend service to manage frames, configure hardware-specific scenes, and deploy code or prebuilt scenes to devices over SSH.

## Top-level layout
- `backend/` – Python FastAPI application that exposes REST/WS APIs, schedules background jobs, and manages persistence via SQLAlchemy. Includes Alembic migrations, ARQ worker tasks, and pytest suites. 【F:backend/app/fastapi.py†L1-L101】【F:backend/app/tasks/worker.py†L1-L64】【F:backend/app/models/user.py†L1-L16】
- `frontend/` – React + TypeScript single-page application built with esbuild, Tailwind, and kea state management. Compiled assets live in `frontend/dist` and are served by the backend when present. 【F:frontend/package.json†L1-L66】【F:backend/app/fastapi.py†L38-L86】
- `frameos/` – Nim-based runtime for devices, containing system drivers, Nim app definitions, and assets compiled into the on-device application. Nim apps live in `src/apps`; repo-provided JavaScript app templates live outside the runtime under `repo/apps/code` (with the general repo app layout still `repo/apps/<folder>/<app>`). Entry point `src/frameos.nim` boots the async runtime. 【F:frameos/src/frameos.nim†L1-L6】
- `e2e/` – Scene/asset generation utilities and snapshot-based end-to-end tests for validating rendered output. 【F:e2e/README.md†L1-L6】
- Supporting files at the root include Docker configuration, Procfile, install scripts, and version metadata for packaging and deployment. 【F:docker-compose.yml†L1-L14】

## Backend notes
- Environment configuration uses `Config` classes driven by env vars such as `SECRET_KEY`, `DATABASE_URL`, `REDIS_URL`, `HASSIO_RUN_MODE`, and debug/test toggles. During development (`DEBUG=1`) it autogenerates a `.env` with a fallback `SECRET_KEY`. 【F:backend/app/config.py†L1-L86】
- FastAPI application wiring (in `app/fastapi.py`):
  - Registers gzip middleware, websocket routers, and routes grouped by auth level (`api_public`, `api_no_auth`, `api_with_auth`).
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
- Repo-level local development runner: `pnpm dev` starts `mprocs` with panes for backend API, ARQ worker, the main frontend dev server, and the frame-local frontend watcher. `redis`, `frameos`, and `backend-docker` panes are available but do not autostart. The `backend-docker` pane runs `scripts/backend-docker.sh`, which persists a generated Docker `SECRET_KEY` in the gitignored `.env.docker.local`. `mprocs.yaml` defines the process list.
- Production build: `pnpm --dir frontend run build` which chains kea codegen, schema generation (`ts-json-schema-generator`), TypeScript type-checking, and final bundling to `dist/`. 【F:frontend/package.json†L6-L66】
- Output folder is consumed by the backend’s static file mounts; ensure `frontend/dist` exists (e.g., via `pnpm --dir frontend run build`) before running the Python app outside of test mode. 【F:backend/app/fastapi.py†L38-L86】
- ALWAYS prefer writing frontend business logic in kea logic files over using effects like `useState` or `useEffect`.
- This includes small functions and callbacks inside components. Prefer to keep as much code as possible in logic files, treating React as a templating layer.

## Device runtime (Nim) notes
- `frameos/frameos` houses the on-device runtime written in Nim with asyncdispatch.
- Entry point `src/frameos.nim` waits on `startFrameOS()` defined under `src/frameos/frameos`. Drivers, system integrations, and Nim app implementations live in nested directories (`src/apps`, `src/drivers`, `src/system`); JavaScript example app sources/configs live under `repo/apps/<folder>/<app>`. 【F:frameos/src/frameos.nim†L1-L6】
- JavaScript repo apps under `repo/apps/code` are catalog templates for custom code apps. Do not generate or commit Nim wrappers inside `repo/apps`; compiled scenes that use them copy their sources into generated `src/apps/sceneapp_*` folders during build/deploy.
- Project uses Nimble (`frameos.nimble`) for builds; `Makefile` likely wraps build/deploy steps for device firmware.

## End-to-end tooling
- `e2e/` directory contains scripts (`run`, `makescenes.py`, `makesnapshots.py`) to render scenes and compare against stored snapshots in `e2e/snapshots`. Run all tests with `./run` from that directory, or specify individual scenes like `./run dataGradient`. 【F:e2e/README.md†L1-L6】

## Deployment & operations
- Docker support: top-level `docker-compose.yml` builds the full stack (backend plus dependencies) exposing port 8989 and persisting SQLite DB under a named volume.
- `Dockerfile` and `Procfile` (not detailed here) package the backend/frontend bundle; watchtower example commands in `README.md` show daily update flows.
- Environment variables documented in backend config govern integration with Home Assistant (HASSIO), Redis, PostHog analytics, and secret management. 【F:README.md†L24-L71】【F:backend/app/config.py†L1-L86】

## Getting started quickly
1. Install JS deps once from the repo root (`pnpm install`) and build the frontend (`pnpm --dir frontend run build`).
2. Install backend deps (`cd backend && pip install -r requirements.txt`).
3. Launch the local development stack with `pnpm dev`, or run the API (`uvicorn app.fastapi:app --reload`) and background worker (`arq app.tasks.worker.WorkerSettings`) separately if needed.
4. Optionally bring up the stack via Docker (`docker compose up --build`).
5. Use the backend UI/API to manage frames, deploy scenes, and monitor logs.

Keep this file updated as architecture or workflows change so future agents have an accurate snapshot of the repository.
