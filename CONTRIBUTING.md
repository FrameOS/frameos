
# Developing locally

## Prerequisites

Install flox: https://flox.dev/docs/install-flox/install/

Clone this repository and run `flox activate`

## FrameOS Backend

To run all services at once:

```bash
pnpm dev
```

This opens `mprocs` with panes for the backend API, ARQ worker, main frontend, and the frame-local frontend watcher. The `redis` pane is available but does not autostart.

To run all of these separately:

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

# start the frame-local frontend asset watcher
cd ../frameos/frontend
pnpm run dev
```

Running a local dev build via docker:

```bash
SECRET_KEY=$(openssl rand -base64 32)
docker build -t frameos .
docker run -d -p 8989:8989 \
    -v ./db:/app/db \
    -v /tmp/frameos-cross:/tmp/frameos-cross \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --privileged \
    --name frameos \
    --restart always \
    -e SECRET_KEY="$SECRET_KEY" \
    -e TMPDIR=/tmp/frameos-cross \
    frameos
```

We need `docker.sock` and `--privileged` for docker-based cross-compilation.

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

Running it natively on a Mac will fail with

```bash
spidev_module.c:33:10: fatal error: 'linux/spi/spidev.h' file not found
#include <linux/spi/spidev.h>
```

So we use Docker:

```bash
cd frameos
docker build -t frameos-frame . && docker run -t -i frameos python3 test.py
```

# TODO

Tracked here: https://github.com/FrameOS/frameos/issues/1
