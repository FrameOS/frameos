import std/[json, os, strutils, tables]
import pixie
import ../interpreter
import ../types
import ../spool
from ../utils/memory import availableRenderBytesOverride, setSimulatedEmbedded
import ../utils/app_images

# The node cache's disk tier, from the interpreter's side
# (docs/value-pipeline.md).
#
# On embedded, a cached image past the in-memory limit used to be stored
# nowhere: the producer re-downloaded on every render and the cache's duration
# setting silently meant nothing. Now the pixels spill to storage, the entry
# becomes a file-backed value, and a hit reads it back — exactly the image the
# memory cache would have held. These tests drive the tiers through a real
# scene: a cached photo producer feeding render/image, with the embedded
# in-memory limit forced down so an 8x4 canvas is already "frame-sized".
#
# The producer hook paints a different colour on every call, so "served from
# disk" and "recomputed" are distinguishable in the canvas itself, not just in
# call counts.

const ScratchDir = "tmp/cache-spool-tests"

# The spill-directory probe creates only the `.cache` leaf — on the device
# the assets root is the SD mount itself and always exists. The test models
# that contract by creating its assets root up front; without it, the probe
# correctly reports no storage and spills fall back to the temp dir.
createDir(ScratchDir)

let callColors = [
  rgbx(255, 0, 0, 255), # first compute: red
  rgbx(0, 255, 0, 255), # second compute: green
  rgbx(0, 0, 255, 255), # third compute: blue
]

const ProducerNodeId = 3.NodeId

var hookCalls = 0
var hookTargets: seq[Image] = @[]
# Whether the cache still held the producer's last value while it ran.
var observedScene: InterpretedFrameScene = nil
var staleHeldDuringCompute: seq[bool] = @[]
# Paint a 4 MB image of its own instead of the scratch the interpreter offers.
var paintOwnImage = false

proc paintingDownload(url: string, maxBytes: int, target: Image,
    fit: ScaledDecodeFit, boundWidth: int, boundHeight: int): tuple[image: Image, data: string] =
  let image = if target.isNil or paintOwnImage: newImage(1024, 1024) else: target
  let color = callColors[min(hookCalls, callColors.high)]
  hookCalls += 1
  hookTargets.add(target)
  if not observedScene.isNil:
    staleHeldDuringCompute.add(observedScene.cacheValues.hasKey(ProducerNodeId))
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      image.data[image.dataIndex(x, y)] = color
  (image, "")

contextDownloadHook = paintingDownload

proc testConfig(width = 8, height = 4): FrameConfig =
  FrameConfig(
    width: width,
    height: height,
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


proc photoScene(): ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: "Cache spool test",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0,
    publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/image", "config": %*{}}),
      node(3, "app", %*{
        "keyword": "data/downloadImage",
        "config": {"url": "https://example.com/photo.jpg"},
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

proc freshScene(width = 8, height = 4): FrameScene =
  let sceneId = "tests/cache-spool".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = photoScene()
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  hookCalls = 0
  hookTargets = @[]
  let config = testConfig(width, height)
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

block a_preview_running_as_an_esp32_takes_the_devices_cache_limit:
  # The editor's preview simulating an ESP32 (frameos_wasm_set_embedded) is
  # not built with -d:frameosEmbedded, and its cache limit used to be a
  # host's: none. Flights Above Me (a cached JS app into render/image) then
  # got a 7.68 MB scratch at 1600x1200 and the preview ran out of memory on
  # the E1004 where the frame decodes into the live canvas. 600x480 at four
  # bytes a pixel is 1.15 MB, over the device's 1 MB limit.
  setSimulatedEmbedded(true)
  availableRenderBytesOverride = 64 # no room for a scratch beside the canvas
  let simulated = freshScene(600, 480)
  let canvas = renderOnce(simulated)
  doAssert hookTargets[0] == canvas, "as the device: decode into the live canvas"
  doAssert not InterpretedFrameScene(simulated).cacheValues.hasKey(ProducerNodeId)
  setSimulatedEmbedded(false)
  # A host keeps what it cached: the producer gets a scratch of its own.
  let host = freshScene(600, 480)
  let hostCanvas = renderOnce(host)
  doAssert hookTargets[0] != hostCanvas, "a host's cached producer owns a scratch"
  availableRenderBytesOverride = 0

block over_limit_image_stays_in_memory_while_the_frame_affords_it:
  # A slideshow's photo under an animation is the cached producer's output on
  # every frame. Past the limit with no disk to spill to it was stored
  # nowhere, and every frame decoded it again. With headroom to spare beside
  # it, the memory tier keeps it.
  cachedImageMemoryLimitOverride = 1
  availableRenderBytesOverride = 3 * 1024 * 1024
  let scene = freshScene()
  discard renderOnce(scene)
  doAssert hookCalls == 1
  doAssert InterpretedFrameScene(scene).cacheValues[ProducerNodeId].kind == fkImage
  let second = renderOnce(scene)
  doAssert hookCalls == 1, "an affordable image is a memory hit"
  doAssert canvasColor(second) == callColors[0]
  availableRenderBytesOverride = 0
  cachedImageMemoryLimitOverride = 0

block an_over_limit_image_needs_the_limit_again_in_headroom:
  # The bar is the memory tier's own limit: with the image held, room for as
  # much again. The SenseCAP Indicator's slideshow kept its 1 MB photo with
  # 2.03 MB to spare only once its boot had settled, under a 2 MB bar.
  cachedImageMemoryLimitOverride = 1024 * 1024 # the 4 MB photo is over it
  paintOwnImage = true
  availableRenderBytesOverride = 1024 * 1024 - 1
  var scene = freshScene()
  discard renderOnce(scene)
  doAssert InterpretedFrameScene(scene).cacheValues.getOrDefault(ProducerNodeId).kind != fkImage,
    "a byte under the limit: not in memory"
  availableRenderBytesOverride = 1024 * 1024
  scene = freshScene()
  discard renderOnce(scene)
  doAssert InterpretedFrameScene(scene).cacheValues[ProducerNodeId].kind == fkImage
  discard renderOnce(scene)
  doAssert hookCalls == 1, "kept: a memory hit"
  paintOwnImage = false
  availableRenderBytesOverride = 0
  cachedImageMemoryLimitOverride = 0

block a_stale_image_is_released_before_its_replacement_is_made:
  # The next photo's decode gets the memory the last one held: on the
  # SenseCAP Indicator that 0.9 MB was the difference between a photo and an
  # error frame.
  cachedImageMemoryLimitOverride = 1024 * 1024
  let scene = freshScene()
  observedScene = InterpretedFrameScene(scene)
  staleHeldDuringCompute = @[]
  discard renderOnce(scene)
  InterpretedFrameScene(scene).cacheTimes[ProducerNodeId] = 0.0 # expired
  let second = renderOnce(scene)
  doAssert hookCalls == 2
  doAssert staleHeldDuringCompute == @[false, false],
    "the expired image was still cached while its replacement decoded"
  doAssert canvasColor(second) == callColors[1]
  doAssert InterpretedFrameScene(scene).cacheValues[ProducerNodeId].kind == fkImage
  observedScene = nil
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
