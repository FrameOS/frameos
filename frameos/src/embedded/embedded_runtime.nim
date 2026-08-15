# FrameOS embedded scene runtime for interpreted scenes via QuickJS.
#
# Owns the interpreted-scene lifecycle on the ESP32: scenes arrive as the
# same JSON the backend ships to Linux frames (seq[FrameSceneInput]), get
# parsed/instantiated through frameos/interpreter, and render through the
# scene graph — code nodes and inline expressions run on QuickJS, app nodes
# run the AOT-compiled standard app library. The firmware's C side feeds us
# scene JSON (from SPIFFS or the backend) and asks for rendered frames.

import std/[json, locks, options, sequtils, strformat, tables]
import pixie

import frameos/types
import frameos/channels
when defined(memProbe): import frameos/utils/memory
import frameos/interpreter
import frameos/planner
import frameos/js_runtime/runtime as jsRuntime
import frameos/js_runtime/app_runtime

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

type
  SceneCatalogEntry* = object
    ## One scene the frame CAN run, as listed in /state/scenes/index.json —
    ## id, display name and refresh interval, and nothing else. The point is
    ## that this is all the memory a non-active scene costs: its nodes, its
    ## app configs and (increasingly) its JavaScript stay on flash until the
    ## scene is selected. A frame with twenty JS-heavy scenes holds one.
    id*: string
    name*: string
    refreshInterval*: float

var sceneCatalog: seq[SceneCatalogEntry] = @[]
  ## Empty on the legacy path (one scenes.json parsed whole), in which case
  ## every listing falls back to the resident cache. Non-empty means the
  ## firmware is feeding scenes one at a time.

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

proc sceneInfoJson*(): string =
  ## The scene list as the console, the USB API and the cloud see it.
  ##
  ## Sourced from the CATALOG when the firmware stores scenes as per-scene
  ## files (the lazy path: only the active scene is parsed, everything else is
  ## a name and an id read from the index). Falls back to the resident cache
  ## for the legacy single-payload path, where every scene is parsed anyway.
  ## `available` is what the frame can switch to; `loaded` is what is actually
  ## built in memory, which on the lazy path is at most one.
  var sceneItems = newJArray()
  var available = 0
  if sceneCatalog.len > 0:
    for entry in sceneCatalog:
      sceneItems.add(%*{
        "id": entry.id,
        "name": if entry.name.len > 0: entry.name else: entry.id,
        "refreshInterval": entry.refreshInterval,
      })
    available = sceneCatalog.len
  else:
    let scenes = getInterpretedScenes()
    for sceneId, exported in scenes:
      sceneItems.add(%*{
        "id": sceneId.string,
        "name": if exported.name.len > 0: exported.name else: sceneId.string,
        "refreshInterval": exported.refreshInterval,
      })
    available = scenes.len
  let payload = %*{
    "loaded": scenesLoadedCount,
    "available": available,
    "hasScene": hasScene(),
    "currentSceneId": if currentSceneId.isSome: currentSceneId.get().string else: "",
    "currentSceneName": currentSceneName(),
    "defaultSceneId": if defaultSceneId.isSome: defaultSceneId.get().string else: "",
    "renderRequested": renderRequested,
    "scenes": sceneItems,
  }
  $payload

proc sceneStateJson*(): string =
  if currentScene.isNil or currentScene.state.isNil or currentScene.state.kind != JObject:
    return "{}"
  $currentScene.state

proc takeRenderRequested*(): bool =
  result = renderRequested
  renderRequested = false

proc fos_nim_send_event_impl*(eventName: cstring, payloadJson: cstring): bool {.exportc, cdecl.} =
  try:
    let payload =
      if payloadJson == nil or ($payloadJson).len == 0:
        %*{}
      else:
        parseJson($payloadJson)
    channels.sendEvent($eventName, payload)
    result = true
  except Exception as e:
    log("event " & $eventName & " failed: " & e.msg)
    result = false

# ------------------------------------------------------------------- setup

proc getFrameConfig*(): FrameConfig =
  frameConfig

proc fos_nim_set_scaling_mode_impl(mode: cstring) {.exportc, cdecl.} =
  ## Fallback fit for image consumers that do not place the image themselves
  ## (a node's own placement wins since #321). fos_client pushes the config
  ## value every render pass, so console/settings/cloud changes apply live —
  ## unlike rotate, no canvas re-init is involved. The C side normalizes to
  ## contain/cover/stretch/center before calling.
  if not frameConfig.isNil and mode != nil and mode.len > 0:
    frameConfig.scalingMode = $mode

proc fos_nim_set_debug_impl(enabled: cint) {.exportc, cdecl.} =
  ## Turns the interpreter's per-node memory profile on and off at runtime
  ## (`set debug 1` on the console). It logs a line per node per render — the
  ## byte size of the value on that edge, the heap delta across the node, and
  ## which fusion tier the planner picked — which is how you find out where a
  ## render's peak memory actually goes. Off by default: on a memory-tight
  ## device the answer matters, but so does not paying for it every render.
  if not frameConfig.isNil:
    frameConfig.debug = enabled != 0

proc initRuntime*(width, height: int, name: string, maxHttpResponseBytes: int,
    rotate = 0) =
  ## Build the minimal FrameConfig + Logger the interpreter and apps expect.
  ## Logs go synchronously to the firmware's ESP_LOG hook; events (e.g. a
  ## "render" dispatched from a scene) set a flag the C render loop polls.
  ##
  ## `settings` starts empty and stays owned by the firmware: the settings poll
  ## (fos_settings.c) delivers backend and cloud service settings alike through
  ## fos_nim_apply_service_settings. Nim never fetches them itself.
  let httpResponseLimit =
    if maxHttpResponseBytes > 0: maxHttpResponseBytes else: DefaultMaxHttpResponseBytes
  var settings = %*{}
  frameConfig = FrameConfig(
    name: name,
    mode: "embedded",
    width: width,
    height: height,
    device: "embedded",
    deviceConfig: DeviceConfig(
      partial: false,
      partialMaxAreaPercent: 0.0,
      partialMaxRefreshesBeforeFull: 0,
      pins: PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1),
    ),
    maxHttpResponseBytes: httpResponseLimit,
    # width/height are the PANEL's; the interpreter creates the scene canvas
    # at the rotated dimensions (same contract as runner.renderSceneImage on
    # Pi) and the embedded packers rotate while packing.
    rotate: (rotate + 1080) mod 360,
    flip: "",
    scalingMode: "cover",
    settings: settings,
    assetsPath: "/srv/assets",
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
    {.cast(gcsafe).}:
      # Every event reaches the scene graph, not a hardcoded few. This used to
      # dispatch only setSceneState/setCurrentScene, which silently dropped
      # everything a scene defines its own handler for — a GPIO button press
      # arrived from the firmware as a "button" event, matched no branch, and
      # vanished. The Counter scene's `event button` nodes never ran, and the
      # frame looked like it had dead buttons. The Pi runner has always
      # dispatched by name (frameos/runner.nim), so this also removes a
      # difference between the two runtimes that scene authors could not see.
      if event == "render":
        renderRequested = true
      elif not currentScene.isNil:
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
  when defined(memProbe): memProbe("  cleanupScene: entry")
  let interpreted = InterpretedFrameScene(scene)
  for _, childScene in interpreted.sceneNodes:
    cleanupScene(childScene)
  interpreted.execNode = nil
  interpreted.getDataNode = nil
  # Before the apps are dropped: each JS app node owns a QuickJS runtime with
  # no destructor, and liveJsRuntimes keeps it reachable regardless, so the
  # scene going away frees none of it.
  for _, app in interpreted.appsByNodeId:
    releaseJsAppRuntime(app)
  when defined(memProbe): memProbe("  cleanupScene: js app runtimes released")
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
  interpreted.cacheExprs = initTable[NodeId, JsonNode]()
  when defined(memProbe): memProbe("  cleanupScene: tables cleared")
  cleanupSceneJs(interpreted)
  when defined(memProbe): memProbe("  cleanupScene: js closed")

# ------------------------------------------------------------------- scenes

proc loadScenes*(payload: string): int =
  when defined(memProbe): memProbe("  >>> loadScenes payload=" & $payload.len & "B")
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
    when defined(memProbe): memProbe("  loadScene: old scene dropped")

  replaceInterpretedScenesCache(newScenes)
  when defined(memProbe): memProbe("  loadScene: scenes cache replaced")
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

proc setSceneCatalog*(indexJson: string): int =
  ## Install the list of scenes available on flash, WITHOUT parsing any of
  ## them. `indexJson` is /state/scenes/index.json:
  ##   {"scenes": [{"id", "name", "refreshInterval"}, …], "default": "<id>"}
  ##
  ## This is what makes lazy loading possible: the frame can list, schedule
  ## and switch scenes knowing only this, and pays for a scene's nodes and
  ## JavaScript only while it is the active one.
  var parsed: JsonNode
  try:
    parsed = parseJson(indexJson)
  except CatchableError as e:
    log("setSceneCatalog: unparseable index: " & e.msg)
    return 0
  if parsed.isNil or parsed.kind != JObject:
    log("setSceneCatalog: index is not an object")
    return 0
  var entries: seq[SceneCatalogEntry] = @[]
  let scenesNode = parsed{"scenes"}
  if not scenesNode.isNil and scenesNode.kind == JArray:
    for item in scenesNode.items:
      if item.kind != JObject:
        continue
      let id = item{"id"}.getStr()
      if id.len == 0:
        continue
      entries.add(SceneCatalogEntry(
        id: id,
        name: item{"name"}.getStr(),
        refreshInterval: item{"refreshInterval"}.getFloat(0.0),
      ))
  sceneCatalog = entries
  if entries.len == 0:
    log("setSceneCatalog: no scenes in index")
    return 0
  # The default is what boots when nothing was selected before; fall back to
  # the first entry so an index without one still starts something.
  let defaultId = parsed{"default"}.getStr()
  defaultSceneId = some(SceneId(
    if defaultId.len > 0: defaultId else: entries[0].id))
  # A previously selected scene that is no longer on flash must not stick
  # around as the target of the next render.
  if currentSceneId.isSome and
      not entries.anyIt(it.id == currentSceneId.get().string):
    currentSceneId = none(SceneId)
  log(&"setSceneCatalog: {entries.len} scene(s) available, default \"{defaultSceneId.get().string}\"")
  entries.len

proc catalogHas(sceneIdText: string): bool =
  sceneCatalog.anyIt(it.id == sceneIdText)

proc loadScene*(payload: string): bool =
  when defined(memProbe): memProbe("  >>> loadScene payload=" & $payload.len & "B")
  ## Build ONE scene and make it the only resident one, tearing down whatever
  ## was live. `payload` is a single scene object (the element the combined
  ## scenes.json holds in its array); it is wrapped so the existing array
  ## parser can be reused rather than duplicated.
  ##
  ## Returns false and leaves the runtime scene-less on a bad payload — the
  ## caller (fos_scenes.c) logs and keeps the previous file on flash, so a
  ## corrupt scene cannot take the frame down permanently.
  let inputs = parseInterpretedSceneInputs("[" & payload & "]")
  if inputs.len == 0:
    log("loadScene: payload contained no scene")
    return false
  let newScenes = buildInterpretedScenes(inputs)
  if newScenes.len == 0:
    log("loadScene: scene did not survive parsing")
    return false

  if not currentScene.isNil:
    cleanupScene(currentScene)
    currentScene = nil
    currentExported = nil
    when defined(memProbe): memProbe("  loadScene: old scene dropped")

  replaceInterpretedScenesCache(newScenes)
  when defined(memProbe): memProbe("  loadScene: scenes cache replaced")
  scenesLoadedCount = newScenes.len
  let sceneId = inputs[0].id
  currentSceneId = some(sceneId)
  if defaultSceneId.isNone:
    defaultSceneId = some(sceneId)
  renderRequested = true
  log(&"loadScene: \"{sceneId.string}\" resident (1 of {max(sceneCatalog.len, 1)})")
  true

proc selectScene*(sceneIdText: string): bool =
  when defined(memProbe): memProbe("  >>> selectScene " & sceneIdText)
  let sceneId = SceneId(sceneIdText)
  let scenes = getInterpretedScenes()
  # On the lazy path the scene is on flash, not in the cache: record the
  # choice and let the firmware feed the payload through loadScene. Returning
  # true here means "known scene", not "already loaded".
  if sceneCatalog.len > 0 and not scenes.hasKey(sceneId):
    if not catalogHas(sceneIdText):
      log("selectScene: scene not found: " & sceneIdText)
      return false
    currentSceneId = some(sceneId)
    renderRequested = true
    log("selectScene: " & sceneIdText & " (pending load from flash)")
    return true
  if not scenes.hasKey(sceneId):
    log("selectScene: scene not found: " & sceneIdText)
    return false

  if not currentScene.isNil:
    cleanupScene(currentScene)
    currentScene = nil
    currentExported = nil

  currentSceneId = some(sceneId)
  renderRequested = true
  log("selectScene: " & sceneIdText)
  true

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
  when defined(memProbe): memProbe("  SCENE INIT " & sceneId.string)
  currentScene = interpreter.init(sceneId, frameConfig, logger, %*{})
  when defined(memProbe): memProbe("  ensureScene: init done")
  log(&"scene \"{currentSceneName()}\" initialized")
  true

proc fos_nim_set_fusion_impl(enabled: cint) {.exportc, cdecl.} =
  ## Test hook for the value-pipeline differential (docs/value-pipeline.md,
  ## principle 4): with fusion off, every image edge falls back to a fully
  ## materialized `Value` — and the panel must come out identical. Rendering the
  ## same scene both ways and comparing the two previews is the on-hardware
  ## version of the host harness, and the only way to check the claim against
  ## the real decoders rather than a test seam.
  ##
  ## Plans are built when a scene loads, so the flag alone would not take
  ## effect: drop the live scene and let the next render re-plan it.
  let wanted = enabled != 0
  if imageFusionEnabled == wanted:
    return
  imageFusionEnabled = wanted
  if not currentScene.isNil:
    cleanupScene(currentScene)
    currentScene = nil
    currentExported = nil
  renderRequested = true
  log("image fusion " & (if wanted: "enabled" else: "disabled") & "; scene will re-plan")

proc sceneRefreshSeconds*(): float =
  if not currentScene.isNil and currentScene.refreshInterval > 0:
    return currentScene.refreshInterval
  if not currentExported.isNil and currentExported.refreshInterval > 0:
    return currentExported.refreshInterval
  0.0

var lastNextSleep: float = -1

proc sceneNextSleepSeconds*(): float =
  ## Per-render sleep override the scene's last render set through
  ## logic/nextSleepDuration (context.nextSleep on the Pi runner);
  ## negative = no override, use the interval logic.
  lastNextSleep

proc renderCurrentScene*(): Option[Image] =
  ## Render the active interpreted scene; none() when no scenes are loaded
  ## (the caller falls back to the baked demo scene).
  lastNextSleep = -1
  if not ensureScene():
    return none(Image)
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
  # The scene is done with its JS nodes until the next render, which on this
  # board is minutes away. Hand their interpreters back now so the packing and
  # display work below — and the next render's image decodes — see the memory.
  releaseIdleJsAppRuntimes()
  when defined(memProbe): memProbe("  renderCurrentScene: idle js runtimes released")
  if image.isNil:
    log("render returned no image")
    return none(Image)
  lastNextSleep = context.nextSleep
  some(image)
