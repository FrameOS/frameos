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


## FrameOS (control software)

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

![](https://mariusandra.com/frameos/images/7-docker-fast-frameos.gif)


## Raspberry Pi setup (individual frames)

Download the [Raspberry Pi Imager](https://www.raspberrypi.com/software/) and select [Raspberry Pi OS Lite](https://www.raspberrypi.org/downloads/raspberry-pi-os/) debian `bullseye`. Select 32-bit if you have the zero w v1, otherwise select 64 bit.

![](https://mariusandra.com/frameos/images/1-os-raspberry-lite.gif)

Click the "Gear" icon and make sure you have set the correct hostname, ssh user/password, and WiFi credentials. Set a strong password and save it in your password manager.

![](https://mariusandra.com/frameos/images/2-config-settings.gif)

Choose your SD card and write

![](https://mariusandra.com/frameos/images/3-storage-write.gif)

It'll take a while

![](https://mariusandra.com/frameos/images/4-wait-wait-wait.gif)

When done, place the card into the raspberry.

![](https://mariusandra.com/frameos/images/13-sdcard.gif)

Place the raspberry on the artboard, and plug it in

![](https://mariusandra.com/frameos/images/14-wire.gif)

And wait until it shows up with `ping` and `ssh`.

![](https://mariusandra.com/frameos/images/6-success.gif)

If you're already here, and plan on using Inky Impresson frames, run `sudo raspi-config` and

1. enable SPI
2. enable I2C

Sadly these aren't automated yet.

![](https://mariusandra.com/frameos/images/10-raspi-config.gif)

## Install the frame

Finally, add the frame to FrameOS. Make sure both can ping each other with the IPs given.

![](https://mariusandra.com/frameos/images/8-deploy-frame.gif)


## Actual frames

There's a chance everything went well and you have a good deploy:

![](https://mariusandra.com/frameos/images/11-good-deploy.gif)

In that case you should see something like this:

![](https://mariusandra.com/frameos/images/12-parrot.gif?)

Add multuple frames, and control their content remotely. 

![](https://mariusandra.com/frameos/images/15-multiple.gif)

## Kiosk mode

With or without a connected e-ink display, each deployed raspberry can show the current image in Kiosk mode. Click the Kiosk URL to see the image in full screen. 

This is perfect if your raspberry has a HDMI port, or you wish to connect to it remotely.

![](https://mariusandra.com/frameos/images/9-kiosk-mode.gif)

## Periodic screenshot

I've used the [Lovelace Kindle Screensaver](https://github.com/sibbl/hass-lovelace-kindle-screensaver) Home Assistant app to expose a screenshot of a Home Assistant dashboard on http://homeassistant.local:4999/. The frame below checks it every 30 seconds, and updates if the image changed.

![](https://mariusandra.com/frameos/images/16-wall.jpg)

I'd like to natively support screenshots of websites in FrameOS, but it's not here now.

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
