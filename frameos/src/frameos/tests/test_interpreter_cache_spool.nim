import std/[json, os, strutils, tables]
import pixie
import ../interpreter
import ../types
import ../spool
from ../utils/memory import availableRenderBytesOverride
import ../../apps/data/frameOSGallery/app as galleryApp

# The node cache's disk tier, from the interpreter's side
# (docs/value-pipeline.md).
#
# On embedded, a cached image past the in-memory limit used to be stored
# nowhere: the producer re-downloaded on every render and the cache's duration
# setting silently meant nothing. Now the pixels spill to storage, the entry
# becomes a file-backed value, and a hit reads it back — exactly the image the
# memory cache would have held. These tests drive the tiers through a real
# scene: a cached gallery producer feeding render/image, with the embedded
# in-memory limit forced down so an 8x4 canvas is already "frame-sized".
#
# The producer hook paints a different colour on every call, so "served from
# disk" and "recomputed" are distinguishable in the canvas itself, not just in
# call counts.

const ScratchDir = "tmp/cache-spool-tests"

let callColors = [
  rgbx(255, 0, 0, 255), # first compute: red
  rgbx(0, 255, 0, 255), # second compute: green
  rgbx(0, 0, 255, 255), # third compute: blue
]

var hookCalls = 0
var hookTargets: seq[Image] = @[]

proc paintingDownload(url: string, maxBytes: int, target: Image,
    fit: ScaledDecodeFit): Image =
  result = if target.isNil: newImage(1024, 1024) else: target
  let color = callColors[min(hookCalls, callColors.high)]
  hookCalls += 1
  hookTargets.add(target)
  for y in 0 ..< result.height:
    for x in 0 ..< result.width:
      result.data[result.dataIndex(x, y)] = color

galleryDownloadHook = paintingDownload

proc testConfig(): FrameConfig =
  FrameConfig(
    width: 8,
    height: 4,
    rotate: 0,
    scalingMode: "cover",
    debug: false,
    settings: %*{},
    saveAssets: %*false,
    assetsPath: ScratchDir
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

const ProducerNodeId = 3.NodeId

proc galleryScene(): ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: "Cache spool test",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0,
    publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/image", "config": %*{}}),
      node(3, "app", %*{
        "keyword": "data/frameOSGallery",
        "config": {"category": "nature"},
        "cache": {
          "enabled": true,
          "inputEnabled": false,
          "durationEnabled": true,
          "duration": "60",
          "expressionEnabled": false
        }
      })
    ],
    edges: @[
      edge(1, 1, "next", 2, "prev"),
      edge(2, 3, "fieldOutput", 2, "fieldInput/image")
    ]
  )

proc freshScene(): FrameScene =
  let sceneId = "tests/cache-spool".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = galleryScene()
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  hookCalls = 0
  hookTargets = @[]
  let config = testConfig()
  init(sceneId, config, testLogger(config), %*{})

proc renderOnce(scene: FrameScene): Image =
  var context = ExecutionContext(
    scene: scene,
    event: "render",
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: 0.0
  )
  render(scene, context)

proc canvasColor(canvas: Image): ColorRGBX =
  canvas.data[canvas.dataIndex(canvas.width div 2, canvas.height div 2)]

block over_limit_cached_image_spills_and_serves_from_disk:
  cachedImageMemoryLimitOverride = 1 # every image is "frame-sized" now
  let scene = freshScene()

  let first = renderOnce(scene)
  doAssert hookCalls == 1
  doAssert canvasColor(first) == callColors[0], "first render paints red"

  # The producer was offered an owned scratch (never the live canvas: the
  # entry will outlive the render), and the cache holds a file, not pixels.
  doAssert not hookTargets[0].isNil
  doAssert hookTargets[0] != first
  let cached = InterpretedFrameScene(scene).cacheValues[ProducerNodeId]
  doAssert cached.kind == fkImageSpool
  doAssert cached.imgSp.width == 8 and cached.imgSp.height == 4
  doAssert fileExists(cached.imgSp.path())
  doAssert getFileSize(cached.imgSp.path()) == 8 * 4 * 4
  doAssert cached.imgSp.path().len > 0 and
    ScratchDir & "/.cache" in cached.imgSp.path()

  # A second render is a hit: the producer does not run, and the canvas shows
  # the FIRST call's pixels, read back from the file.
  let second = renderOnce(scene)
  doAssert hookCalls == 1, "a disk hit must not re-run the producer"
  doAssert canvasColor(second) == callColors[0],
    "the disk tier must serve the stored pixels, byte for byte"

  cachedImageMemoryLimitOverride = 0

block a_swept_file_degrades_to_a_miss_and_reheals:
  cachedImageMemoryLimitOverride = 1
  let scene = freshScene()
  discard renderOnce(scene)
  doAssert hookCalls == 1

  # The card was pulled, or a boot sweep took the file: the entry is dead.
  # That must read as a miss — recompute, restore, carry on.
  removeFile(InterpretedFrameScene(scene).cacheValues[ProducerNodeId].imgSp.path())
  let third = renderOnce(scene)
  doAssert hookCalls == 2, "an unreadable entry is a miss, not an error"
  doAssert canvasColor(third) == callColors[1], "the recompute's pixels win"
  let recached = InterpretedFrameScene(scene).cacheValues[ProducerNodeId]
  doAssert recached.kind == fkImageSpool
  doAssert fileExists(recached.imgSp.path()), "the fresh value spills again"

  cachedImageMemoryLimitOverride = 0

block no_headroom_upgrades_to_the_live_canvas_and_stores_nothing:
  # When there is no room for a scratch next to the canvas (the 13.3E6 shape),
  # the offer upgrades to the live canvas and the cache stays empty — the
  # behaviour every over-limit cached producer had before the disk tier. The
  # live canvas is also exactly what must never be snapshotted, so this pins
  # both the headroom check and the alias guard at once.
  cachedImageMemoryLimitOverride = 1
  availableRenderBytesOverride = 64 # < 2x the 128-byte canvas
  let scene = freshScene()

  let first = renderOnce(scene)
  doAssert hookCalls == 1
  doAssert not hookTargets[0].isNil
  doAssert hookTargets[0] == first, "no headroom: decode into the live canvas"
  doAssert not InterpretedFrameScene(scene).cacheValues.hasKey(ProducerNodeId),
    "the live canvas must never be stored, in memory or on disk"

  discard renderOnce(scene)
  doAssert hookCalls == 2, "nothing stored means every render recomputes"

  availableRenderBytesOverride = 0
  cachedImageMemoryLimitOverride = 0

block under_limit_images_still_cache_in_memory:
  # The disk tier begins where the memory tier ends; below the limit nothing
  # about yesterday changes.
  cachedImageMemoryLimitOverride = 1024 * 1024
  let scene = freshScene()
  discard renderOnce(scene)
  doAssert hookCalls == 1
  doAssert InterpretedFrameScene(scene).cacheValues[ProducerNodeId].kind == fkImage
  discard renderOnce(scene)
  doAssert hookCalls == 1
  cachedImageMemoryLimitOverride = 0

echo "test_interpreter_cache_spool: all assertions passed"
