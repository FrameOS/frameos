import std/[json, options, tables, sequtils, asyncdispatch, unittest]
import pixie
import ../config
import ../runner
import ../scenes
import ../types
import ../channels


type LogStore = ref object
  entries: seq[JsonNode]

proc testLogger(config: FrameConfig, store: LogStore): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
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

  test "scene init failure does not crash the render loop":
    let failingSceneId = "test/failing-init".SceneId
    let previousScene = if exportedScenes.hasKey(failingSceneId): some(exportedScenes[failingSceneId]) else: none(ExportedScene)

    exportedScenes[failingSceneId] = ExportedScene(
      publicStateFields: @[],
      persistedStateKeys: @[],
      init: proc(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
        raise newException(ValueError, "boom"),
      render: proc(self: FrameScene, context: ExecutionContext): Image =
        newImage(1, 1),
      runEvent: proc(self: FrameScene, context: ExecutionContext) =
        discard
    )

    defer:
      if previousScene.isSome:
        exportedScenes[failingSceneId] = previousScene.get()
      else:
        exportedScenes.del(failingSceneId)

    var config = loadConfig()
    config.controlCode = ControlCode(
      enabled: false,
      position: "center",
      size: 0,
      padding: 0,
      offsetY: 0,
      offsetX: 0,
      qrCodeColor: parseHtmlColor("#000000"),
      backgroundColor: parseHtmlColor("#ffffff")
    )

    let store = LogStore(entries: @[])
    var runnerThread = RunnerThread(
      frameConfig: config,
      scenes: initTable[SceneId, FrameScene](),
      currentSceneId: failingSceneId,
      lastRenderAt: 0.0,
      sleepFuture: none(Future[void]),
      isRendering: false,
      triggerRenderNext: false,
      logger: testLogger(config, store)
    )

    waitFor runnerThread.startRenderLoop(maxCycles = 1)

    check store.entries.anyIt(
      it.kind == JObject and
      it.hasKey("event") and
      it["event"].getStr() == "render:error:scene:init"
    )
    check store.entries.anyIt(
      it.kind == JObject and
      it.hasKey("event") and
      it["event"].getStr() == "render:error:scene:init:nil"
    )
