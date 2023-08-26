# FrameOS - smart home frames

This is beta software. Obvious things are missing.

## Required hardware 

The bare minimum: 

- Any raspberry pi with a HDMI port and a browser for Kiosk mode.

Supported frames:

- [Inky Impression 5.7"](https://shop.pimoroni.com/products/inky-impression-5-7?variant=32298701324371) e-ink display
- [Inky Impression 7.3"](https://shop.pimoroni.com/products/inky-impression-7-3?variant=40512683376723) e-ink display

Attach them to a Raspberry Pi Zero W, and control the image via FrameOS.

![](https://mariusandra.com/frameos/images/0-frames.jpeg)

## FrameOS controller

The FrameOS controller is where you set up your frames. You can run it continuously on a server, or locally on your computer when needed. You'll miss out on log aggregation if the FrameOS server is not always on. The frames however will keep on running and updating independently.

![2023-08-21 01 11 13](https://frameos.net/assets/images/frameos-screenshot-5490da95ea8678e1d4f6ba3b58a7d320.png)

## Installation

Read more in [the documentation](https://frameos.net/).

# Developing locally

## FrameOS Control Panel


```bash
python3 -m venv env
source env/bin/activate
pip install -r requirements.txt
cd frontend && npm install && cd ..
honcho start
```

## Running migrations

```bash
# create migration after changing a model
flask db migrate -m "something changed"
# apply the migrations
flask db upgrade
```

# TODO

Tracked here: https://github.com/mariusandra/frameos/issues/1
