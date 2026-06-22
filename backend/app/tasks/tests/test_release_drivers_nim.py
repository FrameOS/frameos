from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from app.codegen.drivers_nim import driver_library_filename, write_driver_library_nim
from app.codegen.release_drivers_nim import (
    release_driver_specs,
    write_release_shared_drivers_nim,
    write_release_waveshare_driver_modules,
)
from app.drivers.drivers import DRIVERS
from app.drivers.waveshare import write_waveshare_driver_nim


def test_release_driver_specs_include_base_drivers_and_waveshare_variants():
    drivers = release_driver_specs()

    assert "frameBuffer" in drivers
    assert "evdev" in drivers
    assert "gpioButton" in drivers
    assert "inky" in drivers
    assert drivers["inky"].can_png is True
    assert "inkyHyperPixel2r" in drivers
    assert "inkyHyperPixel2rLegacyFb" in drivers
    assert "inkyPython" in drivers
    assert drivers["inkyPython"].can_png is True
    assert "waveshare_EPD_7in3e" in drivers
    assert drivers["waveshare_EPD_7in3e"].variant == "EPD_7in3e"
    assert drivers["waveshare_EPD_7in3e"].import_path == "waveshare/waveshare_EPD_7in3e"
    assert drivers["waveshare_EPD_7in3e"].setup_import_path == "waveshare/waveshare_EPD_7in3e"
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
    assert "proc isNativeInkyDevice(device: string): bool" in source
    assert '"pimoroni.inky_impression_5_7"' in source
    assert '"pimoroni.inky_phat_4"' in source
    assert '"pimoroni.inky_phat_red"' in source
    assert '"pimoroni.inky_phat_ssd1608_yellow"' in source
    assert '"pimoroni.inky_what_4"' in source
    assert '"pimoroni.inky_what_red_ht"' in source
    assert '"pimoroni.inky_what_yellow"' in source
    assert '"pimoroni.inky_what_ssd1683_red"' in source
    assert '"pimoroni.inky_what_ssd1683_yellow"' in source
    assert 'of "inkyHyperPixel2r":' in source
    assert 'device == "pimoroni.hyperpixel2r_native"' in source
    assert 'of "inkyHyperPixel2rLegacyFb":' in source
    assert 'device == "pimoroni.hyperpixel2r"' in source
    assert 'of "inky":' in source
    assert "proc evdevEnabledDevice(device: string): bool" in source
    assert 'device != "web_only"' in source
    assert 'not isInkyButtonDevice(device)' in source
    assert 'libraryName: "waveshare_EPD_7in3e.so"' in source
    assert '"frameos_driver_setup"' in source
    assert "proc setupSharedDriver(spec: DriverSpec, driverCtx: driverContext.DriverContext): SetupResult" in source
    assert 'setupLog("FrameOS setup: shared driver " & spec.name & ": loading " & path)' in source
    assert "setupLibraries.add(library)" in source
    assert "finally:\n    unloadLib(library)" not in source
    assert source.index("proc setupLocalDrivers(frameOS: FrameOS): SetupResult") < source.index(
        "proc setup*(frameOS: FrameOS): SetupResult"
    )
    assert "import inkyPython/inkyPython as inkyPythonSetupDriver" not in source
    assert "import inkyHyperPixel2r/inkyHyperPixel2r as inkyHyperPixel2rSetupDriver" not in source
    assert "proc setupReleaseDriverSupport" not in source
    assert "import i2c/i2c as i2cSetupDriver" not in source
    assert "import spi/spi as spiSetupDriver" not in source
    assert "import noSpi/noSpi as noSpiSetupDriver" not in source


def test_release_driver_library_setup_gets_frame_context_for_inky_support():
    source = write_driver_library_nim(release_driver_specs()["inkyPython"])

    assert "proc frameos_driver_setup*(driverContextPtr: pointer): bool" in source
    assert "driverContextInstance = cloneDriverContext(hostContext)" in source
    assert "inkyPythonDriver.setup(driverContextInstance).rebootRequired" in source


def test_release_waveshare_variant_setup_lives_in_generated_driver():
    epd10in3 = replace(DRIVERS["waveshare"], variant="EPD_10in3")
    epd13in3e = replace(DRIVERS["waveshare"], variant="EPD_13in3e")

    epd10_source = write_waveshare_driver_nim({"waveshare": epd10in3})
    epd13_source = write_waveshare_driver_nim({"waveshare": epd13in3e})

    assert 'runSetupStep("spi", proc(): SetupResult = spiSetupDriver.setup())' not in epd10_source
    assert 'setupBootConfig(@["dtoverlay=spi0-0cs", "#dtparam=spi=on"])' in epd10_source
    assert 'runSetupStep("noSpi", proc(): SetupResult = noSpiSetupDriver.setup())' in epd13_source
    assert 'setupBootConfig(@["gpio=7=op,dl", "gpio=8=op,dl"])' in epd13_source


def test_waveshare_epd13in3b_generates_partial_refresh_hooks():
    epd13in3b = replace(DRIVERS["waveshare"], variant="EPD_13in3b")

    source = write_waveshare_driver_nim({"waveshare": epd13in3b})

    assert "let supportsPartialRefresh* = true" in source
    assert "EPD_13IN3B_Display_Base(addr image1[0], addr image2[0])" in source
    assert "EPD_13IN3B_Display_PartialBase(addr image[0])" in source
    assert (
        "EPD_13IN3B_Display_Partial(addr image[0], "
        "xStart.uint16, yStart.uint16, xEnd.uint16, yEnd.uint16)"
        in source
    )


def test_waveshare_epd7in5v2_generates_partial_refresh_hooks():
    epd7in5v2 = replace(DRIVERS["waveshare"], variant="EPD_7in5_V2")

    source = write_waveshare_driver_nim({"waveshare": epd7in5v2})

    assert "let supportsPartialRefresh* = true" in source
    assert "EPD_7IN5_V2_Init_Partial()" in source
    assert "EPD_7IN5_V2_Display_PartialBase(addr image[0])" in source
    assert (
        "EPD_7IN5_V2_Display_Partial(addr image[0], "
        "xStart.uint32, yStart.uint32, xEnd.uint32, yEnd.uint32)"
        in source
    )


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
