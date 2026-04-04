from app.codegen.drivers_nim import write_driver_plugin_nim, write_drivers_nim
from app.drivers.drivers import Driver


def test_write_driver_plugin_nim_exports_runtime_channel_binder():
    source = write_driver_plugin_nim(
        Driver(
            name="evdev",
            import_path="evdev/evdev",
        )
    )

    assert "import frameos/channels" in source
    assert "proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks)" in source
    assert "bindCompiledRuntimeHooks(hooks)" in source
    assert 'import drivers/evdev/evdev as compiled_evdev_driver' in source
    assert "proc setupDriver(frameConfig: FrameConfig): DriverSetupSpec" in source
    assert "setup: setupDriver" in source


def test_write_plugin_drivers_nim_exposes_empty_builtin_setup_registry():
    source = write_drivers_nim({}, use_compiled_plugins=True)

    assert "proc builtinDriverSetupSpecs*(_: FrameConfig): seq[tuple[id: string, spec: DriverSetupSpec]]" in source
    assert "result = @[]" in source


def test_write_driver_plugin_nim_exports_preview_boundary():
    source = write_driver_plugin_nim(
        Driver(
            name="waveshare",
            import_path="waveshare/waveshare",
            can_render=True,
            can_preview=True,
        )
    )

    assert "proc previewDriver(self: FrameOSDriver): DriverPreviewArtifact" in source
    assert "return compiled_waveshare_driver.getPreview(cast[compiled_waveshare_driver.Driver](self))" in source
    assert "canPreview: true" in source
    assert "preview: previewDriver" in source


def test_write_drivers_nim_supports_builtin_driver_mode():
    source = write_drivers_nim(
        {
            "waveshare": Driver(
                name="waveshare",
                import_path="waveshare/waveshare",
                can_render=True,
                can_preview=True,
                can_turn_on_off=True,
            )
        },
        use_compiled_plugins=False,
    )

    assert "import drivers/waveshare/waveshare as waveshareDriver" in source
    assert "import drivers/plugin_runtime" in source
    assert "proc builtinDriverSetupSpecs*(frameConfig: FrameConfig)" in source
    assert "let spec = waveshareDriver.setup(frameConfig)" in source
    assert 'result.add(("waveshare", spec))' in source
    assert "initCompiledDrivers" not in source
    assert "previewArtifactToImage(preview)" in source
    assert "waveshareDriverInstance.turnOn()" in source
