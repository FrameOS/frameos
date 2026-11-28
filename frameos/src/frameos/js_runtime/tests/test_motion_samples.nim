## The samples made for a frame with an accelerometer (docs/accelerometer.md):
## Sand, Spirit level, Oracle ball, Marble maze and 2048's tilt. Each is run
## for real through the JS app runtime (its modules imported from the app's
## sources), on the round AMOLED's 466x466 and the reTerminal Sticky's
## 480x800 (e-paper: not fast), with an accelerometer stubbed in
## (`accelerometerReader`) and without one, as the browser preview has it.

import std/[json, os, strutils, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values

const
  Repo = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".."
  Samples = Repo / "repo" / "scenes" / "samples"
  Amoled = "amoled.co5300_466x466"
  Sticky = "waveshare.EPD_3in97"

var gravity = (x: 0.0, y: 1.0, z: 0.0)
var hasAccelerometer = false

proc stubAccelerometer(x, y, z: var float): bool {.nimcall, gcsafe.} =
  {.cast(gcsafe).}:
    if not hasAccelerometer:
      return false
    x = gravity.x
    y = gravity.y
    z = gravity.z
    true

accelerometerReader = stubAccelerometer

proc tilted(x, y, z: float) =
  hasAccelerometer = true
  gravity = (x: x, y: y, z: z)

proc noAccelerometer() =
  hasAccelerometer = false

proc sample(name: string): JsonNode = parseJson(readFile(Samples / name / "scenes.json"))[0]

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    if "rror" in $payload or payload{"event"}.getStr() in ["log", "error"]:
      echo "  ", ($payload)[0 ..< min(600, ($payload).len)]
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

type Run = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene
  config: JsonNode
  canvas: Image

proc newRun(scene: JsonNode, id: string, width, height: int, device = "", state = %*{}): Run =
  let keyword = scene["nodes"][1]["data"]["keyword"].getStr()
  let app = scene["apps"][keyword]
  let config = FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp", device: device)
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: state, logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "app", appKeyword: keyword, scene: result.scene,
    frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image",
    source = app["sources"]["app.tsx"].getStr(), sourceName = "app.tsx", sources = app["sources"])
  result.canvas = newImage(width, height)
  result.config = %*{}
  for field in app["fields"]:
    result.config[field["name"].getStr()] = field["value"]

proc render(run: Run, nextSleep: var float): Image =
  ## Into a canvas of the frame's size, as a scene's render/image hands it
  ## over, one canvas kept from render to render as a frame keeps its panel
  ## (frameos.pixels writes only the cells that changed): `context.round` is
  ## true on a round panel then.
  let canvas = run.canvas
  let context = ExecutionContext(scene: run.scene, event: "render", payload: %*{},
    hasImage: true, image: canvas, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: nil, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: false)
  result = run.runtime.get(run.owner, run.config, context).asImage()
  nextSleep = context.nextSleep

proc render(run: Run): Image =
  var ignored: float
  run.render(ignored)

proc event(run: Run, name: string, payload: JsonNode = %*{}): bool =
  let context = ExecutionContext(scene: run.scene, event: name, payload: payload,
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
  run.runtime.run(run.owner, run.config, context, isEvent = true)

proc shot(image: Image, name: string) =
  ## FRAMEOS_MOTION_SHOTS=<dir>: the pictures the tests look at, as PNGs.
  let dir = getEnv("FRAMEOS_MOTION_SHOTS")
  if dir.len > 0:
    createDir(dir)
    image.writeFile(dir / name & ".png")

proc ink(c: ColorRGBX, back: ColorRGBX): bool =
  abs(c.r.int - back.r.int) + abs(c.g.int - back.g.int) + abs(c.b.int - back.b.int) > 60

proc centroid(image: Image): tuple[x, y: float, count: int] =
  ## Where the cells that are not the background color are, on average.
  let back = image[image.width div 2, 2]
  var sx, sy = 0.0
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      if ink(image[x, y], back):
        sx += x.float
        sy += y.float
        inc result.count
  if result.count > 0:
    result.x = sx / result.count.float
    result.y = sy / result.count.float

suite "Sand":
  let scene = sample("Sand")

  test "the scene says what it needs and listens for the motion events":
    check scene["settings"]["needs"] == %*["touch", "accelerometer"]
    let events = parseJson(scene["apps"]["sand"]["sources"]["config.json"].getStr())["events"]
    for name in ["tilt", "shake", "orientation", "swipe"]:
      check %name in events.elems

  test "on the round AMOLED the sand runs the way the frame leans":
    tilted(0.0, 1.0, 0.0)
    let run = newRun(scene, "tests/sand-round", 466, 466, device = Amoled)
    var first = run.render()
    for i in 0 ..< 5: first = run.render()
    let before = centroid(first)
    check before.count > 1000
    check before.y > 233 # it starts at the bottom
    tilted(-0.9, 0.1, -0.3) # the left side down
    var image: Image
    for i in 0 ..< 300: image = run.render()
    let after = centroid(image)
    first.shot("sand-round-before")
    image.shot("sand-round-left")
    check after.x < before.x - 40
    check abs(after.count - before.count) < before.count div 20 # no sand made or lost

  test "lying flat, nothing moves":
    tilted(0.0, 1.0, 0.0)
    let run = newRun(scene, "tests/sand-flat", 466, 466)
    var image: Image
    for i in 0 ..< 60: image = run.render()
    tilted(0.02, 0.03, -1.0)
    let a = run.render()
    for i in 0 ..< 20: image = run.render()
    check centroid(a) == centroid(image)

  test "on the Sticky (e-paper) a render runs a second of sand and the frame sleeps once it settles":
    tilted(0.0, 1.0, 0.0)
    let run = newRun(scene, "tests/sand-sticky", 480, 800, device = Sticky)
    var sleep = 0.0
    var image = run.render(sleep)
    var renders = 1
    while sleep < 1 and renders < 40:
      image = run.render(sleep)
      inc renders
    check sleep >= 1 # settled: it waits for a tip
    let before = centroid(image)
    tilted(0.0, -1.0, 0.0) # upside down
    check run.event("tilt", %*{"direction": "up", "x": 0.0, "y": -0.8})
    for i in 0 ..< 12: image = run.render(sleep)
    check centroid(image).y < before.y - 150

  test "without an accelerometer a swipe tips the box":
    noAccelerometer()
    let run = newRun(scene, "tests/sand-swipe", 466, 466)
    var image: Image
    for i in 0 ..< 60: image = run.render()
    let before = centroid(image)
    check run.event("swipe", %*{"direction": "right", "x": 300, "y": 200, "startX": 100, "startY": 200,
      "pointerId": 0, "pointerType": "touch"})
    for i in 0 ..< 300: image = run.render()
    check centroid(image).x > before.x + 40

  test "a shake throws the sand up":
    tilted(0.0, 1.0, 0.0)
    let run = newRun(scene, "tests/sand-shake", 466, 466)
    var image: Image
    for i in 0 ..< 60: image = run.render()
    let before = centroid(image)
    check run.event("shake", %*{"strength": 2.1})
    image = run.render()
    check centroid(image).y < before.y - 40

proc near(c: ColorRGBX, hex: string, slack = 40): bool =
  let want = parseHtmlColor(hex).rgbx
  abs(c.r.int - want.r.int) + abs(c.g.int - want.g.int) + abs(c.b.int - want.b.int) <= slack

proc centroidOf(image: Image, hex: string): tuple[x, y: float, count: int] =
  ## Where the pixels of one color are, on average.
  var sx, sy = 0.0
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      if near(image[x, y], hex):
        sx += x.float
        sy += y.float
        inc result.count
  if result.count > 0:
    result.x = sx / result.count.float
    result.y = sy / result.count.float

proc same(a, b: Image): bool =
  if a.width != b.width or a.height != b.height:
    return false
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      if a[x, y] != b[x, y]:
        return false
  true

const Bubble = "#f6ffd8"

suite "Spirit level":
  let scene = sample("Spirit level")

  test "lying flat, the bubble goes to the high side":
    tilted(0.12, 0.0, -0.99) # the right side low
    let run = newRun(scene, "tests/level-flat", 466, 466, device = Amoled)
    let image = run.render()
    image.shot("level-flat")
    let bubble = image.centroidOf(Bubble)
    check bubble.count > 200
    check bubble.x < 203.0
    check abs(bubble.y - (233.0 - 466.0 * 0.04)) < 12.0

  test "standing up, a tube along the level side, the bubble at its high end":
    tilted(-0.06, 0.99, 0.1) # held upright, the left side a little low
    let run = newRun(scene, "tests/level-tube", 466, 466, device = Amoled)
    let image = run.render()
    image.shot("level-tube")
    let bubble = image.centroidOf(Bubble)
    check bubble.count > 200
    check bubble.x > 263.0

  test "a tap zeroes it where it rests":
    tilted(0.09, 0.0, -0.99)
    let run = newRun(scene, "tests/level-zero", 466, 466, device = Amoled)
    discard run.render()
    check run.event("tap", %*{"x": 233, "y": 233, "pointerId": 0, "pointerType": "touch"})
    check run.scene.state{"zero"}.kind == JObject
    let bubble = run.render().centroidOf(Bubble)
    check abs(bubble.x - 233.0) < 6.0

  test "on e-paper a reading that wobbles under a degree draws the same picture":
    tilted(0.0, 0.995, 0.1)
    let run = newRun(scene, "tests/level-paper", 480, 800, device = Sticky)
    let a = run.render()
    a.shot("level-sticky")
    tilted(0.003, 0.995, 0.1)
    check same(a, run.render())
    tilted(0.06, 0.995, 0.1)
    check not same(a, run.render())

  test "without an accelerometer it shows a demo and says so":
    noAccelerometer()
    let run = newRun(scene, "tests/level-demo", 480, 800, device = Sticky)
    var sleep = 0.0
    let image = run.render(sleep)
    image.shot("level-demo")
    check sleep >= 3600 # e-paper: the demo stays still
    check run.event("tap", %*{"x": 10, "y": 10, "pointerId": 0, "pointerType": "touch"}) == false

suite "Oracle ball":
  let scene = sample("Oracle ball")

  test "a shake asks, and never the same answer twice running":
    tilted(0.0, 1.0, 0.0)
    let run = newRun(scene, "tests/oracle-shake", 466, 466, device = Amoled)
    let idle = run.render()
    idle.shot("oracle-idle")
    var last = -1
    for i in 0 ..< 12:
      check run.event("shake", %*{"strength": 1.8})
      let answer = run.scene.state{"answer"}.getInt(-1)
      check answer >= 0 and answer != last
      last = answer
    let shown = run.render()
    check not shown.isNil
    if not shown.isNil:
      shown.shot("oracle-answer")
      check not same(idle, shown)

  test "face down and back up asks again":
    tilted(0.0, 1.0, 0.0)
    let run = newRun(scene, "tests/oracle-flip", 480, 800, device = Sticky)
    discard run.render()
    check run.event("orientation", %*{"position": "faceDown"}) == false
    check run.event("orientation", %*{"position": "faceUp"})
    check run.scene.state{"answer"}.kind == JInt
    run.render().shot("oracle-sticky")
    check run.event("orientation", %*{"position": "upright"}) == false # not after a face down

  test "without an accelerometer a tap asks":
    noAccelerometer()
    let run = newRun(scene, "tests/oracle-tap", 800, 480)
    discard run.render()
    check run.event("tap", %*{"x": 400, "y": 240, "pointerId": 0, "pointerType": "mouse"})
    check run.scene.state{"answer"}.kind == JInt

proc mazeGame(run: Run): JsonNode = run.scene.state{"game"}

suite "Marble maze":
  let scene = sample("Marble maze")

  test "on e-paper every maze is solved a corridor at a time, by tilts":
    tilted(0.0, 0.0, -1.0)
    for seed in [7, 1234, 99991]:
      let run = newRun(scene, "tests/maze-paper-" & $seed, 480, 800, device = Sticky,
        state = %*{"game": {"seed": seed, "x": 0, "y": 0, "moves": 0, "solved": false, "level": 1}})
      let first = run.render()
      if seed == 7: first.shot("maze-sticky")
      # Every cell a run of tilts reaches from the start, until the hole.
      var seen = @[(0, 0)]
      var queue = @[(0, 0)]
      var solved = false
      while queue.len > 0 and not solved:
        let (x, y) = queue[0]
        queue.delete(0)
        for dir in ["up", "right", "down", "left"]:
          run.scene.state["game"] = %*{"seed": seed, "x": x, "y": y, "moves": 0, "solved": false, "level": 1}
          discard run.event("tilt", %*{"direction": dir, "x": 0.0, "y": 0.0})
          let game = run.mazeGame()
          if game{"solved"}.getBool():
            solved = true
            break
          let at = (game{"x"}.getInt(), game{"y"}.getInt())
          if at notin seen:
            seen.add at
            queue.add at
      check solved
      check seen.len > 4

  test "on a fast screen the marble rolls the way the frame leans":
    tilted(0.0, 0.0, -1.0)
    let run = newRun(scene, "tests/maze-roll", 466, 466, device = Amoled,
      state = %*{"game": {"seed": 42, "x": 0, "y": 0, "moves": 0, "solved": false, "level": 1}})
    let still = run.render()
    still.shot("maze-round")
    check same(still, run.render()) # flat: it stays
    tilted(0.6, 0.6, -0.5)
    var image: Image
    for i in 0 ..< 40: image = run.render()
    check not same(still, image)
    # A tilt says nothing new to a rolling marble: it is the accelerometer's.
    check run.event("tilt", %*{"direction": "right", "x": 0.6, "y": 0.0}) == false

  test "without an accelerometer swipes and arrow keys move it, and a tap after the hole deals the next maze":
    noAccelerometer()
    let run = newRun(scene, "tests/maze-keys", 800, 480,
      state = %*{"game": {"seed": 5, "x": 0, "y": 0, "moves": 0, "solved": false, "level": 1}})
    discard run.render()
    var moved = false
    for key in ["ArrowRight", "ArrowDown"]:
      if run.event("keyDown", %*{"code": key, "key": key, "repeat": false, "shift": false, "ctrl": false,
          "alt": false, "meta": false}):
        moved = true
    check moved
    check run.mazeGame(){"moves"}.getInt() >= 1
    run.scene.state["game"]["solved"] = %true
    check run.event("tap", %*{"x": 10, "y": 10, "pointerId": 0, "pointerType": "mouse"})
    check run.mazeGame(){"level"}.getInt() == 2
    check run.mazeGame(){"solved"}.getBool() == false

suite "2048 tilts":
  let scene = sample("2048")

  test "a tilt and a flick slide the tiles that way":
    tilted(0.0, 0.0, -1.0)
    let board = %*{"size": 4, "cells": [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4], "score": 0, "best": 0,
      "seed": 3, "undo": nil, "won": false, "keepPlaying": false, "moves": 0}
    let run = newRun(scene, "tests/2048-tilt", 480, 800, device = Sticky, state = %*{"game": board, "size": "4"})
    discard run.render()
    check run.event("tilt", %*{"direction": "right", "x": 0.5, "y": 0.0})
    check run.scene.state["game"]["cells"][3].getInt() == 2
    check run.event("flick", %*{"direction": "up", "x": 0.0, "y": -0.5})
    check run.scene.state["game"]["cells"][3].getInt() == 4 or run.scene.state["game"]["cells"][3].getInt() == 2
    check run.scene.state["game"]["cells"][15].getInt() == 0 or run.scene.state["game"]["moves"].getInt() == 2
    check run.scene.state["game"]["moves"].getInt() == 2
    check run.event("tilt", %*{"direction": "sideways"}) == false

# FRAMEOS_MOTION_COVERS=<dir>: the pictures the samples' covers are made of
# (image.jpg, put together by hand from them), on the AMOLED and the Sticky.
let coversDir = getEnv("FRAMEOS_MOTION_COVERS")
if coversDir.len > 0:
  createDir(coversDir)
  proc cover(image: Image, name: string) = image.writeFile(coversDir / name & ".png")

  block:
    tilted(0.0, 1.0, 0.0)
    let round = newRun(sample("Sand"), "covers/sand-round", 466, 466, device = Amoled)
    for i in 0 ..< 40: discard round.render()
    tilted(-0.7, 0.7, -0.2)
    var image: Image
    for i in 0 ..< 300: image = round.render()
    image.cover("sand-round")
    tilted(0.0, 1.0, 0.0)
    let sticky = newRun(sample("Sand"), "covers/sand-sticky", 480, 800, device = Sticky)
    for i in 0 ..< 3: discard sticky.render()
    tilted(0.6, 0.8, 0.0)
    for i in 0 ..< 3: image = sticky.render()
    image.cover("sand-sticky")
  block:
    tilted(-0.08, 0.05, -0.99)
    newRun(sample("Spirit level"), "covers/level-round", 466, 466, device = Amoled).render().cover("level-round")
    tilted(0.04, 0.999, 0.05)
    newRun(sample("Spirit level"), "covers/level-sticky", 480, 800, device = Sticky).render().cover("level-sticky")
  block:
    let round = newRun(sample("Oracle ball"), "covers/oracle-round", 466, 466, device = Amoled)
    discard round.render()
    round.scene.state["answer"] = %1
    sleep(1100)
    round.render().cover("oracle-round")
    let sticky = newRun(sample("Oracle ball"), "covers/oracle-sticky", 480, 800, device = Sticky)
    sticky.scene.state["answer"] = %13
    sticky.render().cover("oracle-sticky")
  block:
    tilted(0.0, 0.0, -1.0)
    let round = newRun(sample("Marble maze"), "covers/maze-round", 466, 466, device = Amoled,
      state = %*{"game": {"seed": 42, "x": 0, "y": 0, "moves": 0, "solved": false, "level": 1}})
    discard round.render()
    tilted(0.5, 0.5, -0.7)
    var image: Image
    for i in 0 ..< 25:
      image = round.render()
      sleep(15)
    image.cover("maze-round")
    let sticky = newRun(sample("Marble maze"), "covers/maze-sticky", 480, 800, device = Sticky,
      state = %*{"game": {"seed": 7, "x": 0, "y": 0, "moves": 0, "solved": false, "level": 1}})
    discard sticky.render()
    for dir in ["right", "down", "left", "down", "right"]:
      discard sticky.event("tilt", %*{"direction": dir, "x": 0.0, "y": 0.0})
    sticky.render().cover("maze-sticky")
