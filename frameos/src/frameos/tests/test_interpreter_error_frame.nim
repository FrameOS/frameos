import std/[json, os, strutils, tables]
import pixie
import ../interpreter
import ../types
import ../values
from ../utils/memory import setSimulatedEmbedded
import ../utils/app_images

# An erroring image producer under an animation, on a device (found on a
# SenseCAP Indicator, 2026-11-15): data/localImage with an empty folder drew
# its error into the live canvas and returned it, the node cache kept that
# (under its 1 MB limit) and served the next pass a view of the canvas as the
# "photo", and render/zoomPan, refusing to zoom its canvas into itself (#797),
# left the frame black. Now the cache never keeps a value that aliases the
# canvas, and the error frame is a small standalone image the cache keeps: the
# producer runs, and logs, once a cache period, and the frame shows the error.

const EmptyDir = "tmp/error-frame-tests"
const ProducerNodeId = 3.NodeId
const Frames = 12

removeDir(EmptyDir)
createDir(EmptyDir)

var errors: seq[string] = @[]

proc testConfig(width, height: int): FrameConfig =
  FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover",
    debug: false, settings: %*{}, saveAssets: %*false, assetsPath: EmptyDir)

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: false)
  logger.log = proc(payload: JsonNode) =
    if payload.kind != JObject: return
    if payload{"error"}.getStr().len > 0:
      errors.add(payload["error"].getStr())
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int,
    targetHandle: string): DiagramEdge =
  DiagramEdge(id: id.NodeId, source: source.NodeId, sourceHandle: sourceHandle,
    target: target.NodeId, targetHandle: targetHandle, data: %*{})

proc sceneWith(consumer, producer: DiagramNode): ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: "Error frame test",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 0.0416,
    publicStateFields: @[],
    nodes: @[node(1, "event", %*{"keyword": "render"}), consumer, producer],
    edges: @[
      edge(1, 1, "next", 2, "prev"),
      edge(2, 3, "fieldOutput", 2, "fieldInput/image")
    ],
    apps: %*{}
  )

proc freshScene(exported: ExportedInterpretedScene, width, height: int): InterpretedFrameScene =
  let sceneId = "tests/error-frame".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = exported
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  errors = @[]
  let config = testConfig(width, height)
  InterpretedFrameScene(init(sceneId, config, testLogger(config), %*{"cycle": 0}))

proc renderInto(scene: FrameScene, canvas: Image) =
  var context = ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: canvas, hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: 0.0)
  discard render(scene, context)

proc cachedAliases(scene: InterpretedFrameScene, canvas: Image): bool =
  scene.cacheValues.hasKey(ProducerNodeId) and
    scene.cacheValues[ProducerNodeId].kind == fkImage and
    scene.cacheValues[ProducerNodeId].asImage().bufferPointer == canvas.bufferPointer

proc shades(canvas: Image): tuple[light, dark: int] =
  for y in 0 ..< canvas.height:
    for x in 0 ..< canvas.width:
      let c = rgb565ToRgbx(canvas.data16[canvas.dataIndex(x, y)])
      let luma = (c.r.int + c.g.int + c.b.int) div 3
      if luma > 200: inc result.light
      elif luma < 60: inc result.dark

block an_empty_folder_under_zoom_pan_shows_its_error_and_runs_once_a_period:
  setSimulatedEmbedded(true)
  let scene = freshScene(sceneWith(
    node(2, "app", %*{"keyword": "render/zoomPan",
      "config": {"motion": "kenBurns", "zoomEnd": "1.45", "durationSeconds": "30"}}),
    node(3, "app", %*{
      "keyword": "data/localImage",
      "config": {"path": EmptyDir, "order": "alphabetical"},
      "cache": {"enabled": true, "inputEnabled": true, "durationEnabled": false,
        "expressionEnabled": true, "expression": "state.cycle",
        "expressionType": "integer"}
    })), 480, 320)
  let canvas = newImage565(480, 320)
  for frame in 0 ..< Frames:
    renderInto(scene, canvas)
    doAssert not scene.cachedAliases(canvas), "frame " & $frame & ": the cache holds the canvas"
    let (light, dark) = shades(canvas)
    let pixels = canvas.width * canvas.height
    doAssert light > pixels div 2 and dark > 0,
      "frame " & $frame & " shows the error frame: " & $light & " light, " & $dark & " dark"
  doAssert errors.len == 1, "one error for " & $Frames & " frames: " & $errors
  doAssert "No images found" in errors[0], errors[0]
  doAssert scene.cacheValues.hasKey(ProducerNodeId), "the error frame is kept"
  let kept = scene.cacheValues[ProducerNodeId].asImage()
  doAssert kept.width == 240 and kept.height == 160,
    "a fraction of the canvas, under 512 KB: " & $kept.width & "x" & $kept.height

  # The period ends: the producer runs, and logs, once more.
  scene.state["cycle"] = %*1
  for _ in 0 ..< Frames:
    renderInto(scene, canvas)
  doAssert errors.len == 2, $errors
  setSimulatedEmbedded(false)

block an_error_frame_on_a_device_is_small_and_standalone:
  setSimulatedEmbedded(true)
  let config = testConfig(1848, 1179)
  let app = AppRoot(nodeId: 3.NodeId, frameConfig: config)
  let canvas = newImage565(1848, 1179)
  let context = ExecutionContext(image: canvas, hasImage: true)
  let frame = app.renderErrorForContext(context, "boom")
  doAssert frame.bufferPointer != canvas.bufferPointer
  doAssert frame.byteSize <= 512 * 1024, $frame.width & "x" & $frame.height
  doAssert frame.width == 1848 div 5 and frame.height == 1179 div 5
  setSimulatedEmbedded(false)

var liveCanvas: Image = nil
var downloads = 0

proc canvasDownload(url: string, maxBytes: int, target: Image,
    fit: ScaledDecodeFit, boundWidth: int, boundHeight: int): tuple[image: Image, data: string] =
  # A producer that hands back the live canvas whatever it was offered.
  inc downloads
  liveCanvas.fill(rgbx(255, 0, 0, 255))
  (liveCanvas, "")

block a_value_that_aliases_the_canvas_is_never_kept_whatever_its_size:
  # 16x8 RGB565 is 256 bytes, far under the device's 1 MB memory limit.
  contextDownloadHook = canvasDownload
  setSimulatedEmbedded(true)
  let scene = freshScene(sceneWith(
    node(2, "app", %*{"keyword": "render/image", "config": %*{}}),
    node(3, "app", %*{
      "keyword": "data/downloadImage",
      "config": {"url": "https://example.com/photo.jpg"},
      "cache": {"enabled": true, "inputEnabled": false, "durationEnabled": true,
        "duration": "60", "expressionEnabled": false}
    })), 16, 8)
  liveCanvas = newImage565(16, 8)
  for _ in 0 ..< 3:
    renderInto(scene, liveCanvas)
    doAssert not scene.cachedAliases(liveCanvas)
    doAssert not scene.cacheValues.hasKey(ProducerNodeId), "in no tier"
  doAssert downloads == 3, "nothing kept: made again each pass, got " & $downloads
  setSimulatedEmbedded(false)
  contextDownloadHook = nil

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
removeDir(EmptyDir)
echo "test_interpreter_error_frame: all assertions passed"
