import std/[json, options, tables, sequtils, asyncdispatch, unittest, os]
import pixie
import ../boot_guard
import ../config
import ../runner
import ../scenes
import ../types
import ../channels


type LogStore = ref object
  entries: seq[JsonNode]

type SavedBootGuardState = object
  hadState: bool
  state: string

let bootGuardPath = BOOT_GUARD_STATE_PATH
let bootGuardDir = parentDir(bootGuardPath)

proc saveBootGuardState(): SavedBootGuardState =
  result.hadState = fileExists(bootGuardPath)
  if result.hadState:
    result.state = readFile(bootGuardPath)

proc restoreBootGuardState(saved: SavedBootGuardState) =
  if saved.hadState:
    createDir(bootGuardDir)
    writeFile(bootGuardPath, saved.state)
  elif fileExists(bootGuardPath):
    removeFile(bootGuardPath)

proc resetBootGuardState() =
  if fileExists(bootGuardPath):
    removeFile(bootGuardPath)

proc testLogger(config: FrameConfig, store: LogStore): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    if logger.enabled:
      store.entries.add(payload)
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc clearEventChannel() =
  while true:
    let (ok, _) = eventChannel.tryRecv()
    if not ok:
      break

proc waitUntil(condition: proc(): bool {.closure.}, steps = 120, stepMs = 5): bool =
  for _ in 0 ..< steps:
    if condition():
      return true
    waitFor sleepAsync(stepMs)
  condition()

proc hasEvent(store: LogStore, eventName: string): bool =
  store.entries.anyIt(it.kind == JObject and it.hasKey("event") and it["event"].kind == JString and
    it["event"].getStr() == eventName)

proc countEvent(store: LogStore, eventName: string): int =
  for entry in store.entries:
    if entry.kind == JObject and entry.hasKey("event") and entry["event"].kind == JString and
        entry["event"].getStr() == eventName:
      result += 1

proc failingInit(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  raise newException(IOError, "network path unavailable")

proc fastInit(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  FrameScene(
    id: sceneId,
    frameConfig: frameConfig,
    logger: logger,
    state: %*{},
    refreshInterval: 0.05,
    backgroundColor: parseHtmlColor("#ffffff")
  )

proc unusedRender(scene: FrameScene, context: ExecutionContext): Image =
  context.image

proc fastRender(scene: FrameScene, context: ExecutionContext): Image =
  context.image.fill(scene.backgroundColor)
  context.image

proc failingRender(scene: FrameScene, context: ExecutionContext): Image =
  raise newException(IOError, "network request failed")

suite "runner loop safety":
  test "render and message loops run one controlled cycle without hanging":
    clearEventChannel()

    var config = loadConfig()
    config.controlCode = ControlCode(
      enabled: false,
      position: "center",
      size: 0,
      padding: 0,
      offsetX: 0,
      offsetY: 0,
      qrCodeColor: parseHtmlColor("#000000"),
      backgroundColor: parseHtmlColor("#ffffff")
    )

    let store = LogStore(entries: @[])
    var runnerThread = RunnerThread(
      frameConfig: config,
      scenes: initTable[SceneId, FrameScene](),
      currentSceneId: getFirstSceneId(),
      lastRenderAt: 0.0,
      sleepFuture: none(Future[void]),
      isRendering: false,
      triggerRenderNext: false,
      logger: testLogger(config, store)
    )

    let renderLoop = runnerThread.startRenderLoop(maxCycles = 1)
    let messageLoop = runnerThread.startMessageLoop(maxIterations = 120)
    sendEvent("render", %*{})

    waitFor renderLoop
    let sawRenderEvent = waitUntil(proc(): bool =
      store.entries.anyIt(it.kind == JObject and it.hasKey("event") and it["event"].kind == JString and it["event"].getStr() == "event:render")
    )
    waitFor messageLoop

    check renderLoop.finished
    check messageLoop.finished
    check runnerThread.lastRenderAt > 0.0
    check sawRenderEvent

  test "scene init errors render as scene errors and clear boot guard count":
    let savedBootGuardState = saveBootGuardState()
    let sceneId = "tests/runner/init-network-error".SceneId
    try:
      resetBootGuardState()
      discard registerBootCrash()
      var uploaded = initTable[SceneId, ExportedInterpretedScene]()
      uploaded[sceneId] = ExportedInterpretedScene(
        name: "Network init scene",
        publicStateFields: @[],
        persistedStateKeys: @[],
        init: failingInit,
        render: unusedRender,
        runEvent: proc (self: FrameScene, context: ExecutionContext): void = discard
      )
      updateUploadedScenes(uploaded)

      var config = loadConfig()
      config.controlCode = ControlCode(
        enabled: false,
        position: "center",
        size: 0,
        padding: 0,
        offsetX: 0,
        offsetY: 0,
        qrCodeColor: parseHtmlColor("#000000"),
        backgroundColor: parseHtmlColor("#ffffff")
      )

      let store = LogStore(entries: @[])
      var runnerThread = RunnerThread(
        frameConfig: config,
        scenes: initTable[SceneId, FrameScene](),
        currentSceneId: sceneId,
        lastRenderAt: 0.0,
        sleepFuture: none(Future[void]),
        isRendering: false,
        triggerRenderNext: false,
        logger: testLogger(config, store)
      )

      waitFor runnerThread.startRenderLoop(maxCycles = 1)

      check runnerThread.lastRenderAt > 0.0
      check hasEvent(store, "render:error:scene:init")
      check hasEvent(store, "render:done")
      check loadBootCrashCount() == 0
      check not runnerThread.scenes.hasKey(sceneId)
      let details = loadBootGuardFailureDetails()
      check details.sceneId.isSome and details.sceneId.get() == sceneId.string
      check details.error.isNone
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())
      restoreBootGuardState(savedBootGuardState)

  test "render signals are logged while fast render logging is paused":
    let sceneId = "tests/runner/fast-render".SceneId
    try:
      var uploaded = initTable[SceneId, ExportedInterpretedScene]()
      uploaded[sceneId] = ExportedInterpretedScene(
        name: "Fast render scene",
        publicStateFields: @[],
        persistedStateKeys: @[],
        init: fastInit,
        render: fastRender,
        runEvent: proc (self: FrameScene, context: ExecutionContext): void = discard
      )
      updateUploadedScenes(uploaded)

      var config = loadConfig()
      config.controlCode = ControlCode(
        enabled: false,
        position: "center",
        size: 0,
        padding: 0,
        offsetX: 0,
        offsetY: 0,
        qrCodeColor: parseHtmlColor("#000000"),
        backgroundColor: parseHtmlColor("#ffffff")
      )

      let store = LogStore(entries: @[])
      let logger = testLogger(config, store)
      var runnerThread = RunnerThread(
        frameConfig: config,
        scenes: initTable[SceneId, FrameScene](),
        currentSceneId: sceneId,
        lastRenderAt: 0.0,
        sleepFuture: none(Future[void]),
        isRendering: false,
        triggerRenderNext: false,
        logger: logger
      )

      waitFor runnerThread.startRenderLoop(maxCycles = 3)

      check countEvent(store, "render:pause") == 1
      # Cycles 1 and 2 log render:done; the pause kicks in at the end of
      # cycle 2, so cycle 3's render:done is suppressed.
      check countEvent(store, "render:done") == 2
      check not logger.enabled
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())

  test "activation control events are logged while render logging is paused":
    clearEventChannel()

    var config = loadConfig()
    let store = LogStore(entries: @[])
    let logger = testLogger(config, store)
    logger.disable()
    var runnerThread = RunnerThread(
      frameConfig: config,
      scenes: initTable[SceneId, FrameScene](),
      currentSceneId: getFirstSceneId(),
      lastRenderAt: 0.0,
      sleepFuture: none(Future[void]),
      isRendering: false,
      triggerRenderNext: false,
      logger: logger
    )

    let messageLoop = runnerThread.startMessageLoop(maxIterations = 2)
    sendEvent("setCurrentScene", %*{"sceneId": "tests/runner/missing-scene"})

    let finished = waitUntil(proc(): bool = messageLoop.finished, steps = 200, stepMs = 5)
    check finished
    if finished:
      waitFor messageLoop
    check hasEvent(store, "event:setCurrentScene")
    check not logger.enabled

  test "scene changes are logged while render logging is paused":
    let sceneId = "tests/runner/paused-scene-change".SceneId
    try:
      var uploaded = initTable[SceneId, ExportedInterpretedScene]()
      uploaded[sceneId] = ExportedInterpretedScene(
        name: "Paused scene change",
        publicStateFields: @[],
        persistedStateKeys: @[],
        init: fastInit,
        render: fastRender,
        runEvent: proc (self: FrameScene, context: ExecutionContext): void = discard
      )
      updateUploadedScenes(uploaded)

      var config = loadConfig()
      config.controlCode = ControlCode(
        enabled: false,
        position: "center",
        size: 0,
        padding: 0,
        offsetX: 0,
        offsetY: 0,
        qrCodeColor: parseHtmlColor("#000000"),
        backgroundColor: parseHtmlColor("#ffffff")
      )

      let store = LogStore(entries: @[])
      let logger = testLogger(config, store)
      logger.disable()
      var runnerThread = RunnerThread(
        frameConfig: config,
        scenes: initTable[SceneId, FrameScene](),
        currentSceneId: sceneId,
        lastRenderAt: 0.0,
        sleepFuture: none(Future[void]),
        isRendering: false,
        triggerRenderNext: false,
        logger: logger
      )

      waitFor runnerThread.startRenderLoop(maxCycles = 1)

      check hasEvent(store, "render:sceneChange")
      check not hasEvent(store, "render:done")
      check not logger.enabled
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())

  test "scene render errors do not update boot guard failure details":
    let savedBootGuardState = saveBootGuardState()
    try:
      resetBootGuardState()
      updateBootGuardFailureDetails(some("startup/scene"), some("Startup Scene"), some("startup crash"))

      var config = loadConfig()
      config.controlCode = ControlCode(
        enabled: false,
        position: "center",
        size: 0,
        padding: 0,
        offsetX: 0,
        offsetY: 0,
        qrCodeColor: parseHtmlColor("#000000"),
        backgroundColor: parseHtmlColor("#ffffff")
      )

      let store = LogStore(entries: @[])
      var runnerThread = RunnerThread(
        frameConfig: config,
        scenes: initTable[SceneId, FrameScene](),
        currentSceneId: "tests/runner/render-network-error".SceneId,
        lastRenderAt: 0.0,
        sleepFuture: none(Future[void]),
        isRendering: false,
        triggerRenderNext: false,
        logger: testLogger(config, store)
      )
      let scene = FrameScene(
        id: "tests/runner/render-network-error".SceneId,
        frameConfig: config,
        logger: runnerThread.logger,
        state: %*{},
        refreshInterval: 60.0,
        backgroundColor: parseHtmlColor("#ffffff")
      )
      let exported = ExportedScene(
        publicStateFields: @[],
        persistedStateKeys: @[],
        render: failingRender,
        runEvent: proc (self: FrameScene, context: ExecutionContext): void = discard
      )

      discard runnerThread.renderSceneImage(exported, scene)

      let details = loadBootGuardFailureDetails()
      check details.sceneId.isSome and details.sceneId.get() == "startup/scene"
      check details.sceneName.isSome and details.sceneName.get() == "Startup Scene"
      check details.error.isSome and details.error.get() == "startup crash"
      check hasEvent(store, "render:error")
    finally:
      restoreBootGuardState(savedBootGuardState)
