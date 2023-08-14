# FrameOS - smart home frames

This is beta software. Obvious things are missing.

## Required hardware 

The bare minimum: 

- Any raspberry pi with a HDMI port and a browser for Kiosk mode.

Supported frames:

- [Inky Impression 5.7"](https://shop.pimoroni.com/products/inky-impression-5-7?variant=32298701324371) e-ink display
- [Inky Impression 7.3"](https://shop.pimoroni.com/products/inky-impression-7-3?variant=40512683376723) e-ink display

Attach them to a Raspberry Pi Zero W, and control the image via FrameOS.

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/0-frames.jpeg?raw=true)


## FrameOS

FrameOS is the control center for your frames. You can run it
continuously on a server, or locally on your computer when needed. You'll miss out on log aggregation if the FrameOS server is not always on. The frames however will keep on running and updating independently.

Running FrameOS via Docker is the easiest. Alternatively read about developing locally below.

```bash
# running the latest release
docker run -d -p 8999:8999 -v data:/app/data mariusandra/frameos

# build your own from this repository
docker build . -t frameos
docker run -d -p 8999:8999 -v data:/app/data frameos
```

Then load http://0.0.0.0:8999 - ideally using a local IP that your frames can connect to.

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/7-docker-fast-frameos.gif?raw=true)


## Raspberry setup

Download the [Raspberry Pi Imager](https://www.raspberrypi.com/software/) and select [Raspberry Pi OS Lite](https://www.raspberrypi.org/downloads/raspberry-pi-os/) debian `bullseye`. Select 32-bit if you have the zero w v1, otherwise select 64 bit.

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/1-os-raspberry-lite.gif?raw=true)

Click the "Gear" icon and make sure you have set the correct hostname, ssh user/password, and WiFi credentials. Set a strong password and save it in your password manager.

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/2-config-settings.gif?raw=true)

Choose your SD card and write

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/3-storage-write.gif?raw=true)

It'll take a while

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/4-wait-wait-wait.gif?raw=true)

When done, place the card into the raspberry.

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/13-sdcard.gif?raw=true)

Place the raspberry on the artboard, and plug it in

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/14-wire.gif?raw=true)

And wait until it shows up with `ping` and `ssh`.

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/6-success.gif?raw=true)

If you're already here, and plan on using Inky Impresson frames, run `sudo raspi-config` and

1. enable SPI
2. enable I2C

Sadly these aren't automated yet.

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/10-raspi-config.gif?raw=true)

## Install the frame

Finally, add the frame to FrameOS. Make sure both can ping each other with the IPs given.

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/8-deploy-frame.gif?raw=true)

## Kiosk mode

With or without a connected frame, FrameOS can dispaly the current rotating image in Kiosk mode. Click the Kiosk URL to see the image in full screen. Perfect for showing over a HDMI connection in a browser.

![](https://github.com/mariusandra/frameos-docs/blob/main/images/9-kiosk-mode.gif?raw=true)

## Actual frames

There's a chance everything went well and you have a good deploy:

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/11-good-deploy.gif?raw=true)

In thas case you should see something like this:

![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/12-parrot.gif?raw=true)

Add multuple frames, and control their content remotely. 

The second frame here uses [Lovelace Kindle Screensaver](https://github.com/sibbl/hass-lovelace-kindle-screensaver) to expose a screenshot of a Home Assistant dashboard.


![](https://raw.githubusercontent.com/mariusandra/frameos-docs/main/images/15-multiple.gif?raw=true)

# Developing locally

## FrameOS Control Panel


```bash
python3 -m venv env
source env/bin/activate
pip install -r requirements.txt
cd frontend && npm install && cd ..
honcho start
```

## Migrations

```bash
# create migration after changing a model
flask db migrate -m "something changed"
# apply the migrations
flask db upgrade
```