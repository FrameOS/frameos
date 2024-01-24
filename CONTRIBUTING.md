
# Developing locally

## Prerequisites

You'll need to install:
Python >= 3.11
`Node.js` and `npm`
`redis-server`
`nim >=2.0.0` (https://nim-lang.org/install.html)
(Note that Debian distros have only packaged `1.6.x` as of Jan 2024)

## FrameOS Controller


```bash
cd backend
python3 -m venv env
source env/bin/activate
pip install -r requirements.txt
flask db upgrade

cd ../frontend
npm install

cd ../frameos
nimble install -d
nimble setup

cd ..

# start a redis server
redis-server --daemonize yes

honcho start
```

## Running migrations

```bash
cd backend
# create migration after changing a model
flask db migrate -m "something changed"
# apply the migrations
flask db upgrade
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
bin/tests
```

## FrameOS on-device software

Running it natively on a Mac will fail with

```bash
spidev_module.c:33:10: fatal error: 'linux/spi/spidev.h' file not found
#include <linux/spi/spidev.h>
```

So we use Docker:

```bash
cd frameos
docker build -t frameos . && docker run -t -i frameos python3 test.py
```

# TODO

Tracked here: https://github.com/FrameOS/frameos/issues/1
