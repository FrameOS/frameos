# FrameOS - smart home frames

This is beyond-alpha level software. It's not meant to work for anyone other than myself.

## Hardware 

Grab yourself a

- [Inky Impression 5.7"](https://shop.pimoroni.com/products/inky-impression-5-7?variant=32298701324371)
- [Inky Impression 7.3"](https://shop.pimoroni.com/products/inky-impression-7-3?variant=40512683376723)

And:

- [Raspberry Pi Zero W](https://shop.pimoroni.com/products/raspberry-pi-zero-w?variant=39458414264403)

Get it with presoldered headers, or solder them yourself.

## Raspberry setup 

Then Install [Raspberry Pi OS Lite](https://www.raspberrypi.org/downloads/raspberry-pi-os/) on a SD card (flash with [etcher](https://etcher.io/)). Remount the drive and edit the following files:

- `boot/ssh` - just create an empty file
- `boot/wpa_supplicant.conf`

```conf
country=US # Your 2-digit country code
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
network={
    ssid="YOUR_NETWORK_NAME"
    psk="YOUR_PASSWORD"
    key_mgmt=WPA-PSK
    scan_ssid=1
}
```

Upon boot run `raspi-config` and:

1. change the password
4. change the hostname
2. enable spi
3. enable i2c

Update software as normal, also install `python3-pip`

Get the pimoroni software installed with examples:

```
curl https://get.pimoroni.com/inky | bash
```

If that's happy, all the dependencies should be installed.

# FrameOS Control Panel

Getting started:

```bash
python3 -m venv env
source env/bin/activate
pip install -r requirements.txt
cd frontend && npm install && cd ..
honcho start
```
