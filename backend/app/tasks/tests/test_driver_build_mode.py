from __future__ import annotations

from types import SimpleNamespace

from app.codegen.drivers_nim import (
    DRIVER_BUILD_MODE_SHARED,
    DRIVER_BUILD_MODE_STATIC,
    frame_driver_build_mode,
    normalize_driver_build_mode,
)


def test_driver_build_mode_defaults_to_shared():
    assert normalize_driver_build_mode(None) == DRIVER_BUILD_MODE_SHARED
    assert normalize_driver_build_mode("") == DRIVER_BUILD_MODE_SHARED
    assert normalize_driver_build_mode("unexpected") == DRIVER_BUILD_MODE_SHARED
    assert frame_driver_build_mode(SimpleNamespace(rpios=None)) == DRIVER_BUILD_MODE_SHARED
    assert frame_driver_build_mode(SimpleNamespace(rpios={})) == DRIVER_BUILD_MODE_SHARED


def test_driver_build_mode_static_requires_explicit_setting():
    assert normalize_driver_build_mode("static") == DRIVER_BUILD_MODE_STATIC
    assert frame_driver_build_mode(SimpleNamespace(rpios={"driverBuildMode": "static"})) == DRIVER_BUILD_MODE_STATIC
