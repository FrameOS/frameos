import std/[json, tables]
import pixie
import ../interpreter
import ../planner
import ../types

# Principle 4 for the opaque-output producers (render/color, render/gradient):
# with fusion on, the generator paints the offered target — the live canvas —
# in place; with fusion off, it allocates, and render/image draws the result.
# The two must be the same pixels, and the shape the rule exists for (a
# semi-transparent fill, which the floor composites and a fused fill would
# erase with) must stay on the floor and keep compositing.

proc testConfig(): FrameConfig =
  FrameConfig(
    width: 8,
    height: 4,
    rotate: 0,
    scalingMode: "cover",
    debug: false,
    settings: %*{},
    saveAssets: %*false
  )

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: false)
  logger.log = proc(payload: JsonNode) = discard payload
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int,
    targetHandle: string): DiagramEdge =
  DiagramEdge(id: id.NodeId, source: source.NodeId, sourceHandle: sourceHandle,
    target: target.NodeId, targetHandle: targetHandle, data: %*{})

proc fillScene(keyword: string, producerConfig: JsonNode,
    imageConfig: JsonNode): ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: "Opaque fill test",
    backgroundColor: parseHtmlColor("#ff0000"),
    refreshInterval: 60.0,
    publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/image", "config": imageConfig}),
      node(3, "app", %*{"keyword": keyword, "config": producerConfig})
    ],
    edges: @[
      edge(1, 1, "next", 2, "prev"),
      edge(2, 3, "fieldOutput", 2, "fieldInput/image")
    ]
  )

proc renderScene(scene: ExportedInterpretedScene, fusion: bool):
    tuple[canvas: Image, plans: int] =
  let sceneId = "tests/opaque-fill".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = scene
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  imageFusionEnabled = fusion
  let config = testConfig()
  let frameScene = init(sceneId, config, testLogger(config), %*{})
  var context = ExecutionContext(
    scene: frameScene,
    event: "render",
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: 0.0
  )
  let canvas = render(frameScene, context)
  (canvas, InterpretedFrameScene(frameScene).imageFusionPlans.len)

proc assertIdentical(a, b: Image, what: string) =
  doAssert a.width == b.width and a.height == b.height
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      doAssert a.data[a.dataIndex(x, y)] == b.data[b.dataIndex(x, y)],
        what & ": pixels diverge at " & $x & "," & $y

block an_opaque_color_fill_fuses_and_changes_nothing:
  let scene = fillScene("render/color", %*{"color": "#336699"}, %*{})
  let fused = renderScene(scene, fusion = true)
  let floor = renderScene(scene, fusion = false)
  doAssert fused.plans == 1, "the opaque fill must be planned"
  doAssert floor.plans == 0
  assertIdentical(fused.canvas, floor.canvas, "opaque color")
  doAssert fused.canvas.data[fused.canvas.dataIndex(4, 2)] ==
    rgbx(0x33, 0x66, 0x99, 255)

block an_opaque_gradient_fuses_and_changes_nothing:
  let scene = fillScene("render/gradient",
    %*{"startColor": "#800080", "endColor": "#ffc0cb", "angle": "45"}, %*{})
  let fused = renderScene(scene, fusion = true)
  let floor = renderScene(scene, fusion = false)
  doAssert fused.plans == 1, "the opaque gradient must be planned"
  assertIdentical(fused.canvas, floor.canvas, "opaque gradient")

block every_placement_is_the_same_1_to_1_draw:
  let scene = fillScene("render/color", %*{"color": "#336699"},
    %*{"placement": "center"})
  let fused = renderScene(scene, fusion = true)
  let floor = renderScene(scene, fusion = false)
  doAssert fused.plans == 1, "a generator fuses under any static placement"
  assertIdentical(fused.canvas, floor.canvas, "centered opaque color")

block a_semi_transparent_fill_still_tints_instead_of_erasing:
  # The rule's reason to exist. The floor composites the half-blue fill over
  # the red background; a fused fill would have SET half-transparent pixels.
  # The planner must refuse, and the picture must remain the tint.
  let scene = fillScene("render/color",
    %*{"color": "rgba(0, 0, 255, 0.5)"}, %*{})
  let fused = renderScene(scene, fusion = true)
  let floor = renderScene(scene, fusion = false)
  doAssert fused.plans == 0, "a semi-transparent fill must stay on the floor"
  assertIdentical(fused.canvas, floor.canvas, "semi-transparent color")
  let pixel = fused.canvas.data[fused.canvas.dataIndex(4, 2)]
  doAssert pixel.a == 255, "composited over an opaque background"
  doAssert pixel.r > 0 and pixel.b > 0,
    "the tint must blend with the background, not replace it"

imageFusionEnabled = true
echo "test_opaque_fill_fusion: all assertions passed"
