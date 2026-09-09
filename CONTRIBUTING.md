
# Developing locally

## Prerequisites

Install flox: https://flox.dev/docs/install-flox/install/

Clone this repository and run `flox activate`

## FrameOS Backend

To run all services at once:

```bash
pnpm dev
```

This opens `mprocs` (the process list is `mprocs.yaml`). These panes
autostart: `backend` (the FastAPI app with `DEBUG=1`), `worker` (the ARQ job
queue), `vite` and `kea` (the main frontend's dev server and its kea-typegen
watcher), `redis`, `postgres` (the Flox-provided Postgres on port 55432,
which the cloud uses) and `wasm` — a Nim → emscripten build of the
interpreted-scene runtime for the browser preview
(`frameos/tools/build_wasm.sh`), which therefore runs on every `pnpm dev`.
These panes exist but do not autostart until you select them: `frameos`
(`make` in `frameos/`, the native runtime), `cloud` and `cloud-hub` (the
FrameOS Cloud dev server and the frame hub; `cloud/scripts/db-setup.sh`
applies migrations first), `backend-docker` (`scripts/backend-docker.sh`) and
`migrate` (alembic upgrade for the backend). The on-frame admin frontend has
no pane; its watcher is `pnpm dev:frame-frontend`.

To run the main pieces separately:

```bash
# start the frontend
cd frontend
pnpm run dev
cd ..

# apply any migrations
cd backend
DEBUG=1 python -m alembic upgrade head

# start the backend
cd backend
DEBUG=1 python -m app.fastapi

# start the job queue
cd backend
DEBUG=1 arq app.tasks.worker.WorkerSettings

# start the frame-local (on-frame admin) frontend asset watcher
pnpm dev:frame-frontend
```

Running a local dev build of the backend via Docker:

```bash
SECRET_KEY=$(openssl rand -base64 32)
mkdir -p db
docker build --target runtime -t frameos .
docker run -d -p 8989:8989 \
    -v ./db:/app/db \
    --name frameos \
    --restart always \
    -e SECRET_KEY="$SECRET_KEY" \
    frameos
```

That plain container is all a normal install needs: deploys install released
binaries and SD-card images are generated without Docker privileges. The
Docker-socket + `--privileged` variant in `README.md` exists only for the
deprecated per-frame source build (`docs/legacy-source-builds.md`); do not
reach for it otherwise.

## Creating migrations

```bash
cd backend
# create migration after changing a model
DEBUG=1 python -m alembic revision --autogenerate -m "name of migration"
# run pending migrations
DEBUG=1 python -m alembic upgrade head
```

## Installing pre-commit

```bash
# run linter on files changes in every commit
pre-commit install
# run linter on all files
pre-commit run --all-files
# uninstall if causing problems
pre-commit uninstall
```

## Running tests

```bash
cd backend
pytest
```

## FrameOS on-frame software

The runtime that runs on the frame is Nim (`frameos/`), not Python. Build
and run it natively on macOS or Linux:

```bash
cd frameos
make build       # app loaders → driver sources → assets → nim c src/frameos.nim → build/frameos
make run         # ./build/frameos --verbose (uses ./frame.json)
make test        # nimble test
make test-shard SHARD=1   # one of the CI shards (tools/run_test_shard.sh)
```

`nimble build` on its own can crash the Nim compiler on macOS; `make build`
(or `nim c` directly) is the supported path. The macOS-specific gotcha is the
startup network check: Nim's `std/net` dlopens libssl by bare name, which in
a Flox shell resolves a mismatched system dylib and segfaults — `make run`
sets `DYLD_FALLBACK_LIBRARY_PATH` for exactly that. Hardware drivers
(e-paper SPI, GPIO) only do anything on a Pi; on a laptop they compile
against the same sources and the `web_only` / framebuffer devices render to
the local admin panel.

There is no Docker image for the on-frame runtime and no `test.py`. What CI
builds in Docker is the *backend* image (`docker build --target runtime`,
`.github/workflows/e2e-docker.yml` "Build Docker Image") and the ESP32
firmware (`--target esp32-ci`, which also runs the firmware's host tests —
see `embedded/esp32/README.md`). Cross-compiling the runtime for a Pi target
without a Pi uses the prebuilt toolchain containers: `make cross-<target>`
and `make release-<target>` (`make cross-list` prints the targets; see
`README.md`, "Cross-compilation").

The end-to-end suites — the scene-renderer snapshots, the Playwright
frontend suite and the opt-in real-SSH deploy test — are described in
`e2e/README.md`.

# TODO

Open work lives in `docs/todo.md`, which links the per-track files
(`docs/convergence-todo.md`, `docs/scenes-todo.md`, `docs/ui-todo.md`,
`docs/manual-testing-todo.md`, `docs/security-todo.md`,
`cloud/docs/accounting-todo.md`, `cloud/STORE-TODO.md`, and the review list
`docs/review-todo.md` while it lasts). Two files hold principles rather than
todos: `docs/cloud-principles.md` and `cloud/SCOPE.md`. The
historical task list is https://github.com/FrameOS/frameos/issues/1.
