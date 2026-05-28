from __future__ import annotations

from types import SimpleNamespace

from app.drivers.devices import drivers_for_frame
from app.drivers.waveshare import (
    BOOT_CONFIG_LINES_BY_VARIANT,
    BOOT_CONFIG_SPI_VARIANTS,
    get_variant_keys_for,
)


def frame(device: str, gpio_buttons: list[dict] | None = None) -> SimpleNamespace:
    return SimpleNamespace(device=device, gpio_buttons=gpio_buttons or [])


def test_web_only_frame_has_no_native_drivers():
    assert drivers_for_frame(frame("web_only")) == {}


def test_framebuffer_frame_uses_evdev_for_local_input():
    drivers = drivers_for_frame(frame("framebuffer"))

    assert "frameBuffer" in drivers
    assert "evdev" in drivers


def test_hyperpixel_round_uses_native_lgpio_driver_by_default():
    drivers = drivers_for_frame(frame("pimoroni.hyperpixel2r"))

    assert "inkyHyperPixel2r" in drivers
    assert "inkyHyperPixel2rLegacyFb" not in drivers
    assert "evdev" in drivers
    assert drivers["inkyHyperPixel2r"].vendor_folder is None
    assert drivers["inkyHyperPixel2r"].link_flags == ("-llgpio",)


def test_hyperpixel_round_legacy_fb_uses_vendor_driver():
    drivers = drivers_for_frame(frame("pimoroni.hyperpixel2r_legacy_fb"))

    assert "inkyHyperPixel2rLegacyFb" in drivers
    assert "inkyHyperPixel2r" not in drivers
    assert "evdev" in drivers
    assert drivers["inkyHyperPixel2rLegacyFb"].vendor_folder == "inkyHyperPixel2r"


def test_waveshare_epd10in3_uses_boot_config_without_generic_spi_setup():
    drivers = drivers_for_frame(frame("waveshare.EPD_10in3"))

    assert "waveshare" in drivers
    assert "bootconfig" in drivers
    assert "spi" not in drivers
    assert "noSpi" not in drivers
    assert drivers["bootconfig"].lines == ["dtoverlay=spi0-0cs", "#dtparam=spi=on"]


def test_native_inky_2025_frame_uses_nim_driver_and_gpio_buttons():
    test_frame = frame("pimoroni.inky_impression_4_2025")
    drivers = drivers_for_frame(test_frame)

    assert "inky" in drivers
    assert "inkyPython" not in drivers
    assert "spi" in drivers
    assert "gpioButton" in drivers
    assert drivers["bootconfig"].lines == ["dtoverlay=spi0-0cs"]
    assert test_frame.gpio_buttons == [
        {"pin": 5, "label": "A"},
        {"pin": 6, "label": "B"},
        {"pin": 16, "label": "C"},
        {"pin": 24, "label": "D"},
    ]


def test_native_inky_legacy_impression_uses_nim_driver_and_gpio_buttons():
    test_frame = frame("pimoroni.inky_impression_5_7")
    drivers = drivers_for_frame(test_frame)

    assert "inky" in drivers
    assert "inkyPython" not in drivers
    assert "gpioButton" in drivers
    assert test_frame.gpio_buttons == [
        {"pin": 5, "label": "A"},
        {"pin": 6, "label": "B"},
        {"pin": 16, "label": "C"},
        {"pin": 24, "label": "D"},
    ]


def test_native_inky_phat_uses_nim_driver_without_gpio_buttons():
    test_frame = frame("pimoroni.inky_phat_4")
    drivers = drivers_for_frame(test_frame)

    assert "inky" in drivers
    assert "inkyPython" not in drivers
    assert "spi" in drivers
    assert "bootconfig" in drivers
    assert "gpioButton" not in drivers
    assert "evdev" in drivers
    assert test_frame.gpio_buttons == []


def test_native_inky_what_yellow_uses_nim_driver_without_gpio_buttons():
    test_frame = frame("pimoroni.inky_what_yellow")
    drivers = drivers_for_frame(test_frame)

    assert "inky" in drivers
    assert "inkyPython" not in drivers
    assert "gpioButton" not in drivers
    assert "evdev" in drivers
    assert test_frame.gpio_buttons == []


def test_native_inky_tricolor_variants_use_nim_driver_without_gpio_buttons():
    for device in [
        "pimoroni.inky_phat_red",
        "pimoroni.inky_phat_ssd1608_yellow",
        "pimoroni.inky_what_ssd1683_black",
    ]:
        test_frame = frame(device)
        drivers = drivers_for_frame(test_frame)

        assert "inky" in drivers
        assert "inkyPython" not in drivers
        assert "gpioButton" not in drivers
        assert "evdev" in drivers
        assert test_frame.gpio_buttons == []


def test_native_inky_13_uses_its_button_c_pin():
    test_frame = frame("pimoroni.inky_impression_13")
    drivers = drivers_for_frame(test_frame)

    assert "inky" in drivers
    assert test_frame.gpio_buttons == [
        {"pin": 5, "label": "A"},
        {"pin": 6, "label": "B"},
        {"pin": 25, "label": "C"},
        {"pin": 24, "label": "D"},
    ]


def test_base_inky_impression_stays_on_python_driver():
    drivers = drivers_for_frame(frame("pimoroni.inky_impression"))

    assert "inkyPython" in drivers
    assert "inky" not in drivers
    assert "i2c" in drivers


def test_boot_config_spi_variants_match_it8951_variants():
    assert BOOT_CONFIG_SPI_VARIANTS == set(get_variant_keys_for("it8951"))

    for variant in BOOT_CONFIG_SPI_VARIANTS:
        assert BOOT_CONFIG_LINES_BY_VARIANT[variant] == [
            "dtoverlay=spi0-0cs",
            "#dtparam=spi=on",
        ]
