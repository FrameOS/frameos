from __future__ import annotations

from pathlib import Path

from app.codegen.drivers_nim import driver_library_filename
from app.codegen.release_drivers_nim import (
    release_driver_specs,
    write_release_shared_drivers_nim,
    write_release_waveshare_driver_modules,
)


def test_release_driver_specs_include_base_drivers_and_waveshare_variants():
    drivers = release_driver_specs()

    assert "frameBuffer" in drivers
    assert "evdev" in drivers
    assert "gpioButton" in drivers
    assert "inkyPython" in drivers
    assert drivers["inkyPython"].can_png is True
    assert "waveshare_EPD_7in3e" in drivers
    assert drivers["waveshare_EPD_7in3e"].variant == "EPD_7in3e"
    assert drivers["waveshare_EPD_7in3e"].import_path == "waveshare/waveshare_EPD_7in3e"
    assert (
        driver_library_filename(drivers["waveshare_EPD_7in3e"])
        == "waveshare_EPD_7in3e.so"
    )


def test_release_shared_registry_filters_drivers_at_runtime():
    source = write_release_shared_drivers_nim(release_driver_specs())

    assert "proc shouldLoadDriver(spec: DriverSpec, frameOS: FrameOS): bool" in source
    assert 'return spec.name == ("waveshare_" & normalizedWaveshareVariant(device))' in source
    assert 'device == "framebuffer"' in source
    assert 'frameOS.frameConfig.gpioButtons.len > 0' in source
    assert "proc evdevEnabledDevice(device: string): bool" in source
    assert 'not isInkyButtonDevice(device)' in source
    assert 'libraryName: "waveshare_EPD_7in3e.so"' in source


def test_release_waveshare_modules_are_variant_specific(tmp_path: Path):
    frameos_root = tmp_path / "frameos"
    waveshare_root = frameos_root / "src" / "drivers" / "waveshare"
    waveshare_root.mkdir(parents=True)
    (waveshare_root / "waveshare.nim").write_text(
        "import drivers/waveshare/driver as waveshareDriver\n"
        "export waveshareDriver\n",
        encoding="utf-8",
    )
    drivers = {"waveshare_EPD_7in3e": release_driver_specs()["waveshare_EPD_7in3e"]}

    write_release_waveshare_driver_modules(frameos_root, drivers)

    assert (waveshare_root / "driver_EPD_7in3e.nim").exists()
    wrapper = (waveshare_root / "waveshare_EPD_7in3e.nim").read_text(encoding="utf-8")
    assert "import drivers/waveshare/driver_EPD_7in3e as waveshareDriver" in wrapper
