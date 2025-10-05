
# Developing locally

## Prerequisites

You'll need to install:
Python >= 3.12
`Node.js` and `npm`
`redis-server`
`nim >=2.0.0` (https://nim-lang.org/install.html)
(Note that Debian distros have only packaged `1.6.x` as of Jan 2024)

## FrameOS Backend

Start a redis server if not running

```bash
redis-server --daemonize yes
```

Installing deps

```bash
cd backend
python3 -m venv env
source env/bin/activate
uv pip install -r requirements.txt
DEBUG=1 alembic upgrade head

cd ../frontend
npm install

cd ../frameos
nimble install -d
nimble setup
cd ..
```

To run all services at once:

```bash
cd frontend
npm run dev &
cd ../backend
bin/dev
```

To run all of these separately:

```bash
# start the frontend
cd frontend
npm run dev
cd ..

# apply any migrations
cd backend
DEBUG=1 python -m alembic upgrade head

# start the backend
cd backend
DEBUG=1 python -m app.fastapi

# start the job queue
cd backend
DEBUG=1 arq app.tasks.worker
```

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
