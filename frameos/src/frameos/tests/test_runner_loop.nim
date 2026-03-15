import std/[json, options, tables, sequtils, asyncdispatch, unittest, strutils]
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
      currentSceneId: "system/bootGuard".SceneId,
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

  test "scene init failures render an error image instead of crashing":
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

    let uploadedBackup = uploadedScenes
    let uploadedPayloadBackup = getUploadedScenePayload()
    let payload = %*{
      "scenes": [
        {
          "id": "broken-init",
          "name": "Broken init",
          "nodes": [
            {"id": "10", "nodeType": "event", "data": {"keyword": "render"}},
            {"id": "11", "nodeType": "app", "data": {"keyword": "render/missing"}}
          ],
          "edges": [],
          "fields": [],
          "settings": {
            "backgroundColor": "#ffffff",
            "refreshInterval": 1.0
          }
        }
      ]
    }

    let (mainScene, _) = updateUploadedScenesFromPayload(payload, false)

    try:
      let store = LogStore(entries: @[])
      var runnerThread = RunnerThread(
        frameConfig: config,
        scenes: initTable[SceneId, FrameScene](),
        currentSceneId: mainScene.get(),
        lastRenderAt: 0.0,
        sleepFuture: none(Future[void]),
        isRendering: false,
        triggerRenderNext: false,
        logger: testLogger(config, store)
      )

      let renderLoop = runnerThread.startRenderLoop(maxCycles = 1)
      waitFor renderLoop

      let sawInitError = store.entries.anyIt(
        it.kind == JObject and
        it.hasKey("event") and
        it["event"].kind == JString and
        it["event"].getStr() == "render:error:scene:init" and
        "Unknown app keyword" in it{"error"}.getStr()
      )

      check renderLoop.finished
      check runnerThread.lastRenderAt > 0.0
      check sawInitError
      check getLastImagePng().len > 0
    finally:
      updateUploadedScenes(uploadedBackup)
      setUploadedScenePayload($uploadedPayloadBackup)
