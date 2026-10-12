## A scene still on disk from before the runtime dropped the Nim Immich app
## names `data/immich` with no scene-local app; the Linux runtime runs the
## JavaScript app that replaced it (frameos/retired_apps.nim).

import std/[json, strutils, tables, unittest]
import pixie
import ../interpreter
import ../retired_apps
import ../js_runtime/app_runtime
import ../types
import ../values

proc testConfig(): FrameConfig =
  FrameConfig(width: 8, height: 6, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, settings: %*{})

var logged: seq[JsonNode] = @[]

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logged.add(payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int, targetHandle: string): DiagramEdge =
  DiagramEdge(id: id.NodeId, source: source.NodeId, sourceHandle: sourceHandle,
    target: target.NodeId, targetHandle: targetHandle, edgeType: "")

suite "retired Nim apps":
  test "the generated copy carries the replacement's files":
    let sources = retiredAppSources("data/immich")
    check not sources.isNil
    check sources{"app.ts"}.getStr().contains("frameos.fetchImage(")
    check parseJson(sources{"config.json"}.getStr())["settings"] == %*["immich"]
    check retiredAppSources("data/clock").isNil
    check retiredAppSources("immich").isNil

  test "a data/immich node runs the JavaScript app":
    let sceneId = "tests/retired-immich".SceneId
    var uploaded = initTable[SceneId, ExportedInterpretedScene]()
    uploaded[sceneId] = ExportedInterpretedScene(
      name: "Stale Immich scene",
      backgroundColor: parseHtmlColor("#000000"),
      refreshInterval: 300.0,
      publicStateFields: @[],
      nodes: @[
        node(10, "event", %*{"keyword": "render"}),
        node(1, "app", %*{"keyword": "data/immich", "config": {"mode": "random"}}),
        node(2, "app", %*{"keyword": "render/image", "config": {}}),
      ],
      edges: @[
        edge(100, 10, "next", 2, "prev"),
        edge(101, 1, "fieldOutput", 2, "fieldInput/image"),
      ],
      apps: %*{}
    )
    setUploadedInterpretedScenes(uploaded)
    resetInterpretedScenes()
    defer: setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

    let config = testConfig()
    let scene = init(sceneId, config, testLogger(config), %*{})
    check InterpretedFrameScene(scene).appsByNodeId[1.NodeId].isDynamicJsApp()

    # No Immich settings on this frame: the JS app answers with its message
    # panel, which proves it ran with the `immich` settings namespace it
    # declares (getSetting would refuse an undeclared one).
    let value = scene.getDataNode(1.NodeId, ExecutionContext(scene: scene, event: "render",
      payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: 0.0))
    check value.kind == fkImage
    var sawMessage = false
    for entry in logged:
      if ($entry).contains("Please provide an Immich server URL"):
        sawMessage = true
    check sawMessage
