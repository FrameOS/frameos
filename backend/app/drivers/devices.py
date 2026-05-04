from __future__ import annotations

from typing import TYPE_CHECKING

from app.drivers.drivers import Driver, DRIVERS
from app.drivers.waveshare import get_variant_keys

if TYPE_CHECKING:
    from app.models.frame import Frame

INKY_BUTTON_DEVICES = {
    "pimoroni.inky_impression",
    "pimoroni.inky_impression_7",
    "pimoroni.inky_impression_13",
}
VIRTUAL_OUTPUT_DEVICES = {
    "http.upload",
    "web_only",
}


def drivers_for_frame(frame: Frame) -> dict[str, Driver]:
    device = frame.device
    device_drivers: dict[str, Driver] = {}
    if device in INKY_BUTTON_DEVICES or device == "pimoroni.inky_python":
        device_drivers = {
            "inkyPython": DRIVERS["inkyPython"],
            "spi": DRIVERS["spi"],
            "i2c": DRIVERS["i2c"],
        }
        if device in INKY_BUTTON_DEVICES:
            device_drivers["gpioButton"] = DRIVERS["gpioButton"]
        if device == "pimoroni.inky_impression_7" or device == "pimoroni.inky_impression_13":
            device_drivers["inkyPython"].can_png = True
    elif device == "pimoroni.hyperpixel2r":
        device_drivers = {"inkyHyperPixel2r": DRIVERS["inkyHyperPixel2r"]}
    elif device == "framebuffer":
        device_drivers = {"frameBuffer": DRIVERS["frameBuffer"]}
    elif device == "http.upload":
        device_drivers = {"httpUpload": DRIVERS["httpUpload"]}
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

        if waveshare.variant in ("EPD_12in48", "EPD_12in48b", "EPD_12in48b_V2", "EPD_13in3e"):
            device_drivers = {"waveshare": waveshare, "noSpi": DRIVERS["noSpi"]}
        else:
            device_drivers = {"waveshare": waveshare, "spi": DRIVERS["spi"]}

        if waveshare.variant == "EPD_10in3":
            device_drivers["bootconfig"] = DRIVERS["bootConfig"]
            device_drivers["bootconfig"].lines = [
                "dtoverlay=spi0-0cs",
                "#dtparam=spi=on"
            ]
        if waveshare.variant == "EPD_13in3e":
            device_drivers["bootconfig"] = DRIVERS["bootConfig"]
            device_drivers["bootconfig"].lines = [
                "gpio=7=op,dl",
                "gpio=8=op,dl",
            ]

    # Enable evdev for devices that can have local input attached.
    if device not in INKY_BUTTON_DEVICES and not device.startswith("waveshare.") and device not in VIRTUAL_OUTPUT_DEVICES:
        device_drivers["evdev"] = DRIVERS["evdev"]

    if frame.device in INKY_BUTTON_DEVICES:
        if frame.device == "pimoroni.inky_impression_13":
            frame.gpio_buttons = [
                {"pin": 5, "label": "A"},
                {"pin": 6, "label": "B"},
                {"pin": 25, "label": "C"},
                {"pin": 24, "label": "D"},
            ]
        else:
            frame.gpio_buttons = [
                {"pin": 5, "label": "A"},
                {"pin": 6, "label": "B"},
                {"pin": 16, "label": "C"},
                {"pin": 24, "label": "D"},
            ]
        device_drivers["bootconfig"] = DRIVERS["bootConfig"]
        device_drivers["bootconfig"].lines = [
            "dtoverlay=spi0-0cs",
        ]

    if "gpioButton" not in device_drivers and len(frame.gpio_buttons or []) > 0:
        device_drivers["gpioButton"] = DRIVERS["gpioButton"]

    return device_drivers
