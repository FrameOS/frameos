import std/[dynlib, json, options, os, sequtils]
import pixie

import frameos/types

const initSymbol = "frameosDriverInit"
const renderSymbol = "frameosDriverRender"
const toPngSymbol = "frameosDriverToPng"
const turnOnSymbol = "frameosDriverTurnOn"
const turnOffSymbol = "frameosDriverTurnOff"
const finalizeSymbol = "frameosDriverFinalize"

type
  DriverInitProc = proc(frameOS: FrameOS, config: JsonNode): FrameOSDriver {.nimcall.}
  DriverRenderProc = proc(driver: FrameOSDriver, image: Image) {.nimcall.}
  DriverToPngProc = proc(driver: FrameOSDriver, rotate: int): string {.nimcall.}
  DriverSimpleProc = proc(driver: FrameOSDriver) {.nimcall.}
  DriverFinalizeProc = proc(driver: FrameOSDriver) {.nimcall.}

  DriverPlugin = ref object
    name: string
    library: string
    handle: LibHandle
    driver: FrameOSDriver
    render: Option[DriverRenderProc]
    toPng: Option[DriverToPngProc]
    turnOn: Option[DriverSimpleProc]
    turnOff: Option[DriverSimpleProc]
    finalize: Option[DriverFinalizeProc]

var
  loadedPlugins: seq[DriverPlugin] = @[]
  driversLogger: Logger

proc logManager(event: string, name: string, details: JsonNode = newJNull()) =
  if driversLogger == nil:
    return
  var payload = %*{
    "event": "driver:manager",
    "action": event,
    "name": name,
  }
  if details != nil and details.kind != JNull:
    for key, value in pairs(details):
      payload[key] = value
  driversLogger.log(payload)

proc unloadDrivers() =
  for plugin in loadedPlugins:
    if plugin.finalize.isSome:
      try:
        plugin.finalize.get()(plugin.driver)
      except CatchableError as e:
        logManager("finalize_error", plugin.name, %*{"message": e.msg})
    if plugin.handle != nil:
      unloadLib(plugin.handle)
  loadedPlugins.setLen(0)

proc loadOptionalProc[T](handle: LibHandle, symbol: string): Option[T] =
  if handle.isNil:
    return none(T)
  let sym = symAddr(handle, symbol)
  if sym.isNil:
    return none(T)
  some(cast[T](sym))

proc manifestEntries(manifest: JsonNode): seq[JsonNode] =
  if manifest == nil:
    return @[]
  case manifest.kind
  of JArray:
    return toSeq(manifest.items)
  of JObject:
    if manifest.hasKey("drivers") and manifest["drivers"].kind == JArray:
      return toSeq(manifest["drivers"].items)
  else:
    discard
  return @[]

proc init*(frameOS: FrameOS) =
  driversLogger = frameOS.logger
  unloadDrivers()

  let manifestPath = frameOS.frameConfig.driversManifest
  if manifestPath.len == 0:
    logManager("manifest_missing", "", %*{"reason": "emptyPath"})
    return
  if not fileExists(manifestPath):
    logManager("manifest_missing", "", %*{"path": manifestPath})
    return

  var manifest: JsonNode
  try:
    manifest = parseJson(readFile(manifestPath))
  except CatchableError as e:
    logManager("manifest_error", "", %*{"error": e.msg, "path": manifestPath})
    return

  let baseDir = parentDir(manifestPath)

  for entry in manifestEntries(manifest):
    let name = entry{"name"}.getStr("")
    if name.len == 0:
      logManager("skip", "", %*{"reason": "missingName"})
      continue

    let libraryRel = entry{"library"}.getStr("")
    if libraryRel.len == 0:
      logManager("skip", name, %*{"reason": "missingLibrary"})
      continue

    var libPath = libraryRel
    if not isAbsolute(libPath):
      libPath = joinPath(baseDir, libPath)
    normalizePath(libPath)

    if not fileExists(libPath):
      logManager("load_failed", name, %*{"error": "libraryMissing", "path": libPath})
      continue

    let handle = loadLib(libPath)
    if handle.isNil:
      logManager("load_failed", name, %*{"error": "dlopenFailed", "path": libPath})
      continue

    let initProcOpt = loadOptionalProc[DriverInitProc](handle, initSymbol)
    if initProcOpt.isNone:
      logManager("load_failed", name, %*{"error": "initSymbolMissing"})
      unloadLib(handle)
      continue

    let configNode = (if entry.kind == JObject and entry.hasKey("config"): entry["config"] else: newJNull())

    var driverInstance: FrameOSDriver
    try:
      driverInstance = initProcOpt.get()(frameOS, configNode)
    except CatchableError as e:
      logManager("load_failed", name, %*{"error": "initException", "message": e.msg})
      unloadLib(handle)
      continue

    if driverInstance.isNil:
      logManager("skip", name, %*{"reason": "driverDisabled"})
      unloadLib(handle)
      continue

    var plugin = DriverPlugin(
      name: name,
      library: libPath,
      handle: handle,
      driver: driverInstance,
      render: loadOptionalProc[DriverRenderProc](handle, renderSymbol),
      toPng: loadOptionalProc[DriverToPngProc](handle, toPngSymbol),
      turnOn: loadOptionalProc[DriverSimpleProc](handle, turnOnSymbol),
      turnOff: loadOptionalProc[DriverSimpleProc](handle, turnOffSymbol),
      finalize: loadOptionalProc[DriverFinalizeProc](handle, finalizeSymbol),
    )

    loadedPlugins.add(plugin)

    var capabilities: seq[string] = @[]
    if plugin.render.isSome: capabilities.add("render")
    if plugin.toPng.isSome: capabilities.add("toPng")
    if plugin.turnOn.isSome: capabilities.add("turnOn")
    if plugin.turnOff.isSome: capabilities.add("turnOff")

    logManager("loaded", name, %*{
      "library": libPath,
      "capabilities": capabilities,
    })

proc render*(image: Image) =
  for plugin in loadedPlugins:
    if plugin.render.isSome:
      try:
        plugin.render.get()(plugin.driver, image)
      except CatchableError as e:
        logManager("render_error", plugin.name, %*{"message": e.msg})

proc toPng*(rotate: int): string =
  for plugin in loadedPlugins:
    if plugin.toPng.isSome:
      try:
        result = plugin.toPng.get()(plugin.driver, rotate)
        if result.len > 0:
          return result
      except CatchableError as e:
        logManager("png_error", plugin.name, %*{"message": e.msg})
  result = ""

proc turnOn*() =
  for plugin in loadedPlugins:
    if plugin.turnOn.isSome:
      try:
        plugin.turnOn.get()(plugin.driver)
      except CatchableError as e:
        logManager("turn_on_error", plugin.name, %*{"message": e.msg})

proc turnOff*() =
  for plugin in loadedPlugins:
    if plugin.turnOff.isSome:
      try:
        plugin.turnOff.get()(plugin.driver)
      except CatchableError as e:
        logManager("turn_off_error", plugin.name, %*{"message": e.msg})
