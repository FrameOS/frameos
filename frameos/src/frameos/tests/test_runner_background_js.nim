## Background JavaScript through the Pi's runner (docs/background-js.md): an
## app's background() keeps running between renders on the runner's own loop,
## and when it asks for a render, it gets one, on a scene whose own interval
## is ten minutes and with nobody sending anything.

import std/[json, options, tables, asyncdispatch, unittest]
import pixie
import ../config
import ../interpreter
import ../runner
import ../scenes
import ../types
import ../js_runtime/js_io

proc ticker(id: string): JsonNode =
  let source = """
    let n = 0
    export async function background() {
      for (;;) {
        await frameos.sleep(0.03)
        n++
        frameos.setState("ticks", n)
        frameos.dispatch("render")
      }
    }
    export function get(app) {
      frameos.setState("drawn", n)
      return <div className="w-full h-full bg-black text-white">{String(n)}</div>
    }
  """
  let app = %*{"origin": "jsxUi", "name": "ui", "category": "data", "version": "1.0.0", "fields": [],
    "output": [{"name": "image", "type": "image"}], "sources": {"app.tsx": source,
      "config.json": $(%*{"name": "ui", "category": "data", "output": [{"name": "image", "type": "image"}], "fields": []})}}
  %*{"id": id, "name": id, "settings": {"execution": "interpreted", "refreshInterval": 600,
      "backgroundColor": "#000000"},
    "fields": [], "apps": {"jsxUi": app},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "jsxUi", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}

proc waitUntil(condition: proc(): bool {.closure.}, steps = 400, stepMs = 5): bool =
  for _ in 0 ..< steps:
    if condition():
      return true
    waitFor sleepAsync(stepMs)
  condition()

suite "background JavaScript on the Pi's runner":
  test "background() runs between renders, and its render requests are answered":
    let sceneId = "tests/background/ticker".SceneId
    updateUploadedScenes(parseInterpretedScenes($(%*[ticker(sceneId.string)])))
    setUploadedSceneOrder(@[sceneId])
    try:
      var config = loadConfig()
      config.device = "framebuffer"
      config.controlCode = ControlCode(enabled: false, position: "center",
        qrCodeColor: parseHtmlColor("#000000"), backgroundColor: parseHtmlColor("#ffffff"))
      var logger = Logger(frameConfig: config, enabled: true)
      logger.log = proc(payload: JsonNode) = discard
      logger.enable = proc() = discard
      logger.disable = proc() = discard
      var runnerThread = RunnerThread(frameConfig: config, scenes: initTable[SceneId, FrameScene](),
        currentSceneId: sceneId, lastRenderAt: 0.0, sleepFuture: none(Future[void]),
        isRendering: false, triggerRenderNext: false, logger: logger)
      let renderLoop = runnerThread.startRenderLoop(maxCycles = 12)
      let messageLoop = runnerThread.startMessageLoop(maxIterations = 2000)
      # Ticks keep coming with nobody sending anything, and renders follow them.
      check waitUntil(proc(): bool = runnerThread.scenes.hasKey(sceneId) and
        runnerThread.scenes[sceneId].state{"ticks"}.getInt() >= 5)
      check waitUntil(proc(): bool = runnerThread.scenes[sceneId].state{"drawn"}.getInt() >= 3)
      # Its twelve renders end the render loop: the requests keep coming, so
      # it never waits out the scene's own ten minutes.
      waitFor renderLoop
      runnerThread.stopMessageLoop = true
      waitFor messageLoop
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())
      stopJsIo()
