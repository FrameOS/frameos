## The Solitaire sample (repo/scenes/samples/Solitaire): its own tests
## (app.test.tsx: the cascade's simulation and the won game's screens) in its
## interpreter, and the cascade a won game ends in, drawn by the scene itself:
## on a fast panel the trails pile up in the app's canvas frame by frame at
## a sub-second interval that goes back to an hour when they stop; on e-paper
## one picture with the trails drawn, and no animation.
## FRAMEOS_SOLITAIRE_SHOTS=<dir> writes what it drew.

import std/[json, os, strutils, unittest]
import pixie
import frameos/interpreter
import frameos/scene_rhythm
import frameos/types
import frameos/js_runtime/app_tests

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

let sample = parseFile(Samples / "Solitaire" / "scenes.json")[0]

proc testConfig(device: string, width = 800, height = 480): FrameConfig =
  FrameConfig(name: "solitaire", mode: "rpios", device: device, width: width, height: height, rotate: 0,
    scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
    timeZone: "UTC", assetsPath: getTempDir())

var logger = Logger(frameConfig: nil, enabled: true)
var problems: seq[string]
logger.log = proc(payload: JsonNode) =
  if payload{"level"}.getStr() == "error" or payload{"event"}.getStr().contains("error"):
    problems.add($payload)
logger.enable = proc() = logger.enabled = true
logger.disable = proc() = logger.enabled = false

proc wonGame(moves = 120): JsonNode =
  var found = newJArray()
  for k in 0 ..< 4:
    var pile = newJArray()
    for r in 0 ..< 13:
      pile.add %(k * 13 + r)
    found.add pile
  %*{"stock": [], "waste": [], "found": found, "tab": [[], [], [], [], [], [], []],
    "down": [0, 0, 0, 0, 0, 0, 0], "draw": 1, "moves": moves}

suite "the Solitaire sample":
  test "its own tests pass in its interpreter":
    let sources = sample["apps"]["solitaire"]["sources"]
    check appTestFiles(sources) == @["app.test.tsx"]
    for testFile in appTestFiles(sources):
      let report = runJsAppTests(sources, testFile, testConfig("framebuffer"))
      if not report["ok"].getBool():
        checkpoint($report)
      check report["ok"].getBool()
      check report["counts"]["total"].getInt() >= 8

suite "the cascade of a won game":
  setup:
    problems = @[]
    rhythmClockOverride = 1000.0
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0

  var shot = 0
  proc draw(scene: FrameScene, config: FrameConfig, name: string): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    result = render(scene, context)
    inc shot
    let dir = getEnv("FRAMEOS_SOLITAIRE_SHOTS")
    if dir.len > 0:
      createDir(dir)
      result.writeFile(dir / ($shot & "-" & name & ".png"))
    rhythmClockOverride += 0.04

  proc load(config: FrameConfig): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[sample])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("solitaire".SceneId, config, logger, %*{"game": wonGame()})

  # Pixels the cards cover in the bottom half, where there is only the
  # table's green (the felt, #2f5a48, and the empty places' outlines) before
  # they fall there. Nothing on a card is green.
  proc cardPixelsBelow(image: Image): int =
    for y in image.height div 2 ..< image.height:
      for x in 0 ..< image.width:
        let c = image[x, y]
        if not (c.g.int - c.r.int > 20 and c.g > c.b):
          inc result

  proc same(a, b: Image): bool =
    if a.width != b.width or a.height != b.height:
      return false
    for y in 0 ..< a.height:
      for x in 0 ..< a.width:
        if a[x, y] != b[x, y]:
          return false
    true

  test "on a fast panel the trails pile up frame by frame, at a frame every 0.04 s":
    # The wide table (foundations down the right) and the classic one
    # (foundations along the top).
    for (width, height) in [(800, 480), (480, 480)]:
      let config = testConfig("framebuffer", width, height)
      let scene = load(config)
      let name = "fast-" & $width & "x" & $height
      check scene.refreshInterval == 3600.0
      discard draw(scene, config, name & "-start")
      check scene.refreshInterval == 0.04
      var last = 0
      var grew = 0
      for frame in 1 .. 60:
        let image = draw(scene, config, name)
        let now = cardPixelsBelow(image)
        check now >= last # copies are never wiped
        if now > last: inc grew
        last = now
      check grew >= 5
      check last > width * height div 20
      check scene.refreshInterval == 0.04
      # A tap stops the cards, and the frame goes back to an hour.
      runEvent(scene, ExecutionContext(scene: scene, event: "tap",
        payload: %*{"x": width div 2, "y": height - 40, "pointerId": 0, "pointerType": "touch"},
        loopIndex: 0, loopKey: ".", nextSleep: -1))
      let stopped = draw(scene, config, name & "-stopped")
      check scene.refreshInterval == 3600.0
      check cardPixelsBelow(stopped) >= last
      check problems.len == 0
      if problems.len > 0: echo problems

  test "on e-paper one picture with the trails drawn, and no animation":
    let config = testConfig("waveshare.EPD_7in5_V2")
    let scene = load(config)
    let first = draw(scene, config, "paper")
    check scene.refreshInterval == 3600.0
    # High contrast there: black outlines on white cards and a white table,
    # so count the black.
    var black = 0
    for y in first.height div 2 ..< first.height:
      for x in 0 ..< first.width:
        if first[x, y].r < 40: inc black
    check black > 5_000
    let again = draw(scene, config, "paper-again")
    check same(again, first)
    check problems.len == 0
    if problems.len > 0: echo problems
