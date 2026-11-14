import std/[json, monotimes, options, os, strutils]
import ../channels
import ../interpreter
import ../single_scene_host
import ../types
import ../js_runtime/app_runtime
import ../js_runtime/run_budget
import ../js_runtime/runtime as jsRuntime
import ../utils/http_client
import ../utils/memory
import pixie
import system/sceneSwitcher/scene as sceneSwitcher

# The ESP32 and the wasm preview hold one scene, built on first use. A battery
# ESP32 reads the button that woke it before its first render, so the press is
# the first use: it must build the scene and reach it, not be dropped because
# nothing is resident yet.

const fixturesPath = currentSourcePath().parentDir / ".." / ".." / ".." / ".." / "docs" / "event-fixtures.json"
const switchCase = "a scene's own setCurrentScene switches scenes, on every host"

var scenes = newJArray()
for c in parseFile(fixturesPath)["dispatcher"]["cases"]:
  if c["name"].getStr() == switchCase:
    scenes = c["scenes"]
doAssert scenes.len == 2, "fixture case missing: " & switchCase
replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($scenes)))

let config = FrameConfig(width: 4, height: 3, rotate: 0, scalingMode: "cover", debug: false, saveAssets: %*false)
var logger = Logger(frameConfig: config, enabled: true)
logger.log = proc(payload: JsonNode) = discard
logger.enable = proc() = logger.enabled = true
logger.disable = proc() = logger.enabled = false

var selected: seq[string]
let host = SingleSceneHost(frameConfig: config, logger: logger)
host.requestSelect = proc (sceneId: string): bool =
  selected.add(sceneId)
  true
host.start()
localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
  {.cast(gcsafe).}:
    host.queue(origin, event, payload, scene)

host.makeCurrent("fixtures/dispatcher/switchFrom".SceneId)
doAssert host.scene.isNil, "the scene is built by its first use, not by being made current"

# The wake press, as an ESP32 queues it: a `gpio` `down` with `wake: true` and
# its `up`, stamped when the button task saw them a second before the scene
# was up. Its window is long over by then, so the first tick makes it the
# `button` `press` the scene's listener hears. (The scene listens for presses
# only: nothing hears the edges themselves.)
let wokeAt = getMonoTime().ticks div 1_000_000 - 1000
discard host.send(eoDriver, "gpio", %*{"pin": 5, "label": "RIGHT", "level": 0, "wake": true, "atMs": wokeAt})
doAssert not host.scene.isNil, "an edge sent before the first render builds the scene"
discard host.send(eoDriver, "gpio", %*{"pin": 5, "label": "RIGHT", "level": 1, "atMs": wokeAt + 80})
doAssert host.tick(), "the tick delivers the press"
doAssert selected == @["fixtures/dispatcher/switchTo"], "selected " & $selected

# A switch sent before the first render (the backend's set_current_scene,
# queued for the wake) must not build the scene it is leaving: the dispatcher
# serves a switch without one, and building it is seconds of work for a scene
# nobody sees.
let fresh = SingleSceneHost(frameConfig: config, logger: logger)
var freshSelected: seq[string]
fresh.requestSelect = proc (sceneId: string): bool =
  freshSelected.add(sceneId)
  true
fresh.start()
fresh.makeCurrent("fixtures/dispatcher/switchFrom".SceneId)
doAssert fresh.send(eoCloud, "setCurrentScene", %*{"sceneId": "fixtures/dispatcher/switchTo"})
doAssert fresh.scene.isNil, "the scene being left was not built for the switch"
doAssert freshSelected == @["fixtures/dispatcher/switchTo"], "selected " & $freshSelected

# ------------------------------------------- after an out-of-memory abort
#
# When PSRAM runs out, the ESP32's allocator longjmps out of whatever it was
# serving (frameos_nim_glue.c) and every `finally` on the way is skipped.
# Before recoverAbortedRun the frame then kept the aborted render's wall-clock
# deadline armed, so every later JS call failed with "render exceeded its
# 90000ms wall-clock deadline"; it also stopped delivering events and kept the
# JS interpreter the abort jumped out of. These abort the same way, from inside
# a JS app's httpRequest and from inside a code node, and check what runs next.

{.emit: """
#include <setjmp.h>
static jmp_buf fos_test_abort_jmp;
static int fos_test_abort_armed = 0;
/* The glue's guard: setjmp here, the call through `body`. 1 = it aborted. */
static int fos_test_guarded(void (*body)(void)) {
  if (setjmp(fos_test_abort_jmp) == 0) {
    fos_test_abort_armed = 1;
    body();
    fos_test_abort_armed = 0;
    return 0;
  }
  fos_test_abort_armed = 0;
  return 1;
}
/* fos_nim_fatal_oom's jump, minus the failed allocation. */
static void fos_test_abort(void) {
  if (fos_test_abort_armed) { fos_test_abort_armed = 0; longjmp(fos_test_abort_jmp, 1); }
}
""".}
proc cGuarded(body: proc () {.cdecl.}): cint {.importc: "fos_test_guarded", nodecl.}
proc abortHere() {.importc: "fos_test_abort", nodecl.}

proc guarded(body: proc () {.cdecl.}): cint =
  # The jump skips Nim's own frame bookkeeping too. A release build keeps none
  # (the firmware); a test built with stack traces would walk the dead frames
  # on its next exception.
  let frames = getFrameState()
  result = cGuarded(body)
  setFrameState(frames)

const abortSceneId = "tests/single-scene-host/oom-abort"
let abortScene = %*{
  "id": abortSceneId,
  "name": "oom abort",
  "settings": {"execution": "interpreted", "refreshInterval": 300},
  "fields": [],
  "nodes": [
    {"id": "render", "type": "event", "data": {"keyword": "render"}},
    {"id": "probe", "type": "app", "data": {"keyword": "probe", "config": {}}},
    {"id": "press", "type": "event", "data": {"keyword": "button"}},
    {"id": "code", "type": "code", "data": {"codeArgs": [], "codeOutputs": [],
      "codeJS": "(console.log('code ran'), 1)"}}
  ],
  "edges": [
    {"id": "x1", "source": "render", "sourceHandle": "next", "target": "probe", "targetHandle": "prev"},
    {"id": "x2", "source": "press", "sourceHandle": "next", "target": "code", "targetHandle": "prev"}
  ],
  "apps": {"probe": {"name": "Probe", "category": "logic", "sources": {
    "app.ts": "export function run() { frameos.log('fetched ' + frameos.httpRequest('https://probe.invalid/').status) }",
    "config.json": $(%*{"name": "Probe", "category": "logic"})
  }}}
}
scenes.add(abortScene)

# Where a JS app's values live (docs/js-apps-and-code-nodes.md): on an ESP32,
# and in the editor's preview while it runs as one, module variables last one
# render, init() runs on every render, and `frameos.remember` carries over.
# The preview of anything else keeps the interpreter, as a Pi does.
const valuesSceneId = "tests/single-scene-host/values"
scenes.add(%*{
  "id": valuesSceneId,
  "name": "values",
  "settings": {"execution": "interpreted", "refreshInterval": 300},
  "fields": [],
  "nodes": [
    {"id": "render", "type": "event", "data": {"keyword": "render"}},
    {"id": "counter", "type": "app", "data": {"keyword": "counter", "config": {}}}
  ],
  "edges": [
    {"id": "v1", "source": "render", "sourceHandle": "next", "target": "counter", "targetHandle": "prev"}
  ],
  "apps": {"counter": {"name": "Counter", "category": "logic", "sources": {
    "app.ts": "let renders = 0\nlet inits = 0\nexport function init() { inits++ }\n" &
      "export function run() { renders++; const kept = (frameos.recall('kept') ?? 0) + 1; " &
      "frameos.remember('kept', kept); frameos.log(`module ${renders} init ${inits} kept ${kept}`) }",
    "config.json": $(%*{"name": "Counter", "category": "logic"})
  }}}
})
# A scene that says which gesture it heard.
const tapSceneId = "tests/single-scene-host/tap"
scenes.add(%*{
  "id": tapSceneId,
  "name": "tap",
  "settings": {"execution": "interpreted", "refreshInterval": 300},
  "fields": [],
  "nodes": [
    {"id": "render", "type": "event", "data": {"keyword": "render"}},
    {"id": "tap", "type": "event", "data": {"keyword": "tap"}},
    {"id": "long", "type": "event", "data": {"keyword": "longPress"}},
    {"id": "sayTap", "type": "code", "data": {"codeArgs": [], "codeOutputs": [],
      "codeJS": "(console.log('heard tap'), 1)"}},
    {"id": "sayLong", "type": "code", "data": {"codeArgs": [], "codeOutputs": [],
      "codeJS": "(console.log('heard longPress'), 1)"}}
  ],
  "edges": [
    {"id": "t1", "source": "tap", "sourceHandle": "next", "target": "sayTap", "targetHandle": "prev"},
    {"id": "t2", "source": "long", "sourceHandle": "next", "target": "sayLong", "targetHandle": "prev"}
  ]
})
replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($scenes)))

var abortIn = ""          # "http" or "code": where the next run jumps out
var logLines: seq[string]
var abortLogger = Logger(frameConfig: config, enabled: true)
abortLogger.log = proc(payload: JsonNode) =
  let line = $payload
  logLines.add(line)
  if abortIn == "code" and "code ran" in line:
    abortHere()
abortLogger.enable = proc() = abortLogger.enabled = true
abortLogger.disable = proc() = abortLogger.enabled = false
jsHttpRequestHook = proc(url, httpMethod, body: string,
    headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  if abortIn == "http":
    abortHere()
  (200, "")

let abortHost = SingleSceneHost(frameConfig: config, logger: abortLogger)
abortHost.requestSelect = proc (sceneId: string): bool = true
abortHost.start()
abortHost.makeCurrent(abortSceneId.SceneId)

proc renderOnce() {.cdecl.} =
  try:
    discard abortHost.ensureScene()
    discard abortHost.renderScene(ExecutionContext(scene: abortHost.scene, event: "render",
      payload: %*{}, loopIndex: 0, loopKey: "."))
  except CatchableError as e:
    doAssert false, "render raised: " & e.msg

proc pressOnce() {.cdecl.} =
  # A press as said (no line, nothing to time): delivered at once, so the
  # scene's handler runs inside this send.
  discard abortHost.send(eoDriver, "button", %*{"pin": 5, "label": "RIGHT", "action": "press"})

proc count(needle: string): int =
  for line in logLines:
    if needle in line:
      inc result

# Inside a JS app's httpRequest: the incident on the E1002 (2026-10-13), a
# 1.2 MB response body that did not fit.
abortIn = "http"
doAssert guarded(renderOnce) == 1, "the render jumped out"
doAssert renderDeadlineArmedNow(), "the jump left the aborted render's deadline armed"
let fromApp = abortHost.recoverAbortedRun()
doAssert not renderDeadlineArmedNow()
doAssert dispatchBudgetTotalNow() == 0
# The app's interpreter was mid-call, and so was the scene's own program,
# which ran the app: both go.
doAssert fromApp.jsDropped == 2, "the app's and the scene's interpreters were mid-call: " & $fromApp
doAssert fromApp.jsBytes > 0
abortIn = ""
logLines.setLen(0)
doAssert guarded(renderOnce) == 0
doAssert count("fetched 200") == 1, "the app runs again, on a new interpreter: " & $logLines
doAssert count("deadline") == 0, $logLines

# Inside a code node, from an event: the dispatcher was draining and the
# scene's program was running. (It holds no lock while it runs, so none is
# left taken.)
abortIn = "code"
doAssert guarded(pressOnce) == 1, "the event jumped out"
let fromCode = abortHost.recoverAbortedRun()
doAssert sceneJsLockFreeForTest(), "or the next code node waits for it forever"
doAssert fromCode.jsDropped == 1, "the scene's interpreter was mid-call: " & $fromCode
abortIn = ""
logLines.setLen(0)
doAssert guarded(pressOnce) == 0
doAssert count("code ran") == 1, "the next press reaches the scene: " & $logLines
doAssert guarded(renderOnce) == 0
doAssert count("fetched 200") == 1, $logLines
doAssert count("deadline") == 0, $logLines
jsHttpRequestHook = nil

proc renderValuesThrice(keep = false) =
  let valuesHost = SingleSceneHost(frameConfig: config, logger: abortLogger)
  valuesHost.keepJsRuntimes = keep
  valuesHost.requestSelect = proc (sceneId: string): bool = true
  valuesHost.start()
  valuesHost.makeCurrent(valuesSceneId.SceneId)
  logLines.setLen(0)
  for _ in 1..3:
    discard valuesHost.ensureScene()
    discard valuesHost.renderScene(ExecutionContext(scene: valuesHost.scene, event: "render",
      payload: %*{}, loopIndex: 0, loopKey: "."))
  valuesHost.dropScene()

setSimulatedEmbedded(true)
renderValuesThrice()
for kept in 1..3:
  doAssert count("module 1 init 1 kept " & $kept) == 1,
    "as an ESP32: a fresh module and init() per render, remember carries over: " & $logLines

# An ESP32 that stays awake, and the preview running as one (wasm_main
# `frameos_wasm_set_embedded`): the interpreter stays while there is room, so
# an interactive scene's module state and handlers outlive a render.
renderValuesThrice(keep = true)
for n in 1..3:
  doAssert count("module " & $n & " init 1 kept " & $n) == 1,
    "as an awake ESP32: one module and one init() while there is room: " & $logLines

setSimulatedEmbedded(false)
renderValuesThrice()
for n in 1..3:
  doAssert count("module " & $n & " init 1 kept " & $n) == 1,
    "as a Pi: one module and one init() for the scene's life: " & $logLines

# A finger that went down before a render and lifted during it. On an ESP32
# the release waits in the touch queue until the render is over, stamped with
# when the glass reported it (`atMs`). The render must not tick the pointer to
# now first: a render that ended more than `longPressMs` after the press made
# it a `longPress`, and the release that followed no tap (the SenseCAP
# Indicator's weather panel, whose first press renders take 800 ms).
let tapHost = SingleSceneHost(frameConfig: config, logger: abortLogger)
tapHost.requestSelect = proc (sceneId: string): bool = true
tapHost.start()
tapHost.makeCurrent(tapSceneId.SceneId)
logLines.setLen(0)
let pressedAt = getMonoTime().ticks div 1_000_000 - 1200
discard tapHost.send(eoDriver, "pointerDown", %*{"x": 100, "y": 100, "pointerId": 1,
  "pointerType": "touch", "button": 0, "buttons": 1, "atMs": pressedAt})
discard tapHost.renderScene(ExecutionContext(scene: tapHost.scene, event: "render",
  payload: %*{}, loopIndex: 0, loopKey: "."))
doAssert count("heard longPress") == 0, "the render made the held finger a long press: " & $logLines
discard tapHost.send(eoDriver, "pointerUp", %*{"x": 100, "y": 100, "pointerId": 1,
  "pointerType": "touch", "button": 0, "buttons": 0, "atMs": pressedAt + 100})
doAssert count("heard tap") == 1, "a 100 ms press is a tap: " & $logLines
# Held on through it, the finger is a long press at the platform's next tick.
logLines.setLen(0)
discard tapHost.send(eoDriver, "pointerDown", %*{"x": 100, "y": 100, "pointerId": 1,
  "pointerType": "touch", "button": 0, "buttons": 1, "atMs": getMonoTime().ticks div 1_000_000 - 1200})
discard tapHost.renderScene(ExecutionContext(scene: tapHost.scene, event: "render",
  payload: %*{}, loopIndex: 0, loopKey: "."))
doAssert tapHost.tick(), "the tick makes the long press"
doAssert count("heard longPress") == 1, $logLines
tapHost.dropScene()

# The scene switcher (docs/scene-switcher.md) on a one-scene host: built by
# the host like any scene but from its own export, with nothing to parse,
# told which scene it was opened from, and the tile tapped is the next scene.
block scene_switcher_on_one_scene:
  let switcherConfig = FrameConfig(width: 320, height: 240, rotate: 0, scalingMode: "cover",
    device: "embedded", debug: false, saveAssets: %*false)
  let order = @["fixtures/dispatcher/switchFrom".SceneId, "fixtures/dispatcher/switchTo".SceneId]
  let switchHost = SingleSceneHost(frameConfig: switcherConfig, logger: logger)
  var picked: seq[string]
  switchHost.requestSelect = proc (sceneId: string): bool =
    picked.add(sceneId)
    switchHost.makeCurrent(SceneId(sceneId)) # the preview's way: at once
    true
  switchHost.sceneOrder = proc (): seq[SceneId] = order
  switchHost.start()
  sceneSwitcherListing = proc (): seq[SwitcherEntry] {.nimcall, gcsafe.} =
    @[SwitcherEntry(id: "fixtures/dispatcher/switchFrom", name: "From"),
      SwitcherEntry(id: "fixtures/dispatcher/switchTo", name: "To")]
  localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
    {.cast(gcsafe).}:
      switchHost.queue(origin, event, payload, scene)
  switchHost.makeCurrent(order[0])
  doAssert switchHost.ensureScene()
  doAssert switchHost.send(eoEventMap, "sceneSwitcher", %*{})
  doAssert picked == @[SceneSwitcherId], $picked
  doAssert switchHost.ensureScene() and switchHost.scene of SceneSwitcherScene
  doAssert switchHost.scene.state{"from"}.getStr() == order[0].string
  doAssert switchHost.sceneName == "Scene switcher"
  let canvas = newImageGray8(320, 240) # an ESP32 e-paper's luma canvas
  let drawn = switchHost.renderScene(ExecutionContext(scene: switchHost.scene, event: "render",
    payload: %*{}, image: canvas, hasImage: true, loopIndex: 0, loopKey: "."))
  doAssert not drawn.isNil and SceneSwitcherScene(switchHost.scene).paper, "a luma canvas is e-paper"
  let sixteen = newImageGray4(320, 240) # the E1003's
  let drawnInFour = switchHost.renderScene(ExecutionContext(scene: switchHost.scene, event: "render",
    payload: %*{}, image: sixteen, hasImage: true, loopIndex: 0, loopKey: "."))
  doAssert not drawnInFour.isNil and SceneSwitcherScene(switchHost.scene).paper, "a 4-bit canvas is e-paper"
  doAssert not sixteen.isOneColor, "the switcher drew nothing into the 4-bit canvas"
  # A key with the role `next`, then OK: the scene after the one it came from.
  doAssert switchHost.send(eoHttpWrite, "button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  doAssert switchHost.scene.state{"highlight"}.getStr() == order[1].string
  doAssert switchHost.send(eoHttpWrite, "button", %*{"label": "OK", "role": "primary", "action": "press"})
  doAssert picked == @[SceneSwitcherId, order[1].string], $picked
  # Back on the switcher, a tap on the first tile picks it, through the
  # input state's gestures, as a finger on an ESP32's glass does.
  doAssert switchHost.send(eoEventMap, "sceneSwitcher", %*{})
  doAssert switchHost.ensureScene() and switchHost.scene.state{"from"}.getStr() == order[1].string
  discard switchHost.renderScene(ExecutionContext(scene: switchHost.scene, event: "render",
    payload: %*{}, image: newImage565(320, 240), hasImage: true, loopIndex: 0, loopKey: "."))
  let grid = switcherGrid(2, 320, 240, thumbnails = false)
  let wireX = (grid.x0 + grid.tileW div 2) * 32767 div 320
  let wireY = (grid.y0 + grid.tileH div 2) * 32767 div 240
  let at = getMonoTime().ticks div 1_000_000
  discard switchHost.send(eoDriver, "pointerDown", %*{"x": wireX, "y": wireY, "pointerId": 1,
    "pointerType": "touch", "button": 0, "buttons": 1, "atMs": at - 120})
  discard switchHost.send(eoDriver, "pointerUp", %*{"x": wireX, "y": wireY, "pointerId": 1,
    "pointerType": "touch", "button": 0, "buttons": 0, "atMs": at - 60})
  doAssert picked[^1] == order[0].string, "the tap picked " & $picked
  # Its state is nobody's file: the switcher is never the scene a boot comes back to.
  doAssert switchHost.scene.isNil or switchHost.sceneId.get() == order[0]
  switchHost.dropScene()
  sceneSwitcherListing = nil

# An ESP32 given no scene yet opens the settings from its status screen (the
# Wi-Fi is set there, docs/scene-settings.md "The frame tab"); closing them
# goes back to no scene, the status screen, and asks the firmware for nothing.
block scene_settings_with_no_scene:
  let noneConfig = FrameConfig(width: 320, height: 240, rotate: 0, scalingMode: "cover",
    device: "embedded", debug: false, saveAssets: %*false)
  let noneHost = SingleSceneHost(frameConfig: noneConfig, logger: logger)
  var picked: seq[string]
  noneHost.requestSelect = proc (sceneId: string): bool =
    picked.add(sceneId)
    noneHost.makeCurrent(SceneId(sceneId))
    true
  noneHost.sceneOrder = proc (): seq[SceneId] = @[]
  noneHost.start()
  localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
    {.cast(gcsafe).}:
      noneHost.queue(origin, event, payload, scene)
  doAssert noneHost.sceneId.isNone and not noneHost.ensureScene()
  doAssert noneHost.send(eoEventMap, "sceneSettings", %*{})
  doAssert picked == @[SceneSettingsId], $picked
  doAssert noneHost.ensureScene() and noneHost.scene.state{"from"}.getStr() == ""
  doAssert noneHost.send(eoEventMap, "sceneSettings", %*{})
  doAssert picked == @[SceneSettingsId], "the way back is the host's own: " & $picked
  doAssert noneHost.sceneId.isNone and noneHost.scene.isNil and noneHost.renderRequested
  # Not a way out of a scene: an empty id for one that is not built in is refused.
  noneHost.makeCurrent(SceneId("fixtures/dispatcher/switchFrom"))
  doAssert not noneHost.send(eoScene, "setCurrentScene", %*{"sceneId": ""})
  doAssert noneHost.sceneId.get().string == "fixtures/dispatcher/switchFrom"
  noneHost.dropScene()
  localEventSink = nil

# A control plane rendering for a frame (the wasm runtime, a fresh process per
# pull, docs/server-rendering.md) opens the switcher a key opened again where
# it left it: the switch replayed with what it was opened from, then the
# highlight put back over what opening it set.
block switcher_opened_again_as_it_was_left:
  let againConfig = FrameConfig(width: 320, height: 240, rotate: 0, scalingMode: "cover",
    device: "embedded", debug: false, saveAssets: %*false)
  let order = @["fixtures/dispatcher/switchFrom".SceneId, "fixtures/dispatcher/switchTo".SceneId]
  let againHost = SingleSceneHost(frameConfig: againConfig, logger: logger)
  againHost.requestSelect = proc (sceneId: string): bool =
    againHost.makeCurrent(SceneId(sceneId))
    true
  againHost.sceneOrder = proc (): seq[SceneId] = order
  againHost.start()
  sceneSwitcherListing = proc (): seq[SwitcherEntry] {.nimcall, gcsafe.} =
    @[SwitcherEntry(id: "fixtures/dispatcher/switchFrom", name: "From"),
      SwitcherEntry(id: "fixtures/dispatcher/switchTo", name: "To")]
  localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
    {.cast(gcsafe).}:
      againHost.queue(origin, event, payload, scene)
  let kept = %*{"from": order[0].string, "highlight": order[1].string, "page": 0}
  doAssert not againHost.reopenBuiltIn(kept), "no scene is current"
  againHost.makeCurrent(order[0])
  doAssert not againHost.reopenBuiltIn(kept), "not a built-in scene"
  againHost.makeCurrent(SceneId(SceneSwitcherId))
  doAssert not againHost.reopenBuiltIn(%*[]), "a state that is not an object"
  doAssert againHost.reopenBuiltIn(kept)
  doAssert againHost.scene of SceneSwitcherScene
  doAssert againHost.scene.state{"from"}.getStr() == order[0].string
  doAssert againHost.scene.state{"highlight"}.getStr() == order[1].string, $againHost.scene.state
  doAssert not againHost.reopenBuiltIn(kept), "resident already"
  # OK picks the tile it left highlighted.
  doAssert againHost.send(eoHttpWrite, "button", %*{"label": "OK", "role": "primary", "action": "press"})
  doAssert againHost.sceneId.get() == order[1]
  againHost.dropScene()
  sceneSwitcherListing = nil
  localEventSink = nil
echo "ok"

# ------------------------------------------- the scene a switcher covers
#
# Opening the scene switcher over a scene keeps that scene (while there is
# room), and the way back makes the same instance current again: no second
# init, no rebuild from its JSON. The way to somewhere else lets it go.
block:
  let coverHost = SingleSceneHost(frameConfig: config, logger: logger)
  coverHost.requestSelect = proc (sceneId: string): bool = true
  coverHost.start()
  let fromId = "fixtures/dispatcher/switchFrom".SceneId
  coverHost.makeCurrent(fromId)
  doAssert coverHost.ensureScene()
  let first = coverHost.scene
  coverHost.makeCurrent("system/sceneSwitcher".SceneId)
  doAssert coverHost.ensureScene()
  doAssert coverHost.scene != first, "the switcher is resident while it shows"
  coverHost.makeCurrent(fromId)
  doAssert coverHost.ensureScene()
  doAssert coverHost.scene == first, "back to the covered scene: the same instance"
  # Covered again, and the way back leads elsewhere: the covered one goes.
  coverHost.makeCurrent("system/sceneSwitcher".SceneId)
  doAssert coverHost.ensureScene()
  coverHost.makeCurrent("fixtures/dispatcher/switchTo".SceneId)
  doAssert coverHost.ensureScene()
  doAssert coverHost.scene != first
  coverHost.makeCurrent(fromId)
  doAssert coverHost.ensureScene()
  doAssert coverHost.scene != first, "switchTo was shown in between: switchFrom is built again"
  # On an ESP32 the switch waits for the scene to be read from flash, and the
  # scene left behind must not outlive the switch: its teardown, later, took the
  # layout's taps with it.
  coverHost.makeCurrent("system/sceneSwitcher".SceneId)
  doAssert coverHost.ensureScene()
  doAssert not coverHost.covered.isNil
  coverHost.makeCurrent("fixtures/dispatcher/switchTo".SceneId, drop = false)
  doAssert coverHost.covered.isNil, "the way back led elsewhere"
  echo "covered scene ok"

# ------------------------------------------- the layout kept between scenes
#
# The host holds one scene, so a switch dropped the layout the old scene wore
# and the next scene read, parsed and started it again: 1.2 s of every switch
# on a reTerminal E1003 (2026-11-10). The layout the dropped scene wore is kept
# for the next scene that wears it; new scenes from the plane let it go.
block:
  let layoutJsx = "export function get(app) { return <div className=\"flex flex-col w-full h-full bg-[#008080]\"><yield /><div className=\"h-[8px] bg-[#c0c0c0]\" /></div> }"
  proc jsxLayout(): JsonNode =
    %*{"id": "tests/keptLayout", "name": "Kept layout", "settings": {"execution": "interpreted",
      "refreshInterval": 60, "backgroundColor": "#000000", "isLayout": true}, "fields": [],
      "apps": {"ui": {"name": "ui", "category": "data", "version": "1.0.0", "fields": [],
        "output": [{"name": "image", "type": "image"}],
        "sources": {"app.tsx": layoutJsx, "config.json": "{\"name\": \"ui\", \"output\": [{\"name\": \"image\", \"type\": \"image\"}], \"fields\": []}"}}},
      "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
        {"id": "2", "type": "app", "data": {"keyword": "ui", "config": {}}},
        {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
      "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
        {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}
  proc wearing(id, color: string): JsonNode =
    %*{"id": id, "name": id, "settings": {"execution": "interpreted", "refreshInterval": 300,
      "backgroundColor": "#000000"}, "fields": [], "apps": {},
      "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
        {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": color}}}],
      "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"}],
      "layout": {"sceneId": "tests/keptLayout", "state": {}}}
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs(
    $(%*[jsxLayout(), wearing("tests/wearsA", "#ff0000"), wearing("tests/wearsB", "#0000ff")]))))
  let keepHost = SingleSceneHost(frameConfig: FrameConfig(width: 40, height: 40, rotate: 0,
    scalingMode: "cover", debug: false, saveAssets: %*false), logger: logger)
  keepHost.requestSelect = proc (sceneId: string): bool = true
  keepHost.start()
  proc show(id: string): FrameScene =
    keepHost.makeCurrent(id.SceneId)
    doAssert keepHost.ensureScene()
    discard keepHost.renderScene(ExecutionContext(scene: keepHost.scene, event: "render",
      payload: %*{}, image: newImage(40, 40), hasImage: true, loopIndex: 0, loopKey: "."))
    doAssert not keepHost.scene.wornLayout.isNil, id & " wears the layout"
    keepHost.scene.wornLayout
  let first = show("tests/wearsA")
  let second = show("tests/wearsB")
  doAssert second == first, "the next scene wearing the layout gets the same instance"
  doAssert show("tests/wearsA") == first, "and back again"
  # New scenes from the plane may hold a changed layout: it is made afresh.
  keepHost.dropScene()
  dropParkedLayout()
  doAssert show("tests/wearsB") != first, "after the scenes were replaced, a new instance"
  echo "kept layout ok"
