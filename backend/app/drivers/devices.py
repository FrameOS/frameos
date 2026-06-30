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

WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_DEVICE = "waveshare.rpi_zero_photopainter_7in3e"
WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_VARIANT = "EPD_7in3e"
WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_PINS = {
    "rst": 17,
    "dc": 25,
    "cs": 8,
    "busy": 24,
    "sclk": 11,
    "mosi": 10,
    "pwr": 27,
}
INKY_GPIO_BUTTONS = [
    {"pin": 5, "label": "A"},
    {"pin": 6, "label": "B"},
    {"pin": 16, "label": "C"},
    {"pin": 24, "label": "D"},
]
INKY_13_GPIO_BUTTONS = [
    {"pin": 5, "label": "A"},
    {"pin": 6, "label": "B"},
    {"pin": 25, "label": "C"},
    {"pin": 24, "label": "D"},
]
WAVESHARE_DEVICE_VARIANTS = {
    WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_DEVICE: WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_VARIANT,
}

WAVESHARE_DEVICE_PIN_DEFAULTS = {
    WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_DEVICE: WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_PINS,
}
DEVICE_GPIO_BUTTON_DEFAULTS = {
    **{
        device: INKY_13_GPIO_BUTTONS
        if device in {"pimoroni.inky_impression_13", "pimoroni.inky_impression_13_2025"}
        else INKY_GPIO_BUTTONS
        for device in INKY_BUTTON_DEVICES
    },
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


def waveshare_variant_for_device(device: str | None) -> str | None:
    if not device:
        return None
    if device in WAVESHARE_DEVICE_VARIANTS:
        return WAVESHARE_DEVICE_VARIANTS[device]
    if not device.startswith("waveshare."):
        return None
    variant = device.split(".", 1)[1]
    if variant == "epd7in5_V2":
        return "EPD_7in5_V2"
    if variant == "epd2in13_V3":
        return "EPD_2in13_V3"
    return variant


def _merged_pin_defaults(pins: dict | None, defaults: dict[str, int]) -> dict[str, int]:
    merged = dict(defaults)
    if isinstance(pins, dict):
        for key in defaults:
            if pins.get(key) is not None:
                merged[key] = pins[key]
        if pins.get("sck") is not None and pins.get("sclk") is None and "sclk" in defaults:
            merged["sclk"] = pins["sck"]
    return merged


def _remove_matching_pin_defaults(pins: dict | None, defaults: dict[str, int]) -> dict | None:
    if not isinstance(pins, dict):
        return pins
    remaining = dict(pins)
    for key, value in defaults.items():
        if remaining.get(key) == value:
            remaining.pop(key, None)
    if remaining.get("sck") == defaults.get("sclk"):
        remaining.pop("sck", None)
    return remaining or None


def device_config_with_defaults(
    device: str | None,
    device_config: dict | None,
    previous_device: str | None = None,
) -> dict:
    config = dict(device_config or {})
    pin_defaults = WAVESHARE_DEVICE_PIN_DEFAULTS.get(device or "")
    if pin_defaults is not None:
        config["pins"] = _merged_pin_defaults(config.get("pins"), pin_defaults)
        return config

    previous_pin_defaults = WAVESHARE_DEVICE_PIN_DEFAULTS.get(previous_device or "")
    if previous_pin_defaults is not None:
        remaining_pins = _remove_matching_pin_defaults(config.get("pins"), previous_pin_defaults)
        if remaining_pins:
            config["pins"] = remaining_pins
        else:
            config.pop("pins", None)
    return config


def device_gpio_button_defaults(device: str | None) -> list[dict] | None:
    defaults = DEVICE_GPIO_BUTTON_DEFAULTS.get(device or "")
    return [dict(button) for button in defaults] if defaults is not None else None


def _normalized_gpio_buttons(buttons: list[dict] | None) -> list[dict]:
    normalized: list[dict] = []
    for button in buttons or []:
        if not isinstance(button, dict):
            continue
        try:
            pin = int(button.get("pin"))
        except (TypeError, ValueError):
            continue
        normalized.append({"pin": pin, "label": str(button.get("label") or f"Pin {pin}")})
    return normalized


def apply_device_gpio_button_defaults(frame: Frame, previous_device: str | None = None) -> None:
    defaults = device_gpio_button_defaults(frame.device)
    if defaults is not None:
        frame.gpio_buttons = defaults
        return

    previous_defaults = device_gpio_button_defaults(previous_device)
    if previous_defaults is not None and _normalized_gpio_buttons(frame.gpio_buttons) == previous_defaults:
        frame.gpio_buttons = None


def apply_device_config_defaults(frame: Frame, previous_device: str | None = None) -> None:
    config = device_config_with_defaults(frame.device, frame.device_config, previous_device)
    if config or isinstance(frame.device_config, dict):
        frame.device_config = config


def device_dimensions(device: str | None) -> tuple[int, int] | None:
    if not device:
        return None
    if device in NATIVE_DEVICE_DIMENSIONS:
        return NATIVE_DEVICE_DIMENSIONS[device]
    variant = waveshare_variant_for_device(device)
    if variant:
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
        apply_device_config_defaults(frame)
        waveshare = replace(DRIVERS["waveshare"])
        waveshare.variant = waveshare_variant_for_device(device)
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
            device_drivers["bootconfig"] = replace(DRIVERS["bootConfig"], lines=list(boot_config_lines))

    # Enable evdev for devices that can have local input attached.
    if device not in INKY_BUTTON_DEVICES and not device.startswith("waveshare.") and device not in VIRTUAL_OUTPUT_DEVICES:
        device_drivers["evdev"] = DRIVERS["evdev"]

    default_gpio_buttons = device_gpio_button_defaults(frame.device)
    if default_gpio_buttons is not None:
        frame.gpio_buttons = default_gpio_buttons

    if frame.device in INKY_BUTTON_DEVICES:
        if "bootconfig" not in device_drivers:
            device_drivers["bootconfig"] = replace(DRIVERS["bootConfig"], lines=["dtoverlay=spi0-0cs"])

    if "gpioButton" not in device_drivers and len(frame.gpio_buttons or []) > 0:
        device_drivers["gpioButton"] = DRIVERS["gpioButton"]

    return device_drivers
