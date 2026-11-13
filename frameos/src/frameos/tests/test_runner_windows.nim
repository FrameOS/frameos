## Windows through the Pi's runner (docs/scene-layouts.md "Windows"): the real
## Tiling sample around two scenes, switched by a message the way any control
## plane, the scene list or a layout's handler switches them. The layout goes
## along from one scene to the next, and the scene left is the runner's own
## instance, running in a tile beside the scene in front.

import std/[json, options, tables, asyncdispatch, unittest, os]
import pixie
import ../config
import ../interpreter
import ../runner
import ../scenes
import ../types
import ../channels

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

proc panel(id, hex: string): JsonNode =
  %*{"id": id, "name": id, "settings": {"execution": "interpreted", "refreshInterval": 0.05,
      "backgroundColor": "#000000"},
    "fields": [], "apps": {}, "layout": {"sceneId": "layout-tiling"},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": hex}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"}]}

proc waitUntil(condition: proc(): bool {.closure.}, steps = 400, stepMs = 5): bool =
  for _ in 0 ..< steps:
    if condition():
      return true
    waitFor sleepAsync(stepMs)
  condition()

suite "windows on the Pi's runner":
  test "a switch carries the layout, and the scene left runs in a tile as itself":
    let sceneA = "tests/windows/a".SceneId
    let sceneB = "tests/windows/b".SceneId
    let tiling = parseFile(Samples / "Tiling layout" / "scenes.json")[0]
    updateUploadedScenes(parseInterpretedScenes($(%*[tiling, panel(sceneA.string, "#ff0000"),
      panel(sceneB.string, "#00ff00")])))
    setUploadedSceneOrder(@[sceneA, sceneB])
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
        currentSceneId: sceneA, lastRenderAt: 0.0, sleepFuture: none(Future[void]),
        isRendering: false, triggerRenderNext: false, logger: logger)
      runnerThread.installWindowHooks()
      let renderLoop = runnerThread.startRenderLoop(maxCycles = 40)
      let messageLoop = runnerThread.startMessageLoop(maxIterations = 800)
      check waitUntil(proc(): bool = runnerThread.scenes.hasKey(sceneA) and
        not runnerThread.scenes[sceneA].wornLayout.isNil)
      let layout = runnerThread.scenes[sceneA].wornLayout
      sendEvent("setCurrentScene", %*{"sceneId": sceneB.string}, eoHttpAdmin)
      check waitUntil(proc(): bool = runnerThread.scenes.hasKey(sceneB) and
        runnerThread.scenes[sceneB].wornLayout == layout and layout.state{"open"} == %*[sceneA.string, sceneB.string])
      check runnerThread.scenes[sceneA].wornLayout.isNil
      # A's tile is the runner's A, not a copy of the layout's own.
      check waitUntil(proc(): bool =
        for slot in layout.slots:
          if slot.child == runnerThread.scenes[sceneA]: return true)
      check InterpretedFrameScene(layout).sceneNodes.len == 0
      runnerThread.stopMessageLoop = true
      waitFor renderLoop
      waitFor messageLoop
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())
