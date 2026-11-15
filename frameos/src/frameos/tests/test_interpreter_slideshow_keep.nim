import std/[json, os, strutils, tables]
import pixie
import ../interpreter
import ../types
import ../values
from ../utils/memory import availableRenderBytesOverride

# "Slideshow with motion" (repo/scenes/samples/Ken Burns slideshow): a cached
# data/localImage, keyed on a cache expression that moves once per photo
# interval, under a render/zoomPan that renders every animation frame. On a
# board whose node cache keeps at most 1 MB in memory, the native-resolution
# photo was refused every frame, so every 42 ms frame decoded a photo again
# (2.2 s on the SenseCAP Indicator) and, because each decode advanced the
# slideshow, showed the next photo and wrote the persisted counter
# (2026-11-15). Now localImage decodes to zoomPan's bounds, the cache keeps
# that bounded photo, and a run the cache only repeats never advances.

const AssetsDir = "tmp/slideshow-keep-tests"
const ProducerNodeId = 3.NodeId

removeDir(AssetsDir)
createDir(AssetsDir)
for name in ["a.jpg", "b.jpg", "c.jpg"]:
  copyFile("src/frameos/tests/fixtures/progressive-480x720.jpg", AssetsDir / name)

var loads: seq[string] = @[]

proc testConfig(): FrameConfig =
  FrameConfig(width: 8, height: 4, rotate: 0, scalingMode: "cover",
    debug: false, settings: %*{}, saveAssets: %*false, assetsPath: AssetsDir)

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: false)
  logger.log = proc(payload: JsonNode) =
    if payload.kind == JObject and payload{"message"}.getStr().startsWith("Loading image: "):
      loads.add(payload["message"].getStr())
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int,
    targetHandle: string): DiagramEdge =
  DiagramEdge(id: id.NodeId, source: source.NodeId, sourceHandle: sourceHandle,
    target: target.NodeId, targetHandle: targetHandle, data: %*{})

proc slideshowScene(): ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: "Slideshow keep test",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 0.0416,
    publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/zoomPan",
        "config": {"motion": "kenBurns", "zoomEnd": "1.45", "durationSeconds": "30"}}),
      node(3, "app", %*{
        "keyword": "data/localImage",
        "config": {"path": AssetsDir, "order": "alphabetical",
          "counterStateKey": "counter", "metadataStateKey": "meta"},
        "cache": {
          "enabled": true,
          "inputEnabled": true,
          "durationEnabled": false,
          "expressionEnabled": true,
          "expression": "state.cycle",
          "expressionType": "integer"
        }
      })
    ],
    edges: @[
      edge(1, 1, "next", 2, "prev"),
      edge(2, 3, "fieldOutput", 2, "fieldInput/image")
    ],
    apps: %*{}
  )

proc freshScene(): InterpretedFrameScene =
  let sceneId = "tests/slideshow-keep".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = slideshowScene()
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  loads = @[]
  let config = testConfig()
  result = InterpretedFrameScene(init(sceneId, config, testLogger(config),
    %*{"counter": 0, "cycle": 0}))

proc renderOnce(scene: FrameScene) =
  var context = ExecutionContext(scene: scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: 0.0)
  discard render(scene, context)

proc shown(scene: FrameScene): string =
  scene.state{"meta"}{"filename"}.getStr()

const Frames = 12

block a_bounded_photo_is_kept_past_the_limit_while_the_floor_holds:
  # The rule itself, apart from the decode budget the test seam shares with
  # it: a value its producer decoded to the bounds it took this pass.
  let canvas = newImage(8, 4)
  let photo = newImage(12, 18)
  var context = ExecutionContext(image: canvas, hasImage: true)
  context.decodeBoundsClaimedBy = ProducerNodeId
  context.decodeBoundsClaimedWidth = 12
  context.decodeBoundsClaimedHeight = 6
  availableRenderBytesOverride = 600 * 1024
  doAssert keepsBoundedImageForTest(photo, ProducerNodeId, context)
  doAssert not keepsBoundedImageForTest(photo, 4.NodeId, context),
    "another node's claim"
  doAssert not keepsBoundedImageForTest(newImage(24, 36), ProducerNodeId, context),
    "larger than the bounds on both axes: not a bounded decode"
  doAssert not keepsBoundedImageForTest(canvas, ProducerNodeId, context),
    "never the live canvas"
  availableRenderBytesOverride = 256 * 1024
  doAssert not keepsBoundedImageForTest(photo, ProducerNodeId, context),
    "under the headroom floor"
  availableRenderBytesOverride = 0

block the_bounded_photo_is_decoded_once_and_kept_for_the_whole_interval:
  # Every image is over the in-memory limit, as a photo is on an ESP32, and
  # the spill cap (4x the limit, or the 8x4 canvas at 4 bytes) refuses the
  # 12x18 bounded photo too: memory is the only tier.
  cachedImageMemoryLimitOverride = 1
  availableRenderBytesOverride = 4 * 1024 * 1024
  let scene = freshScene()
  for _ in 0 ..< Frames:
    renderOnce(scene)
  doAssert loads.len == 1, "one decode for " & $Frames & " frames, got " & $loads.len
  doAssert scene.cacheValues.hasKey(ProducerNodeId), "the bounded photo is kept"
  let kept = scene.cacheValues[ProducerNodeId].asImage()
  doAssert kept.width == 12 and kept.height == 18,
    "decoded to zoomPan's bounds (8x4 x 1.45, cover): " & $kept.width & "x" & $kept.height
  doAssert scene.shown == "a.jpg"
  doAssert scene.state["counter"].getInt() == 1, "the counter stepped once"

  # The interval passes: the next photo, once.
  scene.state["cycle"] = %*1
  for _ in 0 ..< Frames:
    renderOnce(scene)
  doAssert loads.len == 2, $loads
  doAssert scene.shown == "b.jpg"
  doAssert scene.state["counter"].getInt() == 2
  cachedImageMemoryLimitOverride = 0
  availableRenderBytesOverride = 0

block a_photo_the_cache_cannot_keep_is_made_again_without_advancing:
  # Headroom under the floor: nothing is kept, so every frame decodes again,
  # but the same photo, with the counter and its persisted copy untouched
  # until the interval moves.
  cachedImageMemoryLimitOverride = 1
  availableRenderBytesOverride = 0 # a test's word for the headroom: none
  let scene = freshScene()
  for _ in 0 ..< Frames:
    renderOnce(scene)
  doAssert not scene.cacheValues.hasKey(ProducerNodeId)
  doAssert loads.len == 1, "the slideshow stepped once: " & $loads
  doAssert scene.shown == "a.jpg"
  doAssert scene.state["counter"].getInt() == 1, "counter unchanged by the remakes"

  scene.state["cycle"] = %*1
  for _ in 0 ..< Frames:
    renderOnce(scene)
  doAssert loads.len == 2, $loads
  doAssert scene.shown == "b.jpg"
  doAssert scene.state["counter"].getInt() == 2
  cachedImageMemoryLimitOverride = 0
  availableRenderBytesOverride = 0

block a_host_keeps_what_it_cached_as_before:
  let scene = freshScene()
  for _ in 0 ..< Frames:
    renderOnce(scene)
  doAssert loads.len == 1
  doAssert scene.cacheValues.hasKey(ProducerNodeId)
  doAssert scene.state["counter"].getInt() == 1

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
removeDir(AssetsDir)
echo "test_interpreter_slideshow_keep: all assertions passed"
