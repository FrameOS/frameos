from __future__ import annotations

from types import SimpleNamespace

from app.drivers.drivers import DRIVERS
from app.drivers.devices import (
    WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_DEVICE,
    WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_PINS,
    device_config_with_defaults,
    device_dimensions,
    drivers_for_frame,
)
from app.drivers.waveshare import (
    BOOT_CONFIG_LINES_BY_VARIANT,
    BOOT_CONFIG_SPI_VARIANTS,
    get_variant_keys_for,
)


def frame(
    device: str,
    gpio_buttons: list[dict] | None = None,
    device_config: dict | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(device=device, gpio_buttons=gpio_buttons or [], device_config=device_config)


def test_web_only_frame_has_no_native_drivers():
    assert drivers_for_frame(frame("web_only")) == {}


def test_framebuffer_frame_uses_evdev_for_local_input():
    drivers = drivers_for_frame(frame("framebuffer"))

    assert "frameBuffer" in drivers
    assert "evdev" in drivers


def test_hyperpixel_round_uses_the_native_gpio_driver():
    """One driver for the panel since 2026-09-12: DPI block in config.txt,
    ST7701 init and backlight over GPIO. Nothing to vendor or link."""
    drivers = drivers_for_frame(frame("pimoroni.hyperpixel2r"))

    assert "inkyHyperPixel2r" in drivers
    assert "evdev" in drivers
    assert drivers["inkyHyperPixel2r"].vendor_folder is None
    assert drivers["inkyHyperPixel2r"].link_flags == ()
    # The retired "(native)" id and the legacy fb driver are gone, not aliased.
    assert "inkyHyperPixel2r" not in drivers_for_frame(frame("pimoroni.hyperpixel2r_native"))
    assert not any("LegacyFb" in name for name in DRIVERS)


def test_hyperpixel4_panels_share_one_native_driver_with_or_without_touch():
    """The 4.0 and the 4.0 Square, each sold with and without a touchscreen:
    one driver picks the panel (and whether to install the touch overlay) from
    the device id. Touch is the kernel's driver read through evdev, so the
    touch ids need nothing the plain ones do not."""
    expected = {
        "pimoroni.hyperpixel4": (480, 800),
        "pimoroni.hyperpixel4_touch": (480, 800),
        "pimoroni.hyperpixel4sq": (720, 720),
        "pimoroni.hyperpixel4sq_touch": (720, 720),
    }
    for device, dimensions in expected.items():
        drivers = drivers_for_frame(frame(device))

        assert set(drivers) == {"hyperPixel4", "evdev"}, device
        assert drivers["hyperPixel4"].setup_import_path == "hyperPixel4/hyperPixel4"
        assert drivers["hyperPixel4"].can_turn_on_off is True
        assert drivers["hyperPixel4"].vendor_folder is None
        assert device_dimensions(device) == dimensions
    # The Round keeps its own driver: a different controller on different pins.
    assert "hyperPixel4" not in drivers_for_frame(frame("pimoroni.hyperpixel2r"))


def test_waveshare_epd10in3_uses_boot_config_without_generic_spi_setup():
    drivers = drivers_for_frame(frame("waveshare.EPD_10in3"))

    assert "waveshare" in drivers
    assert "bootconfig" in drivers
    assert "spi" not in drivers
    assert "noSpi" not in drivers
    assert drivers["bootconfig"].lines == ["dtoverlay=spi0-0cs", "#dtparam=spi=on"]


def test_waveshare_rpi_zero_photopainter_uses_7in3e_driver_and_pin_defaults():
    test_frame = frame(WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_DEVICE)

    drivers = drivers_for_frame(test_frame)

    assert device_dimensions(WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_DEVICE) == (800, 480)
    assert "waveshare" in drivers
    assert "spi" in drivers
    assert "evdev" not in drivers
    assert "gpioButton" not in drivers
    assert drivers["waveshare"].variant == "EPD_7in3e"
    assert test_frame.device_config == {"pins": WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_PINS}


def test_waveshare_rpi_zero_photopainter_preserves_explicit_pin_overrides():
    test_frame = frame(
        WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_DEVICE,
        device_config={"pins": {"pwr": 18, "sck": 9}},
    )

    drivers_for_frame(test_frame)

    assert test_frame.device_config["pins"] == {
        **WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_PINS,
        "pwr": 18,
        "sclk": 9,
    }


def test_waveshare_rpi_zero_photopainter_defaults_are_removed_when_switching_away():
    assert device_config_with_defaults(
        "waveshare.EPD_7in3e",
        {"pins": dict(WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_PINS)},
        previous_device=WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_DEVICE,
    ) == {}


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


def test_boot_config_spi_variants_enable_spi0_without_kernel_chip_selects():
    assert BOOT_CONFIG_SPI_VARIANTS == set(get_variant_keys_for("it8951")) | {"EPD_13in3e"}

    for variant in BOOT_CONFIG_SPI_VARIANTS:
        assert BOOT_CONFIG_LINES_BY_VARIANT[variant][:2] == [
            "dtoverlay=spi0-0cs",
            "#dtparam=spi=on",
        ]
