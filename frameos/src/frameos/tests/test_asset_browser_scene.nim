## The Asset browser sample (repo/scenes/samples/Asset browser) over a folder
## of pictures: the folder's own entries a page at a time, thumbnails decoded at
## their tile's size, a picture on the whole screen, and the spot it comes back
## to. FRAMEOS_ASSET_SHOTS=<dir> writes each picture there.

import std/[json, os, strutils, times, unittest]
import pixie
import ../channels
import ../interpreter
import ../scene_rhythm
import ../types
import ../js_runtime/app_runtime

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

let assets = getTempDir() / "frameos-asset-browser-" & $epochTime().int

proc picture(path, color: string, width = 1200, height = 800) =
  createDir(path.parentDir)
  let image = newImage(width, height)
  image.fill(parseHtmlColor(color).rgbx)
  image.writeFile(path)

picture(assets / "photos" / "beach.png", "#0ea5e9")
picture(assets / "photos" / "forest.png", "#16a34a", 800, 1200)
picture(assets / "photos" / "sunset.png", "#f97316")
picture(assets / "photos" / "2024" / "snow.png", "#e2e8f0")
picture(assets / "logo.png", "#a855f7", 400, 400)
createDir(assets / "fonts")
writeFile(assets / "fonts" / "Ubuntu.ttf", "not really a font")
writeFile(assets / "notes.txt", "hello")
writeFile(assets / ".hidden.png", "never listed")

suite "the Asset browser scene":
  setup:
    rhythmClockOverride = 1000.0
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0

  var problems: seq[string]
  var logger = Logger(frameConfig: nil, enabled: true)
  logger.log = proc(payload: JsonNode) =
    if payload{"event"}.getStr().contains("error") or payload{"level"}.getStr() == "error":
      problems.add($payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false

  proc frame(width, height: int, device = "framebuffer"): FrameConfig =
    FrameConfig(name: "assets", mode: "rpios", device: device, width: width, height: height, rotate: 0,
      scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
      assetsPath: assets)

  var shot = 0
  proc draw(scene: FrameScene, config: FrameConfig, name: string): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    result = render(scene, context)
    inc shot
    let dir = getEnv("FRAMEOS_ASSET_SHOTS")
    if dir.len > 0:
      createDir(dir)
      result.writeFile(dir / ($shot & "-" & name & ".png"))
    rhythmClockOverride += 1.0

  proc tap(scene: FrameScene, x, y: int) =
    let payload = %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"}
    runEvent(scene, ExecutionContext(scene: scene, event: "tap", payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc swipe(scene: FrameScene, direction: string) =
    let payload = %*{"x": 400, "y": 240, "direction": direction, "pointerId": 0, "pointerType": "touch"}
    runEvent(scene, ExecutionContext(scene: scene, event: "swipe", payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc load(config: FrameConfig): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[parseFile(Samples / "Asset browser" /
      "scenes.json")[0]])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("asset-browser".SceneId, config, logger, %*{})

  proc spot(scene: FrameScene): JsonNode = scene.state{"spot"}

  test "lists the folder's own entries, folders first, nothing hidden":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    let image = draw(scene, config, "top")
    check image.width == 800
    check problems.len == 0
    if problems.len > 0: echo problems
    # The first tile is the folder "fonts", then "photos": open "photos".
    var opened = false
    for x in countup(20, 780, 30):
      scene.tap(x, 140)
      if scene.spot{"dir"}.getStr() == "photos":
        opened = true
        break
      if scene.spot{"dir"}.getStr() == "fonts":
        scene.tap(36, 30) # up
        discard draw(scene, config, "back-up")
    check opened
    for i in 0 ..< 6:
      discard draw(scene, config, "photos")
    check scene.spot{"dir"}.getStr() == "photos"

  test "opens a picture on the whole screen, swipes to the next, and comes back where it was":
    problems = @[]
    let config = frame(800, 480)
    var scene = load(config)
    scene.state["spot"] = %*{"dir": "photos", "page": 1}
    discard draw(scene, config, "photos-again")
    discard draw(scene, config, "photos-thumbs")
    # The folder "2024", then beach, forest and sunset: past the folder's tile.
    var opened = false
    for x in countup(200, 780, 30):
      scene.tap(x, 140)
      if scene.spot{"open"}.getStr().len > 0:
        opened = true
        break
    check opened
    let first = scene.spot{"open"}.getStr()
    check first.startsWith("photos/") and first.endsWith(".png")
    discard draw(scene, config, "viewer")
    scene.swipe("left")
    discard draw(scene, config, "viewer-next")
    check scene.spot{"open"}.getStr() != first
    let open = scene.spot{"open"}.getStr()

    let kept = scene.spot
    scene = load(config)
    scene.state["spot"] = kept
    discard draw(scene, config, "reopened")
    check scene.spot{"open"}.getStr() == open
    scene.swipe("down")
    discard draw(scene, config, "closed")
    check scene.spot{"open"}.getStr() == ""
    check scene.spot{"dir"}.getStr() == "photos"
    check problems.len == 0
    if problems.len > 0: echo problems

  test "e-paper draws its thumbnails in the same pass":
    problems = @[]
    let config = frame(800, 480, "waveshare.EPD_7in5_V2")
    let scene = load(config)
    scene.state["spot"] = %*{"dir": "photos", "page": 1}
    discard draw(scene, config, "paper")
    check problems.len == 0

  test "a folder that went away goes back to the top":
    let config = frame(480, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"dir": "gone/away", "page": 3}
    discard draw(scene, config, "gone")
    check scene.spot{"dir"}.getStr() == ""
    check scene.spot{"page"}.getInt() == 1

removeDir(assets)
