# FrameOS - smart home frames

This is beta level software. Obvious things are missing.

## Required hardware 

Grab yourself a

- [Inky Impression 5.7"](https://shop.pimoroni.com/products/inky-impression-5-7?variant=32298701324371)
- [Inky Impression 7.3"](https://shop.pimoroni.com/products/inky-impression-7-3?variant=40512683376723)

And:

- [Raspberry Pi Zero W](https://shop.pimoroni.com/products/raspberry-pi-zero-w?variant=39458414264403)

Get it with presoldered headers, or solder them yourself. Attach the two devices.

## FrameOS Control Panel

```bash
docker run -d -p 8999:8999 mariusandra/frameos
```

Then load http://0.0.0.0:8999 - ideally with an IP that your frames can connect to.

## Raspberry setup 

Download the [Raspberry Pi Imager](https://www.raspberrypi.com/software/)

- Select [Raspberry Pi OS Lite](https://www.raspberrypi.org/downloads/raspberry-pi-os/) debian `bullseye`. 
- Select 32-bit if you have the zero w v1, otherwise select 64 bit.
- Click the "Gear" icon
- Change the hostname to something unique, like `frame1.local`
- Enable SSH with password. Set a strong user/password and note it down in your password manager.
- Make sure the wifi user/password is correct.

Plug in the raspberry, and wait until you can connect to it:

```bash
ping frame1.local
ssh frame@frame1.local
```

Then add it in the control interface.

### Optional

Then run `sudo raspi-config` and:

1. enable spi
2. enable i2c

Optional, install tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

# Developing 

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