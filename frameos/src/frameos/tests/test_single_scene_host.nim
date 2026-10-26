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
doAssert fromApp.jsDropped == 1, "the app's interpreter was mid-call: " & $fromApp
doAssert fromApp.jsBytes > 0
abortIn = ""
logLines.setLen(0)
doAssert guarded(renderOnce) == 0
doAssert count("fetched 200") == 1, "the app runs again, on a new interpreter: " & $logLines
doAssert count("deadline") == 0, $logLines

# Inside a code node, from an event: the dispatcher was draining and the
# scene's interpreter held sceneJsLock.
abortIn = "code"
doAssert guarded(pressOnce) == 1, "the event jumped out"
doAssert not sceneJsLockFreeForTest(), "the jump left sceneJsLock taken"
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

proc renderValuesThrice() =
  let valuesHost = SingleSceneHost(frameConfig: config, logger: abortLogger)
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
echo "ok"
