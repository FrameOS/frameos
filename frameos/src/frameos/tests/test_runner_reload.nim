import std/[json, options, tables, asyncdispatch, unittest, os]
import pixie

import ../channels
import ../interpreter
import ../runner
import ../scenes
import ../types

type LogStore = ref object
  entries: seq[JsonNode]

proc testConfig(): FrameConfig =
  FrameConfig(
    width: 64,
    height: 32,
    rotate: 0,
    scalingMode: "cover",
    debug: true,
    saveAssets: %*false,
    assetsPath: "",
    controlCode: ControlCode(
      enabled: false,
      position: "center",
      size: 0,
      padding: 0,
      offsetX: 0,
      offsetY: 0,
      qrCodeColor: parseHtmlColor("#000000"),
      backgroundColor: parseHtmlColor("#ffffff")
    )
  )

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

proc hasEvent(store: LogStore, eventName: string): bool =
  for entry in store.entries:
    if entry.kind == JObject and entry.hasKey("event") and entry["event"].kind == JString and entry["event"].getStr() == eventName:
      return true
  false

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int, targetHandle: string): DiagramEdge =
  DiagramEdge(
    id: id.NodeId,
    source: source.NodeId,
    sourceHandle: sourceHandle,
    target: target.NodeId,
    targetHandle: targetHandle,
    edgeType: ""
  )

proc renderContext(scene: FrameScene): ExecutionContext =
  ExecutionContext(
    scene: scene,
    event: "render",
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: 0.0
  )

proc scenePayload(sceneId: SceneId, iteration: int): string =
  $(%*[
    {
      "id": sceneId.string,
      "name": "Runner reload code scene",
      "nodes": [
        {
          "id": "event-" & $iteration,
          "type": "event",
          "data": {"keyword": "render"}
        },
        {
          "id": "app-" & $iteration,
          "type": "app",
          "data": {
            "keyword": "render/text",
            "config": {
              "text": "",
              "richText": "disabled",
              "position": "center",
              "vAlign": "middle",
              "padding": 0,
              "fontColor": "#ffffff",
              "fontSize": 12,
              "borderColor": "#000000",
              "borderWidth": 0,
              "overflow": "fit-bounds"
            }
          }
        },
        {
          "id": "code-" & $iteration,
          "type": "code",
          "data": {
            "code": "((): string => `reload:" & $iteration & "`)()",
            "codeJS": "((): string => `reload:" & $iteration & "`)()",
            "codeArgs": [],
            "codeOutputs": [{"name": "text", "type": "text"}]
          }
        }
      ],
      "edges": [
        {
          "id": "edge-next-" & $iteration,
          "source": "event-" & $iteration,
          "sourceHandle": "next",
          "target": "app-" & $iteration,
          "targetHandle": "prev",
          "type": "appNodeEdge"
        },
        {
          "id": "edge-text-" & $iteration,
          "source": "code-" & $iteration,
          "sourceHandle": "fieldOutput",
          "target": "app-" & $iteration,
          "targetHandle": "fieldInput/text",
          "type": "codeNodeEdge"
        }
      ],
      "fields": [],
      "settings": {
        "refreshInterval": 3600,
        "backgroundColor": "#000000"
      }
    }
  ])

suite "runner reload safety":
  test "reload cleans up interpreted typescript scenes without hanging":
    let config = testConfig()
    let sceneId = "tests/reload-code".SceneId
    let scenesPath = getTempDir() / "frameos-runner-reload-scenes.json"
    let oldScenesEnv = getEnv("FRAMEOS_SCENES_JSON")

    try:
      for iteration in 0 ..< 3:
        writeFile(scenesPath, scenePayload(sceneId, iteration))
        putEnv("FRAMEOS_SCENES_JSON", scenesPath)
        clearEventChannel()
        let store = LogStore(entries: @[])
        let logger = testLogger(config, store)
        resetInterpretedScenes()

        let exported = getInterpretedScenes()
        check exported.hasKey(sceneId)

        let scene = exported[sceneId].init(sceneId, config, logger, %*{})
        discard render(scene, renderContext(scene))

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
        runnerThread.scenes[sceneId] = scene

        let messageLoop = runnerThread.startMessageLoop(maxIterations = 3)
        sendEvent("reload", %*{})

        let finished = waitUntil(proc(): bool = messageLoop.finished, steps = 200, stepMs = 5)
        check finished
        if finished:
          waitFor messageLoop
        check hasExportedScene(runnerThread.currentSceneId)
        check runnerThread.forceSceneReload
        check runnerThread.triggerRenderNext
        check runnerThread.scenes.len == 0

        let reloadedExport = findExportedScene(sceneId)
        check reloadedExport.isSome
        if reloadedExport.isSome:
          let reloadedScene = reloadedExport.get().init(sceneId, config, logger, %*{})
          discard render(reloadedScene, renderContext(reloadedScene))
          cleanupSceneRuntime(reloadedScene)

        check not hasEvent(store, "event:error")
        check not hasEvent(store, "dispatchEvent:error")
        check not hasEvent(store, "render:error")
    finally:
      if oldScenesEnv.len > 0:
        putEnv("FRAMEOS_SCENES_JSON", oldScenesEnv)
      else:
        delEnv("FRAMEOS_SCENES_JSON")
      if fileExists(scenesPath):
        removeFile(scenesPath)
