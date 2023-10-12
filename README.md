# FrameOS - smart home frames

FrameOS is a conductor of Raspberry Pi-powered e-ink displays and LCD screens.

To get started:

- Read the **[device guides](/devices)** - getting started guides, links to 3d-printable models and other resources for each supported display.
- Install the **[FrameOS controller](/installation/controller)** - a self-hosted python app that lets you build and deploy software onto individual frames via SSH.
- Set up the SD card for the [Raspberry Pi](/installation/raspberry) that'll be used in the frame.
- Finally, deploy prebuilt [apps](/apps) onto your frames, or code your own.

![](https://frameos.net/assets/images/1-frames-d127cdd40eaec7b65932a78a7a2034ae.jpg)

![](https://frameos.net/assets/images/diagram-reload-13b29b62750b3db0475aab66cdf49518.gif)

## FrameOS controller

The FrameOS controller is where you set up your frames. You can run it continuously on a server, or locally on your computer when needed. You'll just miss out on log aggregation if the controller is offline. The frames run independently.

![](https://frameos.net/assets/images/diagram-reload-13b29b62750b3db0475aab66cdf49518.gif)

## Installation

Read more in [the documentation](https://frameos.net/).

Docker quickstart:

```bash
# running the latest release
docker run -d -p 8999:8999 -v ./db:/app/db --name frameos --restart always mariusandra/frameos

# update daily to the latest release
docker run -d \
    --name watchtower \
    -v /var/run/docker.sock:/var/run/docker.sock \
    containrrr/watchtower \
    --interval 86400
    frameos

# one time update
docker run \
    -v /var/run/docker.sock:/var/run/docker.sock \
    containrrr/watchtower \
    --run-once \
    frameos
```

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
