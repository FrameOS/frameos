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
from ../events import SceneSettingsId, SceneSwitcherId, settingsWindowId
from ../layout_choice import layoutListing
import system/sceneSettings/scene as sceneSettings
from ../scene_switcher_linux import installSceneSwitcherHooks

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

proc panel(id, hex: string, layout = "layout-tiling"): JsonNode =
  %*{"id": id, "name": id, "settings": {"execution": "interpreted", "refreshInterval": 0.05,
      "backgroundColor": "#000000"},
    "fields": [{"name": "message", "label": "Message", "type": "string", "value": "hi", "access": "public"}],
    "apps": {}, "layout": {"sceneId": layout},
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
      runnerThread.stopRenderLoop = true
      waitFor renderLoop
      waitFor messageLoop
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())

  test "every scene's settings open in a window of their own, which stays open while another has the focus":
    let sceneA = "tests/windows/a".SceneId
    let sceneB = "tests/windows/b".SceneId
    # On a desktop, a scene's own settings (event_loop.settingsWindows).
    let settingsA = settingsWindowId(sceneA.string).SceneId
    let settingsB = settingsWindowId(sceneB.string).SceneId
    let desktop = parseFile(Samples / "Windows 98 layout" / "scenes.json")[0]
    updateUploadedScenes(parseInterpretedScenes($(%*[desktop, panel(sceneA.string, "#ff0000", "layout-windows-98"),
      panel(sceneB.string, "#00ff00", "layout-windows-98")])))
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
      let renderLoop = runnerThread.startRenderLoop(maxCycles = 300)
      let messageLoop = runnerThread.startMessageLoop(maxIterations = 6000)
      check waitUntil(proc(): bool = runnerThread.scenes.hasKey(sceneA) and
        not runnerThread.scenes[sceneA].wornLayout.isNil)
      let layout = runnerThread.scenes[sceneA].wornLayout
      proc windowOf(id: SceneId): JsonNode =
        for win in layout.state{"wins"}.getElems():
          if win{"id"}.getStr() == id.string:
            return win
      proc forward(id: SceneId) =
        ## The way the layout brings a window forward.
        layout.state["asked"] = %id.string
        sendEvent("setCurrentScene", %*{"sceneId": id.string}, eoScene)
        check waitUntil(proc(): bool = runnerThread.currentSceneId == id and
          runnerThread.scenes.hasKey(id) and runnerThread.scenes[id].wornLayout == layout)
        # And drawn so: the layout follows the focus one render at a time.
        check waitUntil(proc(): bool = layout.state{"last"}.getStr() == id.string)
      # Opened over A: a window of its own on the same desktop, named after A.
      sendEvent("sceneSettings", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = runnerThread.currentSceneId == settingsA and
        not windowOf(settingsA).isNil and runnerThread.scenes[settingsA].wornLayout == layout)
      check windowOf(settingsA){"title"}.getStr() == sceneA.string & " Properties"
      check not windowOf(sceneA).isNil
      let panelA = runnerThread.scenes[settingsA]
      check panelA.state{"from"}.getStr() == sceneA.string
      panelA.state{"values"}["message"] = %"edited A"
      # B brought forward: A's settings stay open in their window, drawn there as
      # themselves, edits and all.
      forward(sceneB)
      check not windowOf(settingsA).isNil
      check waitUntil(proc(): bool =
        for slot in layout.slots:
          if slot.child == panelA: return true)
      check panelA.wornLayout.isNil
      # B's settings: a second window and instance beside A's.
      sendEvent("sceneSettings", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = runnerThread.currentSceneId == settingsB and
        not windowOf(settingsB).isNil and runnerThread.scenes[settingsB].wornLayout == layout)
      check windowOf(settingsB){"title"}.getStr() == sceneB.string & " Properties"
      check not windowOf(settingsA).isNil
      let panelB = runnerThread.scenes[settingsB]
      check panelB != panelA
      check panelB.state{"from"}.getStr() == sceneB.string
      panelB.state{"values"}["message"] = %"edited B"
      check panelA.state{"values", "message"}.getStr() == "edited A"
      # A's forward again: as it was left.
      forward(settingsA)
      check panelA.state{"values", "message"}.getStr() == "edited A"
      check not panelA.state{"away"}.getBool()
      check panelB.state{"away"}.getBool()
      # Save in B (its Save is this switch, the values as state): B takes them,
      # B's window closes, A's stays with its edit, and A keeps its own value.
      forward(settingsB)
      runnerThread.scenes[settingsB].state["goneBack"] = %true # done, as its own Save or pick marks it
      sendEvent("setCurrentScene", %*{"sceneId": sceneB.string, "state": {"message": "edited B"}}, eoScene)
      check waitUntil(proc(): bool = runnerThread.currentSceneId == sceneB and windowOf(settingsB).isNil)
      check runnerThread.scenes[sceneB].state{"message"}.getStr() == "edited B"
      check runnerThread.scenes[sceneA].state{"message"}.getStr() == "hi"
      check not windowOf(settingsA).isNil
      check panelA.state{"values", "message"}.getStr() == "edited A"
      # The frame page: one window of its own, over the scene in front.
      sendEvent("sceneSettings", %*{"page": "frame"}, eoHttpAdmin)
      check waitUntil(proc(): bool = runnerThread.currentSceneId == SceneSettingsId.SceneId and
        not windowOf(SceneSettingsId.SceneId).isNil)
      check not windowOf(settingsA).isNil
      let framePage = SceneSettingsScene(runnerThread.scenes[SceneSettingsId.SceneId])
      check framePage.heldLayout(layoutListing()) == "layout-windows-98"
      # Cancel in A's goes back to A by itself: its window closes, the others stay.
      forward(settingsA)
      # The frame page left open beside the focus wears no layout now (the one
      # instance went along), and its Layout still holds the frame's.
      check framePage.state{"away"}.getBool() and framePage.wornLayout.isNil
      check framePage.heldLayout(layoutListing()) == "layout-windows-98"
      sendEvent("sceneSettings", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = runnerThread.currentSceneId == sceneA and windowOf(settingsA).isNil and
        runnerThread.scenes[sceneA].wornLayout == layout)
      check not windowOf(SceneSettingsId.SceneId).isNil
      # None of them is the scene a restart comes back to.
      check runnerThread.scenes[sceneA].state{"message"}.getStr() == "hi"
      runnerThread.stopMessageLoop = true
      runnerThread.stopRenderLoop = true
      waitFor renderLoop
      waitFor messageLoop
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())

  test "on the tiling desktop every scene's settings are a tile of their own, and Save closes only its own":
    let sceneA = "tests/windows/a".SceneId
    let sceneB = "tests/windows/b".SceneId
    let settingsA = settingsWindowId(sceneA.string).SceneId
    let settingsB = settingsWindowId(sceneB.string).SceneId
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
      let renderLoop = runnerThread.startRenderLoop(maxCycles = 300)
      let messageLoop = runnerThread.startMessageLoop(maxIterations = 6000)
      check waitUntil(proc(): bool = runnerThread.scenes.hasKey(sceneA) and
        not runnerThread.scenes[sceneA].wornLayout.isNil)
      let layout = runnerThread.scenes[sceneA].wornLayout
      proc settled(id: SceneId): bool =
        runnerThread.currentSceneId == id and runnerThread.scenes.hasKey(id) and
          runnerThread.scenes[id].wornLayout == layout and layout.state{"last"}.getStr() == id.string
      proc ask(id: SceneId, event: string, payload: JsonNode) =
        ## As the layout does it (its `asked`, then the event).
        layout.state["asked"] = %id.string
        sendEvent(event, payload, eoScene)
        check waitUntil(proc(): bool = settled(id))
      ask(settingsA, "sceneSettings", %*{})
      ask(sceneB, "setCurrentScene", %*{"sceneId": sceneB.string})
      ask(settingsB, "sceneSettings", %*{})
      # Four tiles, in the order they opened: A, its settings, B, its settings.
      check layout.state{"open"} == %*[sceneA.string, settingsA.string, sceneB.string, settingsB.string]
      check runnerThread.scenes[settingsA].state{"from"}.getStr() == sceneA.string
      check runnerThread.scenes[settingsB].state{"from"}.getStr() == sceneB.string
      # The frame's settings: a tile more, over the scene B's settings are for.
      ask(SceneSettingsId.SceneId, "sceneSettings", %*{"page": "frame"})
      check runnerThread.scenes[SceneSettingsId.SceneId].state{"from"}.getStr() == sceneB.string
      check layout.state{"open"}.len == 5
      # Save in B's: B takes it, its tile closes, the others stay where they are.
      ask(settingsB, "setCurrentScene", %*{"sceneId": settingsB.string})
      runnerThread.scenes[settingsB].state["goneBack"] = %true # done, as its own Save or pick marks it
      sendEvent("setCurrentScene", %*{"sceneId": sceneB.string, "state": {"message": "saved"}}, eoScene)
      check waitUntil(proc(): bool = settled(sceneB))
      check runnerThread.scenes[sceneB].state{"message"}.getStr() == "saved"
      check layout.state{"open"} == %*[sceneA.string, settingsA.string, sceneB.string, SceneSettingsId]
      runnerThread.stopMessageLoop = true
      runnerThread.stopRenderLoop = true
      waitFor renderLoop
      waitFor messageLoop
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())


proc desktopRunner(layoutFile, layoutId: string, ids: seq[SceneId], layoutState: JsonNode = nil): RunnerThread =
  ## A Pi's runner with the sample `layoutFile` around `ids`, the first one
  ## showing, the way the tests above start one.
  var scenes = %*[parseFile(Samples / layoutFile / "scenes.json")[0]]
  for i, id in ids:
    let scene = panel(id.string, ["#ff0000", "#00ff00", "#0000ff"][i mod 3], layoutId)
    if not layoutState.isNil:
      scene["layout"]["state"] = layoutState
    scenes.add scene
  updateUploadedScenes(parseInterpretedScenes($scenes))
  setUploadedSceneOrder(ids)
  var config = loadConfig()
  config.device = "framebuffer"
  config.controlCode = ControlCode(enabled: false, position: "center",
    qrCodeColor: parseHtmlColor("#000000"), backgroundColor: parseHtmlColor("#ffffff"))
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  result = RunnerThread(frameConfig: config, scenes: initTable[SceneId, FrameScene](),
    currentSceneId: ids[0], lastRenderAt: 0.0, sleepFuture: none(Future[void]),
    isRendering: false, triggerRenderNext: false, logger: logger)
  result.installWindowHooks()
  # The scene list as the runner lists it, so it knows the scene it opened from.
  installSceneSwitcherHooks()

proc altF4() =
  ## The key the desktop closes the window in front with, as a keyboard sends it.
  sendEvent("keyDown", %*{"key": "F4", "code": "F4", "repeat": false, "shift": false, "ctrl": false,
    "alt": true, "meta": false}, eoHttpAdmin)

suite "closing a window on a desktop opens nothing else":
  test "the window in front closed gives the focus to the one under it, not to the scene it was opened from":
    let sceneA = "tests/windows/a".SceneId
    let sceneB = "tests/windows/b".SceneId
    let runnerThread = desktopRunner("Windows 98 layout", "layout-windows-98", @[sceneA, sceneB])
    try:
      let renderLoop = runnerThread.startRenderLoop(maxCycles = 300)
      let messageLoop = runnerThread.startMessageLoop(maxIterations = 6000)
      check waitUntil(proc(): bool = runnerThread.scenes.hasKey(sceneA) and
        not runnerThread.scenes[sceneA].wornLayout.isNil)
      let layout = runnerThread.scenes[sceneA].wornLayout
      proc windowOf(id: SceneId): JsonNode =
        for win in layout.state{"wins"}.getElems():
          if win{"id"}.getStr() == id.string:
            return win
      proc settled(id: SceneId): bool =
        runnerThread.currentSceneId == id and layout.state{"last"}.getStr() == id.string
      proc forward(id: SceneId) =
        layout.state["asked"] = %id.string
        sendEvent("setCurrentScene", %*{"sceneId": id.string}, eoScene)
        check waitUntil(proc(): bool = settled(id))
      # Control Panel opened over A, then B in front, then Control Panel again:
      # under it is B's window, and A's under that.
      sendEvent("sceneSettings", %*{"page": "frame"}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(SceneSettingsId.SceneId))
      forward(sceneB)
      forward(SceneSettingsId.SceneId)
      check runnerThread.scenes[SceneSettingsId.SceneId].state{"from"}.getStr() == sceneA.string
      altF4()
      # B has the focus, the window that was under; A stays behind it.
      check waitUntil(proc(): bool = settled(sceneB))
      check windowOf(SceneSettingsId.SceneId).isNil
      check not windowOf(sceneA).isNil
      check windowOf(sceneA){"z"}.getInt() < windowOf(sceneB){"z"}.getInt() or
        layout.state{"openScenes"}.getElems()[^1].getStr() == sceneB.string
      # A scene's settings close with it: A's settings in front, and A closed.
      forward(sceneA)
      sendEvent("sceneSettings", %*{}, eoHttpAdmin)
      let settingsA = settingsWindowId(sceneA.string).SceneId
      check waitUntil(proc(): bool = settled(settingsA))
      forward(sceneA)
      altF4()
      check waitUntil(proc(): bool = settled(sceneB))
      check windowOf(sceneA).isNil
      check windowOf(settingsA).isNil
      runnerThread.stopMessageLoop = true
      runnerThread.stopRenderLoop = true
      waitFor renderLoop
      waitFor messageLoop
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())

  test "a window closed stays closed when the scene list goes back to its scene, and opens when it is picked":
    let sceneA = "tests/windows/a".SceneId
    let sceneB = "tests/windows/b".SceneId
    let runnerThread = desktopRunner("Windows 98 layout", "layout-windows-98", @[sceneA, sceneB])
    try:
      let renderLoop = runnerThread.startRenderLoop(maxCycles = 300)
      let messageLoop = runnerThread.startMessageLoop(maxIterations = 6000)
      check waitUntil(proc(): bool = runnerThread.scenes.hasKey(sceneA) and
        not runnerThread.scenes[sceneA].wornLayout.isNil)
      let layout = runnerThread.scenes[sceneA].wornLayout
      proc windowOf(id: SceneId): JsonNode =
        for win in layout.state{"wins"}.getElems():
          if win{"id"}.getStr() == id.string:
            return win
      proc settled(id: SceneId): bool =
        runnerThread.currentSceneId == id and layout.state{"last"}.getStr() == id.string
      check waitUntil(proc(): bool = not windowOf(sceneA).isNil)
      # The last window closed: a bare desktop, A still the frame's scene.
      altF4()
      check waitUntil(proc(): bool = windowOf(sceneA).isNil and layout.state{"gone"}.getStr() == sceneA.string)
      check runnerThread.currentSceneId == sceneA
      # The scene list, and its own Close (the command again): back on A, which
      # stays closed, and the list's window goes.
      sendEvent("sceneSwitcher", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(SceneSwitcherId.SceneId) and not windowOf(SceneSwitcherId.SceneId).isNil)
      sendEvent("sceneSwitcher", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(sceneA))
      check windowOf(sceneA).isNil
      check windowOf(SceneSwitcherId.SceneId).isNil
      check layout.state{"wins"}.len == 0
      # The scene list again, and A picked in it (its tile is this switch): A opens.
      sendEvent("sceneSwitcher", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(SceneSwitcherId.SceneId))
      runnerThread.scenes[SceneSwitcherId.SceneId].state["goneBack"] = %true # done, as its own Save or pick marks it
      sendEvent("setCurrentScene", %*{"sceneId": sceneA.string}, eoScene)
      check waitUntil(proc(): bool = settled(sceneA) and not windowOf(sceneA).isNil)
      check windowOf(SceneSwitcherId.SceneId).isNil
      # Minimized, the same: the settings cancelled leave it minimized.
      layout.state["wins"] = %*[block:
        var win = windowOf(sceneA)
        win["min"] = %true
        win]
      sendEvent("sceneSettings", %*{}, eoHttpAdmin)
      let settingsA = settingsWindowId(sceneA.string).SceneId
      check waitUntil(proc(): bool = settled(settingsA))
      sendEvent("sceneSettings", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(sceneA))
      check windowOf(sceneA){"min"}.getBool()
      check windowOf(settingsA).isNil
      runnerThread.stopMessageLoop = true
      runnerThread.stopRenderLoop = true
      waitFor renderLoop
      waitFor messageLoop
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())

  test "one scene at a time, a window minimized or closed stays so under the scene list, and the next scene shows":
    let sceneA = "tests/windows/a".SceneId
    let sceneB = "tests/windows/b".SceneId
    let runnerThread = desktopRunner("Windows 98 layout", "layout-windows-98", @[sceneA, sceneB],
      %*{"windowMode": "off", "showWindowBar": true})
    try:
      let renderLoop = runnerThread.startRenderLoop(maxCycles = 300)
      let messageLoop = runnerThread.startMessageLoop(maxIterations = 6000)
      check waitUntil(proc(): bool = runnerThread.scenes.hasKey(sceneA) and
        not runnerThread.scenes[sceneA].wornLayout.isNil)
      let layout = runnerThread.scenes[sceneA].wornLayout
      proc settled(id: SceneId): bool =
        runnerThread.currentSceneId == id and layout.state{"last"}.getStr() == id.string
      check waitUntil(proc(): bool = settled(sceneA))
      check layout.state{"wins"}.isNil
      # A minimized (its task button), then B from anywhere: B shows.
      layout.state["minimized"] = %true
      sendEvent("setCurrentScene", %*{"sceneId": sceneB.string}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(sceneB))
      check not layout.state{"minimized"}.getBool()
      # B closed (its window's close), then the scene list closed again: still closed.
      layout.state["closed"] = %true
      sendEvent("sceneSwitcher", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(SceneSwitcherId.SceneId))
      check layout.state{"closed"}.getBool()
      sendEvent("sceneSwitcher", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(sceneB))
      check layout.state{"closed"}.getBool()
      # And B picked in the list: its window again.
      sendEvent("sceneSwitcher", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(SceneSwitcherId.SceneId))
      runnerThread.scenes[SceneSwitcherId.SceneId].state["goneBack"] = %true # done, as its own Save or pick marks it
      sendEvent("setCurrentScene", %*{"sceneId": sceneB.string}, eoScene)
      check waitUntil(proc(): bool = settled(sceneB) and not layout.state{"closed"}.getBool())
      runnerThread.stopMessageLoop = true
      runnerThread.stopRenderLoop = true
      waitFor renderLoop
      waitFor messageLoop
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())

  test "on the tiling desktop a scene's tile closed stays closed when a built-in tile goes back to it":
    let sceneA = "tests/windows/a".SceneId
    let sceneB = "tests/windows/b".SceneId
    let runnerThread = desktopRunner("Tiling layout", "layout-tiling", @[sceneA, sceneB])
    try:
      let renderLoop = runnerThread.startRenderLoop(maxCycles = 300)
      let messageLoop = runnerThread.startMessageLoop(maxIterations = 6000)
      check waitUntil(proc(): bool = runnerThread.scenes.hasKey(sceneA) and
        not runnerThread.scenes[sceneA].wornLayout.isNil)
      let layout = runnerThread.scenes[sceneA].wornLayout
      proc settled(id: SceneId): bool =
        runnerThread.currentSceneId == id and layout.state{"last"}.getStr() == id.string
      proc ask(id: SceneId, event: string, payload: JsonNode) =
        layout.state["asked"] = %id.string
        sendEvent(event, payload, eoScene)
        check waitUntil(proc(): bool = settled(id))
      ask(sceneB, "setCurrentScene", %*{"sceneId": sceneB.string})
      ask(sceneA, "setCurrentScene", %*{"sceneId": sceneA.string})
      # Setup opened over A, then A's tile closed (its X: out of `open`).
      ask(SceneSettingsId.SceneId, "sceneSettings", %*{"page": "frame"})
      check runnerThread.scenes[SceneSettingsId.SceneId].state{"from"}.getStr() == sceneA.string
      layout.state["open"] = %*[sceneB.string, SceneSettingsId]
      # Setup's own Cancel: back to A by itself. A's tile stays closed, Setup's
      # goes, and B, which had the focus before, takes it.
      sendEvent("sceneSettings", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(sceneB))
      check layout.state{"open"} == %*[sceneB.string]
      runnerThread.stopMessageLoop = true
      runnerThread.stopRenderLoop = true
      waitFor renderLoop
      waitFor messageLoop
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())

  test "a scene's settings window keeps its edits when something else switches the scene, and closes once it goes back":
    let sceneA = "tests/windows/a".SceneId
    let sceneB = "tests/windows/b".SceneId
    let settingsA = settingsWindowId(sceneA.string).SceneId
    let runnerThread = desktopRunner("Windows 98 layout", "layout-windows-98", @[sceneA, sceneB])
    try:
      let renderLoop = runnerThread.startRenderLoop(maxCycles = 300)
      let messageLoop = runnerThread.startMessageLoop(maxIterations = 6000)
      check waitUntil(proc(): bool = runnerThread.scenes.hasKey(sceneA) and
        not runnerThread.scenes[sceneA].wornLayout.isNil)
      let layout = runnerThread.scenes[sceneA].wornLayout
      proc windowOf(id: SceneId): JsonNode =
        for win in layout.state{"wins"}.getElems():
          if win{"id"}.getStr() == id.string:
            return win
      proc settled(id: SceneId): bool =
        runnerThread.currentSceneId == id and layout.state{"last"}.getStr() == id.string
      sendEvent("sceneSettings", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(settingsA) and not windowOf(settingsA).isNil)
      let panelA = runnerThread.scenes[settingsA]
      panelA.state{"values"}["message"] = %"edited A"
      # B from outside the layout (the API, a key, a schedule): A's settings stay
      # open in their window, the edit in them.
      sendEvent("setCurrentScene", %*{"sceneId": sceneB.string}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(sceneB))
      check not windowOf(settingsA).isNil
      check panelA.state{"away"}.getBool()
      check builtInsAway.contains(settingsA.string)
      # Brought forward again, as it was left.
      layout.state["asked"] = %settingsA.string
      sendEvent("setCurrentScene", %*{"sceneId": settingsA.string}, eoScene)
      check waitUntil(proc(): bool = settled(settingsA))
      check panelA.state{"values", "message"}.getStr() == "edited A"
      check not builtInsAway.contains(settingsA.string)
      # The same command again (a swipe, the API) sends it back: done, its window
      # closes and nothing keeps it.
      sendEvent("sceneSettings", %*{}, eoHttpAdmin)
      check waitUntil(proc(): bool = settled(sceneA))
      check windowOf(settingsA).isNil
      check not builtInsAway.contains(settingsA.string)
      check not panelA.state{"away"}.getBool()
      runnerThread.stopMessageLoop = true
      runnerThread.stopRenderLoop = true
      waitFor renderLoop
      waitFor messageLoop
    finally:
      updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())
