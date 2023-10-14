
# Developing locally

## FrameOS Controller


```bash
cd backend 
python3 -m venv env
source env/bin/activate
pip install -r requirements.txt
flask db upgrade

cd ../frontend
npm install
cd ..

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

## FrameOS device software

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

Tracked here: https://github.com/mariusandra/frameos/issues/1
