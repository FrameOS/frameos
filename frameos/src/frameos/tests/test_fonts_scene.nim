## The Fonts sample (repo/scenes/samples/Fonts): the fonts in the frame's
## fonts folder, a page at a time with each name in its own face, and a
## specimen of the one picked (docs/esp32-fonts.md). Here the folder is the
## collection FrameOS ships (assets/copied/fonts), as a Pi has it after a
## deploy and an ESP32 after "Sync fonts".
##
## FRAMEOS_FONTS_SHOT=<file.png> writes the picture, for the sample's image.

import std/[json, os, strutils, unittest]
import pixie
import ../interpreter
import ../scene_rhythm
import ../types
import ../ui/events
import ../ui/layout
import ../utils/font

const
  Root = normalizedPath(currentSourcePath().parentDir() / ".." / ".." / ".." / "..")
  Samples = Root / "repo" / "scenes" / "samples"
  Assets = Root / "frameos" / "assets" / "copied"
  Id = "fonts"

suite "the Fonts scene":
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

  proc frame(width, height: int, assets: string): FrameConfig =
    FrameConfig(name: "fonts", mode: "rpios", device: "framebuffer", width: width, height: height, rotate: 0,
      scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
      assetsPath: assets)

  proc draw(scene: FrameScene, config: FrameConfig): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    result = render(scene, context)
    rhythmClockOverride += 1.0

  proc send(scene: FrameScene, event: string, payload: JsonNode) =
    runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc load(config: FrameConfig): FrameScene =
    setSvgFontAssetsPath(config.assetsPath)
    setUploadedInterpretedScenes(parseInterpretedScenes($parseFile(Samples / "Fonts" / "scenes.json")))
    resetInterpretedScenes()
    logger.frameConfig = config
    init(Id.SceneId, config, logger, %*{})

  proc target(): UiTarget =
    for node in 0 .. 64:
      result = uiTarget(Id, node, create = false)
      if not result.isNil: return

  proc taps(): seq[(float32, float32)] =
    let ui = target()
    for r in ui.regions:
      if r.handlers[ueClick] > 0:
        result.add((r.x + r.w / 2 + ui.offsetX, r.y + r.h / 2 + ui.offsetY))

  test "lists the frame's fonts, each in its face, and a tap picks one for the specimen":
    problems = @[]
    let config = frame(800, 480, Assets)
    let scene = load(config)
    let first = scene.draw(config)
    # A row a font on the page, and the two page buttons.
    let rows = taps()
    check rows.len >= 8
    # The second row is the first font file, by name: pick it.
    scene.send("tap", %*{"x": rows[1][0], "y": rows[1][1], "pointerId": 0, "pointerType": "touch"})
    let picked = scene.state{"font"}.getStr()
    check picked.endsWith(".ttf")
    check fileExists(Assets / "fonts" / picked)
    let second = scene.draw(config)
    check first.data != second.data
    # The next page shows other fonts; the specimen stays.
    let next = taps()[^1]
    scene.send("tap", %*{"x": next[0], "y": next[1], "pointerId": 0, "pointerType": "touch"})
    check scene.state{"page"}.getInt() == 1
    let third = scene.draw(config)
    check third.data != second.data
    check scene.state{"font"}.getStr() == picked
    check problems.len == 0
    if problems.len > 0: echo problems
    let shot = getEnv("FRAMEOS_FONTS_SHOT")
    if shot.len > 0:
      scene.send("tap", %*{"x": taps()[0][0], "y": taps()[0][1], "pointerId": 0, "pointerType": "touch"})
      discard scene.draw(config)
      scene.send("tap", %*{"x": taps()[2][0], "y": taps()[2][1], "pointerId": 0, "pointerType": "touch"})
      scene.draw(config).writeFile(shot)

  test "a frame with no fonts shows the built-in face":
    problems = @[]
    let config = frame(480, 800, getTempDir() / "frameos-fonts-scene-none")
    let scene = load(config)
    discard scene.draw(config)
    # Narrow: the list, one row (the built-in face) and the page buttons.
    check taps().len == 3
    scene.send("tap", %*{"x": taps()[0][0], "y": taps()[0][1], "pointerId": 0, "pointerType": "touch"})
    check scene.state{"font"}.getStr() == ""
    check scene.state{"page"}.getInt() == -1 # the specimen, on a narrow screen
    discard scene.draw(config)
    check problems.len == 0
