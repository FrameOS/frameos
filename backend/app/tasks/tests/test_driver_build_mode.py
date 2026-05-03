from __future__ import annotations

from types import SimpleNamespace

from app.codegen.drivers_nim import (
    DRIVER_BUILD_MODE_SHARED,
    DRIVER_BUILD_MODE_STATIC,
    driver_library_filename,
    frame_driver_build_mode,
    normalize_driver_build_mode,
    write_shared_drivers_nim,
)
from app.drivers.drivers import Driver


def test_driver_build_mode_defaults_to_shared():
    assert normalize_driver_build_mode(None) == DRIVER_BUILD_MODE_SHARED
    assert normalize_driver_build_mode("") == DRIVER_BUILD_MODE_SHARED
    assert normalize_driver_build_mode("unexpected") == DRIVER_BUILD_MODE_SHARED
    assert frame_driver_build_mode(SimpleNamespace(rpios=None)) == DRIVER_BUILD_MODE_SHARED
    assert frame_driver_build_mode(SimpleNamespace(rpios={})) == DRIVER_BUILD_MODE_SHARED


def test_driver_build_mode_static_requires_explicit_setting():
    assert normalize_driver_build_mode("static") == DRIVER_BUILD_MODE_STATIC
    assert frame_driver_build_mode(SimpleNamespace(rpios={"driverBuildMode": "static"})) == DRIVER_BUILD_MODE_STATIC


def test_waveshare_driver_library_filename_includes_variant():
    waveshare = Driver(name="waveshare", variant="EPD_7in3e", import_path="waveshare/waveshare")

    assert driver_library_filename(waveshare) == "libframeos_driver_waveshare_EPD_7in3e.so"
    assert 'libraryName: "libframeos_driver_waveshare_EPD_7in3e.so"' in write_shared_drivers_nim({"waveshare": waveshare})
    assert driver_library_filename(Driver(name="frameBuffer")) == "libframeos_driver_frameBuffer.so"
