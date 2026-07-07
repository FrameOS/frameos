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

import std/[json, locks, options, strformat, strutils, tables]
import pixie

import frameos/types
import frameos/channels
import frameos/interpreter
import frameos/utils/image as frameos_image
import frameos/utils/memory
import frameos/js_runtime/runtime as jsRuntime

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
  currentScene: FrameScene
  currentExported: ExportedInterpretedScene
  currentSceneId: Option[SceneId] = none(SceneId)
  defaultSceneId: Option[SceneId] = none(SceneId)
  scenesLoadedCount = 0
  renderRequested = false
  handlingEvent = false
  lastImage: Image
  lastNextSleep: float = -1
  sceneInfoBuffer: string
  sceneStateBuffer: string
  lastErrorBuffer: string

proc currentSceneName(): string =
  if not currentExported.isNil and currentExported.name.len > 0:
    return currentExported.name
  if currentSceneId.isSome:
    return currentSceneId.get().string
  ""

proc setLastError(msg: string) =
  lastErrorBuffer = msg
  if msg.len > 0:
    log("error: " & msg)

# ------------------------------------------------------------------ cleanup

proc cleanupScene(scene: FrameScene) =
  ## Break ORC cycles and close the scene's QuickJS context before dropping
  ## the last reference (mirrors src/embedded/embedded_runtime.nim).
  if scene.isNil or not (scene of InterpretedFrameScene):
    return
  let interpreted = InterpretedFrameScene(scene)
  for _, childScene in interpreted.sceneNodes:
    cleanupScene(childScene)
  interpreted.execNode = nil
  interpreted.getDataNode = nil
  interpreted.appsByNodeId = initTable[NodeId, AppRoot]()
  interpreted.appInputsForNodeId = initTable[NodeId, Table[string, NodeId]]()
  interpreted.appInlineInputsForNodeId = initTable[NodeId, Table[string, string]]()
  interpreted.codeInputsForNodeId = initTable[NodeId, Table[string, NodeId]]()
  interpreted.codeInlineInputsForNodeId = initTable[NodeId, Table[string, string]]()
  interpreted.sceneNodes = initTable[NodeId, FrameScene]()
  interpreted.sceneExportByNodeId = initTable[NodeId, ExportedScene]()
  interpreted.nextNodeIds = initTable[NodeId, NodeId]()
  interpreted.eventListeners = initTable[string, seq[NodeId]]()
  interpreted.nodes = initTable[NodeId, DiagramNode]()
  interpreted.edges = @[]
  interpreted.cacheValues = initTable[NodeId, Value]()
  interpreted.cacheTimes = initTable[NodeId, float]()
  interpreted.cacheKeys = initTable[NodeId, JsonNode]()
  cleanupSceneJs(interpreted)

proc dropCurrentScene() =
  if not currentScene.isNil:
    cleanupScene(currentScene)
    currentScene = nil
    currentExported = nil

# ------------------------------------------------------------------- scenes

proc selectSceneById(sceneIdText: string): bool =
  let sceneId = SceneId(sceneIdText)
  let scenes = getInterpretedScenes()
  if not scenes.hasKey(sceneId):
    setLastError("scene not found: " & sceneIdText)
    return false
  dropCurrentScene()
  currentSceneId = some(sceneId)
  renderRequested = true
  true

proc ensureScene(): bool =
  if not currentScene.isNil:
    return true
  if currentSceneId.isNone:
    return false
  let sceneId = currentSceneId.get()
  let scenes = getInterpretedScenes()
  if not scenes.hasKey(sceneId):
    setLastError("scene not found: " & sceneId.string)
    return false
  currentExported = scenes[sceneId]
  currentScene = interpreter.init(sceneId, frameConfig, logger, %*{})
  log(&"scene \"{currentSceneName()}\" initialized")
  true

proc runSceneEvent(event: string, payload: JsonNode) =
  if currentScene.isNil:
    return
  let context = ExecutionContext(scene: currentScene, event: event,
      payload: if payload.isNil: %*{} else: payload, loopIndex: 0, loopKey: ".")
  runEvent(currentScene, context)

# ------------------------------------------------------------------- setup

proc frameos_wasm_init(width, height: cint, name: cstring,
    timeZone: cstring, settingsJson: cstring): bool {.exportc, cdecl.} =
  ## Build the minimal FrameConfig + Logger the interpreter and apps expect.
  ## Safe to call repeatedly; every call resets scenes and state.
  ##
  ## settingsJson carries the frame's assembled settings (app API keys etc.),
  ## the same object the device receives in frame.json; apps read secrets from
  ## frameConfig.settings{"openAI"}{"apiKey"} and the like.
  try:
    dropCurrentScene()
    resetInterpretedScenes()
    currentSceneId = none(SceneId)
    defaultSceneId = none(SceneId)
    scenesLoadedCount = 0
    renderRequested = false
    lastImage = nil

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
      imageEngine: "pixie",
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
    initLock(logger.lock)
    channels.embeddedLogHook = proc(payload: JsonNode) {.gcsafe.} =
      jsLogHook(($payload).cstring)
    channels.embeddedEventHook = proc(sceneId: Option[SceneId], event: string,
        payload: JsonNode) {.gcsafe.} =
      {.cast(gcsafe).}:
        jsEventHook(event.cstring, (if payload.isNil: "{}" else: $payload).cstring)
        if event == "render":
          renderRequested = true
        elif not currentScene.isNil and not handlingEvent:
          # Unlike the ESP32 runtime the preview forwards every non-render
          # event to the scene (like runner.nim does on Linux), so custom
          # event nodes ("button", user events) work interactively. The
          # handlingEvent latch keeps a scene that re-dispatches its own
          # event from recursing forever.
          if event == "setCurrentScene" and payload != nil and payload.kind == JObject and
              payload.hasKey("sceneId"):
            let nextId = payload{"sceneId"}.getStr()
            if nextId.len > 0 and (currentSceneId.isNone or currentSceneId.get().string != nextId):
              discard selectSceneById(nextId)
              return
          handlingEvent = true
          try:
            runSceneEvent(event, payload)
          except Exception as e:
            setLastError("event " & event & " failed: " & e.msg)
          finally:
            handlingEvent = false
          renderRequested = true
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

    dropCurrentScene()
    replaceInterpretedScenesCache(newScenes)
    scenesLoadedCount = newScenes.len

    if currentSceneId.isSome and not newScenes.hasKey(currentSceneId.get()):
      currentSceneId = none(SceneId)
    defaultSceneId = firstId
    if currentSceneId.isNone:
      currentSceneId = firstId
    renderRequested = true
    log(&"loadScenes: {scenesLoadedCount} scene(s) ready, default \"{firstId.get().string}\"")
    scenesLoadedCount.cint
  except Exception as e:
    setLastError("loadScenes failed: " & e.msg)
    0

proc frameos_wasm_select_scene(sceneId: cstring): bool {.exportc, cdecl.} =
  try:
    selectSceneById($sceneId)
  except Exception as e:
    setLastError("selectScene failed: " & e.msg)
    false

# ---------------------------------------------------------------- rendering

proc frameos_wasm_render(): cint {.exportc, cdecl.} =
  ## Render the current scene into an RGBA buffer owned by Nim; read it via
  ## frameos_wasm_buffer/_buffer_len/_width/_height. Returns 0 on success,
  ## 1 when the render produced an error frame, 2 when nothing could render.
  renderRequested = false
  try:
    refreshDecodeBudget()
    if not ensureScene():
      setLastError("no scene selected")
      return 2
    let context = ExecutionContext(
      scene: currentScene,
      event: "render",
      payload: %*{},
      hasImage: false,
      loopIndex: 0,
      loopKey: ".",
      nextSleep: -1
    )
    let image = interpreter.render(currentScene, context)
    if image.isNil:
      setLastError("render returned no image")
      return 2
    lastImage = image
    lastNextSleep = context.nextSleep
    # Scene graphs often dispatch "render" while handling the render event
    # itself; that must not loop the preview forever.
    renderRequested = false
    0
  except Exception as e:
    setLastError("render failed: " & e.msg)
    try:
      lastImage = renderError(frameConfig.width, frameConfig.height, "Render failed: " & e.msg)
      1
    except CatchableError:
      lastImage = nil
      2

proc frameos_wasm_buffer(): pointer {.exportc, cdecl.} =
  if lastImage.isNil or lastImage.data.len == 0:
    return nil
  addr lastImage.data[0]

proc frameos_wasm_buffer_len(): cint {.exportc, cdecl.} =
  if lastImage.isNil: 0.cint
  else: (lastImage.data.len * 4).cint

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
    channels.sendEvent($eventName, payload)
    true
  except Exception as e:
    setLastError("event " & $eventName & " failed: " & e.msg)
    false

proc frameos_wasm_render_requested(): bool {.exportc, cdecl.} =
  renderRequested

# ------------------------------------------------------------------- status

proc frameos_wasm_next_sleep(): cdouble {.exportc, cdecl.} =
  ## Seconds the scene asked to sleep before the next render
  ## (logic/nextSleepDuration); -1 when the scene didn't override it.
  lastNextSleep.cdouble

proc frameos_wasm_scene_interval(): cdouble {.exportc, cdecl.} =
  if not currentScene.isNil and currentScene.refreshInterval > 0:
    return currentScene.refreshInterval.cdouble
  if not currentExported.isNil and currentExported.refreshInterval > 0:
    return currentExported.refreshInterval.cdouble
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
    "currentSceneId": if currentSceneId.isSome: currentSceneId.get().string else: "",
    "currentSceneName": currentSceneName(),
    "defaultSceneId": if defaultSceneId.isSome: defaultSceneId.get().string else: "",
    "renderRequested": renderRequested,
    "scenes": sceneItems,
  })
  sceneInfoBuffer.cstring

proc frameos_wasm_scene_state(): cstring {.exportc, cdecl.} =
  if currentScene.isNil or currentScene.state.isNil or currentScene.state.kind != JObject:
    sceneStateBuffer = "{}"
  else:
    sceneStateBuffer = $currentScene.state
  sceneStateBuffer.cstring

proc frameos_wasm_last_error(): cstring {.exportc, cdecl.} =
  lastErrorBuffer.cstring

# ---------------------------------------------------------------- keep alive
# Nim/ARC emits destructor calls for every module-level global at the end of
# the main module's top-level code — the moment main() returns, all global
# tables (scene registries, asset tables, ...) are freed, while MODULARIZE
# keeps the wasm instance callable. Exiting through emscripten's live-runtime
# unwind skips that epilogue entirely and keeps the runtime alive for the
# exported frameos_wasm_* calls.
proc emscripten_exit_with_live_runtime() {.importc, header: "<emscripten.h>", noreturn.}
emscripten_exit_with_live_runtime()
