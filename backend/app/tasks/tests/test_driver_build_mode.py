from __future__ import annotations

from types import SimpleNamespace

from app.codegen.drivers_nim import (
    DRIVER_BUILD_MODE_PRECOMPILED,
    DRIVER_BUILD_MODE_SHARED,
    DRIVER_BUILD_MODE_STATIC,
    driver_build_mode_uses_shared_libraries,
    driver_library_filename,
    frame_driver_build_mode,
    normalize_driver_build_mode,
    write_shared_drivers_nim,
)
from app.drivers.drivers import Driver


def test_driver_build_mode_defaults_to_static():
    assert normalize_driver_build_mode(None) == DRIVER_BUILD_MODE_STATIC
    assert normalize_driver_build_mode("") == DRIVER_BUILD_MODE_STATIC
    assert normalize_driver_build_mode("unexpected") == DRIVER_BUILD_MODE_STATIC
    assert frame_driver_build_mode(SimpleNamespace(rpios=None)) == DRIVER_BUILD_MODE_STATIC
    assert frame_driver_build_mode(SimpleNamespace(rpios={})) == DRIVER_BUILD_MODE_STATIC


def test_driver_build_mode_shared_requires_explicit_setting():
    assert normalize_driver_build_mode("shared") == DRIVER_BUILD_MODE_SHARED
    assert frame_driver_build_mode(SimpleNamespace(rpios={"driverBuildMode": "shared"})) == DRIVER_BUILD_MODE_SHARED


def test_driver_build_mode_static_is_valid():
    assert normalize_driver_build_mode("static") == DRIVER_BUILD_MODE_STATIC
    assert frame_driver_build_mode(SimpleNamespace(rpios={"driverBuildMode": "static"})) == DRIVER_BUILD_MODE_STATIC


def test_driver_build_mode_precompiled_uses_shared_libraries():
    assert normalize_driver_build_mode("precompiled") == DRIVER_BUILD_MODE_PRECOMPILED
    assert frame_driver_build_mode(SimpleNamespace(rpios={"driverBuildMode": "precompiled"})) == DRIVER_BUILD_MODE_PRECOMPILED
    assert driver_build_mode_uses_shared_libraries("precompiled") is True
    assert driver_build_mode_uses_shared_libraries("shared") is True
    assert driver_build_mode_uses_shared_libraries("static") is False


def test_waveshare_driver_library_filename_includes_variant():
    waveshare = Driver(name="waveshare", variant="EPD_7in3e", import_path="waveshare/waveshare")

    assert driver_library_filename(waveshare) == "waveshare_EPD_7in3e.so"
    assert 'libraryName: "waveshare_EPD_7in3e.so"' in write_shared_drivers_nim({"waveshare": waveshare})
    assert driver_library_filename(Driver(name="frameBuffer")) == "frameBuffer.so"


def test_shared_driver_registry_types_empty_sequence():
    source = write_shared_drivers_nim({})

    assert "let driverSpecs: seq[DriverSpec] = @[]" in source
