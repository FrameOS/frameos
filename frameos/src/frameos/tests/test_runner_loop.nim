import std/[json, options, tables, sequtils, asyncdispatch, unittest, os]
import pixie
import ../boot_guard
import ../config
import ../driver_render_hint
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

proc oneSecondInit(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  FrameScene(
    id: sceneId,
    frameConfig: frameConfig,
    logger: logger,
    state: %*{},
    refreshInterval: 1.0,
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

  test "a driver asking for an earlier retry is called back without re-rendering":
    # The framebuffer waiting for a KMS modeset is the live example: without
    # the return channel it is re-probed only on the next scheduled pass, so a
    # frame on a long interval stays blank for an interval after a boot that
    # was seconds from working (frameos/driver_render_hint).
    #
    # What it must NOT do is shorten the scene's own schedule. The first
    # version did, and a headless frame on an hourly interval re-rendered
    # every 60 seconds forever — running the scene's apps, HTTP fetches and
    # image generation included — to produce a frame the driver already had.
    clearEventChannel()
    clearEarlierRenderRequest()

    let sceneId = "tests/runner/driver-retry".SceneId
    var uploaded = initTable[SceneId, ExportedInterpretedScene]()
    uploaded[sceneId] = ExportedInterpretedScene(
      name: "One second scene",
      publicStateFields: @[],
      persistedStateKeys: @[],
      init: oneSecondInit,
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

    # Stands in for the driver: the runner reads the request off the same
    # thread-local slot whether a statically linked driver wrote it or the host
    # folded it back out of a `.so`.
    requestEarlierRender(0.25)
    # Two cycles: the first sleeps (and is where the callback happens), the
    # second breaks out before sleeping again.
    waitFor runnerThread.startRenderLoop(maxCycles = 2)

    # The scene keeps its own schedule — the whole point of the fix. (The
    # sleep is the interval minus the render that just happened, so it lands
    # just under a second; what matters is that it is nowhere near the 250 ms
    # the driver asked for.)
    for entry in store.entries:
      if entry{"event"}.getStr() == "render:sleep":
        check entry{"ms"}.getFloat() > 900.0
    # Exactly one scene render per cycle, not one per driver callback.
    check countEvent(store, "render:done") == 2
    # Consumed, not left standing for the next pass.
    check takeEarlierRenderRequest().isNone

  test "a driver request leaves a fast scene's schedule alone":
    clearEventChannel()
    clearEarlierRenderRequest()

    let fastSceneId = "tests/runner/driver-retry-fast".SceneId
    var fastUploaded = initTable[SceneId, ExportedInterpretedScene]()
    fastUploaded[fastSceneId] = ExportedInterpretedScene(
      name: "Fast scene",
      publicStateFields: @[],
      persistedStateKeys: @[],
      init: fastInit,
      render: fastRender,
      runEvent: proc (self: FrameScene, context: ExecutionContext): void = discard
    )
    updateUploadedScenes(fastUploaded)

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
      currentSceneId: fastSceneId,
      lastRenderAt: 0.0,
      sleepFuture: none(Future[void]),
      isRendering: false,
      triggerRenderNext: false,
      logger: testLogger(config, store)
    )

    requestEarlierRender(30.0)
    waitFor runnerThread.startRenderLoop(maxCycles = 2)

    # A request far beyond the scene's own interval never fires inside the
    # sleep, and never delays the next render either.
    check not hasEvent(store, "render:driver:retry")
    for entry in store.entries:
      if entry{"event"}.getStr() == "render:sleep":
        check entry{"ms"}.getFloat() <= 50.0

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

  test "setCurrentScene resolves public scene ids to their uploaded registration":
    clearEventChannel()

    # Cloud pushes register scenes as "uploaded/<id>", but the provider's
    # set_current_scene verb (and workspace-authored schedules) name the
    # public id. The runner must resolve it instead of failing "Scene not
    # found".
    let publicSceneId = "tests/runner/public-activation"
    let uploadedSceneId = ("uploaded/" & publicSceneId).SceneId
    try:
      var uploaded = initTable[SceneId, ExportedInterpretedScene]()
      uploaded[uploadedSceneId] = ExportedInterpretedScene(
        name: "Uploaded activation scene",
        publicStateFields: @[],
        persistedStateKeys: @[],
        init: fastInit,
        render: fastRender,
        runEvent: proc (self: FrameScene, context: ExecutionContext): void = discard
      )
      updateUploadedScenes(uploaded)

      var config = loadConfig()
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

      let messageLoop = runnerThread.startMessageLoop(maxIterations = 2)
      sendEvent("setCurrentScene", %*{"sceneId": publicSceneId})

      let finished = waitUntil(proc(): bool = messageLoop.finished, steps = 200, stepMs = 5)
      check finished
      if finished:
        waitFor messageLoop
      check runnerThread.currentSceneId == uploadedSceneId
      check runnerThread.scenes.hasKey(uploadedSceneId)
      check not store.entries.anyIt(it.kind == JObject and
        it{"error"}.getStr("") == "Scene not found")
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())

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
