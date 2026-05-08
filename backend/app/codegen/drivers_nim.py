from __future__ import annotations

import json
import re

from app.drivers.drivers import Driver

DRIVER_BUILD_MODE_STATIC = "static"
DRIVER_BUILD_MODE_SHARED = "shared"
DRIVER_BUILD_MODE_PRECOMPILED = "precompiled"
DEFAULT_DRIVER_BUILD_MODE = DRIVER_BUILD_MODE_STATIC
VALID_DRIVER_BUILD_MODES = {
    DRIVER_BUILD_MODE_STATIC,
    DRIVER_BUILD_MODE_SHARED,
    DRIVER_BUILD_MODE_PRECOMPILED,
}

COMPILATION_MODE_STATIC = DRIVER_BUILD_MODE_STATIC
COMPILATION_MODE_SHARED = DRIVER_BUILD_MODE_SHARED
COMPILATION_MODE_PRECOMPILED = DRIVER_BUILD_MODE_PRECOMPILED
DEFAULT_COMPILATION_MODE = DEFAULT_DRIVER_BUILD_MODE
VALID_COMPILATION_MODES = VALID_DRIVER_BUILD_MODES


def normalize_driver_build_mode(value: str | None) -> str:
    normalized = (value or DEFAULT_DRIVER_BUILD_MODE).strip().lower()
    if normalized not in VALID_DRIVER_BUILD_MODES:
        return DEFAULT_DRIVER_BUILD_MODE
    return normalized


def normalize_compilation_mode(value: str | None) -> str:
    return normalize_driver_build_mode(value)


def frame_driver_build_mode(frame) -> str:
    rpios_settings = getattr(frame, "rpios", None) or {}
    return normalize_driver_build_mode(rpios_settings.get("compilationMode") or rpios_settings.get("driverBuildMode"))


def frame_compilation_mode(frame) -> str:
    return frame_driver_build_mode(frame)


def driver_build_mode_uses_shared_libraries(value: str | None) -> bool:
    return normalize_driver_build_mode(value) in {
        DRIVER_BUILD_MODE_SHARED,
        DRIVER_BUILD_MODE_PRECOMPILED,
    }


def compilation_mode_uses_shared_libraries(value: str | None) -> bool:
    return driver_build_mode_uses_shared_libraries(value)


def compiled_drivers(drivers: dict[str, Driver]) -> list[Driver]:
    return [driver for driver in drivers.values() if driver.import_path]


def setup_drivers(drivers: dict[str, Driver]) -> list[Driver]:
    return [driver for driver in drivers.values() if driver.setup_import_path or driver.lines]


def driver_library_filename(driver: Driver) -> str:
    suffix = driver.name
    if driver.name == "waveshare" and driver.variant:
        safe_variant = re.sub(r"[^A-Za-z0-9_]+", "_", driver.variant).strip("_")
        if safe_variant:
            suffix = f"{driver.name}_{safe_variant}"
    return f"{suffix}.so"


def nim_string_literal(value: str) -> str:
    return json.dumps(value)


def nim_string_seq_literal(values: list[str]) -> str:
    return "@[" + ", ".join(nim_string_literal(value) for value in values) + "]"


def driver_context_helpers_nim() -> str:
    return """
proc buildDriverContext(frameOS: FrameOS): driverContext.DriverContext =
  let sourceConfig = frameOS.frameConfig
  let sourceDeviceConfig = sourceConfig.deviceConfig
  var deviceConfig = driverContext.DeviceConfig(
    vcom: 0.0,
    httpUploadUrl: "",
    httpUploadHeaders: @[],
  )
  if not sourceDeviceConfig.isNil:
    deviceConfig.vcom = sourceDeviceConfig.vcom
    deviceConfig.httpUploadUrl = sourceDeviceConfig.httpUploadUrl
    for header in sourceDeviceConfig.httpUploadHeaders:
      deviceConfig.httpUploadHeaders.add(driverContext.HttpHeaderPair(
        name: header.name,
        value: header.value,
      ))

  var palette = driverContext.PaletteConfig(colors: @[])
  if not sourceConfig.palette.isNil:
    palette.colors = sourceConfig.palette.colors

  var config = driverContext.DriverFrameConfig(
    mode: sourceConfig.mode,
    device: sourceConfig.device,
    debug: sourceConfig.debug,
    width: sourceConfig.width,
    height: sourceConfig.height,
    deviceConfig: deviceConfig,
    gpioButtons: @[],
    palette: palette,
  )
  for button in sourceConfig.gpioButtons:
    config.gpioButtons.add(driverContext.GPIOButton(pin: button.pin, label: button.label))

  var logger = driverContext.DriverLogger(
    log: nil,
    enabled: false,
    debug: sourceConfig.debug,
  )
  if not frameOS.logger.isNil:
    logger = driverContext.DriverLogger(
      log: frameOS.logger.log,
      enabled: frameOS.logger.enabled,
      debug: sourceConfig.debug,
    )

  result = driverContext.DriverContext(
    frameConfig: config,
    logger: logger,
  )

proc syncDriverContext(frameOS: FrameOS, context: driverContext.DriverContext) =
  if context.isNil or context.frameConfig.isNil:
    return
  frameOS.frameConfig.width = context.frameConfig.width
  frameOS.frameConfig.height = context.frameConfig.height
"""


def setup_parts_nim(
    drivers: dict[str, Driver],
    include_compiled_drivers: bool = True,
) -> tuple[list[str], list[str], list[str]]:
    imports: list[str] = []
    setup_calls: list[str] = []
    names: list[str] = []
    imported_aliases: set[str] = set()

    for driver in setup_drivers(drivers):
        if driver.import_path and not include_compiled_drivers:
            continue
        if driver.setup_import_path:
            alias = f"{driver.name}SetupDriver"
            if alias not in imported_aliases:
                imports.append(f"import {driver.setup_import_path} as {alias}")
                imported_aliases.add(alias)
            setup_calls.append(
                f'addSetupResult(result, runSetupStep("{driver.name}", proc(): SetupResult = {alias}.setup()))'
            )
            names.append(driver.name)
        if driver.lines:
            setup_calls.append(
                f'addSetupResult(result, runSetupStep("{driver.name}", proc(): SetupResult = setupBootConfig({nim_string_seq_literal(driver.lines)})))'
            )
            names.append(driver.name)

    return imports, setup_calls, names


def setup_helpers_nim(
    drivers: dict[str, Driver],
    include_compiled_drivers: bool = True,
    setup_proc_name: str = "setup",
    setup_proc_exported: bool = True,
    include_setup_driver_names: bool = True,
) -> tuple[list[str], str, str]:
    imports, setup_calls, names = setup_parts_nim(
        drivers,
        include_compiled_drivers=include_compiled_drivers,
    )
    newline = "\n"
    setup_body = (newline + "  ").join(setup_calls or ["result = setupOk()"])
    names_source = nim_string_seq_literal(names)
    names_proc = (
        f"""
proc setupDriverNames*(): seq[string] =
  {("return " + names_source) if names else "result = @[]"}
"""
        if include_setup_driver_names
        else ""
    )
    setup_proc_star = "*" if setup_proc_exported else ""
    code = f"""
{names_proc}

proc {setup_proc_name}{setup_proc_star}(frameOS: FrameOS): SetupResult =
  discard frameOS
  {setup_body}
"""
    return imports, code, names_source


def driver_library_context_helpers_nim() -> str:
    return """
proc driverLog(payload: JsonNode) =
  log(payload)

proc cloneDriverContext(source: DriverContext): DriverContext =
  var deviceConfig = DeviceConfig(
    vcom: 0.0,
    httpUploadUrl: "",
    httpUploadHeaders: @[],
  )
  var palette = PaletteConfig(colors: @[])
  var config = DriverFrameConfig(
    mode: "",
    device: "",
    debug: false,
    width: 0,
    height: 0,
    deviceConfig: deviceConfig,
    gpioButtons: @[],
    palette: palette,
  )
  var logger = DriverLogger(log: driverLog, enabled: true, debug: false)

  if not source.isNil:
    if not source.logger.isNil:
      logger.enabled = source.logger.enabled
      logger.debug = source.logger.debug
    if not source.frameConfig.isNil:
      let sourceConfig = source.frameConfig
      config.mode = sourceConfig.mode
      config.device = sourceConfig.device
      config.debug = sourceConfig.debug
      config.width = sourceConfig.width
      config.height = sourceConfig.height
      if not sourceConfig.deviceConfig.isNil:
        deviceConfig.vcom = sourceConfig.deviceConfig.vcom
        deviceConfig.httpUploadUrl = sourceConfig.deviceConfig.httpUploadUrl
        for header in sourceConfig.deviceConfig.httpUploadHeaders:
          deviceConfig.httpUploadHeaders.add(HttpHeaderPair(name: header.name, value: header.value))
      if not sourceConfig.palette.isNil:
        palette.colors = sourceConfig.palette.colors
      for button in sourceConfig.gpioButtons:
        config.gpioButtons.add(GPIOButton(pin: button.pin, label: button.label))

  result = DriverContext(frameConfig: config, logger: logger)

proc syncHostDriverContext(host: DriverContext, local: DriverContext) =
  if host.isNil or host.frameConfig.isNil or local.isNil or local.frameConfig.isNil:
    return
  host.frameConfig.width = local.frameConfig.width
  host.frameConfig.height = local.frameConfig.height
"""


def write_drivers_nim(
    drivers: dict[str, Driver],
    driver_build_mode: str = DEFAULT_DRIVER_BUILD_MODE,
) -> str:
    if driver_build_mode_uses_shared_libraries(driver_build_mode):
        return write_shared_drivers_nim(drivers)
    return write_static_drivers_nim(drivers)


def write_static_drivers_nim(drivers: dict[str, Driver]) -> str:
    imports = []
    vars = []
    init_drivers = []
    render_drivers = []
    png_drivers: list[str] = []
    on_drivers = []
    off_drivers = []
    setup_imports, setup_code, _setup_names = setup_helpers_nim(drivers)

    for driver in drivers.values():
        if driver.import_path:
            imports.append(f"import {driver.import_path} as {driver.name}Driver")
            vars.append(f"var {driver.name}DriverInstance: {driver.name}Driver.Driver")
            init_drivers.append(f"{driver.name}DriverInstance = {driver.name}Driver.init(driverCtx)")
            if driver.can_render:
                render_drivers.append(f"{driver.name}DriverInstance.render(image)")
            if driver.can_png and len(png_drivers) == 0:
                png_drivers.append(f"return {driver.name}Driver.toPng(rotate, flip)")
            if driver.can_turn_on_off:
                on_drivers.append(f"{driver.name}DriverInstance.turnOn()")
                off_drivers.append(f"{driver.name}DriverInstance.turnOff()")

    newline = "\n"

    code = f"""
import pixie
import frameos/types
import frameos/driver_context as driverContext
import frameos/device_setup
{newline.join(imports)}
{newline.join(setup_imports)}
{newline.join(vars)}
{driver_context_helpers_nim()}

proc init*(frameOS: FrameOS) =
  let driverCtx = buildDriverContext(frameOS)
  {(newline + '  ').join(init_drivers or ["discard"])}
  syncDriverContext(frameOS, driverCtx)

proc render*(image: Image) =
  {(newline + '  ').join(render_drivers or ["discard"])}

proc toPng*(rotate: int, flip: string): string =
  {(newline + '  ').join(png_drivers or ['result = ""'])}

proc turnOn*() =
  {(newline + '  ').join(on_drivers or ["discard"])}

proc turnOff*() =
  {(newline + '  ').join(off_drivers or ["discard"])}

{setup_code}
    """

    return code


def write_shared_drivers_nim(drivers: dict[str, Driver]) -> str:
    specs: list[str] = []
    for driver in compiled_drivers(drivers):
        specs.append(
            "DriverSpec("
            f'name: "{driver.name}", '
            f'libraryName: "{driver_library_filename(driver)}", '
            f"canSetup: {str(bool(driver.setup_import_path)).lower()}, "
            f"canRender: {str(driver.can_render).lower()}, "
            f"canPng: {str(driver.can_png).lower()}, "
            f"canTurnOnOff: {str(driver.can_turn_on_off).lower()}"
            ")"
        )

    newline = "\n"
    spec_lines = ("," + newline + "  ").join(specs)
    if spec_lines:
        spec_lines = newline + "  " + spec_lines + newline
    setup_imports, setup_local_code, _setup_names = setup_helpers_nim(
        drivers,
        include_compiled_drivers=False,
        setup_proc_name="setupLocalDrivers",
        setup_proc_exported=False,
        include_setup_driver_names=False,
    )
    setup_names = [driver.name for driver in setup_drivers(drivers)]
    setup_names_source = nim_string_seq_literal(setup_names)

    code = f"""
import std/[dynlib, json, options, os]
import pixie
import frameos/types
import frameos/driver_context as driverContext
import frameos/device_setup
import frameos/channels as hostChannels
import frameos/driver_abi
{newline.join(setup_imports)}

type
  DriverSpec = object
    name: string
    libraryName: string
    canSetup: bool
    canRender: bool
    canPng: bool
    canTurnOnOff: bool

  LoadedDriver = object
    spec: DriverSpec
    library: LibHandle
    instance: pointer
    render: DriverRenderProc
    toPng: DriverToPngProc
    turnOn: DriverActionProc
    turnOff: DriverActionProc

let driverSpecs: seq[DriverSpec] = @[{spec_lines}]

var loadedDrivers: seq[LoadedDriver] = @[]
{driver_context_helpers_nim()}

proc hostLog(event: JsonNode) {{.cdecl, gcsafe.}} =
  hostChannels.log(event)

proc hostSendEvent(scene: Option[SceneId], event: string, payload: JsonNode) {{.cdecl, gcsafe.}} =
  hostChannels.sendEvent(scene, event, payload)

proc driverLibraryPath(spec: DriverSpec): string =
  getAppDir() / "drivers" / spec.libraryName

proc loadRequiredSymbol[T](library: LibHandle, driverName: string, symbol: string): T =
  let address = symAddr(library, symbol)
  if address.isNil:
    hostChannels.log(%*{{"event": "driver:shared:error", "driver": driverName,
        "error": "Missing symbol", "symbol": symbol}})
    return nil
  cast[T](address)

proc setupSharedDriver(spec: DriverSpec, driverCtx: driverContext.DriverContext): SetupResult =
  let path = driverLibraryPath(spec)
  echo "FrameOS setup: shared driver " & spec.name & ": loading " & path
  let library = loadLib(path)
  if library.isNil:
    echo "FrameOS setup: shared driver " & spec.name & ": failed to load " & path
    raise newException(OSError, "Unable to load driver library: " & path)
  try:
    let setupProc = loadRequiredSymbol[DriverSetupProc](library, spec.name, "frameos_driver_setup")
    if setupProc.isNil:
      raise newException(OSError, "Missing setup symbol for driver: " & spec.name)
    echo "FrameOS setup: shared driver " & spec.name & ": running setup"
    result.rebootRequired = setupProc(cast[pointer](driverCtx))
    echo "FrameOS setup: shared driver " & spec.name & ": setup complete"
  finally:
    unloadLib(library)

proc setupSharedDrivers(frameOS: FrameOS): SetupResult =
  echo "FrameOS setup: shared driver registry: building context"
  let driverCtx = buildDriverContext(frameOS)
  echo "FrameOS setup: shared driver registry: selected " & $driverSpecs.len & " driver(s)"
  for spec in driverSpecs:
    if spec.canSetup:
      let setupSpec = spec
      addSetupResult(result, runSetupStep(setupSpec.name, proc(): SetupResult = setupSharedDriver(setupSpec, driverCtx)))
      syncDriverContext(frameOS, driverCtx)

proc init*(frameOS: FrameOS) =
  loadedDrivers = @[]
  let driverCtx = buildDriverContext(frameOS)
  for spec in driverSpecs:
    let path = driverLibraryPath(spec)
    let library = loadLib(path)
    if library.isNil:
      hostChannels.log(%*{{"event": "driver:shared:error", "driver": spec.name,
          "error": "Unable to load driver library", "path": path}})
      continue

    let initProc = loadRequiredSymbol[DriverInitProc](library, spec.name, "frameos_driver_init")
    if initProc.isNil:
      unloadLib(library)
      continue

    var loaded = LoadedDriver(
      spec: spec,
      library: library,
      instance: initProc(cast[pointer](driverCtx), hostLog, hostSendEvent),
    )
    if spec.canRender:
      loaded.render = loadRequiredSymbol[DriverRenderProc](library, spec.name, "frameos_driver_render")
    if spec.canPng:
      loaded.toPng = loadRequiredSymbol[DriverToPngProc](library, spec.name, "frameos_driver_to_png")
    if spec.canTurnOnOff:
      loaded.turnOn = loadRequiredSymbol[DriverActionProc](library, spec.name, "frameos_driver_turn_on")
      loaded.turnOff = loadRequiredSymbol[DriverActionProc](library, spec.name, "frameos_driver_turn_off")
    loadedDrivers.add(loaded)
    syncDriverContext(frameOS, driverCtx)
    hostChannels.log(%*{{"event": "driver:shared", "driver": spec.name, "path": path, "loaded": true}})

proc render*(image: Image) =
  for driver in loadedDrivers:
    if driver.spec.canRender and not driver.render.isNil:
      driver.render(driver.instance, cast[pointer](image))

proc toPng*(rotate: int, flip: string): string =
  for driver in loadedDrivers:
    if driver.spec.canPng and not driver.toPng.isNil:
      var length = 0
      let data = driver.toPng(driver.instance, rotate.cint, flip.cstring, addr length)
      if data.isNil or length <= 0:
        return ""
      result = newString(length)
      copyMem(addr result[0], data, length)
      return
  result = ""

proc turnOn*() =
  for driver in loadedDrivers:
    if driver.spec.canTurnOnOff and not driver.turnOn.isNil:
      driver.turnOn(driver.instance)

proc turnOff*() =
  for driver in loadedDrivers:
    if driver.spec.canTurnOnOff and not driver.turnOff.isNil:
      driver.turnOff(driver.instance)

{setup_local_code}

proc setupDriverNames*(): seq[string] =
  return {setup_names_source}

proc setup*(frameOS: FrameOS): SetupResult =
  echo "FrameOS setup: shared driver setup: starting"
  addSetupResult(result, setupSharedDrivers(frameOS))
  echo "FrameOS setup: shared driver setup: complete"
  echo "FrameOS setup: local driver setup: starting"
  addSetupResult(result, setupLocalDrivers(frameOS))
  echo "FrameOS setup: local driver setup: complete"
    """

    return code


def write_driver_library_nim(driver: Driver) -> str:
    if not driver.import_path:
        raise ValueError(f"Driver {driver.name} has no import path")

    json_import = "import std/json\n"
    png_var = "\n  pngBuffer: string" if driver.can_png else ""

    image_import = "import pixie\n" if driver.can_render else ""

    setup_import = ""
    setup_proc = ""
    setup_driver_alias = f"{driver.name}Driver"
    if driver.setup_import_path:
        if driver.setup_import_path != driver.import_path:
            setup_driver_alias = f"{driver.name}SetupDriver"
            setup_import = f"import drivers/{driver.setup_import_path} as {setup_driver_alias}\n"
        setup_proc = f"""
proc frameos_driver_setup*(driverContextPtr: pointer): bool {{.cdecl, exportc, dynlib.}} =
  let hostContext = cast[DriverContext](driverContextPtr)
  driverContextInstance = cloneDriverContext(hostContext)
  result = {setup_driver_alias}.setup(driverContextInstance).rebootRequired
  syncHostDriverContext(hostContext, driverContextInstance)
"""

    render_proc = ""
    if driver.can_render:
        render_proc = f"""
proc frameos_driver_render*(driver: pointer, image: pointer) {{.cdecl, exportc, dynlib.}} =
  if driver.isNil:
    return
  {driver.name}Driver.render(cast[{driver.name}Driver.Driver](driver), cast[Image](image))
"""

    png_proc = ""
    if driver.can_png:
        png_proc = f"""
proc frameos_driver_to_png*(driver: pointer, rotate: cint, flip: cstring, length: ptr int): pointer {{.cdecl, exportc, dynlib.}} =
  try:
    pngBuffer = {driver.name}Driver.toPng(rotate.int, $flip)
    if not length.isNil:
      length[] = pngBuffer.len
    if pngBuffer.len == 0:
      return nil
    result = cast[pointer](unsafeAddr pngBuffer[0])
  except Exception as e:
    if not length.isNil:
      length[] = 0
    log(%*{{"event": "driver:{driver.name}:toPng:error", "error": e.msg}})
    result = nil
"""

    turn_procs = ""
    if driver.can_turn_on_off:
        turn_procs = f"""
proc frameos_driver_turn_on*(driver: pointer) {{.cdecl, exportc, dynlib.}} =
  if driver.isNil:
    return
  {driver.name}Driver.turnOn(cast[{driver.name}Driver.Driver](driver))

proc frameos_driver_turn_off*(driver: pointer) {{.cdecl, exportc, dynlib.}} =
  if driver.isNil:
    return
  {driver.name}Driver.turnOff(cast[{driver.name}Driver.Driver](driver))
"""

    code = f"""
{json_import}\
{image_import}\
import frameos/channels
import frameos/driver_context
import frameos/driver_abi
import drivers/{driver.import_path} as {driver.name}Driver
{setup_import}

var
  driverContextInstance: DriverContext
  driverInstance: {driver.name}Driver.Driver{png_var}
{driver_library_context_helpers_nim()}

{setup_proc}

proc frameos_driver_init*(driverContextPtr: pointer, logHook: HostLogProc, sendEventHook: HostSendEventProc): pointer {{.cdecl, exportc, dynlib.}} =
  setSharedHostCallbacks(logHook, sendEventHook)
  let hostContext = cast[DriverContext](driverContextPtr)
  driverContextInstance = cloneDriverContext(hostContext)
  driverInstance = {driver.name}Driver.init(driverContextInstance)
  syncHostDriverContext(hostContext, driverContextInstance)
  result = cast[pointer](driverInstance)
{render_proc}
{png_proc}
{turn_procs}
"""

    return code
