# FrameOS wasm runtime: interpreted scenes rendered in the browser.
#
# Compiled with emscripten (tools/build_wasm.sh, -d:frameosWasm) into an ES
# module the frontend loads inside a Web Worker for the "live preview" modal.
# Scenes arrive as the same JSON the backend ships to frames
# (seq[FrameSceneInput]); rendering happens through frameos/interpreter with
# pixie, code nodes run on QuickJS. The C API below mirrors the ESP32
# embedded runtime (src/embedded), swapping the firmware hooks for
# emscripten JS-library hooks (log + event notifications go out through
# postMessage, HTTP comes in through synchronous XHR).

import std/[json, locks, math, monotimes, options, sequtils, strformat, strutils, tables, times]
import pixie

import frameos/types
import frameos/channels
import frameos/single_scene_host
import system/sceneSwitcher/scene as sceneSwitcher
import frameos/relayed_input
from frameos/input_state import initInputState
from frameos/ui/events as uiEvents import uiTimersPending
import frameos/interpreter
import frameos/planner
import frameos/utils/image as frameos_image
import frameos/utils/memory
import frameos/utils/dither
import frameos/utils/asset_colors
import frameos/js_runtime/runtime as jsRuntime
import frameos/js_runtime/app_tests
import lib/tz
import frameos/version

# ------------------------------------------------------------------ JS hooks
# Implemented in tools/wasm/frameos_library.js and linked by emcc.

proc jsLogHook(msg: cstring) {.importc: "frameos_wasm_js_log", cdecl.}
proc jsEventHook(event: cstring, payload: cstring) {.importc: "frameos_wasm_js_event", cdecl.}

proc log(msg: string) =
  jsLogHook(msg.cstring)

# ------------------------------------------------------------------- state

var
  frameConfig: FrameConfig
  logger: Logger
  defaultSceneId: Option[SceneId] = none(SceneId)
  scenesLoadedCount = 0
  # The loaded payload's scene order, for `setCurrentScene {direction}`.
  loadedSceneOrder: seq[SceneId] = @[]
  # The scene's lifetime, its lifecycle events and the dispatcher's EventHost:
  # shared with the ESP32 runtime (frameos/single_scene_host).
  host = SingleSceneHost()
  lastImage: Image
  lastNextSleep: float = -1
  sceneInfoBuffer: string
  sceneStateBuffer: string
  lastErrorBuffer: string
  versionBuffer: string
  appTestsBuffer: string
  # Backend-persisted scene state, seeded via frameos_wasm_set_scene_state
  # before the scene's first render and merged into scene.state at init.
  pendingSceneStates = initTable[string, JsonNode]()
  # A built-in scene (the switcher, the settings) a control plane selected
  # for a frame it renders for: opened again as it was left, from its
  # seeded state, before anything uses it (restoreBuiltIn).
  builtInToRestore = ""
  renderPaletteBuffer: string
  # Running as an ESP32, every render draws into one canvas kept for the
  # runtime's life, in the format that frame keeps it in (embedded_runtime
  # `renderCanvas`): RGB565 on a 13.3" colour panel with 8 MB of PSRAM, luma
  # on a grey one, RGBX where two of it fit. Before this the preview made a
  # fresh RGBX canvas every render while the page still held the last one, so
  # at 1200x1600 under 8 MB even a blank scene's second render was refused
  # 7.3 MB: an out-of-memory the frame never has.
  deviceCanvas: Image
  deviceCanvasBitsPerPixel = 32
  # A 565 or luma canvas expanded to RGBA for the page (frameos_wasm_buffer).
  # It stands in for the panel buffer, which the device's heap leaves out, so
  # it comes from plain malloc, outside the simulated ceiling.
  rgbaOut: ptr UncheckedArray[ColorRGBX]
  rgbaOutPixels = 0

proc fosWasmMemorySetHeld(bytes: csize_t) {.
  importc: "fos_wasm_memory_set_held", header: "<fos_wasm_mem.h>", cdecl.}
proc cMalloc(size: csize_t): pointer {.importc: "malloc", header: "<stdlib.h>", cdecl.}
proc cFree(p: pointer) {.importc: "free", header: "<stdlib.h>", cdecl.}

proc currentSceneName(): string =
  host.sceneName

proc setLastError(msg: string) =
  lastErrorBuffer = msg
  if msg.len > 0:
    log("error: " & msg)

# ------------------------------------------------------------------- scenes

proc switcherListing(): seq[SwitcherEntry] {.nimcall, gcsafe.} =
  ## The scene switcher's tiles: the loaded payload, in its order.
  {.cast(gcsafe).}:
    let scenes = getInterpretedScenes()
    for sceneId in loadedSceneOrder:
      result.add SwitcherEntry(id: sceneId.string,
        name: if scenes.hasKey(sceneId): scenes[sceneId].name else: "")

sceneSwitcherListing = switcherListing

# ------------------------------------------------------------------- canvas

proc dropDeviceCanvas() =
  if not deviceCanvas.isNil and lastImage == deviceCanvas:
    lastImage = nil
  deviceCanvas = nil
  fosWasmMemorySetHeld(0)

proc previewCanvas(): Image =
  ## The canvas the next render draws into, or nil for a fresh RGBX one per
  ## render, which is what a Pi's runner does. Made on first use, reused
  ## after, like the device's. The bytes a 565 or luma canvas saves against
  ## the RGBX one the simulated ceiling was worked out for
  ## (devices.ts `previewOverheadBytes`) stay charged, so the ceiling and every
  ## reading of it mean the same as with a bundle that drew RGBX.
  if not runsAsEmbedded() or frameConfig.isNil:
    if not deviceCanvas.isNil:
      dropDeviceCanvas()
    return nil
  let
    width = if frameConfig.rotate in [90, 270]: frameConfig.height else: frameConfig.width
    height = if frameConfig.rotate in [90, 270]: frameConfig.width else: frameConfig.height
    format =
      case deviceCanvasBitsPerPixel
      of 16: pfRgb565
      of 8: pfGray8
      of 4: pfGray4
      else: pfRgbx
  if not deviceCanvas.isNil and deviceCanvas.width == width and
      deviceCanvas.height == height and deviceCanvas.format == format:
    return deviceCanvas
  dropDeviceCanvas()
  deviceCanvas =
    case format
    of pfRgb565: newImage565(width, height)
    of pfGray8: newImageGray8(width, height)
    of pfGray4: newImageGray4(width, height)
    of pfRgbx: newImage(width, height)
  if format == pfRgb565:
    # The rounding the device's 565 stores do, so a gradient does not step.
    deviceCanvas.ditherStores = true
  fosWasmMemorySetHeld(csize_t(width * height * 4 - deviceCanvas.byteSize))
  let described =
    case format
    of pfRgb565: "rgb565 (dithered stores)"
    of pfGray8: "gray8"
    of pfGray4: "gray4 (dithered stores)"
    of pfRgbx: "rgbx"
  log(&"canvas: {width}x{height} {described}")
  deviceCanvas

proc selectSceneById(sceneIdText: string): bool =
  let sceneId = SceneId(sceneIdText)
  if not getInterpretedScenes().hasKey(sceneId) and not isBuiltInScene(sceneIdText):
    setLastError("scene not found: " & sceneIdText)
    return false
  # A switch the scene made (or the dispatcher) is a fresh opening.
  builtInToRestore = ""
  host.makeCurrent(sceneId)
  true

proc restoreBuiltIn() =
  ## A built-in scene the plane kept for a frame it renders for
  ## (docs/server-rendering.md, "Keys, touch and the schedule"): opened again
  ## with the state it had, once that state is seeded, before the first event
  ## or render uses it. Without a seeded state it opens as one opened by name.
  if builtInToRestore.len == 0:
    return
  let sceneId = builtInToRestore
  builtInToRestore = ""
  let stored = pendingSceneStates.getOrDefault(sceneId)
  if stored.isNil or stored.kind != JObject or stored.len == 0:
    return
  if not host.reopenBuiltIn(stored):
    log("built-in scene " & sceneId & " could not be opened again as it was left")

# ------------------------------------------------------------------- setup

proc JS_SetTimezoneOffsetFunc(fn: proc (time: int64): cint {.cdecl.}) {.importc, header: "quickjs/quickjs.h".}

proc frameZoneOffset(time: int64): cint {.cdecl.} =
  ## What JS `Date` takes for the local zone at `time` (milliseconds since
  ## the epoch): minutes west of UTC in the frame's configured zone, not the
  ## browser's. QuickJS asks it (JS_SetTimezoneOffsetFunc, quickts) for every
  ## getTimezoneOffset() and local date field.
  try:
    let zone = if frameConfig.isNil: "UTC" else: frameConfig.timeZone
    cint(-(utcOffsetSeconds(zone, float(time div 1000)).int64 div 60))
  except CatchableError:
    0

proc frameos_wasm_init(width, height: cint, name: cstring,
    timeZone: cstring, settingsJson: cstring): bool {.exportc, cdecl.} =
  coverageCacheBudget = 2 * 1024 * 1024 # pixie keeps shared paths' coverage, as the devices do
  ## Build the minimal FrameConfig + Logger the interpreter and apps expect.
  ## Safe to call repeatedly; every call resets scenes and state.
  ##
  ## settingsJson carries the frame's assembled settings (app API keys etc.),
  ## the same object the device receives in frame.json; apps read secrets from
  ## frameConfig.settings{"openAI"}{"apiKey"} and the like.
  try:
    host.dropScene()
    resetInterpretedScenes()
    setSimulatedEmbedded(false)
    host.sceneId = none(SceneId)
    defaultSceneId = none(SceneId)
    scenesLoadedCount = 0
    host.renderRequested = false
    lastImage = nil
    dropDeviceCanvas()
    deviceCanvasBitsPerPixel = 32
    pendingSceneStates = initTable[string, JsonNode]()
    builtInToRestore = ""
    clearRenderPaletteOverride()

    var settings = %*{}
    let settingsText = $settingsJson
    if settingsText.len > 0:
      try:
        let parsed = parseJson(settingsText)
        if parsed.kind == JObject:
          settings = parsed
      except CatchableError:
        setLastError("init: could not parse settings JSON; running without secrets")

    let tz = ($timeZone).strip()
    frameConfig = FrameConfig(
      name: $name,
      mode: "wasm",
      width: width.int,
      height: height.int,
      device: "wasm",
      deviceConfig: DeviceConfig(
        partial: false,
        partialMaxAreaPercent: 0.0,
        partialMaxRefreshesBeforeFull: 0,
        pins: PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1),
      ),
      maxHttpResponseBytes: DefaultMaxHttpResponseBytes,
      rotate: 0,
      flip: "",
      scalingMode: "cover",
      settings: settings,
      assetsPath: "/srv/assets",
      saveAssets: %*false,
      logToFile: "",
      debug: false,
      timeZone: if tz.len > 0: tz else: "UTC",
      schedule: FrameSchedule(events: @[]),
      gpioButtons: @[],
      controlCode: ControlCode(enabled: false),
      network: NetworkConfig(),
      agent: AgentConfig(),
      mountpoints: MountpointsConfig(items: @[]),
      errorBehavior: ErrorBehaviorConfig(mode: "continue"),
      palette: PaletteConfig(colors: @[]),
      httpsProxy: HttpsProxyConfig(),
      timeZoneUpdates: TimeZoneUpdatesConfig(),
      frameAdminAuth: %*{},
    )
    logger = Logger(
      frameConfig: frameConfig,
      enabled: true,
      log: proc(payload: JsonNode) =
        jsLogHook(($payload).cstring)
    )
    # Load the baked tz data (a device does this from detectSystemTimeZone;
    # there is no /etc/localtime here) so chrono knows the configured zone.
    # JS-side time: `frameos.format` (chrono) and `new Date()` (QuickJS via
    # frameZoneOffset) both follow it.
    initTimeZone()
    jsRuntime.setJsTimeZone(frameConfig.timeZone)
    JS_SetTimezoneOffsetFunc(frameZoneOffset)
    initLock(logger.lock)
    channels.embeddedLogHook = proc(payload: JsonNode) {.gcsafe.} =
      jsLogHook(($payload).cstring)
    channels.embeddedEventHook = proc(sceneId: Option[SceneId], event: string,
        payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
      {.cast(gcsafe).}:
        # Pointer and keyboard input comes from the page in the first place
        # and arrives many times a second: like runner.nim, which keeps it out
        # of the frame log, it is not echoed back.
        if eventPolicy(event).device notin {edPointer, edKeyboard}:
          jsEventHook(event.cstring, (if payload.isNil: "{}" else: $payload).cstring)
        # Queued, never run from inside the run that dispatched it — the rule
        # every host has (docs/events.md). frameos_wasm_event and the render
        # pass drain.
        host.queue(origin, event, payload, sceneId)
    host.frameConfig = frameConfig
    host.logger = logger
    host.note = proc (message: string) = log(message)
    host.logEntry = proc (entry: JsonNode) = jsLogHook(($entry).cstring)
    # Nobody else owns a switch here: the preview just does it.
    host.requestSelect = proc (sceneId: string): bool = selectSceneById(sceneId)
    # The loaded payload's order, for `setCurrentScene {direction}`; a preview
    # of one scene switches nowhere.
    host.sceneOrder = proc (): seq[SceneId] = loadedSceneOrder
    host.runtimeCommand = proc (command: RuntimeCommand, payload: JsonNode) =
      log("runtime command ignored in the preview: " & $command)
    # Backend-persisted state, seeded by frameos_wasm_set_scene_state.
    host.initialState = proc (sceneId: SceneId): JsonNode =
      pendingSceneStates.getOrDefault(sceneId.string)
    host.start()
    result = true
  except Exception as e:
    setLastError("init failed: " & e.msg)
    result = false

# ------------------------------------------------------------------ loading

proc frameos_wasm_load_scenes(payload: cstring): cint {.exportc, cdecl.} =
  ## Parse and install interpreted scenes from the backend's JSON format
  ## (array of scenes). Returns the number of scenes loaded.
  try:
    let inputs = parseInterpretedSceneInputs($payload)
    if inputs.len == 0:
      setLastError("loadScenes: no scenes in payload")
      return 0
    let firstId = some(inputs[0].id)
    let newScenes = buildInterpretedScenes(inputs)
    if newScenes.len == 0:
      setLastError("loadScenes: no scenes survived parsing")
      return 0

    host.dropScene()
    dropParkedLayout()
    replaceInterpretedScenesCache(newScenes)
    scenesLoadedCount = newScenes.len
    # A layout is in no scene list (docs/scene-layouts.md).
    loadedSceneOrder = inputs.mapIt(it.id).filterIt(newScenes.hasKey(it) and not newScenes[it].isLayout)

    if host.sceneId.isSome and not newScenes.hasKey(host.sceneId.get()):
      host.sceneId = none(SceneId)
    defaultSceneId = firstId
    if host.sceneId.isNone:
      host.sceneId = firstId
    host.renderRequested = true
    log(&"loadScenes: {scenesLoadedCount} scene(s) ready, default \"{firstId.get().string}\"")
    scenesLoadedCount.cint
  except Exception as e:
    setLastError("loadScenes failed: " & e.msg)
    0

proc frameos_wasm_set_save_assets(payloadJson: cstring): bool {.exportc, cdecl.} =
  ## The frame's saveAssets config (bool, or {nodeName: bool}), so apps'
  ## "auto" save mode behaves like on a device. Call after init; without it
  ## the runtime keeps the historical default of false.
  try:
    if frameConfig.isNil:
      setLastError("setSaveAssets: init not called")
      return false
    frameConfig.saveAssets = parseJson($payloadJson)
    true
  except Exception as e:
    setLastError("setSaveAssets failed: " & e.msg)
    false

proc frameos_wasm_set_scene_state(sceneId: cstring, stateJson: cstring): bool {.exportc, cdecl.} =
  ## Seed persisted state for a scene before it initializes — how the backend
  ## restores stored state for virtual frames, where every render is a fresh
  ## wasm process. Merged into scene.state (over field defaults) when the
  ## scene inits, so it must be called before the first render.
  try:
    let parsed = parseJson($stateJson)
    if parsed.kind != JObject:
      setLastError("setSceneState: state must be a JSON object")
      return false
    pendingSceneStates[$sceneId] = parsed
    true
  except Exception as e:
    setLastError("setSceneState failed: " & e.msg)
    false

proc frameos_wasm_set_fusion(enabled: bool) {.exportc, cdecl.} =
  ## The differential's kill switch, same contract as the device console's
  ## `set fusion 0|1`: with fusion off every image edge falls back to the
  ## materialized floor, and the rendered pixels must not change. Plans are
  ## built at scene init, so call this before selecting the scene.
  imageFusionEnabled = enabled

proc frameos_wasm_set_embedded(enabled: bool) {.exportc, cdecl.} =
  ## Run as an ESP32 (memory.runsAsEmbedded): `app.frame.embedded` is true,
  ## downloads decode into the canvas, and a JS app's interpreter is kept
  ## between renders while the simulated memory has room, as on an ESP32 that
  ## stays awake (fos_client.c `frameos_nim_set_keep_js`), which is every
  ## frame anybody taps. Releasing them after each render, as a deep-sleeping
  ## frame does, lost an interactive scene's module state and the handlers
  ## of the picture on screen with every render: clicks did nothing and
  ## `active:` never held (jsx-now-playing, 2026-11-08). Off by default, as
  ## a Pi; every frameos_wasm_init turns it off.
  setSimulatedEmbedded(enabled)
  host.keepJsRuntimes = enabled

proc frameos_wasm_set_canvas_bits_per_pixel(bitsPerPixel: cint) {.exportc, cdecl.} =
  ## The canvas the device keeps, while running as an ESP32 (eight times
  ## devices.ts `canvasBytesPerPixel`): 16 RGB565, 8 luma, 4 sixteen greys, 32
  ## RGBX, the default every frameos_wasm_init restores. Anything else is RGBX.
  deviceCanvasBitsPerPixel = if bitsPerPixel in [4.cint, 8.cint, 16.cint]: bitsPerPixel.int else: 32

proc frameos_wasm_set_render_scale(scale: cdouble) {.exportc, cdecl.} =
  ## The frame's render scale (frame.json renderScale, render_scale.nim): what
  ## a .tsx app's JSX is laid out for. 0, the default every frameos_wasm_init
  ## restores, is automatic from the preview's size, as on the frame.
  if not frameConfig.isNil:
    frameConfig.renderScale = if scale > 0.0 and scale <= 4.0: scale.float else: 0.0

proc panelTable(pixelFormat: int): seq[(int, int, int)] =
  ## The stock table of a palette panel, by the firmware's
  ## `fos_pixel_format_t` (embedded_main.nim `panelPaletteForFormat`); empty
  ## for the grey, two-colour and RGB formats.
  case pixelFormat
  of 5: saturated4ColorPalette
  of 6: saturated7ColorPalette
  of 7: spectra6ColorPalette
  else: @[]

proc frameos_wasm_set_frame(frameJson: cstring): bool {.exportc, cdecl.} =
  ## What else of frame.json the frame's own runtime keeps, for a control
  ## plane rendering for a frame (docs/server-rendering.md):
  ## `{"eventMap": [rules] | null, "palette": ["#rrggbb", …] | {"colors":
  ## […]}, "colors": {autoFit, global}, "pixelFormat": n, "gpioButtons":
  ## [{pin, label, role?}], "rotate": 0 | 90 | 180 | 270}`, every key
  ## optional; call it before the scenes are loaded. The event map is the
  ## frame's (docs/events.md "Event map"), read by the dispatcher off this
  ## config; `palette` and `colors` are what the ESP32's settings hand its
  ## runtime (fos_nim_set_palette_impl / _colors_impl), and `pixelFormat` the
  ## panel, so the automatic fit of drawn images aims at the colours the
  ## panel shows, as embedded_main's render does; `rotate` is the frame's,
  ## for the relayed pointers' panel positions.
  try:
    if frameConfig.isNil:
      setLastError("setFrame: init not called")
      return false
    let node = parseJson($frameJson)
    if node.kind != JObject:
      setLastError("setFrame: expected an object")
      return false
    if node.hasKey("eventMap"):
      let rules = node["eventMap"]
      frameConfig.eventMap = if rules.kind == JArray: rules else: nil
    if node.hasKey("palette"):
      var list = node["palette"]
      if list.kind == JObject:
        list = list{"colors"}
      var colors: seq[(int, int, int)] = @[]
      if not list.isNil and list.kind == JArray:
        try:
          for entry in list.items:
            let color = parseHtmlColor(entry.getStr())
            colors.add((int(color.r * 255 + 0.5), int(color.g * 255 + 0.5), int(color.b * 255 + 0.5)))
        except CatchableError:
          # One unreadable colour empties the list, as on the device.
          colors = @[]
      frameConfig.palette.colors = colors
    if node.hasKey("colors"):
      let colors = if node["colors"].kind == JObject: node["colors"] else: newJObject()
      frameConfig.colors = colors
      setFrameColorSettings(parseFrameColorSettings(colors))
    var rebuildInput = false
    if node.hasKey("gpioButtons") and node["gpioButtons"].kind == JArray:
      var buttons: seq[GPIOButton] = @[]
      for entry in node["gpioButtons"].items:
        if entry.kind != JObject or entry{"pin"}.isNil or entry{"pin"}.kind != JInt:
          continue
        buttons.add GPIOButton(pin: entry["pin"].getInt(), label: entry{"label"}.getStr(),
          role: entry{"role"}.getStr())
      frameConfig.gpioButtons = buttons
      rebuildInput = true
    var rotate = 0
    let rotateNode = node{"rotate"}
    if not rotateNode.isNil and rotateNode.kind == JInt and rotateNode.getInt() in [0, 90, 180, 270]:
      rotate = rotateNode.getInt()
      rebuildInput = true
    if rebuildInput:
      # The dispatcher's input state copies the buttons' roles when it is
      # made. And a touch frame's glass reports where it was touched on the
      # panel (fos_touch.c, the wire position), which input_state turns into
      # the scene's point by the frame's rotation: this runtime draws the
      # scene's canvas, already turned (width x height here), so the input
      # state is given the panel the frame has.
      host.start()
      let geometry = FrameConfig(
        width: if rotate in [90, 270]: frameConfig.height else: frameConfig.width,
        height: if rotate in [90, 270]: frameConfig.width else: frameConfig.height,
        rotate: rotate, flip: "", device: frameConfig.device,
        gpioButtons: frameConfig.gpioButtons, inputSettings: frameConfig.inputSettings)
      let keyboardAt = host.events.inputState.keyboardAt
      host.events.inputState = initInputState(geometry)
      host.events.inputState.keyboardAt = keyboardAt
    let format = node{"pixelFormat"}
    if not format.isNil and format.kind == JInt:
      let stock = panelTable(format.getInt())
      setAssetColorsPanelPalette(if stock.len == 0: stock
        else: fitPaletteOverride(frameConfig.palette.colors, stock))
    true
  except Exception as e:
    setLastError("setFrame failed: " & e.msg)
    false

proc frameos_wasm_render_palette(): cstring {.exportc, cdecl.} =
  ## A photo's own dither palette in effect after the last render (its
  ## colour profile's `palette`, utils/dither `renderPaletteOverride`), as
  ## `["#rrggbb", …]`; `[]` when none. A plane packing the picture for a
  ## panel dithers to it before the frame's own palette, as the device's
  ## packer does (`activePalette(framePalette(stock))`).
  let colors = newJArray()
  for (r, g, b) in renderPaletteOverride:
    colors.add(%(&"#{clamp(r, 0, 255):02x}{clamp(g, 0, 255):02x}{clamp(b, 0, 255):02x}"))
  renderPaletteBuffer = $colors
  renderPaletteBuffer.cstring

proc frameos_wasm_select_scene(sceneId: cstring): bool {.exportc, cdecl.} =
  try:
    result = selectSceneById($sceneId)
    # Selected by name from outside: a built-in one is where the plane left
    # it (frameos_wasm_set_scene_state may come before or after this).
    if result and isBuiltInScene($sceneId):
      builtInToRestore = $sceneId
  except Exception as e:
    setLastError("selectScene failed: " & e.msg)
    result = false

# ---------------------------------------------------------------- rendering

var renderedThisProcess = false

proc frameos_wasm_render_guarded(): cint {.importc: "frameos_wasm_render", cdecl.}
  ## The render behind tools/wasm/fos_wasm_mem.c's out-of-memory guard.

proc frameos_wasm_render_impl(): cint {.exportc, cdecl.} =
  ## Render the current scene into an RGBA buffer owned by Nim; read it via
  ## frameos_wasm_buffer/_buffer_len/_width/_height. Returns 0 on success,
  ## 1 when the render produced an error frame, 2 when nothing could render.
  ##
  ## Called through `frameos_wasm_render` in tools/wasm/fos_wasm_mem.c, which
  ## wraps it in the setjmp guard that catches a simulated out-of-memory and
  ## returns 3. Without a simulated memory limit the guard is a direct call.
  host.renderRequested = false
  renderedThisProcess = true
  try:
    refreshDecodeBudget()
    restoreBuiltIn()
    if not host.ensureScene():
      setLastError("no scene selected")
      return 2
    # Log like the device's runner does, so the preview's runtime log shows
    # each render happening even when cached apps return an identical image.
    log($(%*{"event": "render:scene", "width": frameConfig.width, "height": frameConfig.height}))
    let renderStarted = epochTime()
    # Running as an ESP32: the persistent canvas goes in with the event, as on
    # the device; the interpreter's "render" handler owes it the background.
    let canvas = previewCanvas()
    let context = ExecutionContext(
      scene: host.scene,
      event: "render",
      payload: %*{},
      image: canvas,
      hasImage: not canvas.isNil,
      loopIndex: 0,
      loopKey: ".",
      nextSleep: -1
    )
    # Renders, then delivers what the render (and an `init` or `open` before
    # it) dispatched. A `render` dispatched from inside a render is dropped by
    # the interpreter, so this does not loop the preview; one that a handler
    # dispatched is one more pass, as on a frame.
    let image = host.renderScene(context)
    if image.isNil:
      setLastError("render returned no image")
      return 2
    lastImage = image
    lastNextSleep = context.nextSleep
    log($(%*{
      "event": "render:done",
      "sceneId": if host.sceneId.isSome: host.sceneId.get().string else: "",
      "ms": round((epochTime() - renderStarted) * 1000, 3)
    }))
    0
  except Exception as e:
    setLastError("render failed: " & e.msg)
    try:
      if not deviceCanvas.isNil:
        # Into the persistent canvas, as the device does: a fresh full-frame
        # image is the allocation a frame with its canvas held cannot afford.
        deviceCanvas.renderErrorInto(deviceCanvas.width, deviceCanvas.height,
          "Render failed: " & e.msg)
        lastImage = deviceCanvas
      else:
        lastImage = renderError(frameConfig.width, frameConfig.height, "Render failed: " & e.msg)
      1
    except CatchableError:
      lastImage = nil
      2

proc frameos_wasm_buffer(): pointer {.exportc, cdecl.} =
  ## The last frame as RGBA, width * height * 4 bytes: an RGBX image's own
  ## pixels, a 565 or luma canvas expanded into `rgbaOut` (opaque).
  if lastImage.isNil or lastImage.width <= 0 or lastImage.height <= 0:
    return nil
  if lastImage.format == pfRgbx:
    if lastImage.dataLen == 0 or not lastImage.isContiguous:
      return nil
    return addr lastImage.data[0]
  let pixels = lastImage.width * lastImage.height
  if rgbaOut.isNil or rgbaOutPixels != pixels:
    if not rgbaOut.isNil:
      cFree(rgbaOut)
    rgbaOut = cast[ptr UncheckedArray[ColorRGBX]](cMalloc(csize_t(pixels * 4)))
    rgbaOutPixels = if rgbaOut.isNil: 0 else: pixels
    if rgbaOut.isNil:
      return nil
  for y in 0 ..< lastImage.height:
    let row = y * lastImage.width
    for x in 0 ..< lastImage.width:
      rgbaOut[row + x] = lastImage.unsafe[x, y]
  rgbaOut

proc frameos_wasm_buffer_len(): cint {.exportc, cdecl.} =
  if lastImage.isNil: 0.cint
  elif lastImage.format == pfRgbx: (lastImage.dataLen * 4).cint
  else: (lastImage.width * lastImage.height * 4).cint

proc frameos_wasm_width(): cint {.exportc, cdecl.} =
  if lastImage.isNil: 0.cint else: lastImage.width.cint

proc frameos_wasm_height(): cint {.exportc, cdecl.} =
  if lastImage.isNil: 0.cint else: lastImage.height.cint

# ------------------------------------------------------------------- events

proc frameos_wasm_event(eventName: cstring, payloadJson: cstring): bool {.exportc, cdecl.} =
  ## Dispatch an event ("setSceneState", "button", custom events, ...) into
  ## the current scene, exactly like the backend does over the frame API.
  try:
    let payload =
      if payloadJson == nil or ($payloadJson).len == 0:
        %*{}
      else:
        parseJson($payloadJson)
    # Everything the page sends is the `preview` origin; what that may say is
    # the contract's (docs/events-contract.json).
    if eventPolicy($eventName).device notin {edPointer, edKeyboard}:
      jsEventHook(eventName, ($payload).cstring)
    restoreBuiltIn()
    host.send(eoPreview, $eventName, payload)
  except Exception as e:
    setLastError("event " & $eventName & " failed: " & e.msg)
    false

proc frameos_wasm_device_input(inputJson: cstring): cint {.exportc, cdecl.} =
  ## What a thin client's scene would have heard since its last pull, relayed
  ## with the render pull it asked for (frameos/relayed_input.nim): the
  ## Pico's button edges, as its own driver's `gpio`, then an ESP32's events
  ## (`gpio` and pointer events from its driver, its schedule's entries, its
  ## HTTP API's), each from the origin it came from, so the dispatcher's
  ## origin rules and event maps decide as on the board
  ## (docs/server-rendering.md, "Keys, touch and the schedule"). Then time
  ## passes to now, so a tap whose double-press window closed on the board
  ## is a `press` before the render. Returns how many were delivered, -1 when
  ## the input was unreadable.
  try:
    let events = relayedEvents(parseJson($inputJson), getMonoTime().ticks div 1_000_000)
    restoreBuiltIn()
    # A tap lands on what the glass shows: a UI's clickable regions and its
    # handlers are the last render's (ui/events.nim), and a plane renders in
    # a fresh process that has drawn nothing yet. So a pull carrying pointer
    # events draws the scene once first and throws that picture away (found
    # on the bench: a tap on the scene switcher's tile did nothing).
    if not renderedThisProcess:
      for event in events:
        if event.name.startsWith("pointer"):
          discard frameos_wasm_render_guarded()
          break
    for event in events:
      discard host.send(event.origin, event.name, event.payload)
    discard host.tick()
    events.len.cint
  except Exception as e:
    setLastError("device input failed: " & e.msg)
    -1

proc frameos_wasm_control_event(origin: cstring, eventName: cstring, payloadJson: cstring): bool {.exportc, cdecl.} =
  ## An event a control plane sent a thin client (a custom event from the
  ## workspace), held for its render pull and delivered here before the
  ## render, as the frame's own HTTP API or hub would have. From `http:admin`
  ## or `cloud` only, so the contract's origin rules still decide (the cloud
  ## may fire a custom event only where the scene declared it). False when it
  ## came to nothing.
  try:
    let source =
      case $origin
      of $eoHttpAdmin: eoHttpAdmin
      of $eoCloud: eoCloud
      else:
        setLastError("control event from " & $origin & ", which is not a control plane")
        return false
    let payload =
      if payloadJson == nil or ($payloadJson).len == 0:
        %*{}
      else:
        parseJson($payloadJson)
    restoreBuiltIn()
    host.send(source, $eventName, payload)
  except Exception as e:
    setLastError("control event " & $eventName & " failed: " & e.msg)
    false

proc frameos_wasm_tick(): bool {.exportc, cdecl.} =
  ## Time passing with nothing sent — the worker calls this while a pointer or
  ## a button is held or a button press waits for a possible second one, so a
  ## long press is delivered while the finger is still down, as on a frame. True when it made an event; ask frameos_wasm_render_requested.
  try:
    restoreBuiltIn()
    host.tick()
  except Exception as e:
    setLastError("tick failed: " & e.msg)
    false

proc frameos_wasm_pointers_down(): cint {.exportc, cdecl.} =
  ## How much input the runtime is still timing: pointers held, GPIO buttons
  ## held, button presses waiting out their double-press window, and a UI's
  ## timer (a key's light, a held key: ui/events.nim). The
  ## worker ticks while any is, so a long press lands while the finger is
  ## down and a `press` once its window closes.
  if host.events.isNil: 0.cint
  else: (host.events.inputState.pointersDown + host.events.inputState.buttonsBusy +
    (if uiTimersPending(): 1 else: 0)).cint

proc frameos_wasm_render_requested(): bool {.exportc, cdecl.} =
  host.renderRequested

# ------------------------------------------------------------------- status

proc frameos_wasm_next_sleep(): cdouble {.exportc, cdecl.} =
  ## Seconds the scene asked to sleep before the next render
  ## (logic/nextSleepDuration); -1 when the scene didn't override it.
  lastNextSleep.cdouble

proc frameos_wasm_scene_interval(): cdouble {.exportc, cdecl.} =
  if not host.scene.isNil and host.scene.refreshInterval > 0:
    return host.scene.refreshInterval.cdouble
  if not host.exported.isNil and host.exported.refreshInterval > 0:
    return host.exported.refreshInterval.cdouble
  0.0

proc frameos_wasm_scene_info(): cstring {.exportc, cdecl.} =
  let scenes = getInterpretedScenes()
  var sceneItems = newJArray()
  for sceneId, exported in scenes:
    sceneItems.add(%*{
      "id": sceneId.string,
      "name": if exported.name.len > 0: exported.name else: sceneId.string,
      "refreshInterval": exported.refreshInterval,
    })
  sceneInfoBuffer = $(%*{
    "loaded": scenesLoadedCount,
    "currentSceneId": if host.sceneId.isSome: host.sceneId.get().string else: "",
    "currentSceneName": currentSceneName(),
    "defaultSceneId": if defaultSceneId.isSome: defaultSceneId.get().string else: "",
    "renderRequested": host.renderRequested,
    "scenes": sceneItems,
  })
  sceneInfoBuffer.cstring

proc frameos_wasm_scene_state(): cstring {.exportc, cdecl.} =
  if host.scene.isNil or host.scene.state.isNil or host.scene.state.kind != JObject:
    sceneStateBuffer = "{}"
  else:
    sceneStateBuffer = $host.scene.state
  sceneStateBuffer.cstring

proc frameos_wasm_last_error(): cstring {.exportc, cdecl.} =
  lastErrorBuffer.cstring

proc frameos_wasm_run_app_tests(appJson: cstring, testFile: cstring): cstring {.exportc, cdecl.} =
  ## Run one test file of a JavaScript app (`appJson`: the app as a scene
  ## carries it, or just `{"sources": {...}}`) in this runtime's interpreter
  ## and return the report (js_runtime/app_tests.nim) as JSON. Needs
  ## frameos_wasm_init first, for the frame the tests see.
  try:
    let app = parseJson($appJson)
    let sources = if app.kind == JObject and app.hasKey("sources"): app["sources"] else: app
    appTestsBuffer = $runJsAppTests(sources, $testFile, frameConfig)
  except Exception as e:
    appTestsBuffer = $(%*{"ok": false, "error": "could not run the tests: " & e.msg,
      "counts": {"passed": 0, "failed": 0, "skipped": 0, "total": 0}, "durationMs": 0, "children": [], "logs": []})
  appTestsBuffer.cstring

# The FrameOS version this runtime was built from, in the same published form
# a frame reports ("2026.9.0", no build hash) — so a preview can say which
# interpreter it renders with, and whether that is the firmware the frame
# actually runs. Baked at build time (-d:frameosVersion, from versions.json).
proc frameos_wasm_version(): cstring {.exportc, cdecl.} =
  versionBuffer = publishedFrameOSVersion(compiledFrameOSVersion())
  versionBuffer.cstring

# ---------------------------------------------------------------- keep alive
# Nim/ARC emits destructor calls for every module-level global at the end of
# the main module's top-level code — the moment main() returns, all global
# tables (scene registries, asset tables, ...) are freed, while MODULARIZE
# keeps the wasm instance callable. Exiting through emscripten's live-runtime
# unwind skips that epilogue entirely and keeps the runtime alive for the
# exported frameos_wasm_* calls.
proc emscripten_exit_with_live_runtime() {.importc, header: "<emscripten.h>", noreturn.}
emscripten_exit_with_live_runtime()
