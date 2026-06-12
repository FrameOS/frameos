
import std/[dynlib, json, options, os]
import pixie
import frameos/types
import frameos/driver_context as driverContext
import frameos/device_setup
import frameos/channels as hostChannels
import frameos/driver_abi


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

let driverSpecs: seq[DriverSpec] = @[]

var loadedDrivers: seq[LoadedDriver] = @[]
var setupLibraries: seq[LibHandle] = @[]

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


proc hostLog(event: JsonNode) {.cdecl, gcsafe.} =
  hostChannels.log(event)

proc hostSendEvent(scene: Option[SceneId], event: string, payload: JsonNode) {.cdecl, gcsafe.} =
  hostChannels.sendEvent(scene, event, payload)

proc driverLibraryPath(spec: DriverSpec): string =
  getAppDir() / "drivers" / spec.libraryName

proc loadRequiredSymbol[T](library: LibHandle, driverName: string, symbol: string): T =
  let address = symAddr(library, symbol)
  if address.isNil:
    hostChannels.log(%*{"event": "driver:shared:error", "driver": driverName,
        "error": "Missing symbol", "symbol": symbol})
    return nil
  cast[T](address)

proc setupSharedDriver(spec: DriverSpec, driverCtx: driverContext.DriverContext): SetupResult =
  let path = driverLibraryPath(spec)
  setupLog("FrameOS setup: shared driver " & spec.name & ": loading " & path)
  let library = loadLib(path)
  if library.isNil:
    setupLog("FrameOS setup: shared driver " & spec.name & ": failed to load " & path)
    setupLog("FrameOS setup: shared driver " & spec.name & ": file exists: " & $fileExists(path))
    setupLog("FrameOS setup: shared driver " & spec.name & ": LD_LIBRARY_PATH=" & getEnv("LD_LIBRARY_PATH"))
    raise newException(OSError, "Unable to load driver library: " & path)
  let setupProc = loadRequiredSymbol[DriverSetupProc](library, spec.name, "frameos_driver_setup")
  if setupProc.isNil:
    raise newException(OSError, "Missing setup symbol for driver: " & spec.name)
  setupLog("FrameOS setup: shared driver " & spec.name & ": running setup")
  result.rebootRequired = setupProc(cast[pointer](driverCtx))
  setupLibraries.add(library)
  setupLog("FrameOS setup: shared driver " & spec.name & ": setup complete")

proc setupSharedDrivers(frameOS: FrameOS): SetupResult =
  setupLog("FrameOS setup: shared driver registry: building context")
  let driverCtx = buildDriverContext(frameOS)
  setupLog("FrameOS setup: shared driver registry: selected " & $driverSpecs.len & " driver(s)")
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
      hostChannels.log(%*{"event": "driver:shared:error", "driver": spec.name,
          "error": "Unable to load driver library", "path": path})
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
    hostChannels.log(%*{"event": "driver:shared", "driver": spec.name, "path": path, "loaded": true})

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




proc setupLocalDrivers(frameOS: FrameOS): SetupResult =
  let driverCtx = buildDriverContext(frameOS)
  result = setupOk()
  syncDriverContext(frameOS, driverCtx)


proc setupDriverNames*(): seq[string] =
  return @[]

proc setup*(frameOS: FrameOS): SetupResult =
  setupLog("FrameOS setup: shared driver setup: starting")
  addSetupResult(result, setupSharedDrivers(frameOS))
  setupLog("FrameOS setup: shared driver setup: complete")
  setupLog("FrameOS setup: local driver setup: starting")
  addSetupResult(result, setupLocalDrivers(frameOS))
  setupLog("FrameOS setup: local driver setup: complete")
    