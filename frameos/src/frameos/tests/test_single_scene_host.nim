import std/[json, monotimes, options, os, sequtils, strutils, tables]
import ../channels
import ../events_gen
from ../events import settingsWindowId
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
import system/sceneSettings/scene as sceneSettings
from ../layout_choice import layoutListing
from ../ui/events import uiTarget
from ../ui/layout import ueClick

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
# was up. Its up is the `button` `press` the scene's listener hears (no rule
# binds a double press of it: nothing waits). (The scene listens for presses
# only: nothing hears the edges themselves.)
let wokeAt = getMonoTime().ticks div 1_000_000 - 1000
discard host.send(eoDriver, "gpio", %*{"pin": 5, "label": "RIGHT", "level": 0, "wake": true, "atMs": wokeAt})
doAssert not host.scene.isNil, "an edge sent before the first render builds the scene"
discard host.send(eoDriver, "gpio", %*{"pin": 5, "label": "RIGHT", "level": 1, "atMs": wokeAt + 80})
discard host.tick()
doAssert selected == @["fixtures/dispatcher/switchTo"], "selected " & $selected

# What the scene's async code dispatches between renders (docs/async-js.md: a
# picture came, `frameos.dispatch("render")` in a promise's callback) is
# queued, and nothing sends while the firmware idles: the idle loop drains it
# after the pump, or it waited for the next tap (the SenseCAP, 2026-11-15).
discard host.takeRenderRequested()
host.queue(eoScene, "render", %*{})
doAssert not host.tick(), "no time-based input: the tick alone delivers nothing"
doAssert not host.takeRenderRequested(), "still queued"
doAssert host.drainQueued(), "the idle loop's drain delivers it"
doAssert host.takeRenderRequested(), "and the render it asked for is wanted"
doAssert not host.drainQueued(), "nothing left"

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
# The app was mid-call in the scene's context, as was the scene's own
# program, which ran the app: the one interpreter they share goes.
doAssert fromApp.jsDropped == 1, "the scene's interpreter, its app's too, was mid-call: " & $fromApp
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
  let grid = switcherGrid(320, 240, thumbnails = false)
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

# ------------------------------------------- a covered scene replaced
#
# A scene changed while the switcher or the settings cover it (a push, a store
# install, the Code editor's save, an ESP32's `usb_api scene-put`) comes back
# as the frame holds it now, never as the instance from before: the CrowPanel
# 1.46" rotary kept running 2048's old onEvent after a put made under its
# switcher, until a restart (the hardware bench, 2026-11-26).
block:
  proc painted(color: string): string =
    $(%*[{"id": "tests/replaced", "name": "Replaced", "settings": {"execution": "interpreted",
      "refreshInterval": 300, "backgroundColor": "#000000"}, "fields": [], "apps": {},
      "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
        {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": color}}}],
      "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"}]}])
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs(painted("#ff0000"))))
  let replaceHost = SingleSceneHost(frameConfig: config, logger: logger)
  replaceHost.requestSelect = proc (sceneId: string): bool = true
  replaceHost.start()
  let replacedId = "tests/replaced".SceneId
  proc shownRed(): bool =
    doAssert replaceHost.ensureScene()
    let image = replaceHost.renderScene(ExecutionContext(scene: replaceHost.scene, event: "render",
      payload: %*{}, image: newImage(4, 3), hasImage: true, loopIndex: 0, loopKey: "."))
    image[0, 0].r > 128 and image[0, 0].b < 128
  replaceHost.makeCurrent(replacedId)
  doAssert shownRed()
  let before = replaceHost.scene
  replaceHost.makeCurrent("system/sceneSwitcher".SceneId)
  doAssert replaceHost.ensureScene()
  doAssert replaceHost.covered == before
  # What an ESP32's loadScene does with the scene read off flash again.
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs(painted("#0000ff"))),
    newSet = false)
  replaceHost.makeCurrent(replacedId)
  doAssert not shownRed(), "the scene as it is now, not the covered instance's old graph"
  doAssert replaceHost.scene != before, "a new instance"
  doAssert replaceHost.covered.isNil
  # Unchanged, the way back is still the same instance.
  let after = replaceHost.scene
  replaceHost.makeCurrent("system/sceneSwitcher".SceneId)
  doAssert replaceHost.ensureScene()
  replaceHost.makeCurrent(replacedId)
  doAssert replaceHost.ensureScene() and replaceHost.scene == after
  replaceHost.dropScene()
  echo "covered scene replaced ok"

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

  # The switcher opened over a scene wears that scene's layout: the same
  # instance, lent and given back, never a second one started beside it
  # (1.6-2.5 s of each switcher open on a reTerminal Sticky, read off flash
  # again, 2026-11-26).
  keepHost.dropScene()
  dropParkedLayout()
  keepHost.requestSelect = proc (sceneId: string): bool =
    keepHost.makeCurrent(sceneId.SceneId)
    true
  keepHost.sceneOrder = proc (): seq[SceneId] = @["tests/wearsA".SceneId, "tests/wearsB".SceneId]
  proc renderNow() =
    discard keepHost.renderScene(ExecutionContext(scene: keepHost.scene, event: "render",
      payload: %*{}, image: newImage(40, 40), hasImage: true, loopIndex: 0, loopKey: "."))
  let worn = show("tests/wearsA")
  let covered = keepHost.scene
  doAssert keepHost.send(eoHttpAdmin, "sceneSwitcher", %*{})
  doAssert keepHost.ensureScene() and keepHost.scene.id.string == SceneSwitcherId
  doAssert keepHost.covered == covered, "the scene stays under the switcher"
  renderNow()
  doAssert keepHost.scene.wornLayout == worn, "the switcher wears the covered scene's layout instance"
  doAssert covered.wornLayout.isNil, "lent, not shared"
  keepHost.makeCurrent("tests/wearsA".SceneId)
  doAssert keepHost.ensureScene() and keepHost.scene == covered, "back to the covered scene"
  renderNow()
  doAssert keepHost.scene.wornLayout == worn, "and its layout back with it"
  keepHost.dropScene()
  dropParkedLayout()
  keepHost.requestSelect = proc (sceneId: string): bool = true
  keepHost.sceneOrder = nil
  echo "the switcher borrows the layout ok"

# ------------------------------------------------------ windows (the browser)
#
# A windowed host (the browser's, wasm_main `frameos_wasm_set_windowed`) runs
# a frame's scenes side by side, as a Pi does (docs/scene-layouts.md
# "Windows"): a scene the frame leaves stays, for a layout's window, and is the
# same one when it comes forward; a built-in scene left for another window
# stays open as it was.
block windowed_host_keeps_what_it_leaves:
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($scenes)))
  let fromId = "fixtures/dispatcher/switchFrom".SceneId
  let toId = "fixtures/dispatcher/switchTo".SceneId
  let w = SingleSceneHost(frameConfig: config, logger: logger)
  w.requestSelect = proc (sceneId: string): bool =
    w.makeCurrent(sceneId.SceneId)
    true
  w.sceneOrder = proc (): seq[SceneId] = @[fromId, toId]
  w.start()
  w.setWindowed(true)
  w.makeCurrent(fromId)
  doAssert w.ensureScene()
  let first = w.scene
  doAssert w.send(eoHttpAdmin, "setCurrentScene", %*{"sceneId": toId.string})
  doAssert w.ensureScene() and w.scene.id == toId
  doAssert w.windows.getOrDefault(fromId) == first
  doAssert hostSceneFor(fromId) == first, "a window shows the scene itself"
  doAssert w.send(eoHttpAdmin, "setCurrentScene", %*{"sceneId": fromId.string})
  doAssert w.ensureScene() and w.scene == first, "the same one comes forward"
  # The settings, left for another window: open there, as they were. Each
  # scene's are an instance of their own (event_loop.settingsWindows).
  doAssert w.send(eoHttpAdmin, "sceneSettings", %*{})
  doAssert w.ensureScene() and w.scene.id.string == settingsWindowId(fromId.string)
  let panel = w.scene
  doAssert panel.state{"from"}.getStr() == fromId.string
  doAssert w.send(eoHttpAdmin, "setCurrentScene", %*{"sceneId": toId.string})
  doAssert panel.state{"away"}.getBool(), $panel.state
  doAssert hostSceneFor(settingsWindowId(fromId.string).SceneId) == panel
  doAssert panel.state{"from"}.getStr() == fromId.string
  # Opened from the other scene: an instance of its own, the first left open.
  doAssert w.ensureScene()
  doAssert w.send(eoHttpAdmin, "sceneSettings", %*{})
  doAssert w.ensureScene() and w.scene != panel and w.scene.id.string == settingsWindowId(toId.string)
  doAssert w.scene.state{"from"}.getStr() == toId.string
  doAssert panel.state{"away"}.getBool() and panel.state{"from"}.getStr() == fromId.string
  doAssert hostSceneFor(settingsWindowId(fromId.string).SceneId) == panel
  # The frame page: one window, the plain id, over the scene those are for.
  doAssert w.send(eoHttpAdmin, "sceneSettings", %*{"page": "frame"})
  doAssert w.ensureScene() and w.scene.id.string == SceneSettingsId
  doAssert w.scene.state{"from"}.getStr() == toId.string
  # Off: one scene at a time again, nothing kept.
  w.setWindowed(false)
  doAssert w.windows.len == 0 and hostSceneFor.isNil and not builtInScenesStay

# A desktop learns each scene's own window size from `app.frame.scenes`
# (`settings.windowSize`): off the host's own list, the switcher's (an
# ESP32's catalog, or the loaded scenes: loadedSceneListing, the browser's).
block windowed_listing_carries_window_sizes:
  # And its icon and category (`settings.icon` / `settings.category`,
  # docs/scene-icons.md): a value that is not a path is no icon; the category
  # is the scene's text as it is (the desktops trim it).
  var sized = parseJson($scenes)
  sized[1]["settings"]["windowSize"] = %"480x480"
  sized[1]["settings"]["icon"] = %" M12 2L2 22h20z "
  sized[0]["settings"]["icon"] = %"<svg/>"
  sized[1]["settings"]["category"] = %" Real time "
  sized[1]["settings"]["opens"] = %"pdf epub"
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($sized)))
  let fromId = "fixtures/dispatcher/switchFrom".SceneId
  let toId = "fixtures/dispatcher/switchTo".SceneId
  doAssert sized[1]["id"].getStr() == toId.string
  let w = SingleSceneHost(frameConfig: config, logger: logger)
  w.sceneOrder = proc (): seq[SceneId] = @[fromId, toId]
  let listing = sceneSwitcherListing
  sceneSwitcherListing = proc (): seq[SwitcherEntry] {.nimcall, gcsafe.} =
    {.cast(gcsafe).}:
      loadedSceneListing(@["fixtures/dispatcher/switchFrom".SceneId, "fixtures/dispatcher/switchTo".SceneId,
        "fixtures/dispatcher/gone".SceneId])
  w.setWindowed(true)
  var listed = windowSceneListing()
  doAssert listed.len == 3, $listed
  doAssert listed[0]{"windowSize"}.isNil, $listed
  doAssert listed[1]{"windowSize"}.getStr() == "480x480", $listed
  doAssert listed[0]{"icon"}.isNil, $listed
  doAssert listed[1]{"icon"}.getStr() == "M12 2L2 22h20z", $listed
  doAssert listed[0]{"category"}.isNil, $listed
  doAssert listed[1]{"category"}.getStr() == " Real time ", $listed
  doAssert listed[0]{"opens"}.isNil, $listed
  doAssert listed[1]{"opens"}.getStr() == "pdf epub", $listed
  # A scene in the order that is not loaded: its id alone.
  doAssert listed[2] == %*{"id": "fixtures/dispatcher/gone", "name": ""}, $listed
  sceneSwitcherListing = proc (): seq[SwitcherEntry] {.nimcall, gcsafe.} =
    @[SwitcherEntry(id: "fixtures/dispatcher/switchTo", name: "To", windowSize: "640x480", icon: "M0 0h24v24H0z",
      category: "Weather", opens: "txt")]
  listed = windowSceneListing()
  doAssert listed.len == 1 and listed[0]{"windowSize"}.getStr() == "640x480", $listed
  doAssert listed[0]{"icon"}.getStr() == "M0 0h24v24H0z", $listed
  doAssert listed[0]{"category"}.getStr() == "Weather", $listed
  doAssert listed[0]{"opens"}.getStr() == "txt", $listed
  w.setWindowed(false)
  sceneSwitcherListing = listing
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($scenes)))
  echo "window sizes listed ok"

# ------------------------------------------- windows where memory is short
#
# An ESP32 runs a desktop's windows too, but only so many at once, the one in
# front included (app_runtime.windowLimit: 2 on an 8 MB board): a scene brought
# to the front lets the window kept longest ago go, a window asked for past the
# limit takes the place of one the desktop no longer has open, else stays
# empty, and without a desktop the frame keeps one scene, as it always did.
block windows_where_memory_is_short:
  deviceMemoryBytesOverride = 8 * 1024 * 1024 - 65536
  doAssert windowLimit() == 2
  let layoutJsx = "export function get(app) { return <div className=\"flex flex-col w-full h-full\"><yield /></div> }"
  let layout = %*{"id": "tests/desk", "name": "Desk", "settings": {"execution": "interpreted",
    "refreshInterval": 60, "backgroundColor": "#000000", "isLayout": true}, "fields": [],
    "apps": {"ui": {"name": "ui", "category": "data", "version": "1.0.0", "fields": [],
      "output": [{"name": "image", "type": "image"}],
      "sources": {"app.tsx": layoutJsx, "config.json": "{\"name\": \"ui\", \"output\": [{\"name\": \"image\", \"type\": \"image\"}], \"fields\": []}"}}},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "ui", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}
  proc scene(id: string, worn: bool): JsonNode =
    result = %*{"id": id, "name": id, "settings": {"execution": "interpreted", "refreshInterval": 300,
      "backgroundColor": "#000000"}, "fields": [], "apps": {},
      "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
        {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": "#ff0000"}}}],
      "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"}]}
    if worn:
      result["layout"] = %*{"sceneId": "tests/desk", "state": {}}
  let a = "tests/winA".SceneId
  let b = "tests/winB".SceneId
  let c = "tests/winC".SceneId
  let plain = "tests/plain".SceneId
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($(%*[layout,
    scene(a.string, true), scene(b.string, true), scene(c.string, true), scene(plain.string, false),
    scene("tests/plainToo", false)]))))
  let lim = SingleSceneHost(frameConfig: FrameConfig(width: 40, height: 40, rotate: 0,
    scalingMode: "cover", debug: false, saveAssets: %*false), logger: logger)
  lim.requestSelect = proc (sceneId: string): bool =
    lim.makeCurrent(sceneId.SceneId)
    true
  lim.sceneOrder = proc (): seq[SceneId] = @[a, b, c, plain, "tests/plainToo".SceneId]
  lim.start()
  lim.setWindowed(true)
  proc render() =
    discard lim.renderScene(ExecutionContext(scene: lim.scene, event: "render",
      payload: %*{}, image: newImage(40, 40), hasImage: true, loopIndex: 0, loopKey: "."))
  proc desk(open: varargs[string]) =
    ## What the desktop has open, as a layout's keepOpen writes it.
    let worn = if lim.scene.isNil: nil else: lim.scene.wornLayout
    doAssert not worn.isNil, "the scene wears the desk"
    worn.state["openScenes"] = %open
  proc show(id: SceneId) =
    doAssert lim.send(eoHttpAdmin, "setCurrentScene", %*{"sceneId": id.string})
    doAssert lim.ensureScene() and lim.scene.id == id

  # Without a desktop, one scene: the one left goes.
  lim.makeCurrent(plain)
  doAssert lim.ensureScene()
  render()
  show("tests/plainToo".SceneId)
  doAssert lim.windows.len == 0, "no desktop keeps the scene left"
  render()
  doAssert not builtInScenesStay, "no desktop: the built-in scenes go back as always"
  doAssert lim.send(eoHttpAdmin, "sceneSettings", %*{})
  doAssert lim.ensureScene() and lim.scene.id.string == SceneSettingsId, "the one settings, as always"

  # On a desktop the scene left stays in its window.
  show(a)
  render()
  desk(a.string)
  show(b)
  doAssert lim.windows.hasKey(a), "the desktop has it open: it stays"
  render()
  desk(a.string, b.string)
  render()
  doAssert lim.windows.hasKey(a), "open on the desktop, it outlives the pass"
  doAssert builtInScenesStay, "a desktop: the built-in scenes stay for their windows"
  # A third window past the limit, with both still open: it does not start.
  doAssert hostSceneFor(c).isNil, "past the limit, with nothing to let go"
  doAssert lim.windows.hasKey(a) and not lim.windows.hasKey(c)
  # The desktop closed A: C takes its place.
  desk(b.string, c.string)
  let third = hostSceneFor(c)
  doAssert not third.isNil and lim.windows.hasKey(c) and not lim.windows.hasKey(a)
  # Built-in scenes are not counted: B's settings over it, B and C kept.
  doAssert lim.send(eoHttpAdmin, "sceneSettings", %*{})
  doAssert lim.ensureScene() and isBuiltInScene(lim.scene.id.string)
  doAssert lim.windows.hasKey(b) and lim.windows.hasKey(c), "the settings take no scene's place"
  # A scene brought to the front lets the window kept longest ago go.
  show(a)
  doAssert not lim.windows.hasKey(c), "C was kept longest ago"
  doAssert lim.windows.hasKey(b)
  # The desktop gone (another layout, none): after the pass, nothing is kept.
  desk()
  render()
  doAssert lim.windows.len == 0, "no desktop, no windows"
  lim.setWindowed(false)

  # Where one scene runs at a time (the 13.3" E1004), the scene in front takes
  # that place: the one left is not kept, open on the desktop or not.
  deviceMemoryBytesOverride = 3 * 1024 * 1024
  doAssert windowLimit() == 1
  lim.setWindowed(true)
  show(plain)
  show(a)
  render()
  desk(a.string)
  doAssert not lim.keepsInWindow(a), "one at a time: nothing is kept for a window"
  show(b)
  doAssert lim.windows.len == 0, "the scene left went, open on the desktop or not"
  render()
  desk(a.string, b.string)
  doAssert hostSceneFor(a).isNil, "and no window starts beside the one in front"
  lim.setWindowed(false)

  # Where two run, the window kept longest ago goes at the switch, before the
  # next scene starts beside them.
  deviceMemoryBytesOverride = 8 * 1024 * 1024 - 65536
  lim.setWindowed(true)
  show(a)
  render()
  desk(a.string)
  show(b)
  render()
  desk(a.string, b.string)
  doAssert lim.windows.len == 1 and lim.windows.hasKey(a)
  lim.makeCurrent(c)
  doAssert lim.windows.len == 1 and lim.windows.hasKey(b) and not lim.windows.hasKey(a),
    "B kept, A let go as it was left: two in all with C"
  lim.setWindowed(false)
  deviceMemoryBytesOverride = 0
  echo "windows where memory is short ok"

# A scene that wears another layout than the one parked lets the parked one go
# as its own starts: nobody wears it any more, and its interpreters held their
# memory until the next switch (NeXTSTEP's beside OS/2 Warp on a reTerminal
# E1004, 2026-11-19). The scenes it had open go to the new layout.
block another_layout_lets_the_parked_one_go:
  let layoutJsx = "export function get(app) { return <div className=\"flex flex-col w-full h-full\"><yield /></div> }"
  proc desk(id: string): JsonNode =
    %*{"id": id, "name": id, "settings": {"execution": "interpreted",
      "refreshInterval": 60, "backgroundColor": "#000000", "isLayout": true}, "fields": [],
      "apps": {"ui": {"name": "ui", "category": "data", "version": "1.0.0", "fields": [],
        "output": [{"name": "image", "type": "image"}],
        "sources": {"app.tsx": layoutJsx, "config.json": "{\"name\": \"ui\", \"output\": [{\"name\": \"image\", \"type\": \"image\"}], \"fields\": []}"}}},
      "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
        {"id": "2", "type": "app", "data": {"keyword": "ui", "config": {}}},
        {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
      "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
        {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}
  proc wearing(id, layoutId: string): JsonNode =
    %*{"id": id, "name": id, "settings": {"execution": "interpreted", "refreshInterval": 300,
      "backgroundColor": "#000000"}, "fields": [], "apps": {},
      "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
        {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": "#ff0000"}}}],
      "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"}],
      "layout": {"sceneId": layoutId, "state": {}}}
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($(%*[
    desk("tests/deskOne"), desk("tests/deskTwo"), wearing("tests/inOne", "tests/deskOne"),
    wearing("tests/inTwo", "tests/deskTwo")]))))
  let h = SingleSceneHost(frameConfig: FrameConfig(width: 40, height: 40, rotate: 0,
    scalingMode: "cover", debug: false, saveAssets: %*false), logger: logger)
  h.requestSelect = proc (sceneId: string): bool =
    h.makeCurrent(sceneId.SceneId)
    true
  h.sceneOrder = proc (): seq[SceneId] = @["tests/inOne".SceneId, "tests/inTwo".SceneId]
  h.start()
  h.makeCurrent("tests/inOne".SceneId)
  doAssert h.ensureScene()
  discard h.renderScene(ExecutionContext(scene: h.scene, event: "render",
    payload: %*{}, image: newImage(40, 40), hasImage: true, loopIndex: 0, loopKey: "."))
  doAssert not h.scene.wornLayout.isNil and h.scene.wornLayout.id.string == "tests/deskOne"
  h.makeCurrent("tests/inTwo".SceneId)
  doAssert h.ensureScene()
  discard h.renderScene(ExecutionContext(scene: h.scene, event: "render",
    payload: %*{}, image: newImage(40, 40), hasImage: true, loopIndex: 0, loopKey: "."))
  doAssert h.scene.wornLayout.id.string == "tests/deskTwo"
  doAssert takeParkedLayout("tests/deskOne").isNil, "the first desk is not parked any more"
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($scenes)))
  echo "another layout lets the parked one go ok"

# ------------------------------------------- the frame page beside the focus
#
# Two windows, a scene and the frame page, and the focus moved from the page to
# the scene: the page stays open in its window and still holds the frame's
# layout, with that layout's gear. The one layout instance goes along with the
# focus, so the page wears none there, and read off its own it said "No
# layout" (the Windows 98 Control Panel beside the Welcome, 2026-11-17).
block the_frame_page_keeps_the_frame_layout_when_the_focus_moves:
  let deskJsx = "export function get(app) { return <div className=\"flex w-full h-full\">" &
    "<div className=\"w-1/2 h-full\"><yield /></div>" &
    "<div className=\"w-1/2 h-full\"><Scene id=\"system/sceneSettings\" /></div></div> }"
  let desk = %*{"id": "tests/deskTwo", "name": "Desk two", "settings": {"execution": "interpreted",
    "refreshInterval": 60, "backgroundColor": "#000000", "isLayout": true, "desktop": true},
    "fields": [{"name": "look", "label": "Look", "type": "string", "value": "plain", "access": "public"}],
    "apps": {"ui": {"name": "ui", "category": "data", "version": "1.0.0", "fields": [],
      "output": [{"name": "image", "type": "image"}],
      "sources": {"app.tsx": deskJsx, "config.json": "{\"name\": \"ui\", \"output\": [{\"name\": \"image\", \"type\": \"image\"}], \"fields\": []}"}}},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "ui", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}
  let welcome = "tests/welcome".SceneId
  let shown = %*{"id": welcome.string, "name": "Welcome", "settings": {"execution": "interpreted",
    "refreshInterval": 300, "backgroundColor": "#000000"}, "fields": [], "apps": {},
    "layout": {"sceneId": "tests/deskTwo", "state": {}},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": "#ff0000"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"}]}
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($(%*[desk, shown]))))
  let savedRead = sceneSettings.frameSettingsRead
  sceneSettings.frameSettingsRead = proc (): JsonNode {.nimcall, gcsafe, raises: [].} =
    {.cast(gcsafe).}:
      result = %*{"rotate": 0, "renderScale": 0}
  let w = SingleSceneHost(frameConfig: FrameConfig(width: 400, height: 240, rotate: 0,
    scalingMode: "cover", debug: false, saveAssets: %*false), logger: logger)
  w.requestSelect = proc (sceneId: string): bool =
    w.makeCurrent(sceneId.SceneId)
    true
  w.sceneOrder = proc (): seq[SceneId] = @[welcome]
  w.start()
  w.setWindowed(true)
  proc render() =
    discard w.renderScene(ExecutionContext(scene: w.scene, event: "render",
      payload: %*{}, image: newImage(400, 240), hasImage: true, loopIndex: 0, loopKey: "."))
  proc layoutGear(): bool =
    ## The gear beside Layout (the frame page's handler 20004), in what the
    ## page's last render laid out.
    for r in uiTarget(SceneSettingsId, 1, create = false).regions:
      if r.handlers[ueClick] == 20004 + 1:
        return true
  w.makeCurrent(welcome)
  doAssert w.ensureScene()
  render()
  # The frame page, opened over the Welcome: its window has the focus.
  doAssert w.send(eoHttpAdmin, "sceneSettings", %*{"page": "frame"})
  doAssert w.ensureScene() and w.scene.id.string == SceneSettingsId
  let page = SceneSettingsScene(w.scene)
  render()
  doAssert page.state{"page"}.getStr() == "frame"
  doAssert not page.wornLayout.isNil and page.wornLayout.id.string == "tests/deskTwo"
  doAssert page.heldLayout(layoutListing()) == "tests/deskTwo"
  doAssert layoutGear(), "the layout's gear beside its select"
  # The focus to the Welcome: the page stays open in its window, drawn there.
  doAssert w.send(eoHttpAdmin, "setCurrentScene", %*{"sceneId": welcome.string})
  doAssert w.ensureScene() and w.scene.id == welcome
  doAssert page.state{"away"}.getBool() and page.wornLayout.isNil, $page.state
  uiTarget(SceneSettingsId, 1).regions.setLen(0)
  render()
  doAssert uiTarget(SceneSettingsId, 1).regions.len > 0, "the page was drawn in its window"
  doAssert page.heldLayout(layoutListing()) == "tests/deskTwo", "the frame's layout, not none"
  doAssert layoutGear(), "and its gear"
  # And back: the same.
  doAssert w.send(eoHttpAdmin, "setCurrentScene", %*{"sceneId": SceneSettingsId})
  doAssert w.ensureScene() and w.scene == page
  render()
  doAssert page.heldLayout(layoutListing()) == "tests/deskTwo" and layoutGear()
  w.setWindowed(false)
  sceneSettings.frameSettingsRead = savedRead
  echo "the frame page keeps the frame's layout ok"

# A scene that cannot be built (an app this runtime does not have, a split's
# panel scene that is gone) keeps the frame's own keys and swipes: the held
# key still opens the scene list. The exception used to take every event with
# it, and the frame could only be left from its control plane (the UX bench,
# 2026-11-27).
block a_scene_that_fails_to_start_keeps_the_frame_map:
  let brokenId = "fixtures/broken".SceneId
  let fineId = "fixtures/dispatcher/switchFrom".SceneId
  var withBroken = copy(scenes)
  withBroken.add %*{"id": brokenId.string, "name": "Broken",
    "settings": {"execution": "interpreted", "refreshInterval": 300},
    "nodes": [{"id": "e1", "type": "event", "data": {"keyword": "render"}},
      {"id": "a1", "type": "app", "data": {"keyword": "data/noSuchApp", "config": {}}}],
    "edges": [{"id": "x1", "source": "e1", "sourceHandle": "next", "target": "a1", "targetHandle": "prev"}],
    "fields": []}
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($withBroken)))
  let mapConfig = FrameConfig(width: 320, height: 240, rotate: 0, scalingMode: "cover", device: "embedded",
    debug: false, saveAssets: %*false, eventMap: %*[
      {"event": "button", "match": {"label": "OK", "action": "longPress"}, "emit": "sceneSwitcher", "as": {}},
      {"event": "edgeSwipe", "match": {"edge": "top"}, "emit": "sceneSettings", "as": {}}])
  let brokenHost = SingleSceneHost(frameConfig: mapConfig, logger: logger)
  var notes: seq[string]
  var picked: seq[string]
  brokenHost.note = proc (message: string) = notes.add message
  brokenHost.requestSelect = proc (sceneId: string): bool =
    picked.add(sceneId)
    brokenHost.makeCurrent(SceneId(sceneId))
    true
  # The broken scene in the middle of the frame's order: the arrows walk on
  # from it either way (below).
  let walkOrder = @[fineId, brokenId, "fixtures/dispatcher/third".SceneId]
  brokenHost.sceneOrder = proc (): seq[SceneId] = walkOrder
  brokenHost.start()
  localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
    {.cast(gcsafe).}:
      brokenHost.queue(origin, event, payload, scene)
  brokenHost.makeCurrent(brokenId)
  var threw = false
  try:
    discard brokenHost.ensureScene()
  except Exception:
    threw = true
  doAssert threw and brokenHost.scene.isNil, "the fixture scene must fail to build"
  # A press the scene alone could hear goes nowhere, and says so once.
  discard brokenHost.send(eoHttpWrite, "button", %*{"label": "OK", "role": "primary", "action": "press"})
  discard brokenHost.send(eoHttpWrite, "button", %*{"label": "OK", "role": "primary", "action": "press"})
  doAssert notes.countIt("failed to start" in it) == 1, $notes
  doAssert picked.len == 0, $picked
  # The held key is the frame's: the scene list opens over the broken scene.
  doAssert brokenHost.send(eoHttpWrite, "button", %*{"label": "OK", "role": "primary", "action": "longPress"})
  doAssert picked == @[SceneSwitcherId], $picked
  doAssert brokenHost.ensureScene() and brokenHost.scene of SceneSwitcherScene
  # And from it, the way to a scene that works.
  doAssert brokenHost.send(eoHttpAdmin, "setCurrentScene", %*{"sceneId": fineId.string})
  doAssert brokenHost.ensureScene() and brokenHost.scene.id == fineId
  # Back on the broken one, a swipe down still opens its settings.
  brokenHost.makeCurrent(brokenId)
  discard brokenHost.send(eoDriver, "edgeSwipe", %*{"edge": "top", "direction": "down", "x": 16383, "y": 0})
  doAssert picked[^1].startsWith(SceneSettingsId), $picked
  # And the arrows walk on from it, either way: the next scene is the one
  # after it in the frame's order, not the first (with no instance to ask,
  # the walk began nowhere: `next` went to the list's first scene, which
  # here is the broken one itself, and `prev` to its last).
  for (direction, want) in [("next", walkOrder[2]), ("prev", walkOrder[0])]:
    brokenHost.makeCurrent(brokenId)
    picked.setLen(0)
    discard brokenHost.send(eoHttpWrite, "setCurrentScene", %*{"direction": direction})
    doAssert picked == @[want.string], direction & ": " & $picked
  replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($scenes)))
  echo "a scene that fails to start keeps the frame's keys ok"
