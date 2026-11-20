import std/[json, os, strutils, unittest]
import pixie
import ../interpreter
import ../scene_rhythm
import ../single_scene_host
import ../types
import ../js_runtime/app_runtime
import ../utils/app_images

# The Gallery sample's header names the picked category in the style of the
# category's own pill below it (text-sm font-semibold). Tapped round its four
# pills twice, the second round must draw what the first did: the label was
# drawn regular instead of semibold from the second round on, a text node
# set from its own spans with the bold fonts of a recalled arrangement
# (ui/layout.nim, `recall` and `ensureSpans`).

const
  W = 480
  H = 480
  PillY = 448
  Pills = [66, 182, 298, 414]

let root = currentSourcePath().parentDir / ".." / ".." / ".." / ".."
let gallery = block:
  let raw = parseJson(readFile(root / "e2e" / "scenes" / "jsxSquareGallery.json"))
  if raw.kind == JArray: raw[0] else: raw

proc noPhoto(url: string, maxBytes: int, target: Image, fit: ScaledDecodeFit,
    boundWidth: int, boundHeight: int): tuple[image: Image, data: string] =
  raise newException(IOError, "404 Not Found")
contextDownloadHook = noPhoto

let config = FrameConfig(name: "sensecap", mode: "embedded", width: W, height: H, rotate: 0,
  scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false,
  assetsPath: getTempDir() / "frameos-gallery-label-test")
var logger = Logger(frameConfig: config, enabled: true)
logger.log = proc(payload: JsonNode) = discard
logger.enable = proc() = discard
logger.disable = proc() = discard

proc frame(scene: FrameScene, canvas: Image) =
  rhythmClockOverride += 0.5
  discard render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: canvas, hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1))
  discard settleIdleJsAppRuntimes(keep = true)

proc pointer(scene: FrameScene, event: string, x, y: int) =
  runEvent(scene, ExecutionContext(scene: scene, event: event,
    payload: %*{"x": x, "y": y, "pointerId": 1, "pointerType": "touch", "button": 0},
    loopIndex: 0, loopKey: ".", nextSleep: -1))

proc header(canvas: Image): seq[ColorRGBX] =
  ## The top bar: the category's label and the photo's.
  for y in 0 ..< 60:
    for x in 0 ..< W:
      result.add canvas[x, y]

suite "the Gallery sample's label":
  test "drawn the same on the second round of taps as on the first":
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[gallery])))
    resetInterpretedScenes()
    let scene = init(gallery["id"].getStr().SceneId, config, logger, %*{})
    let canvas = newImage(W, H)
    scene.frame(canvas)
    var first: seq[seq[ColorRGBX]]
    for round in 0 ..< 2:
      for i, x in Pills:
        # As a finger does: the press drawn, then the tap's change.
        scene.pointer("pointerDown", x, PillY)
        scene.frame(canvas)
        scene.pointer("pointerUp", x, PillY)
        scene.pointer("tap", x, PillY)
        scene.frame(canvas)
        if round == 0:
          first.add canvas.header
        else:
          check canvas.header == first[i]
