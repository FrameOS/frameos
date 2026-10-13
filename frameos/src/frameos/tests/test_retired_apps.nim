## A scene still on disk from before the runtime dropped a Nim app names
## `data/immich` (or `data/frameOSGallery`) with no scene-local app; the Linux
## runtime runs the JavaScript app that replaced it (frameos/retired_apps.nim).

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
    let gallery = retiredAppSources("data/frameOSGallery")
    check not gallery.isNil
    check gallery{"app.ts"}.getStr().contains("https://gallery.frameos.net/image")
    check retiredAppSources("data/clock").isNil
    check retiredAppSources("immich").isNil
    check retiredAppSources("frameOSGallery").isNil

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

    # No Immich settings on this frame: the JS app throws its message, which
    # proves it ran with the `immich` settings namespace it declares
    # (getSetting would refuse an undeclared one).
    expect(JsAppError):
      discard scene.getDataNode(1.NodeId, ExecutionContext(scene: scene, event: "render",
        payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: 0.0))
    var sawMessage = false
    for entry in logged:
      if ($entry).contains("Please provide an Immich server URL"):
        sawMessage = true
    check sawMessage

  test "a render/chart node in the render flow draws the JavaScript chart":
    let sceneId = "tests/retired-chart".SceneId
    var uploaded = initTable[SceneId, ExportedInterpretedScene]()
    uploaded[sceneId] = ExportedInterpretedScene(
      name: "Stale chart scene",
      backgroundColor: parseHtmlColor("#000000"),
      refreshInterval: 300.0,
      publicStateFields: @[],
      nodes: @[
        node(10, "event", %*{"keyword": "render"}),
        node(1, "app", %*{"keyword": "render/chart", "config": {"data": "[1, 3, 2]",
          "transparentBackground": "false", "backgroundColor": "#ff0000"}}),
      ],
      edges: @[edge(100, 10, "next", 1, "prev")],
      apps: %*{}
    )
    setUploadedInterpretedScenes(uploaded)
    resetInterpretedScenes()
    defer: setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

    let config = FrameConfig(width: 80, height: 60, rotate: 0, scalingMode: "cover", debug: false,
      saveAssets: %*false, settings: %*{})
    let scene = init(sceneId, config, testLogger(config), %*{})
    check InterpretedFrameScene(scene).appsByNodeId[1.NodeId].isDynamicJsApp()
    let canvas = newImage(80, 60)
    let image = render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
      hasImage: true, image: canvas, loopIndex: 0, loopKey: ".", nextSleep: 0.0))
    var red, line = 0
    for x in 0 ..< 80:
      for y in 0 ..< 60:
        if image[x, y].r > 200 and image[x, y].g < 60:
          inc red
        if image[x, y].b > 150 and image[x, y].r < 120:
          inc line
    check red > 80 * 60 div 2  # the chart's own background, drawn onto the canvas
    check line > 0
