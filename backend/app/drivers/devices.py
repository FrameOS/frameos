from typing import Dict

from app.drivers.drivers import Driver, DRIVERS
from app.drivers.waveshare import get_variant_keys

def drivers_for_device(device: str) -> Dict[str, Driver]:
    device_drivers: Dict[str, Driver] = {}
    if device == "pimoroni.inky_impression":
        device_drivers = {"inkyPython": DRIVERS["inkyPython"], "spi": DRIVERS["spi"], "i2c": DRIVERS["i2c"]}
    elif device == "pimoroni.hyperpixel2r":
        device_drivers = {"inkyHyperPixel2r": DRIVERS["inkyHyperPixel2r"]}
    elif device == "framebuffer":
        device_drivers = {"frameBuffer": DRIVERS["frameBuffer"]}
    elif device.startswith("waveshare."):
        waveshare = DRIVERS["waveshare"]
        waveshare.variant = device.split(".")[1]
        # backwards compatibility
        if waveshare.variant == "epd7in5_V2":
            waveshare.variant = "EPD_7in5_V2"
        if waveshare.variant == "epd2in13_V3":
            waveshare.variant = "EPD_2in13_V3"

        if waveshare.variant not in get_variant_keys():
            raise Exception(f"Unknown waveshare driver variant {waveshare.variant}")
        device_drivers = {"waveshare": waveshare, "spi": DRIVERS["spi"]}

    # Always enable evdev if not eink
    if device != "pimoroni.inky_imporession" and not device.startswith("waveshare."):
        device_drivers['evdev'] = DRIVERS['evdev']

    return device_drivers
