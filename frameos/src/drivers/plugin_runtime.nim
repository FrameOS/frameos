import algorithm, dynlib, json, os, options, pixie
import frameos/channels
import frameos/types

const DRIVER_PLUGINS_FOLDER = "./drivers"
const COMPILED_DRIVER_PLUGIN_SYMBOL = "getCompiledDriverPlugin"
const COMPILED_PLUGIN_RUNTIME_CHANNELS_SYMBOL = "bindCompiledPluginRuntimeChannels"

type
  CompiledDriverPluginFactory = proc(): CompiledDriverPlugin {.cdecl.}
  CompiledPluginRuntimeChannelsBinder = proc(hooks: ptr CompiledRuntimeHooks) {.cdecl.}
  LoadedCompiledDriver = ref object
    path: string
    plugin: CompiledDriverPlugin
    instance: FrameOSDriver

var loadedCompiledDrivers: seq[LoadedCompiledDriver] = @[]
var compiledDriverLoadCounter = 0

proc copyCompiledDriverLibrary(sourcePath: string): string =
  inc compiledDriverLoadCounter
  let targetPath = getTempDir() / ("frameos-driver-" & $compiledDriverLoadCounter & "-" & extractFilename(sourcePath))
  copyFile(sourcePath, targetPath)
  targetPath

proc removeCopiedCompiledDriverLibrary(path: string) =
  if path.len == 0:
    return
  try:
    if fileExists(path):
      removeFile(path)
  except OSError:
    discard

proc driverLabel(plugin: CompiledDriverPlugin, fallbackPath: string): string =
  if plugin.isNil or plugin.id.len == 0:
    return extractFilename(fallbackPath)
  if plugin.variant.len == 0:
    return plugin.id
  plugin.id & " (" & plugin.variant & ")"

proc logDriverPluginWarning(frameOS: FrameOS, pluginPath: string, message: string) =
  if frameOS.isNil or frameOS.logger.isNil:
    echo "Warning: ", message, ": ", pluginPath
    return
  frameOS.logger.log(%*{
    "event": "driver:plugin:warning",
    "driverPath": pluginPath,
    "message": message,
  })

proc bindPluginChannels(handle: LibHandle) =
  let binder = cast[CompiledPluginRuntimeChannelsBinder](
    symAddr(handle, COMPILED_PLUGIN_RUNTIME_CHANNELS_SYMBOL)
  )
  if binder.isNil:
    return
  var runtimeHooks = getCompiledRuntimeHooks()
  binder(addr runtimeHooks)

proc loadCompiledDriverPlugin(path: string): Option[CompiledDriverPlugin] =
  var copiedPath = ""
  try:
    copiedPath = copyCompiledDriverLibrary(path)
    let handle = loadLib(copiedPath)
    if handle.isNil:
      return none(CompiledDriverPlugin)
    bindPluginChannels(handle)
    let factory = cast[CompiledDriverPluginFactory](symAddr(handle, COMPILED_DRIVER_PLUGIN_SYMBOL))
    if factory.isNil:
      return none(CompiledDriverPlugin)
    let plugin = factory()
    if plugin.isNil or plugin.driver.isNil or plugin.driver.init.isNil:
      return none(CompiledDriverPlugin)
    return some(plugin)
  except CatchableError:
    return none(CompiledDriverPlugin)
  finally:
    removeCopiedCompiledDriverLibrary(copiedPath)

proc initCompiledDrivers*(frameOS: FrameOS) =
  loadedCompiledDrivers = @[]

  if not dirExists(DRIVER_PLUGINS_FOLDER):
    return

  var driverPaths: seq[string] = @[]
  for path in walkFiles(DRIVER_PLUGINS_FOLDER / "*.so"):
    driverPaths.add(path)
  driverPaths.sort(system.cmp[string])

  for path in driverPaths:
    let pluginOption = loadCompiledDriverPlugin(path)
    if pluginOption.isNone:
      logDriverPluginWarning(frameOS, path, "Failed to load compiled driver plugin")
      continue

    let plugin = pluginOption.get()
    try:
      let instance = plugin.driver.init(frameOS)
      loadedCompiledDrivers.add(LoadedCompiledDriver(path: path, plugin: plugin, instance: instance))
      if frameOS != nil and frameOS.logger != nil:
        frameOS.logger.log(%*{
          "event": "driver:plugin:loaded",
          "driver": driverLabel(plugin, path),
          "driverPath": path,
        })
    except CatchableError as e:
      logDriverPluginWarning(frameOS, path, "Failed to initialize compiled driver plugin: " & e.msg)

proc renderCompiledDrivers*(image: Image) =
  for loaded in loadedCompiledDrivers:
    if loaded.plugin.isNil or loaded.plugin.driver.isNil:
      continue
    if loaded.plugin.driver.canRender and loaded.plugin.driver.render != nil:
      loaded.plugin.driver.render(loaded.instance, image)

proc compiledDriversToPng*(rotate: int): string =
  for loaded in loadedCompiledDrivers:
    if loaded.plugin.isNil or loaded.plugin.driver.isNil:
      continue
    if loaded.plugin.driver.canPng and loaded.plugin.driver.toPng != nil:
      let image = loaded.plugin.driver.toPng(loaded.instance, rotate)
      if image.len > 0:
        return image
  ""

proc turnOnCompiledDrivers*() =
  for loaded in loadedCompiledDrivers:
    if loaded.plugin.isNil or loaded.plugin.driver.isNil:
      continue
    if loaded.plugin.driver.canTurnOnOff and loaded.plugin.driver.turnOn != nil:
      loaded.plugin.driver.turnOn(loaded.instance)

proc turnOffCompiledDrivers*() =
  for loaded in loadedCompiledDrivers:
    if loaded.plugin.isNil or loaded.plugin.driver.isNil:
      continue
    if loaded.plugin.driver.canTurnOnOff and loaded.plugin.driver.turnOff != nil:
      loaded.plugin.driver.turnOff(loaded.instance)
