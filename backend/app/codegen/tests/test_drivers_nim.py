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
