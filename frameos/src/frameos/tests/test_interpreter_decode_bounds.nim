import std/[json, os, tables]
import pixie
import ../interpreter
import ../planner
import ../types
import ../utils/app_images
from ../utils/image import boundedDecodeDims, decodeImageBounded

# The requestedBounds protocol end to end (docs/value-pipeline.md): a chain
# that cannot fuse — a 90° rotation mid-chain, a refused blend — still hands
# the terminal producer the consumer's useful resolution, addressed and
# one-shot like a decode target. The hook observes exactly what the producer
# was offered; the floor comparison pins the bounded decode's semantics.

var
  hookBounds: seq[tuple[width, height: int]] = @[]
  hookTargets: seq[Image] = @[]

proc recordingDownload(url: string, maxBytes: int, target: Image,
    fit: ScaledDecodeFit, boundWidth: int, boundHeight: int):
    tuple[image: Image, data: string] =
  hookBounds.add((boundWidth, boundHeight))
  hookTargets.add(target)
  if not target.isNil:
    return (target, "")
  if boundWidth > 0 and boundHeight > 0:
    return (newImage(boundWidth, boundHeight), "")
  # The materialized floor: native resolution.
  (newImage(96, 48), "")

contextDownloadHook = recordingDownload

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

proc boundsScene(rotationDegree: string, imageConfig: JsonNode): ExportedInterpretedScene =
  var nodes = @[
    node(1, "event", %*{"keyword": "render"}),
    node(2, "app", %*{"keyword": "render/image", "config": imageConfig}),
    node(3, "app", %*{
      "keyword": "data/downloadImage",
      "config": {"url": "https://example.invalid/photo.jpg"}
    })
  ]
  var edges = @[edge(1, 1, "next", 2, "prev")]
  if rotationDegree.len > 0:
    nodes.add(node(4, "app", %*{"keyword": "data/rotateImage",
      "config": {"rotationDegree": rotationDegree}}))
    edges.add(edge(2, 3, "fieldOutput", 4, "fieldInput/image"))
    edges.add(edge(3, 4, "fieldOutput", 2, "fieldInput/image"))
  else:
    edges.add(edge(2, 3, "fieldOutput", 2, "fieldInput/image"))
  ExportedInterpretedScene(
    name: "Decode bounds test",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0,
    publicStateFields: @[],
    nodes: nodes,
    edges: edges,
    apps: %*{}
  )

proc zoomScene(zoomEnd: string): ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: "Zoom bounds test",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0,
    publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/zoomPan",
        "config": {"motion": "zoomIn", "zoomStart": "1.0", "zoomEnd": zoomEnd}}),
      node(3, "app", %*{
        "keyword": "data/downloadImage",
        "config": {"url": "https://example.invalid/photo.jpg"}
      })
    ],
    edges: @[
      edge(1, 1, "next", 2, "prev"),
      edge(2, 3, "fieldOutput", 2, "fieldInput/image")
    ],
    apps: %*{}
  )

proc renderScene(exported: ExportedInterpretedScene): Image =
  let sceneId = "tests/decode-bounds".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = exported
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  hookBounds = @[]
  hookTargets = @[]
  let config = testConfig()
  let scene = init(sceneId, config, testLogger(config), %*{})
  var context = ExecutionContext(
    scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: 0.0
  )
  render(scene, context)

proc renderWith(rotationDegree: string, imageConfig: JsonNode = %*{}): Image =
  renderScene(boundsScene(rotationDegree, imageConfig))

block a_rotate_90_chain_offers_swapped_canvas_bounds:
  discard renderWith("90")
  doAssert hookBounds.len == 1
  doAssert hookTargets[0].isNil, "an unfused chain has no target to offer"
  doAssert hookBounds[0] == (width: 4, height: 8),
    "the 8x4 canvas swaps through the rotation: " & $hookBounds[0]

block a_fused_direct_edge_offers_a_target_not_bounds:
  discard renderWith("")
  doAssert hookBounds.len == 1
  doAssert not hookTargets[0].isNil, "the direct edge fuses"
  doAssert hookBounds[0] == (width: 0, height: 0),
    "a target supersedes bounds"

block a_refused_blend_still_offers_bounds:
  discard renderWith("", %*{"blendMode": "mask"})
  doAssert hookBounds.len == 1
  doAssert hookTargets[0].isNil
  doAssert hookBounds[0] == (width: 8, height: 4)

block a_zoom_consumer_offers_multiplied_canvas_bounds:
  # zoomPan can never fuse — its draw is a per-render crop — but the largest
  # crop it will ever show uses at most zoomEnd times the canvas resolution,
  # rounded up, from the source.
  discard renderScene(zoomScene("1.5"))
  doAssert hookBounds.len == 1
  doAssert hookTargets[0].isNil, "zoomPan never offers a target"
  doAssert hookBounds[0] == (width: 12, height: 6),
    "the 8x4 canvas times 1.5: " & $hookBounds[0]

block the_kill_switch_returns_everything_to_the_floor:
  imageBoundsEnabled = false
  discard renderWith("90")
  imageBoundsEnabled = true
  doAssert hookBounds.len == 1
  doAssert hookTargets[0].isNil
  doAssert hookBounds[0] == (width: 0, height: 0)

block bounded_decode_dims_cover_the_box_without_upscaling:
  # Enough pixels for any placement into the bounds, aspect preserved.
  doAssert boundedDecodeDims(4000, 2600, 800, 480) == (width: 800, height: 520)
  doAssert boundedDecodeDims(2600, 4000, 800, 480) == (width: 800, height: 1231)
  doAssert boundedDecodeDims(1000, 3000, 480, 800) == (width: 480, height: 1440)
  # Already inside (or matching) the box on an axis: native, never upscaled.
  doAssert boundedDecodeDims(640, 480, 800, 480) == (width: 640, height: 480)
  doAssert boundedDecodeDims(100, 100, 800, 480) == (width: 100, height: 100)
  doAssert boundedDecodeDims(800, 480, 800, 480) == (width: 800, height: 480)

block a_real_jpeg_decodes_bounded_and_equivalent:
  # The floor comparison the protocol's contract promises: the bounded decode
  # is the native decode's picture at a useful resolution — same geometry,
  # same content — not the same bytes. Classified like the on-device A/Bs:
  # the mean color must hold while the pixel count drops ~25x.
  let data = readFile("src/frameos/tests/fixtures/large-gradient.jpg")
  let bounded = decodeImageBounded(data, 800, 480)
  doAssert bounded.width == 800 and bounded.height == 520,
    $bounded.width & "x" & $bounded.height
  let native = decodeImage(data)
  doAssert native.width == 4000 and native.height == 2600
  var sums: array[2, array[3, float]]
  for (index, image) in [(0, bounded), (1, native)]:
    var r, g, b: int64
    for i in 0 ..< image.dataLen:
      r += image.data[i].r.int64
      g += image.data[i].g.int64
      b += image.data[i].b.int64
    let n = image.dataLen.float
    sums[index] = [r.float / n, g.float / n, b.float / n]
  for channel in 0 .. 2:
    doAssert abs(sums[0][channel] - sums[1][channel]) < 2.0,
      "mean channel " & $channel & " moved: " &
      $sums[0][channel] & " vs " & $sums[1][channel]

echo "test_interpreter_decode_bounds: all assertions passed"
