from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING

from app.drivers.drivers import Driver, DRIVERS
from app.drivers.waveshare import (
    BOOT_CONFIG_LINES_BY_VARIANT,
    BOOT_CONFIG_SPI_VARIANTS,
    NO_SPI_VARIANTS,
    convert_waveshare_source,
    get_variant_keys,
)

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

NATIVE_DEVICE_DIMENSIONS = {
    "pimoroni.inky_impression_7_3": (800, 480),
    "pimoroni.inky_impression_7_color": (800, 480),
    "pimoroni.inky_impression_5_7": (600, 448),
    "pimoroni.inky_impression_5_7_color": (600, 448),
    "pimoroni.inky_impression_4_7_color": (640, 400),
    "pimoroni.inky_impression_4": (600, 400),
    "pimoroni.inky_impression_4_2025": (600, 400),
    "pimoroni.inky_impression_4_spectra6": (600, 400),
    "pimoroni.inky_impression_7": (800, 480),
    "pimoroni.inky_impression_7_2025": (800, 480),
    "pimoroni.inky_impression_13": (1600, 1200),
    "pimoroni.inky_impression_13_2025": (1600, 1200),
    "pimoroni.inky_phat_4": (250, 122),
    "pimoroni.inky_phat_4_color": (250, 122),
    "pimoroni.inky_phat_jd79661": (250, 122),
    "pimoroni.inky_phat_black": (212, 104),
    "pimoroni.inky_phat_red": (212, 104),
    "pimoroni.inky_phat_red_ht": (212, 104),
    "pimoroni.inky_phat_yellow": (212, 104),
    "pimoroni.inky_phat_ssd1608": (250, 122),
    "pimoroni.inky_phat_ssd1608_black": (250, 122),
    "pimoroni.inky_phat_ssd1608_red": (250, 122),
    "pimoroni.inky_phat_ssd1608_yellow": (250, 122),
    "pimoroni.inky_what_4": (400, 300),
    "pimoroni.inky_what_4_color": (400, 300),
    "pimoroni.inky_what_jd79668": (400, 300),
    "pimoroni.inky_what_black": (400, 300),
    "pimoroni.inky_what_red": (400, 300),
    "pimoroni.inky_what_red_ht": (400, 300),
    "pimoroni.inky_what_yellow": (400, 300),
    "pimoroni.inky_what_legacy_yellow": (400, 300),
    "pimoroni.inky_what_ssd1683": (400, 300),
    "pimoroni.inky_what_ssd1683_black": (400, 300),
    "pimoroni.inky_what_ssd1683_red": (400, 300),
    "pimoroni.inky_what_ssd1683_yellow": (400, 300),
    "pimoroni.hyperpixel2r": (480, 480),
    "pimoroni.hyperpixel2r_native": (480, 480),
}


def device_dimensions(device: str | None) -> tuple[int, int] | None:
    if not device:
        return None
    if device in NATIVE_DEVICE_DIMENSIONS:
        return NATIVE_DEVICE_DIMENSIONS[device]
    if device.startswith("waveshare."):
        variant = device.split(".", 1)[1]
        if variant == "epd7in5_V2":
            variant = "EPD_7in5_V2"
        elif variant == "epd2in13_V3":
            variant = "EPD_2in13_V3"
        try:
            source = convert_waveshare_source(variant)
        except Exception:
            return None
        if source.width and source.height:
            return (source.width, source.height)
    return None


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
        device_drivers = {"inkyHyperPixel2rLegacyFb": DRIVERS["inkyHyperPixel2rLegacyFb"]}
    elif device == "pimoroni.hyperpixel2r_native":
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
        if frame.device in {
            "pimoroni.inky_impression_13",
            "pimoroni.inky_impression_13_2025",
        }:
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
