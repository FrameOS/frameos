# FrameOS embedded scene runtime (M3: interpreted scenes via QuickJS).
#
# Owns the interpreted-scene lifecycle on the ESP32: scenes arrive as the
# same JSON the backend ships to Linux frames (seq[FrameSceneInput]), get
# parsed/instantiated through frameos/interpreter, and render through the
# scene graph — code nodes and inline expressions run on QuickJS, app nodes
# run the AOT-compiled standard app library. The firmware's C side feeds us
# scene JSON (from SPIFFS or the backend) and asks for rendered frames.

import std/[json, locks, options, strformat, tables]
import pixie

import frameos/types
import frameos/channels
import frameos/interpreter
import frameos/js_runtime/runtime as jsRuntime

# ------------------------------------------------------------------ C hooks

proc espLog(msg: cstring) {.importc: "frameos_nim_log_hook", cdecl.}

proc log*(msg: string) =
  espLog(msg.cstring)

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

proc sceneCount*(): int =
  scenesLoadedCount

proc hasScene*(): bool =
  not currentExported.isNil or defaultSceneId.isSome

proc currentSceneName*(): string =
  if not currentExported.isNil and currentExported.name.len > 0:
    return currentExported.name
  if currentSceneId.isSome:
    return currentSceneId.get().string
  ""

proc takeRenderRequested*(): bool =
  result = renderRequested
  renderRequested = false

# ------------------------------------------------------------------- setup

proc initRuntime*(width, height: int, name: string) =
  ## Build the minimal FrameConfig + Logger the interpreter and apps expect.
  ## Logs go synchronously to the firmware's ESP_LOG hook; events (e.g. a
  ## "render" dispatched from a scene) set a flag the C render loop polls.
  frameConfig = FrameConfig(
    name: name,
    mode: "embedded",
    width: width,
    height: height,
    device: "embedded",
    deviceConfig: DeviceConfig(pins: PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1)),
    maxHttpResponseBytes: DefaultMaxHttpResponseBytes,
    rotate: 0,
    flip: "",
    scalingMode: "cover",
    imageEngine: "pixie",
    settings: %*{},
    assetsPath: "/state/assets",
    saveAssets: %*false,
    logToFile: "",
    debug: false,
    timeZone: "UTC",
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
      espLog(($payload).cstring)
  )
  initLock(logger.lock)
  channels.embeddedLogHook = proc(payload: JsonNode) {.gcsafe.} =
    espLog(($payload).cstring)
  channels.embeddedEventHook = proc(sceneId: Option[SceneId], event: string, payload: JsonNode) {.gcsafe.} =
    if event == "render":
      renderRequested = true
    elif event in ["setSceneState", "setCurrentScene"] and not currentScene.isNil:
      try:
        let context = ExecutionContext(scene: currentScene, event: event,
            payload: if payload.isNil: %*{} else: payload, loopIndex: 0, loopKey: ".")
        runEvent(currentScene, context)
      except Exception as e:
        log("event " & event & " failed: " & e.msg)

proc cleanupScene(scene: FrameScene) =
  ## Break ORC cycles and close the scene's QuickJS context before dropping
  ## the last reference (mirrors scenes.nim cleanupSceneRuntime, which lives
  ## outside the embedded build).
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

# ------------------------------------------------------------------- scenes

proc loadScenes*(payload: string): int =
  ## Parse and install interpreted scenes from the backend's JSON format
  ## (array of scenes; same payload Linux frames read from scenes.json).
  ## Returns the number of scenes loaded; the current scene is re-created
  ## on the next render so hot updates don't tear down mid-render state.
  let inputs = parseInterpretedSceneInputs(payload)
  if inputs.len == 0:
    log("loadScenes: no scenes in payload")
    return 0

  let firstId = some(inputs[0].id)
  let newScenes = buildInterpretedScenes(inputs)
  if newScenes.len == 0:
    log("loadScenes: no scenes survived parsing")
    return 0

  # Tear down the old scene before swapping the registry so its QuickJS
  # context and app instances are reclaimed.
  if not currentScene.isNil:
    cleanupScene(currentScene)
    currentScene = nil
    currentExported = nil

  replaceInterpretedScenesCache(newScenes)
  scenesLoadedCount = newScenes.len

  # Keep the current scene across updates when it still exists; otherwise
  # fall back to the first scene in the payload.
  if currentSceneId.isSome and not newScenes.hasKey(currentSceneId.get()):
    currentSceneId = none(SceneId)
  defaultSceneId = firstId
  if currentSceneId.isNone:
    currentSceneId = firstId

  log(&"loadScenes: {scenesLoadedCount} scene(s) ready, default \"{firstId.get().string}\"")
  scenesLoadedCount

proc ensureScene(): bool =
  if not currentScene.isNil:
    return true
  if currentSceneId.isNone:
    return false
  let sceneId = currentSceneId.get()
  let scenes = getInterpretedScenes()
  if not scenes.hasKey(sceneId):
    log("scene not found: " & sceneId.string)
    return false
  currentExported = scenes[sceneId]
  currentScene = interpreter.init(sceneId, frameConfig, logger, %*{})
  log(&"scene \"{currentSceneName()}\" initialized")
  true

proc sceneRefreshSeconds*(): float =
  if not currentScene.isNil and currentScene.refreshInterval > 0:
    return currentScene.refreshInterval
  if not currentExported.isNil and currentExported.refreshInterval > 0:
    return currentExported.refreshInterval
  0.0

proc renderCurrentScene*(): Option[Image] =
  ## Render the active interpreted scene; none() when no scenes are loaded
  ## (the caller falls back to the baked demo scene).
  if not ensureScene():
    return none(Image)
  let context = ExecutionContext(
    scene: currentScene,
    event: "render",
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: "."
  )
  let image = interpreter.render(currentScene, context)
  if image.isNil:
    log("render returned no image")
    return none(Image)
  some(image)
