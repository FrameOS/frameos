from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING

from app.drivers.drivers import Driver, DRIVERS
from app.drivers.waveshare import BOOT_CONFIG_LINES_BY_VARIANT, BOOT_CONFIG_SPI_VARIANTS, NO_SPI_VARIANTS, get_variant_keys

if TYPE_CHECKING:
    from app.models.frame import Frame

INKY_NATIVE_DEVICES = {
    "pimoroni.inky_impression_7_3",
    "pimoroni.inky_impression_7_color",
    "pimoroni.inky_impression_5_7",
    "pimoroni.inky_impression_5_7_color",
    "pimoroni.inky_impression_4_7_color",
    "pimoroni.inky_impression_4",
    "pimoroni.inky_impression_4_2025",
    "pimoroni.inky_impression_4_spectra6",
    "pimoroni.inky_impression_7",
    "pimoroni.inky_impression_7_2025",
    "pimoroni.inky_impression_13",
    "pimoroni.inky_impression_13_2025",
    "pimoroni.inky_phat_4",
    "pimoroni.inky_phat_4_color",
    "pimoroni.inky_phat_jd79661",
    "pimoroni.inky_phat_black",
    "pimoroni.inky_phat_red",
    "pimoroni.inky_phat_red_ht",
    "pimoroni.inky_phat_yellow",
    "pimoroni.inky_phat_ssd1608",
    "pimoroni.inky_phat_ssd1608_black",
    "pimoroni.inky_phat_ssd1608_red",
    "pimoroni.inky_phat_ssd1608_yellow",
    "pimoroni.inky_what_4",
    "pimoroni.inky_what_4_color",
    "pimoroni.inky_what_jd79668",
    "pimoroni.inky_what_black",
    "pimoroni.inky_what_red",
    "pimoroni.inky_what_red_ht",
    "pimoroni.inky_what_yellow",
    "pimoroni.inky_what_legacy_yellow",
    "pimoroni.inky_what_ssd1683",
    "pimoroni.inky_what_ssd1683_black",
    "pimoroni.inky_what_ssd1683_red",
    "pimoroni.inky_what_ssd1683_yellow",
}
INKY_PYTHON_DEVICES = {
    "pimoroni.inky_impression",
    "pimoroni.inky_python",
}
INKY_BUTTON_DEVICES = {
    "pimoroni.inky_impression",
    "pimoroni.inky_impression_7_3",
    "pimoroni.inky_impression_7_color",
    "pimoroni.inky_impression_5_7",
    "pimoroni.inky_impression_5_7_color",
    "pimoroni.inky_impression_4_7_color",
    "pimoroni.inky_impression_4",
    "pimoroni.inky_impression_4_2025",
    "pimoroni.inky_impression_4_spectra6",
    "pimoroni.inky_impression_7",
    "pimoroni.inky_impression_7_2025",
    "pimoroni.inky_impression_13",
    "pimoroni.inky_impression_13_2025",
}
VIRTUAL_OUTPUT_DEVICES = {
    "http.upload",
    "web_only",
}


def drivers_for_frame(frame: Frame) -> dict[str, Driver]:
    device = frame.device
    device_drivers: dict[str, Driver] = {}
    if device in INKY_NATIVE_DEVICES:
        device_drivers = {
            "inky": replace(DRIVERS["inky"]),
            "spi": DRIVERS["spi"],
            "bootconfig": replace(DRIVERS["bootConfig"], lines=["dtoverlay=spi0-0cs"]),
        }
        if device in INKY_BUTTON_DEVICES:
            device_drivers["gpioButton"] = DRIVERS["gpioButton"]
    elif device in INKY_PYTHON_DEVICES:
        device_drivers = {
            "inkyPython": DRIVERS["inkyPython"],
            "spi": DRIVERS["spi"],
            "i2c": DRIVERS["i2c"],
        }
        if device in INKY_BUTTON_DEVICES:
            device_drivers["gpioButton"] = DRIVERS["gpioButton"]
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

        if waveshare.variant in BOOT_CONFIG_SPI_VARIANTS:
            device_drivers = {"waveshare": waveshare}
        elif waveshare.variant in NO_SPI_VARIANTS:
            device_drivers = {"waveshare": waveshare, "noSpi": DRIVERS["noSpi"]}
        else:
            device_drivers = {"waveshare": waveshare, "spi": DRIVERS["spi"]}

        boot_config_lines = BOOT_CONFIG_LINES_BY_VARIANT.get(waveshare.variant)
        if boot_config_lines:
            device_drivers["bootconfig"] = DRIVERS["bootConfig"]
            device_drivers["bootconfig"].lines = list(boot_config_lines)

    # Enable evdev for devices that can have local input attached.
    if device not in INKY_BUTTON_DEVICES and not device.startswith("waveshare.") and device not in VIRTUAL_OUTPUT_DEVICES:
        device_drivers["evdev"] = DRIVERS["evdev"]

    if frame.device in INKY_BUTTON_DEVICES:
        if frame.device in {"pimoroni.inky_impression_13", "pimoroni.inky_impression_13_2025"}:
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
        if "bootconfig" not in device_drivers:
            device_drivers["bootconfig"] = replace(DRIVERS["bootConfig"], lines=["dtoverlay=spi0-0cs"])

    if "gpioButton" not in device_drivers and len(frame.gpio_buttons or []) > 0:
        device_drivers["gpioButton"] = DRIVERS["gpioButton"]

    return device_drivers
