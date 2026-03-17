from app.codegen.drivers_nim import write_driver_plugin_nim
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
    assert "proc deviceInitDriver(frameConfig: FrameConfig): DriverInitSpec" in source
    assert "deviceInit: deviceInitDriver" in source


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
