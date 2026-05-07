from __future__ import annotations

from types import SimpleNamespace

from app.drivers.devices import drivers_for_frame


def frame(device: str, gpio_buttons: list[dict] | None = None) -> SimpleNamespace:
    return SimpleNamespace(device=device, gpio_buttons=gpio_buttons or [])


def test_web_only_frame_has_no_native_drivers():
    assert drivers_for_frame(frame("web_only")) == {}


def test_framebuffer_frame_uses_evdev_for_local_input():
    drivers = drivers_for_frame(frame("framebuffer"))

    assert "frameBuffer" in drivers
    assert "evdev" in drivers


def test_waveshare_epd10in3_uses_boot_config_without_generic_spi_setup():
    drivers = drivers_for_frame(frame("waveshare.EPD_10in3"))

    assert "waveshare" in drivers
    assert "bootconfig" in drivers
    assert "spi" not in drivers
    assert "noSpi" not in drivers
