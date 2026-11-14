## The Pixel toys sample scene (repo/scenes/samples/Pixel toys): effects
## computed cell by cell in JS and returned as 8-bit palette frames
## (`frameos.pixels`), one at a time, a swipe for the next. Run for real
## through the JS app runtime (its modules imported from the app's sources),
## this pins that every effect draws and moves, that a seed makes it the same
## on every frame type, which cell size each picks, what a swipe does, and the
## scene's wiring.

import std/[json, monotimes, os, sequtils, strutils, times, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/utils/memory
import frameos/types
import frameos/values

const
  Repo = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".."
  SamplePath = Repo / "repo" / "scenes" / "samples" / "Pixel toys" / "scenes.json"
  FixturePath = Repo / "e2e" / "scenes" / "pixelToys.json"
  Effects = ["fire", "bluefire", "greenfire", "fireworks", "fountain", "waterfall", "starfield", "matrix",
    "ripples", "blobs", "plasma", "life"]

let
  sample = parseJson(readFile(SamplePath))[0]
  app = sample["apps"]["pixelToys"]
  fixture = parseJson(readFile(FixturePath))

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

type Toys = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene

proc newToys(id: string, width, height: int): Toys =
  let config = FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp")
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "toys", appKeyword: "pixelToys", scene: result.scene,
    frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image",
    source = app["sources"]["app.tsx"].getStr(), sourceName = "app.tsx", sources = app["sources"])

proc render(toys: Toys, config: JsonNode): Image =
  let context = ExecutionContext(scene: toys.scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: nil, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: false)
  toys.runtime.get(toys.owner, config, context).asImage()

proc event(toys: Toys, config: JsonNode, name: string, payload: JsonNode) =
  let context = ExecutionContext(scene: toys.scene, event: name, payload: payload,
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
  discard toys.runtime.run(toys.owner, config, context, isEvent = true)

proc same(a, b: Image): bool =
  if a.width != b.width or a.height != b.height:
    return false
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      if a[x, y] != b[x, y]:
        return false
  true

proc hot(c: ColorRGBX): bool = c.r.int + c.g.int + c.b.int > 3 * 0xb0
proc dark(c: ColorRGBX): bool = c.r.int + c.g.int + c.b.int < 3 * 0x10

proc lit(image: Image, x0 = 0, y0 = 0, x1 = -1, y1 = -1): int =
  for y in y0 ..< (if y1 < 0: image.height else: y1):
    for x in x0 ..< (if x1 < 0: image.width else: x1):
      let c = image[x, y]
      if c.r.int + c.g.int + c.b.int > 3 * 0x30: inc result

suite "Pixel toys":
  test "the effects the app offers are the effects the scene offers":
    let options = app["fields"][0]["options"].mapIt(it.getStr())
    check options == @Effects
    check sample["fields"][0]["options"].mapIt(it["value"].getStr()) == options
    check sample["fields"][0]["value"].getStr() == "fire"

  test "effect, quality and the FPS counter are state fields wired into the app":
    var bound: seq[string]
    for edge in sample["edges"]:
      if edge["type"].getStr() == "codeNodeEdge" and edge["target"].getStr() == "toys":
        bound.add edge["source"].getStr() & " -> " & edge["targetHandle"].getStr()
    check bound == @["effect -> fieldInput/effect", "quality -> fieldInput/pixelSize",
      "showFps -> fieldInput/showFps"]
    for field in sample["fields"]:
      check field["access"].getStr() == "public" and field["persist"].getStr() == "disk"
    check sample["settings"]["refreshInterval"].getFloat() < 1 # it animates
    let events = parseJson(app["sources"]["config.json"].getStr())["events"]
    check events == %*["tap", "swipe", "back", "forward"]

  test "the e2e fixture is the sample, its Hellfire seeded":
    check fixture["apps"]["pixelToys"]["sources"] == app["sources"]
    check fixture["fields"] == sample["fields"]
    check fixture["fields"][0]["value"].getStr() == "fire"
    check fixture["nodes"].filterIt(it["id"].getStr() == "toys")[0]["data"]["config"]["seed"].getStr() == "666"
    check fixture["e2eFrame"] == %*{"width": 480, "height": 480}

  test "Hellfire: hot at the bottom, out at the top, chunky pixels":
    let frame = newToys("tests/toys-fire-shape", 64, 256).render(%*{"effect": "fire", "pixelSize": "2", "seed": "7"})
    var hotBottom, outTop = 0
    for x in 0 ..< 64:
      if hot(frame[x, 255]): inc hotBottom
      if dark(frame[x, 0]): inc outTop
    check hotBottom == 64
    check outTop == 64
    check frame[0, 254] == frame[1, 255] # a cell is a square of one color
    var burning = 0
    for x in 0 ..< 64:
      if not dark(frame[x, 216]): inc burning
    check burning > 0 # not a glowing line: something burns 40 px up

  test "Hellfire stands under half the panel at every cell size":
    # Doom's cooling burns ~72 rows up: a 60-row grid (8 px on a 480 px
    # panel, the ESP32's) was a wall of fire. The cooling follows the grid.
    for size in ["8", "4", "2"]:
      let toys = newToys("tests/toys-fire-height-" & size, 480, 480)
      var frame: Image
      for i in 0 ..< 4:
        frame = toys.render(%*{"effect": "fire", "pixelSize": size, "seed": "9"})
      var litTop, litLow = 0
      for x in 0 ..< 480:
        for y in 0 ..< 120:
          if not dark(frame[x, y]): inc litTop
        if not dark(frame[x, 330]): inc litLow
      checkpoint "pixelSize " & size & ": lit in the top quarter " & $litTop & ", at 30% up " & $litLow
      check litTop == 0
      check litLow > 100

  test "every effect draws, and moves":
    for effect in Effects:
      let toys = newToys("tests/toys-draws-" & effect, 240, 160)
      let config = %*{"effect": effect, "pixelSize": "4", "seed": "11"}
      var frames: seq[Image]
      for i in 0 ..< 30:
        frames.add toys.render(config)
      checkpoint effect & ": lit " & $lit(frames[^1])
      check frames[^1].width == 240 and frames[^1].height == 160
      check lit(frames[^1]) > 200
      check not same(frames[^1], frames[^2])

  test "ripples keep calm water at the edges however long they run":
    # The frameos.ops path once wrote the shown heights into the array the
    # neighbours' sum is kept in, whose edges convolve never touches: the
    # edges grew every frame and filled the pond with bright squares.
    let toys = newToys("tests/toys-ripples-edges", 240, 240)
    var frame: Image
    for i in 0 ..< 300:
      frame = toys.render(%*{"effect": "ripples", "pixelSize": "4", "seed": "4"})
    let calm = frame[0, 0]
    var edge = 0
    for i in 0 ..< 240:
      for (x, y) in [(i, 0), (i, 239), (0, i), (239, i)]:
        if frame[x, y] != calm: inc edge
    check edge == 0
    var white = 0
    for y in 0 ..< 240:
      for x in 0 ..< 240:
        let c = frame[x, y]
        if c.r > 0xe0 and c.g > 0xe0 and c.b > 0xe0: inc white
    checkpoint $white & " white pixels"
    check white < 240 * 240 div 20

  test "the same seed is the same show; another seed another":
    for effect in Effects:
      let
        a = newToys("tests/toys-a-" & effect, 160, 120)
        b = newToys("tests/toys-b-" & effect, 160, 120)
        c = newToys("tests/toys-c-" & effect, 160, 120)
      var x, y, z: Image
      for i in 0 ..< 12:
        x = a.render(%*{"effect": effect, "pixelSize": "4", "seed": "21"})
        y = b.render(%*{"effect": effect, "pixelSize": "4", "seed": "21"})
        z = c.render(%*{"effect": effect, "pixelSize": "4", "seed": "22"})
      checkpoint effect
      check same(x, y)
      check not same(x, z)

  test "the automatic cell size is the effect's, coarser on an ESP32":
    let config = %*{"effect": "blobs", "pixelSize": "0", "seed": "3"}
    let host = newToys("tests/toys-auto-host", 64, 64).render(config)
    check same(host, newToys("tests/toys-four", 64, 64).render(%*{"effect": "blobs", "pixelSize": "4", "seed": "3"}))
    setSimulatedEmbedded(true)
    defer: setSimulatedEmbedded(false)
    let device = newToys("tests/toys-auto-device", 64, 64).render(config)
    check same(device, newToys("tests/toys-eight", 64, 64).render(%*{"effect": "blobs", "pixelSize": "8", "seed": "3"}))

  test "a swipe is the next or previous effect, round the end; a tap drops a stone on the ripples":
    let toys = newToys("tests/toys-events", 240, 240)
    var config = %*{"effect": "fire", "pixelSize": "4", "seed": "5"}
    discard toys.render(config)
    toys.event(config, "swipe", %*{"direction": "left", "x": 120, "y": 120})
    check toys.scene.state{"effect"}.getStr() == "bluefire"
    toys.event(config, "swipe", %*{"direction": "right", "x": 120, "y": 120})
    check toys.scene.state{"effect"}.getStr() == "life"
    # In from an edge: a touch frame's event map makes it forward or back.
    toys.event(config, "forward", %*{})
    check toys.scene.state{"effect"}.getStr() == "bluefire"
    toys.event(config, "back", %*{})
    check toys.scene.state{"effect"}.getStr() == "life"
    config = %*{"effect": "ripples", "pixelSize": "4", "seed": "5"}
    var before: Image
    for i in 0 ..< 40:
      before = toys.render(config) # the water settles
    toys.event(config, "tap", %*{"x": 120, "y": 120})
    let after = toys.render(config)
    check lit(after, 100, 100, 140, 140) != lit(before, 100, 100, 140, 140)

  test "the counter leaves the effect as it found it":
    let
      plain = newToys("tests/toys-plain", 160, 160)
      counted = newToys("tests/toys-counted", 160, 160)
      base = %*{"effect": "fireworks", "pixelSize": "2", "seed": "8"}
      asked = %*{"effect": "fireworks", "pixelSize": "2", "seed": "8", "showFps": "true"}
    for i in 0 .. 4:
      let
        a = plain.render(base)
        b = counted.render(asked)
      for y in 40 ..< 160:
        for x in 0 ..< 160:
          check a[x, y] == b[x, y]

  test "a 480x480 frame of each":
    for effect in Effects:
      let toys = newToys("tests/toys-time-" & effect, 480, 480)
      let config = %*{"effect": effect, "pixelSize": "4", "seed": "1"}
      for i in 0 ..< 3:
        discard toys.render(config)
      let start = getMonoTime()
      for i in 0 ..< 10:
        discard toys.render(config)
      let perFrame = (getMonoTime() - start).inMicroseconds.float / 10_000
      echo "pixel toys ", effect, " 480x480 / pixelSize 4: ", formatFloat(perFrame, ffDecimal, 2), " ms a frame"
      check perFrame < 1000
