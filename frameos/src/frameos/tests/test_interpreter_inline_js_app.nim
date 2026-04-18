import std/[json, tables]
import pixie

import ../interpreter
import ../types
import ../values

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

proc edge(id, source: int, sourceHandle: string, target: int, targetHandle: string): DiagramEdge =
  DiagramEdge(
    id: id.NodeId,
    source: source.NodeId,
    sourceHandle: sourceHandle,
    target: target.NodeId,
    targetHandle: targetHandle,
    edgeType: ""
  )

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

let sceneId = "tests/interpreter-inline-js-app".SceneId
var uploaded = initTable[SceneId, ExportedInterpretedScene]()

uploaded[sceneId] = ExportedInterpretedScene(
  name: "Interpreter inline JS app test",
  backgroundColor: parseHtmlColor("#000000"),
  refreshInterval: 1.0,
  publicStateFields: @[],
  nodes: @[
    node(10, "event", %*{"keyword": "render"}),
    node(1, "app", %*{
      "name": "forked js image",
      "keyword": "data/jsImage",
      "config": {
        "width": 4,
        "height": 3
      },
      "sources": {
        "config.json": """
{
  "name": "Forked JS Image",
  "category": "data",
  "fields": [
    { "name": "width", "type": "integer", "value": 1 },
    { "name": "height", "type": "integer", "value": 1 },
    { "name": "color", "type": "color", "value": "#44aa22" },
    { "name": "opacity", "type": "float", "value": 1 }
  ],
  "output": [
    { "name": "image", "type": "image" }
  ]
}
""",
        "app.compiled.js": """
globalThis.__frameosModule = {
  get(app) {
    return frameos.image({
      width: app.config.width,
      height: app.config.height,
      color: app.config.color,
      opacity: app.config.opacity
    })
  }
}
""",
      }
    }),
    node(2, "app", %*{
      "name": "image",
      "keyword": "render/image",
      "config": {
        "placement": "stretch",
        "blendMode": "overwrite"
      }
    })
  ],
  edges: @[
    edge(100, 10, "next", 2, "prev"),
    edge(101, 1, "fieldOutput", 2, "fieldInput/image")
  ]
)

setUploadedInterpretedScenes(uploaded)
resetInterpretedScenes()

let config = testConfig()
let logger = testLogger(config)
let scene = init(sceneId, config, logger, %*{})

block test_interpreter_inline_js_data_node:
  let dataValue = scene.getDataNode(1.NodeId, ctx(scene, "render"))
  doAssert dataValue.kind == fkImage
  let dataImage = dataValue.asImage()
  doAssert dataImage.width == 4
  doAssert dataImage.height == 3
  let px = dataImage.data[dataImage.dataIndex(0, 0)]
  doAssert px.g > 0
  doAssert px.a > 0

block test_interpreter_inline_js_render_node:
  let rendered = render(scene, ctx(scene, "render"))
  doAssert rendered.width == 4
  doAssert rendered.height == 3
  let px = rendered.data[rendered.dataIndex(0, 0)]
  doAssert px.g > 0
  doAssert px.a > 0

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
