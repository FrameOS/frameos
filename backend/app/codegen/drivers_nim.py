import re

from app.codegen.utils import sanitize_nim_string
from app.drivers.drivers import Driver


def driver_compile_id(driver: Driver) -> str:
    if driver.variant:
        return f"{driver.name}/{driver.variant}"
    return driver.name


def driver_file_stem(driver_id: str) -> str:
    stem = re.sub(r"[^a-zA-Z0-9_-]+", "_", driver_id or "driver").strip("_")
    return stem or "driver"


def driver_module_name_from_id(driver_id: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_]+", "_", driver_file_stem(driver_id))


def driver_module_name(driver: Driver) -> str:
    return driver_module_name_from_id(driver_compile_id(driver))


def driver_library_filename_from_id(driver_id: str) -> str:
    return f"{driver_module_name_from_id(driver_id)}.so"


def driver_library_filename(driver: Driver) -> str:
    return driver_library_filename_from_id(driver_compile_id(driver))


def loadable_drivers(drivers: dict[str, Driver]) -> list[Driver]:
    return [driver for driver in drivers.values() if driver.import_path]


def write_driver_plugin_nim(driver: Driver) -> str:
    if not driver.import_path:
        raise ValueError(f"Driver {driver.name} does not have a runtime import path")

    plugin_id = driver_compile_id(driver)
    variant = driver.variant or ""
    alias = f"compiled_{driver_module_name(driver)}_driver"

    render_proc = "nil"
    if driver.can_render:
        render_proc = f"""
proc renderDriver(self: FrameOSDriver, image: Image) =
  if self.isNil:
    return
  {alias}.render(cast[{alias}.Driver](self), image)
""".strip()

    preview_proc = "nil"
    if driver.can_preview:
        preview_proc = f"""
proc previewDriver(self: FrameOSDriver): DriverPreviewArtifact =
  if self.isNil:
    return nil
  return {alias}.getPreview(cast[{alias}.Driver](self))
""".strip()

    power_procs = ""
    turn_on_ref = "nil"
    turn_off_ref = "nil"
    if driver.can_turn_on_off:
        power_procs = f"""
proc turnOnDriver(self: FrameOSDriver) =
  if self.isNil:
    return
  {alias}.turnOn(cast[{alias}.Driver](self))

proc turnOffDriver(self: FrameOSDriver) =
  if self.isNil:
    return
  {alias}.turnOff(cast[{alias}.Driver](self))
""".strip()
        turn_on_ref = "turnOnDriver"
        turn_off_ref = "turnOffDriver"

    setup_proc = """
proc setupDriver(frameConfig: FrameConfig): DriverSetupSpec =
  when compiles({alias}.setup(frameConfig)):
    return {alias}.setup(frameConfig)
  else:
    return nil
""".strip().format(alias=alias)

    blocks = [
        "import pixie",
        "import frameos/channels",
        "import frameos/types",
        f"import drivers/{driver.import_path} as {alias}",
        "",
        "proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =",
        "  bindCompiledRuntimeHooks(hooks)",
        "",
        "proc initDriver(frameOS: FrameOS): FrameOSDriver =",
        f"  {alias}.init(frameOS)",
        "",
        setup_proc,
    ]
    if driver.can_render:
        blocks.extend(["", render_proc])
    if driver.can_preview:
        blocks.extend(["", preview_proc])
    if power_procs:
        blocks.extend(["", power_procs])
    blocks.extend(
        [
            "",
            "proc getCompiledDriverPlugin*(): CompiledDriverPlugin {.exportc, dynlib, cdecl.} =",
            "  CompiledDriverPlugin(",
            f'    id: "{sanitize_nim_string(plugin_id)}",',
            f'    variant: "{sanitize_nim_string(variant)}",',
            "    driver: ExportedDriver(",
            f'      canRender: {"true" if driver.can_render else "false"},',
            f'      canPreview: {"true" if driver.can_preview else "false"},',
            f'      canTurnOnOff: {"true" if driver.can_turn_on_off else "false"},',
            "      init: initDriver,",
            "      setup: setupDriver,",
            f'      render: {"renderDriver" if driver.can_render else "nil"},',
            f'      preview: {"previewDriver" if driver.can_preview else "nil"},',
            f"      turnOn: {turn_on_ref},",
            f"      turnOff: {turn_off_ref},",
            "    ),",
            "  )",
        ]
    )
    return "\n".join(blocks) + "\n"


def write_drivers_nim(drivers: dict[str, Driver]) -> str:
    return """
import pixie
import frameos/types
import drivers/plugin_runtime

proc init*(frameOS: FrameOS) =
  initCompiledDrivers(frameOS)

proc render*(image: Image) =
  renderCompiledDrivers(image)

proc getPreview*(): Image =
  result = compiledDriversPreviewImage()

proc turnOn*() =
  turnOnCompiledDrivers()

proc turnOff*() =
  turnOffCompiledDrivers()
"""
