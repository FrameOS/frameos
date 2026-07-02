import std/[json, tables, sequtils]
import ../interpreter
import ../types

# State field parsing and access filtering for interpreted scenes:
# - "access" and "showIf" survive scenes.json parsing
# - private fields are excluded from publicStateFields but still seed state
# - setSceneState only applies public fields

proc testConfig(): FrameConfig =
  FrameConfig(
    width: 4,
    height: 3,
    rotate: 0,
    scalingMode: "cover",
    debug: true,
    saveAssets: %*false
  )

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    discard payload
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

let scenesJson = """
[{
  "id": "tests/state-fields",
  "name": "State fields",
  "settings": {"execution": "interpreted", "refreshInterval": 300, "backgroundColor": "#000000"},
  "nodes": [{"id": "e1", "type": "event", "data": {"keyword": "render"}}],
  "edges": [],
  "fields": [
    {"name": "search", "type": "string", "value": "birds", "access": "public", "persist": "disk"},
    {"name": "counter", "type": "integer", "value": "5", "access": "private", "persist": "memory"},
    {"name": "legacyNoAccess", "type": "string", "value": "on"},
    {
      "name": "metadataPosition", "type": "select", "options": ["top", "bottom"], "value": "bottom",
      "access": "public", "persist": "disk",
      "showIf": [{"field": "showMetadata", "operator": "eq", "value": true}]
    },
    {"name": "showMetadata", "type": "boolean", "value": "true", "access": "public", "persist": "disk"}
  ]
}]
"""

let inputs = parseInterpretedSceneInputs(scenesJson)
doAssert inputs.len == 1
let sceneInput = inputs[0]

block test_state_field_parsing:
  doAssert sceneInput.fields.len == 5
  let searchField = sceneInput.fields[0]
  doAssert searchField.name == "search"
  doAssert searchField.access == "public"
  doAssert searchField.showIf.isNil
  let metadataField = sceneInput.fields[3]
  doAssert metadataField.name == "metadataPosition"
  doAssert not metadataField.showIf.isNil
  doAssert metadataField.showIf.kind == JArray
  doAssert metadataField.showIf[0]{"field"}.getStr() == "showMetadata"

block test_public_state_field_filtering:
  let exported = buildInterpretedScenes(inputs)[sceneInput.id]
  doAssert exported.stateFields.len == 5
  let publicNames = exported.publicStateFields.mapIt(it.name)
  # Private fields are excluded; missing access defaults to public
  doAssert publicNames == @["search", "legacyNoAccess", "metadataPosition", "showMetadata"]

block test_private_fields_still_seed_state:
  setUploadedInterpretedScenes(buildInterpretedScenes(inputs))
  resetInterpretedScenes()

  let config = testConfig()
  let logger = testLogger(config)
  let scene = InterpretedFrameScene(init(sceneInput.id, config, logger, %*{}))
  doAssert scene.state{"search"}.getStr() == "birds"
  doAssert scene.state{"counter"}.getInt() == 5

  # setSceneState applies public fields and ignores private ones
  var context = ExecutionContext(
    scene: scene,
    event: "setSceneState",
    payload: %*{"state": {"search": "cats", "counter": 99}},
    hasImage: false,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: 0.0
  )
  runEvent(scene, context)
  doAssert scene.state{"search"}.getStr() == "cats"
  doAssert scene.state{"counter"}.getInt() == 5

  setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

echo "test_interpreter_state_fields: all assertions passed"
