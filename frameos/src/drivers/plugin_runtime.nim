import algorithm, dynlib, json, os, options, pixie
import frameos/channels
import frameos/types
import frameos/utils/image

const DRIVER_PLUGINS_FOLDER = "./drivers"
const COMPILED_DRIVER_PLUGIN_SYMBOL = "getCompiledDriverPlugin"
const COMPILED_PLUGIN_RUNTIME_CHANNELS_SYMBOL = "bindCompiledPluginRuntimeChannels"
const NIM_PLUGIN_MAIN_SYMBOL = "NimMain"

type
  CompiledDriverPluginFactory = proc(): CompiledDriverPlugin {.cdecl.}
  CompiledPluginRuntimeChannelsBinder = proc(hooks: ptr CompiledRuntimeHooks) {.cdecl.}
  NimPluginMain = proc() {.cdecl.}
  LoadedCompiledDriver = ref object
    path: string
    plugin: CompiledDriverPlugin
    instance: FrameOSDriver

var loadedCompiledDrivers: seq[LoadedCompiledDriver] = @[]
var compiledDriverLoadCounter = 0
var testPreviewArtifact: DriverPreviewArtifact

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

proc initializeNimPluginRuntime(handle: LibHandle) =
  let nimMain = cast[NimPluginMain](symAddr(handle, NIM_PLUGIN_MAIN_SYMBOL))
  if nimMain.isNil:
    return
  nimMain()

proc loadCompiledDriverPlugin(path: string): Option[CompiledDriverPlugin] =
  var copiedPath = ""
  try:
    copiedPath = copyCompiledDriverLibrary(path)
    let handle = loadLib(copiedPath)
    if handle.isNil:
      return none(CompiledDriverPlugin)
    initializeNimPluginRuntime(handle)
    bindPluginChannels(handle)
    let factory = cast[CompiledDriverPluginFactory](symAddr(handle, COMPILED_DRIVER_PLUGIN_SYMBOL))
    if factory.isNil:
      return none(CompiledDriverPlugin)
    let plugin = factory()
    if plugin.isNil or plugin.driver.isNil or plugin.driver.init.isNil:
      return none(CompiledDriverPlugin)
    if plugin.abiVersion != COMPILED_PLUGIN_ABI_VERSION:
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

proc setPreviewPixel(image: Image, x, y: int, r, g, b: uint8, a: uint8 = 255'u8) =
  let index = y * image.width + x
  image.data[index].r = r
  image.data[index].g = g
  image.data[index].b = b
  image.data[index].a = a

proc previewPaletteColor(preview: DriverPreviewArtifact, colorIndex: int): (uint8, uint8, uint8) =
  let defaultPalette: seq[(uint8, uint8, uint8)] =
    case preview.pixelFormat:
    of dpfMono1:
      @[(0'u8, 0'u8, 0'u8), (255'u8, 255'u8, 255'u8)]
    else:
      @[]
  let palette = if preview.palette.len > 0: preview.palette else: defaultPalette
  if colorIndex < 0 or colorIndex >= palette.len:
    return (0'u8, 0'u8, 0'u8)
  palette[colorIndex]

proc previewArtifactToImage*(preview: DriverPreviewArtifact): Image =
  if preview.isNil or preview.width <= 0 or preview.height <= 0 or preview.data.len == 0:
    return nil

  result = newImage(preview.width, preview.height)
  case preview.pixelFormat:
  of dpfRgba8:
    let expected = preview.width * preview.height * 4
    if preview.data.len < expected:
      return nil
    for y in 0 ..< preview.height:
      for x in 0 ..< preview.width:
        let offset = (y * preview.width + x) * 4
        setPreviewPixel(
          result, x, y,
          preview.data[offset],
          preview.data[offset + 1],
          preview.data[offset + 2],
          preview.data[offset + 3]
        )
  of dpfGray8:
    let expected = preview.width * preview.height
    if preview.data.len < expected:
      return nil
    for y in 0 ..< preview.height:
      for x in 0 ..< preview.width:
        let gray = preview.data[y * preview.width + x]
        setPreviewPixel(result, x, y, gray, gray, gray)
  of dpfIndexed8:
    let expected = preview.width * preview.height
    if preview.data.len < expected:
      return nil
    for y in 0 ..< preview.height:
      for x in 0 ..< preview.width:
        let colorIndex = preview.data[y * preview.width + x].int
        let (r, g, b) = previewPaletteColor(preview, colorIndex)
        setPreviewPixel(result, x, y, r, g, b)
  of dpfIndexed4:
    let rowWidth = (preview.width + 1) div 2
    let expected = rowWidth * preview.height
    if preview.data.len < expected:
      return nil
    for y in 0 ..< preview.height:
      for x in 0 ..< preview.width:
        let packed = preview.data[y * rowWidth + x div 2]
        let colorIndex =
          if (x mod 2) == 0:
            (packed shr 4) and 0x0F
          else:
            packed and 0x0F
        let (r, g, b) = previewPaletteColor(preview, colorIndex.int)
        setPreviewPixel(result, x, y, r, g, b)
  of dpfIndexed2:
    let rowWidth = (preview.width + 3) div 4
    let expected = rowWidth * preview.height
    if preview.data.len < expected:
      return nil
    for y in 0 ..< preview.height:
      for x in 0 ..< preview.width:
        let packed = preview.data[y * rowWidth + x div 4]
        let shift = (3 - (x mod 4)) * 2
        let colorIndex = (packed shr shift) and 0x03
        let (r, g, b) = previewPaletteColor(preview, colorIndex.int)
        setPreviewPixel(result, x, y, r, g, b)
  of dpfMono1:
    let rowWidth = (preview.width + 7) div 8
    let expected = rowWidth * preview.height
    if preview.data.len < expected:
      return nil
    for y in 0 ..< preview.height:
      for x in 0 ..< preview.width:
        let packed = preview.data[y * rowWidth + x div 8]
        let shift = 7 - (x mod 8)
        let colorIndex = ((packed shr shift) and 0x01).int
        let (r, g, b) = previewPaletteColor(preview, colorIndex)
        setPreviewPixel(result, x, y, r, g, b)

proc compiledDriversPreviewImage*(): Image =
  for loaded in loadedCompiledDrivers:
    if loaded.plugin.isNil or loaded.plugin.driver.isNil:
      continue
    if loaded.plugin.driver.canPreview and loaded.plugin.driver.preview != nil:
      try:
        let preview = loaded.plugin.driver.preview(loaded.instance)
        let image = previewArtifactToImage(preview)
        if image != nil:
          if preview != nil and preview.rotate != 0:
            return image.rotateDegrees(preview.rotate)
          return image
      except CatchableError:
        discard
  nil

# Test seam for API preview coverage without building a shared-library driver plugin.
proc clearCompiledDriversForTests*() =
  testPreviewArtifact = nil
  loadedCompiledDrivers = @[]

proc previewFromTestDriver(self: FrameOSDriver): DriverPreviewArtifact =
  testPreviewArtifact

proc setCompiledDriverPreviewForTests*(preview: DriverPreviewArtifact) =
  testPreviewArtifact = preview
  if preview.isNil:
    loadedCompiledDrivers = @[]
    return

  loadedCompiledDrivers = @[
    LoadedCompiledDriver(
      path: "__test__/preview-driver.so",
      plugin: CompiledDriverPlugin(
        id: "__test__/preview-driver",
        abiVersion: COMPILED_PLUGIN_ABI_VERSION,
        driver: ExportedDriver(
          canPreview: true,
          preview: previewFromTestDriver,
        ),
      ),
      instance: FrameOSDriver(name: "__test__/preview-driver"),
    )
  ]

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
