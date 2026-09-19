import std/[json, tables, sequtils, strutils]
import ../interpreter
import ../refresh_interval
import ../types

# The refresh interval is a state field (refresh_interval.nim):
# - a scene with no such field gets an implicit public `refreshInterval`,
#   seeded from settings.refreshInterval and listed last
# - a field named `refreshInterval`, or one with role "refreshInterval", is
#   taken over instead (the role wins), and moved last
# - the runtime reads the interval back from state after every run

proc testConfig(): FrameConfig =
  FrameConfig(width: 4, height: 3, rotate: 0, scalingMode: "cover", debug: false, saveAssets: %*false)

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    discard payload
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc sceneJson(id, fields: string, refreshInterval = "300", nodes = "", edges = ""): string =
  """{"id": """" & id & """", "name": "t",
    "settings": {"execution": "interpreted", "refreshInterval": """ & refreshInterval & """},
    "nodes": [{"id": "e1", "type": "event", "data": {"keyword": "render"}}""" & nodes & """],
    "edges": [""" & edges & """], "fields": [""" & fields & """]}"""

let scenesJson = "[" & [
  sceneJson("tests/implicit",
    """{"name": "search", "type": "string", "value": "birds", "access": "public", "persist": "disk"}""",
    refreshInterval = "900"),
  sceneJson("tests/named",
    """{"name": "refreshInterval", "type": "float", "value": "120", "label": "Every", "access": "public"},
       {"name": "search", "type": "string", "value": "birds", "access": "public"}"""),
  sceneJson("tests/role",
    """{"name": "refreshInterval", "type": "float", "value": "120", "access": "public"},
       {"name": "seconds", "type": "float", "value": "3600", "label": "Seconds per image",
        "access": "public", "persist": "disk", "role": "refreshInterval"},
       {"name": "search", "type": "string", "value": "birds", "access": "public"}"""),
  sceneJson("tests/private",
    """{"name": "refreshInterval", "type": "float", "value": "45", "access": "private"}"""),
  sceneJson("tests/empty-default",
    """{"name": "seconds", "type": "float", "value": "", "access": "public", "role": "refreshInterval"}""",
    refreshInterval = "777"),
  sceneJson("tests/code",
    "",
    nodes = """,{"id": "c1", "type": "app", "data": {"keyword": "logic/setAsState",
      "config": {"stateKey": "refreshInterval", "valueJson": 12}}}""",
    edges = """{"id": "x1", "source": "e1", "sourceHandle": "next", "target": "c1", "targetHandle": "prev"}"""),
].join(",") & "]"

let inputs = parseInterpretedSceneInputs(scenesJson)
doAssert inputs.len == 6
let exports = buildInterpretedScenes(inputs)

proc initScene(id: string, persisted: JsonNode = %*{}): InterpretedFrameScene =
  let config = testConfig()
  InterpretedFrameScene(init(id.SceneId, config, testLogger(config), persisted))

proc setState(scene: InterpretedFrameScene, state: JsonNode) =
  var context = ExecutionContext(scene: scene, event: "setSceneState", payload: %*{"state": state},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
  runEvent(scene, context)

block test_parse_refresh_seconds:
  doAssert parseRefreshSeconds(%60) == 60.0
  doAssert parseRefreshSeconds(%0.5) == 0.5
  doAssert parseRefreshSeconds(%" 90 ") == 90.0
  doAssert parseRefreshSeconds(%"") == 0.0
  doAssert parseRefreshSeconds(%"soon") == 0.0
  doAssert parseRefreshSeconds(%0) == 0.0
  doAssert parseRefreshSeconds(%(-5)) == 0.0
  doAssert parseRefreshSeconds(%"nan") == 0.0
  doAssert parseRefreshSeconds(%"inf") == 0.0
  doAssert parseRefreshSeconds(newJNull()) == 0.0
  doAssert parseRefreshSeconds(nil) == 0.0

block test_implicit_field_is_appended:
  let exported = exports["tests/implicit".SceneId]
  doAssert exported.publicStateFields.mapIt(it.name) == @["search", "refreshInterval"]
  let field = exported.publicStateFields[^1]
  doAssert field.label == RefreshIntervalLabel
  doAssert field.fieldType == "float"
  doAssert field.value.getFloat() == 900.0
  doAssert field.role == RefreshIntervalRole
  doAssert exported.refreshIntervalKey == "refreshInterval"
  doAssert exported.refreshIntervalImplicit
  doAssert exported.refreshIntervalDefault == 900.0
  doAssert "refreshInterval" in exported.persistedStateKeys

block test_named_field_is_taken_over_and_moved_last:
  let exported = exports["tests/named".SceneId]
  doAssert exported.publicStateFields.mapIt(it.name) == @["search", "refreshInterval"]
  # The scene's own label survives: it knows what its interval means
  doAssert exported.publicStateFields[^1].label == "Every"
  doAssert not exported.refreshIntervalImplicit
  doAssert exported.refreshIntervalDefault == 120.0

block test_role_beats_the_name:
  let exported = exports["tests/role".SceneId]
  doAssert exported.publicStateFields.mapIt(it.name) == @["refreshInterval", "search", "seconds"]
  doAssert exported.refreshIntervalKey == "seconds"
  doAssert exported.refreshIntervalDefault == 3600.0

block test_private_field_is_not_offered:
  let exported = exports["tests/private".SceneId]
  doAssert exported.publicStateFields.len == 0
  doAssert exported.refreshIntervalKey == "refreshInterval"

block test_runtime_follows_state:
  setUploadedInterpretedScenes(exports)
  resetInterpretedScenes()

  let implicit = initScene("tests/implicit")
  doAssert implicit.refreshInterval == 900.0
  doAssert implicit.state{"refreshInterval"}.getFloat() == 900.0
  implicit.setState(%*{"refreshInterval": 60})
  doAssert implicit.refreshInterval == 60.0
  # Control forms send strings
  implicit.setState(%*{"refreshInterval": "30"})
  doAssert implicit.refreshInterval == 30.0
  # Nonsense falls back to the scene's default instead of spinning or stalling
  implicit.setState(%*{"refreshInterval": 0})
  doAssert implicit.refreshInterval == 900.0
  implicit.setState(%*{"refreshInterval": "later"})
  doAssert implicit.refreshInterval == 900.0

  # Persisted state (a customized interval) wins over the default at init
  doAssert initScene("tests/implicit", %*{"refreshInterval": 42}).refreshInterval == 42.0

  let role = initScene("tests/role")
  doAssert role.refreshInterval == 3600.0
  role.setState(%*{"refreshInterval": 5})
  doAssert role.refreshInterval == 3600.0 # a plain field once another has the role
  role.setState(%*{"seconds": 600})
  doAssert role.refreshInterval == 600.0

  # A private interval is the scene's own business: panels cannot move it
  let private = initScene("tests/private")
  doAssert private.refreshInterval == 45.0
  private.setState(%*{"refreshInterval": 5})
  doAssert private.refreshInterval == 45.0

  # An empty declared default falls back to settings.refreshInterval
  doAssert initScene("tests/empty-default").refreshInterval == 777.0

  setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

block test_scene_sets_its_own_interval:
  setUploadedInterpretedScenes(exports)
  resetInterpretedScenes()
  let scene = initScene("tests/code")
  doAssert scene.refreshInterval == 300.0
  var context = ExecutionContext(scene: scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
  discard render(scene, context)
  doAssert scene.refreshInterval == 12.0
  setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

echo "test_refresh_interval: all assertions passed"
