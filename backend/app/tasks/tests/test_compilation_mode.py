from __future__ import annotations

from types import SimpleNamespace

from app.codegen.drivers_nim import (
    COMPILATION_MODE_PRECOMPILED,
    COMPILATION_MODE_SHARED,
    COMPILATION_MODE_SHARED_SCENES,
    COMPILATION_MODE_STATIC,
    compilation_mode_uses_shared_drivers,
    compilation_mode_uses_shared_libraries,
    driver_library_filename,
    frame_compilation_mode,
    normalize_compilation_mode,
    write_driver_library_nim,
    write_shared_drivers_nim,
    write_static_drivers_nim,
)
from app.drivers.drivers import Driver


def test_compilation_mode_defaults_to_precompiled():
    assert normalize_compilation_mode(None) == COMPILATION_MODE_PRECOMPILED
    assert normalize_compilation_mode("") == COMPILATION_MODE_PRECOMPILED
    assert normalize_compilation_mode("unexpected") == COMPILATION_MODE_PRECOMPILED
    assert frame_compilation_mode(SimpleNamespace(rpios=None)) == COMPILATION_MODE_PRECOMPILED
    assert frame_compilation_mode(SimpleNamespace(rpios={})) == COMPILATION_MODE_PRECOMPILED


def test_compilation_mode_shared_requires_explicit_setting():
    assert normalize_compilation_mode("shared") == COMPILATION_MODE_SHARED
    assert frame_compilation_mode(SimpleNamespace(rpios={"compilationMode": "shared"})) == COMPILATION_MODE_SHARED
    assert normalize_compilation_mode("shared-scenes") == COMPILATION_MODE_SHARED_SCENES
    assert frame_compilation_mode(SimpleNamespace(rpios={"compilationMode": "shared-scenes"})) == COMPILATION_MODE_SHARED_SCENES


def test_compilation_mode_static_is_valid():
    assert normalize_compilation_mode("static") == COMPILATION_MODE_STATIC
    assert frame_compilation_mode(SimpleNamespace(rpios={"compilationMode": "static"})) == COMPILATION_MODE_STATIC


def test_buildroot_compilation_mode_uses_buildroot_settings():
    assert (
        frame_compilation_mode(
            SimpleNamespace(
                mode="buildroot",
                buildroot={"compilationMode": "static"},
                rpios={"compilationMode": "precompiled"},
            )
        )
        == COMPILATION_MODE_STATIC
    )


def test_compilation_mode_precompiled_uses_shared_libraries():
    assert normalize_compilation_mode("precompiled") == COMPILATION_MODE_PRECOMPILED
    assert frame_compilation_mode(SimpleNamespace(rpios={"compilationMode": "precompiled"})) == COMPILATION_MODE_PRECOMPILED
    assert compilation_mode_uses_shared_libraries("precompiled") is True
    assert compilation_mode_uses_shared_libraries("shared") is True
    assert compilation_mode_uses_shared_libraries("shared-scenes") is True
    assert compilation_mode_uses_shared_libraries("static") is False
    assert compilation_mode_uses_shared_drivers("precompiled") is True
    assert compilation_mode_uses_shared_drivers("shared") is True
    assert compilation_mode_uses_shared_drivers("shared-scenes") is False
    assert compilation_mode_uses_shared_drivers("static") is False


def test_waveshare_driver_library_filename_includes_variant():
    waveshare = Driver(name="waveshare", variant="EPD_7in3e", import_path="waveshare/waveshare")

    assert driver_library_filename(waveshare) == "waveshare_EPD_7in3e.so"
    assert 'libraryName: "waveshare_EPD_7in3e.so"' in write_shared_drivers_nim({"waveshare": waveshare})
    assert driver_library_filename(Driver(name="frameBuffer")) == "frameBuffer.so"


def test_shared_driver_registry_types_empty_sequence():
    source = write_shared_drivers_nim({})

    assert "let driverSpecs: seq[DriverSpec] = @[]" in source
    assert "proc availableDriverNames*(): seq[string]" in source


def test_generated_driver_context_copies_pin_overrides():
    source = write_static_drivers_nim({})

    assert "pins: driverContext.PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1)" in source
    assert "deviceConfig.pins = driverContext.PinOverrides(" in source
    assert "sclk: sourceDeviceConfig.pins.sclk" in source

    library_source = write_driver_library_nim(Driver(name="frameBuffer", import_path="frameBuffer/frameBuffer"))
    assert "pins: PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1)" in library_source
    assert "deviceConfig.pins = PinOverrides(" in library_source


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
    assert 'setupLog("FrameOS setup: shared driver " & spec.name & ": loading " & path)' in source
    assert "setupProc(cast[pointer](driverCtx))" in source
    assert "setupLibraries.add(library)" in source
    assert "finally:\n    unloadLib(library)" not in source
    assert "import inkyPython/inkyPython as inkyPythonSetupDriver" not in source
    assert "import i2c/i2c as i2cSetupDriver" in source
    assert 'runSetupStep("i2c"' in source
    assert "proc availableDriverNames*(): seq[string]" in source
    assert '"inkyPython"' in source
    assert '"i2c"' in source


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
    assert ".setup(driverCtx)" in source
    assert "syncDriverContext(frameOS, driverCtx)" in source
    assert 'setupBootConfig(@["dtoverlay=spi0-0cs", "#dtparam=spi=on"])' in source
    assert "proc availableDriverNames*(): seq[string]" in source
    assert '"inkyPython"' in source
    assert '"i2c"' in source
