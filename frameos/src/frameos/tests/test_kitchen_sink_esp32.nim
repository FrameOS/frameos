import std/[json, os, sequtils, strutils, tables, unittest]
import pixie
import ../interpreter
import ../scene_rhythm
import ../single_scene_host
import ../types
import ../js_runtime/app_runtime
import ../utils/memory

# The Kitchen sink as a SenseCAP Indicator (ESP32-S3, 8 MB PSRAM, 480x480) runs
# it: RGB565 in the panel's own buffer, the interpreters settled after every
# frame as the single-scene host does, with little memory left. It is the
# biggest thing a UI does on that board, and each of these failures shipped to
# the bench first: a tap that did nothing because the interpreter holding its
# handler went with the frame (2026-11-08), and picture records that leaked
# until it did (2026-11-07).

const
  W = 480
  H = 480
  TabY = 448
  PaintTabX = 144
  LightsTabX = 240

let root = currentSourcePath().parentDir / ".." / ".." / ".." / ".."
let kitchenSink = block:
  let raw = parseJson(readFile(root / "e2e" / "scenes" / "jsxSquareKitchenSink.json"))
  if raw.kind == JArray: raw[0] else: raw
let topBar = parseJson(readFile(root / "repo" / "scenes" / "samples" / "Top bar layout" / "scenes.json"))[0]

let config = FrameConfig(name: "sensecap", mode: "embedded", width: W, height: H, rotate: 0,
  scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false,
  assetsPath: getTempDir() / "frameos-kitchen-sink-test")

var errors: seq[string]
var logger = Logger(frameConfig: config, enabled: true)
logger.log = proc(payload: JsonNode) =
  let line = $payload
  if "rror" in line:
    errors.add line
logger.enable = proc() = discard
logger.disable = proc() = discard

proc start(withLayout: bool): FrameScene =
  let scene = copy(kitchenSink)
  if withLayout:
    scene["layout"] = %*{"sceneId": topBar["id"].getStr()}
  setUploadedInterpretedScenes(parseInterpretedScenes($(%*[topBar, scene])))
  resetInterpretedScenes()
  errors = @[]
  init(kitchenSink["id"].getStr().SceneId, config, logger, %*{})

proc frame(scene: FrameScene, canvas: Image) =
  ## One pass and what the single-scene host does after it.
  rhythmClockOverride += 0.5
  discard render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: canvas, hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1))
  discard settleIdleJsAppRuntimes(keep = true)

proc pointer(scene: FrameScene, event: string, x, y: int) =
  runEvent(scene, ExecutionContext(scene: scene, event: event,
    payload: %*{"x": x, "y": y, "pointerId": 1, "pointerType": "touch", "button": 0},
    loopIndex: 0, loopKey: ".", nextSleep: -1))

proc tap(scene: FrameScene, canvas: Image, x, y: int) =
  scene.pointer("pointerDown", x, y)
  scene.pointer("pointerUp", x, y)
  scene.pointer("tap", x, y)
  scene.frame(canvas)

proc sink(scene: FrameScene): JsonNode =
  ## What the app keeps with frameos.remember.
  for app in InterpretedFrameScene(scene).appsByNodeId.values:
    if app of DynamicJsApp and DynamicJsApp(app).runtime.memory.hasKey("sink"):
      return parseJson(DynamicJsApp(app).runtime.memory["sink"])
  newJObject()

proc paintStroke(scene: FrameScene, canvas: Image) =
  scene.pointer("pointerDown", 150, 200)
  for i in 1 .. 8:
    scene.pointer("pointerMove", 150 + i * 15, 200 + i * 8)
    scene.frame(canvas)
  scene.pointer("pointerUp", 270, 264)
  scene.frame(canvas)

suite "an interpreter that goes":
  setup:
    rhythmClockOverride = 1000.0
    setSimulatedEmbedded(true)
    availableRenderBytesOverride = 900 * 1024
    discard takeInterpreterDiscards()

  teardown:
    setSimulatedEmbedded(false)
    availableRenderBytesOverride = 0

  test "getting ahead of a decode leaves one holding a UI's handlers alone":
    let scene = start(true)
    let canvas = newImage565(W, H)
    scene.frame(canvas)
    check not renderMemoryReleaseHook(false) or takeInterpreterDiscards().allIt(not it.heldHandlers)
    scene.tap(canvas, PaintTabX, TabY)
    check scene.sink{"tab"}.getStr() == "paint"

  test "an allocation that failed takes it, and says so":
    let scene = start(false)
    let canvas = newImage565(W, H)
    scene.frame(canvas)
    discard takeInterpreterDiscards()
    check releaseRenderMemory()
    let discards = takeInterpreterDiscards()
    check discards.len == 1
    check discards[0].heldHandlers and discards[0].sceneId == kitchenSink["id"].getStr()
    check discards[0].reason == "an allocation failed"

  test "the frame's log and the panel say so, and the panel stops saying so":
    let scene = start(false)
    let canvas = newImage565(W, H)
    scene.frame(canvas)
    var said: seq[JsonNode]
    var quiet = Logger(frameConfig: config, enabled: true)
    quiet.log = proc(payload: JsonNode) = said.add payload
    let host = SingleSceneHost(frameConfig: config, logger: quiet)
    discard releaseRenderMemory()
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: canvas, hasImage: true,
      loopIndex: 0, loopKey: ".", nextSleep: -1)
    let before = canvas[W div 2, H - 8]
    host.reportInterpreterDiscards(context, canvas)
    check said.len == 1 and said[0]{"event"}.getStr() == "js:interpreterDiscarded"
    check said[0]{"heldHandlers"}.getBool()
    check canvas[W div 2, H - 8] != before
    check context.nextSleep > 0 and context.nextSleep <= 6
    # Nothing more went: nothing more is said.
    let again = said.len
    host.reportInterpreterDiscards(context, canvas)
    check said.len == again

for withLayout in [false, true]:
  suite "the Kitchen sink on an 8 MB ESP32, " & (if withLayout: "in a layout" else: "on its own"):
    setup:
      rhythmClockOverride = 1000.0
      setSimulatedEmbedded(true)
      # What the board had left with both of Paint's canvases made: under
      # KeepInterpretersBytes, which is what let the interpreter go.
      availableRenderBytesOverride = 900 * 1024
      rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0

    teardown:
      setSimulatedEmbedded(false)
      availableRenderBytesOverride = 0
      rhythmCanvasGeneration = nil

    test "it renders":
      let scene = start(withLayout)
      let canvas = newImage565(W, H)
      scene.frame(canvas)
      scene.frame(canvas)
      check errors.len == 0

    test "its pages change, and keep changing, with memory this short":
      let scene = start(withLayout)
      let canvas = newImage565(W, H)
      scene.frame(canvas)
      check liveJsAppRuntimeBytes() > 0 # the interpreter holding the handlers stayed
      scene.tap(canvas, PaintTabX, TabY)
      check scene.sink{"tab"}.getStr() == "paint"
      scene.tap(canvas, LightsTabX, TabY)
      check scene.sink{"tab"}.getStr() == "lights"
      scene.tap(canvas, PaintTabX, TabY)
      check scene.sink{"tab"}.getStr() == "paint"
      check errors.len == 0

    test "a drag paints, and the pages still answer after it":
      let scene = start(withLayout)
      let canvas = newImage565(W, H)
      scene.frame(canvas)
      scene.tap(canvas, PaintTabX, TabY)
      scene.paintStroke(canvas)
      check scene.sink{"strokes"}.len == 1
      scene.paintStroke(canvas)
      check scene.sink{"strokes"}.len == 2
      scene.tap(canvas, LightsTabX, TabY)
      check scene.sink{"tab"}.getStr() == "lights"
      check errors.len == 0

    test "frames do not leak":
      let scene = start(withLayout)
      let canvas = newImage565(W, H)
      scene.frame(canvas)
      scene.tap(canvas, PaintTabX, TabY)
      for _ in 0 ..< 40:
        scene.paintStroke(canvas)
      GC_fullCollect()
      let before = getOccupiedMem()
      for _ in 0 ..< 40:
        scene.paintStroke(canvas)
      GC_fullCollect()
      let grown = getOccupiedMem() - before
      # 360 frames: a parse a frame (16-45 KB) would be 6 MB or more.
      check grown < 1024 * 1024
