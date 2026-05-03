from __future__ import annotations

import re

from app.drivers.drivers import Driver

DRIVER_BUILD_MODE_STATIC = "static"
DRIVER_BUILD_MODE_SHARED = "shared"
DEFAULT_DRIVER_BUILD_MODE = DRIVER_BUILD_MODE_SHARED
VALID_DRIVER_BUILD_MODES = {DRIVER_BUILD_MODE_STATIC, DRIVER_BUILD_MODE_SHARED}


def normalize_driver_build_mode(value: str | None) -> str:
    normalized = (value or DEFAULT_DRIVER_BUILD_MODE).strip().lower()
    if normalized not in VALID_DRIVER_BUILD_MODES:
        return DEFAULT_DRIVER_BUILD_MODE
    return normalized


def frame_driver_build_mode(frame) -> str:
    rpios_settings = getattr(frame, "rpios", None) or {}
    return normalize_driver_build_mode(rpios_settings.get("driverBuildMode"))


def compiled_drivers(drivers: dict[str, Driver]) -> list[Driver]:
    return [driver for driver in drivers.values() if driver.import_path]


def driver_library_filename(driver: Driver) -> str:
    suffix = driver.name
    if driver.name == "waveshare" and driver.variant:
        safe_variant = re.sub(r"[^A-Za-z0-9_]+", "_", driver.variant).strip("_")
        if safe_variant:
            suffix = f"{driver.name}_{safe_variant}"
    return f"libframeos_driver_{suffix}.so"


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

  result = driverContext.DriverContext(
    frameConfig: config,
    logger: driverContext.DriverLogger(
      log: frameOS.logger.log,
      enabled: frameOS.logger.enabled,
      debug: sourceConfig.debug,
    ),
  )

proc syncDriverContext(frameOS: FrameOS, context: driverContext.DriverContext) =
  if context.isNil or context.frameConfig.isNil:
    return
  frameOS.frameConfig.width = context.frameConfig.width
  frameOS.frameConfig.height = context.frameConfig.height
"""


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
    if normalize_driver_build_mode(driver_build_mode) == DRIVER_BUILD_MODE_SHARED:
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
{newline.join(imports)}
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
    """

    return code


def write_shared_drivers_nim(drivers: dict[str, Driver]) -> str:
    specs: list[str] = []
    for driver in compiled_drivers(drivers):
        specs.append(
            "DriverSpec("
            f'name: "{driver.name}", '
            f'libraryName: "{driver_library_filename(driver)}", '
            f"canRender: {str(driver.can_render).lower()}, "
            f"canPng: {str(driver.can_png).lower()}, "
            f"canTurnOnOff: {str(driver.can_turn_on_off).lower()}"
            ")"
        )

    newline = "\n"
    spec_lines = ("," + newline + "  ").join(specs)
    if spec_lines:
        spec_lines = newline + "  " + spec_lines + newline

    code = f"""
import std/[dynlib, json, options, os]
import pixie
import frameos/types
import frameos/driver_context as driverContext
import frameos/channels as hostChannels
import frameos/driver_abi

type
  DriverSpec = object
    name: string
    libraryName: string
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

let driverSpecs = @[{spec_lines}]

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
    """

    return code


def write_driver_library_nim(driver: Driver) -> str:
    if not driver.import_path:
        raise ValueError(f"Driver {driver.name} has no import path")

    json_import = "import std/json\n"
    png_var = "\n  pngBuffer: string" if driver.can_png else ""

    image_import = "import pixie\n" if driver.can_render else ""

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

var
  driverContextInstance: DriverContext
  driverInstance: {driver.name}Driver.Driver{png_var}
{driver_library_context_helpers_nim()}

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
