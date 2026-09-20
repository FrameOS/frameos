import std/[json, tables, sequtils, strutils]
import ../interpreter
import ../types

# The "init" event of an interpreted scene (docs/event-system-analysis.md §3.4):
# - fired by the scene's own init, once per instance, after its apps exist —
#   so a top-level scene hears it and its first render draws what it set
# - a child scene still hears it exactly once (the parent used to fire it)
# - a key event that every listener filters out is reported without its payload

var logged: seq[JsonNode] = @[]

proc testConfig(): FrameConfig =
  FrameConfig(width: 4, height: 3, rotate: 0, scalingMode: "cover", debug: false, saveAssets: %*false)

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logged.add(payload)
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc listener(id, event, stateKey: string, filter = ""): string =
  ## An event node wired to a logic/setAsState that marks `stateKey`.
  """{"id": "e-""" & id & """", "type": "event", "data": {"keyword": """" & event & """"""" &
    (if filter.len > 0: """, "config": """ & filter else: "") & """}},
  {"id": "a-""" & id & """", "type": "app", "data": {"keyword": "logic/setAsState",
    "config": {"stateKey": """" & stateKey & """", "valueJson": true, "debugLog": true}}}"""

proc wire(id: string): string =
  """{"id": "x-""" & id & """", "source": "e-""" & id & """", "sourceHandle": "next", "target": "a-""" &
    id & """", "targetHandle": "prev"}"""

let scenesJson = """[
  {"id": "tests/lifecycle/top", "name": "top", "settings": {"execution": "interpreted", "refreshInterval": 300},
   "nodes": [""" & listener("1", "init", "gotInit") & "," & listener("2", "keyDown", "gotKeyA",
      """{"key": "KEY_A"}""") & """],
   "edges": [""" & wire("1") & "," & wire("2") & """], "fields": []},
  {"id": "tests/lifecycle/child", "name": "child", "settings": {"execution": "interpreted", "refreshInterval": 300},
   "nodes": [""" & listener("1", "init", "childInit") & """],
   "edges": [""" & wire("1") & """], "fields": []},
  {"id": "tests/lifecycle/parent", "name": "parent", "settings": {"execution": "interpreted", "refreshInterval": 300},
   "nodes": [{"id": "e1", "type": "event", "data": {"keyword": "render"}},
             {"id": "s1", "type": "scene", "data": {"keyword": "tests/lifecycle/child", "config": {}}}],
   "edges": [{"id": "x1", "source": "e1", "sourceHandle": "next", "target": "s1", "targetHandle": "prev"}],
   "fields": []}
]"""

let inputs = parseInterpretedSceneInputs(scenesJson)
doAssert inputs.len == 3
setUploadedInterpretedScenes(buildInterpretedScenes(inputs))
resetInterpretedScenes()

proc initScene(id: string): InterpretedFrameScene =
  let config = testConfig()
  InterpretedFrameScene(init(id.SceneId, config, testLogger(config), %*{}))

proc stateSets(key: string): int =
  logged.countIt(it{"event"}.getStr().endsWith(":setAsState") and it{"key"}.getStr() == key)

block test_a_top_level_scene_hears_init_before_its_first_render:
  logged.setLen(0)
  let listenersBefore = eventListenersRun
  let scene = initScene("tests/lifecycle/top")
  doAssert scene.state{"gotInit"}.getBool(), "init ran no listener: " & $scene.state
  doAssert stateSets("gotInit") == 1
  doAssert eventListenersRun == listenersBefore + 1

block test_a_child_scene_hears_init_exactly_once:
  logged.setLen(0)
  let parent = initScene("tests/lifecycle/parent")
  doAssert parent.sceneNodes.len == 1
  for _, child in parent.sceneNodes:
    doAssert child.state{"childInit"}.getBool()
  doAssert stateSets("childInit") == 1, "child init fired " & $stateSets("childInit") & " times"
  # Rendering the parent walks the scene node; the child is not initialized again.
  var context = ExecutionContext(scene: parent, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".")
  runEvent(parent, context)
  doAssert stateSets("childInit") == 1

block test_a_filtered_out_key_is_reported_without_what_was_typed:
  let scene = initScene("tests/lifecycle/top")
  logged.setLen(0)
  let listenersBefore = eventListenersRun
  var context = ExecutionContext(scene: scene, event: "keyDown", payload: %*{"key": "KEY_P", "code": 25},
    hasImage: false, loopIndex: 0, loopKey: ".")
  runEvent(scene, context)
  doAssert eventListenersRun == listenersBefore
  let reports = logged.filterIt(it{"event"}.getStr() == "runEvent:noListenerMatched")
  doAssert reports.len == 1
  doAssert not reports[0].hasKey("payload")
  doAssert "KEY_P" notin $reports[0]
  # The matching key runs the listener.
  context = ExecutionContext(scene: scene, event: "keyDown", payload: %*{"key": "KEY_A", "code": 30},
    hasImage: false, loopIndex: 0, loopKey: ".")
  runEvent(scene, context)
  doAssert scene.state{"gotKeyA"}.getBool()
  doAssert eventListenersRun == listenersBefore + 1

echo "test_interpreter_lifecycle: ok"
