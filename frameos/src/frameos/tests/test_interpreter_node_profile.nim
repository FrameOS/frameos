import std/[json, tables]
import pixie
import ../interpreter
import ../types
import ../utils/app_images
import ../utils/image

# The per-node memory profile the interpreter logs in debug mode.
#
# "Which edge is holding the memory" is the question every fusion rule is an
# answer to, and until this existed the only way to ask it on a device was to
# watch it run out. One line per node per render: what the value on that edge
# costs to hold, what running the node did to the heap, and which fusion tier
# the planner picked for it.

var logs: seq[JsonNode] = @[]

proc recordingDownload(url: string, maxBytes: int, target: Image,
    fit: ScaledDecodeFit, boundWidth: int, boundHeight: int): tuple[image: Image, data: string] =
  if target.isNil:
    return (newImage(64, 64), "")
  scaleAndDrawImage(target, newImage(64, 64), scaledFitPlacement(fit),
    blendMode = OverwriteBlend)
  (target, "")

contextDownloadHook = recordingDownload

proc testConfig(debug: bool): FrameConfig =
  FrameConfig(
    name: "test", mode: "embedded", width: 24, height: 16, rotate: 0,
    scalingMode: "cover", debug: debug, settings: %*{}, saveAssets: %*false
  )

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = logs.add(payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int,
    targetHandle: string): DiagramEdge =
  DiagramEdge(id: id.NodeId, source: source.NodeId, sourceHandle: sourceHandle,
    target: target.NodeId, targetHandle: targetHandle, data: %*{})

proc buildScene(): ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: "Profile test",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0,
    publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/image", "config": {"placement": "cover"}}),
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

proc renderWith(debug: bool): seq[JsonNode] =
  let sceneId = "tests/node-profile".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = buildScene()
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()

  logs = @[]
  let config = testConfig(debug)
  let scene = init(sceneId, config, testLogger(config), %*{})
  var context = ExecutionContext(
    scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: 0.0
  )
  discard render(scene, context)

  result = @[]
  for entry in logs:
    if entry{"event"}.getStr() == "interpreter:node:profile":
      result.add(entry)

block profiling_is_debug_only:
  # It samples the heap and walks JSON trees per node per render; a frame that
  # did not ask for it must not pay for it.
  doAssert renderWith(debug = false).len == 0

block every_node_reports_its_value_and_cost:
  let profiles = renderWith(debug = true)
  doAssert profiles.len == 2,
    "expected one profile per executed node, got " & $profiles.len

  var sawProducer = false
  var sawConsumer = false
  for profile in profiles:
    doAssert profile.hasKey("durationMs")
    case profile{"keyword"}.getStr()
    of "data/downloadImage":
      sawProducer = true
      doAssert profile{"dataNode"}.getBool()
      doAssert profile{"valueKind"}.getStr() == "fkImage"
      # It was handed the canvas, so the value on this edge is canvas-sized —
      # 24x16x4. An unfused producer would report the 64x64 source instead,
      # which is the whole thing worth watching for.
      doAssert profile{"valueBytes"}.getInt() == 24 * 16 * 4,
        "producer value was " & $profile{"valueBytes"}.getInt() & " bytes"
      doAssert profile{"valueWidth"}.getInt() == 24
      doAssert profile{"valueHeight"}.getInt() == 16
    of "render/image":
      sawConsumer = true
      doAssert not profile{"dataNode"}.getBool()
      doAssert profile.hasKey("fusion"),
        "the consumer should name the fusion plan it is running under"
      doAssert profile{"fusion"}{"tier"}.getStr() == "liveCanvas"
      doAssert profile{"fusion"}{"input"}.getStr() == "image"
      doAssert profile{"fusion"}{"producerNodeId"}.getInt() == 3
      doAssert profile{"fusion"}{"applied"}.getBool()
      # Applied is the offer; claimed is the producer actually taking it. The
      # test decoder consumes the target, so both must hold — a producer that
      # allocates its own value while planned "fused" shows up as
      # applied-without-claimed (how wikicommons hid a 1.7MB allocation).
      doAssert profile{"fusion"}{"claimed"}.getBool()
    else:
      doAssert false, "unexpected node in profile: " & $profile

  doAssert sawProducer and sawConsumer

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
contextDownloadHook = nil

echo "test_interpreter_node_profile: all assertions passed"
