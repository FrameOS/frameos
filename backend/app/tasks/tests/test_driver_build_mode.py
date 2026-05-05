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
    write_driver_library_nim,
    write_shared_drivers_nim,
    write_static_drivers_nim,
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


def test_shared_drivers_run_compiled_driver_setup_from_library():
    source = write_shared_drivers_nim(
        {
            "inkyPython": Driver(
                name="inkyPython",
                import_path="inkyPython/inkyPython",
                setup_import_path="inkyPython/inkyPython",
                can_render=True,
            ),
            "i2c": Driver(name="i2c", setup_import_path="i2c/i2c"),
        }
    )

    assert 'canSetup: true, canRender: true' in source
    assert '"frameos_driver_setup"' in source
    assert "proc setupSharedDriver(spec: DriverSpec, driverCtx: driverContext.DriverContext): SetupResult" in source
    assert "setupProc(cast[pointer](driverCtx))" in source
    assert "import inkyPython/inkyPython as inkyPythonSetupDriver" not in source
    assert "import i2c/i2c as i2cSetupDriver" in source
    assert 'runSetupStep("i2c"' in source


def test_driver_library_exports_setup_symbol_when_driver_has_setup():
    source = write_driver_library_nim(
        Driver(
            name="inkyPython",
            import_path="inkyPython/inkyPython",
            setup_import_path="inkyPython/inkyPython",
            can_render=True,
        )
    )

    assert "proc frameos_driver_setup*(driverContextPtr: pointer): bool" in source
    assert "discard driverContextPtr" in source
    assert "inkyPythonDriver.setup().rebootRequired" in source


def test_driver_library_can_pass_context_to_setup_symbol():
    source = write_driver_library_nim(
        Driver(
            name="inkyPython",
            import_path="inkyPython/inkyPython",
            setup_import_path="inkyPython/inkyPython",
            setup_accepts_context=True,
            can_render=True,
        )
    )

    assert "proc frameos_driver_setup*(driverContextPtr: pointer): bool" in source
    assert "driverContextInstance = cloneDriverContext(hostContext)" in source
    assert "inkyPythonDriver.setup(driverContextInstance).rebootRequired" in source
    assert "syncHostDriverContext(hostContext, driverContextInstance)" in source


def test_static_drivers_setup_uses_generated_driver_list():
    source = write_static_drivers_nim(
        {
            "inkyPython": Driver(
                name="inkyPython",
                import_path="inkyPython/inkyPython",
                setup_import_path="inkyPython/inkyPython",
                can_render=True,
            ),
            "i2c": Driver(name="i2c", setup_import_path="i2c/i2c"),
            "bootconfig": Driver(name="bootConfig", lines=["dtoverlay=spi0-0cs", "#dtparam=spi=on"]),
        }
    )

    assert "proc setup*(frameOS: FrameOS): SetupResult" in source
    assert 'runSetupStep("inkyPython"' in source
    assert 'runSetupStep("i2c"' in source
    assert 'setupBootConfig(@["dtoverlay=spi0-0cs", "#dtparam=spi=on"])' in source
