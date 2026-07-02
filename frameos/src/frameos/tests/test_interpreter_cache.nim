import std/[json, tables]
import pixie
import ../interpreter
import ../types
import ../values

# Interpreted node caches: expression-driven invalidation (mirroring compiled
# scenes) and the duration parse-failure guard (an unparseable duration must
# hold for the 60s default, not expire every render).

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

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc ctx(scene: FrameScene, event: string): ExecutionContext =
  ExecutionContext(
    scene: scene,
    event: event,
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: 0.0
  )

let jsTextSources = %*{
  "config.json": """
{
  "name": "Tick Text",
  "category": "data",
  "fields": [],
  "output": [{"name": "text", "type": "text"}]
}
""",
  "app.ts": """
export function get(app: FrameOSApp): string {
  return `tick=${app.state.tick}`
}
"""
}

let sceneId = "tests/interpreter-cache".SceneId
var uploaded = initTable[SceneId, ExportedInterpretedScene]()

uploaded[sceneId] = ExportedInterpretedScene(
  name: "Cache test",
  backgroundColor: parseHtmlColor("#000000"),
  refreshInterval: 1.0,
  publicStateFields: @[
    StateField(name: "tick", fieldType: "integer", value: %*"1"),
    StateField(name: "bucket", fieldType: "integer", value: %*"1")
  ],
  nodes: @[
    node(1, "app", %*{
      "keyword": "jsTickExpr",
      "config": {},
      "sources": jsTextSources,
      "cache": {
        "enabled": true,
        "inputEnabled": false,
        "durationEnabled": false,
        "expressionEnabled": true,
        "expression": "state.bucket",
        "expressionType": "integer"
      }
    }),
    node(2, "app", %*{
      "keyword": "jsTickDuration",
      "config": {},
      "sources": jsTextSources,
      "cache": {
        "enabled": true,
        "inputEnabled": false,
        "durationEnabled": true,
        # Not a number: must fall back to the 60s default, never 0
        "duration": "state{\"seconds\"}.getFloat()",
        "expressionEnabled": false
      }
    })
  ],
  edges: @[],
  apps: %*{}
)

setUploadedInterpretedScenes(uploaded)
resetInterpretedScenes()

let config = testConfig()
let logger = testLogger(config)
let scene = init(sceneId, config, logger, %*{})

block test_expression_cache:
  doAssert scene.getDataNode(1.NodeId, ctx(scene, "render")).asString() == "tick=1"

  # Underlying data changes but the expression value does not: cache holds
  scene.state["tick"] = %*2
  doAssert scene.getDataNode(1.NodeId, ctx(scene, "render")).asString() == "tick=1"

  # Expression value changes: recompute
  scene.state["bucket"] = %*2
  doAssert scene.getDataNode(1.NodeId, ctx(scene, "render")).asString() == "tick=2"

  # And holds again on the new expression value
  scene.state["tick"] = %*3
  doAssert scene.getDataNode(1.NodeId, ctx(scene, "render")).asString() == "tick=2"

block test_unparseable_duration_holds:
  scene.state["tick"] = %*10
  doAssert scene.getDataNode(2.NodeId, ctx(scene, "render")).asString() == "tick=10"

  # A junk duration string must not expire the cache immediately
  scene.state["tick"] = %*11
  doAssert scene.getDataNode(2.NodeId, ctx(scene, "render")).asString() == "tick=10"

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

echo "test_interpreter_cache: all assertions passed"
