## The Pixel toys sample scene (repo/scenes/samples/Pixel toys): effects
## computed cell by cell in JS and returned as `frameos.pixels`, one at a time
## or all at once as layers, with controls and swipes. Run for real through
## the JS app runtime (its modules imported from the app's sources), this pins
## that every effect draws and moves, that a seed makes it the same on every
## frame type, which cell size each picks, the grid, the controls and what a
## tap or a swipe does, and the scene's wiring.

import std/[json, monotimes, os, sequtils, strutils, times, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/utils/memory
import frameos/types
import frameos/values

const
  Repo = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".."
  SamplePath = Repo / "repo" / "scenes" / "samples" / "Pixel toys" / "scenes.json"
  Effects = ["fire", "bluefire", "greenfire", "fireworks", "fountain", "waterfall", "starfield", "matrix",
    "ripples", "blobs", "plasma", "life"]

let
  sample = parseJson(readFile(SamplePath))[0]
  app = sample["apps"]["pixelToys"]

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

proc lit(image: Image, x0 = 0, y0 = 0, x1 = -1, y1 = -1): int =
  for y in y0 ..< (if y1 < 0: image.height else: y1):
    for x in x0 ..< (if x1 < 0: image.width else: x1):
      let c = image[x, y]
      if c.r.int + c.g.int + c.b.int > 3 * 0x30: inc result

suite "Pixel toys":
  test "the effects the app offers are the effects the scene offers, all at once first":
    let options = app["fields"][0]["options"].mapIt(it.getStr())
    check options == @["all"] & @Effects
    check sample["fields"][0]["options"].mapIt(it["value"].getStr()) == options
    check sample["fields"][0]["value"].getStr() == "all"

  test "effect, quality, controls and the FPS counter are state fields wired into the app":
    var bound: seq[string]
    for edge in sample["edges"]:
      if edge["type"].getStr() == "codeNodeEdge" and edge["target"].getStr() == "toys":
        bound.add edge["source"].getStr() & " -> " & edge["targetHandle"].getStr()
    check bound == @["effect -> fieldInput/effect", "quality -> fieldInput/pixelSize",
      "controls -> fieldInput/showControls", "showFps -> fieldInput/showFps"]
    for field in sample["fields"]:
      check field["access"].getStr() == "public" and field["persist"].getStr() == "disk"
    check sample["settings"]["refreshInterval"].getFloat() < 1 # it animates
    let events = parseJson(app["sources"]["config.json"].getStr())["events"]
    check events == %*["tap", "swipe"]

  test "every effect draws, and moves":
    for effect in @["all"] & @Effects:
      let toys = newToys("tests/toys-draws-" & effect, 240, 160)
      let config = %*{"effect": effect, "pixelSize": "4", "seed": "11"}
      var frames: seq[Image]
      for i in 0 ..< 30:
        frames.add toys.render(config)
      checkpoint effect & ": lit " & $lit(frames[^1])
      check frames[^1].width == 240 and frames[^1].height == 160
      check lit(frames[^1]) > 200
      check not same(frames[^1], frames[^2])

  test "the same seed is the same show; another seed another":
    for effect in @["all"] & @Effects:
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

  test "all at once is a grid of tiles, each an effect, with the background between them":
    let toys = newToys("tests/toys-grid", 480, 480)
    var frame: Image
    for i in 0 ..< 20:
      frame = toys.render(%*{"effect": "all", "pixelSize": "4", "seed": "5"})
    # 3x3 slots of 154 px with 4 px gaps, each a 152 px tile in its middle:
    # something lit in every tile, nothing between them.
    for row in 0 ..< 3:
      for col in 0 ..< 3:
        let x0 = 5 + col * 158
        let y0 = 5 + row * 158
        checkpoint "tile " & $col & "," & $row
        check lit(frame, x0, y0, x0 + 152, y0 + 152) > 100
    check lit(frame, 157, 0, 163, 480) == 0
    check lit(frame, 0, 157, 480, 163) == 0

  test "the automatic cell size is the effect's, coarser on an ESP32":
    let config = %*{"effect": "blobs", "pixelSize": "0", "seed": "3"}
    let host = newToys("tests/toys-auto-host", 64, 64).render(config)
    check same(host, newToys("tests/toys-four", 64, 64).render(%*{"effect": "blobs", "pixelSize": "4", "seed": "3"}))
    setSimulatedEmbedded(true)
    defer: setSimulatedEmbedded(false)
    let device = newToys("tests/toys-auto-device", 64, 64).render(config)
    check same(device, newToys("tests/toys-eight", 64, 64).render(%*{"effect": "blobs", "pixelSize": "8", "seed": "3"}))

  test "the controls are a bar along the bottom, and the effect stands above it":
    let toys = newToys("tests/toys-controls", 480, 480)
    let frame = toys.render(%*{"effect": "plasma", "pixelSize": "4", "seed": "5", "showControls": "true"})
    check frame[2, 478] == rgbx(0x0b, 0x0e, 0x13, 255) # the bar's ground
    check lit(frame, 0, 453, 480, 480) > 200 # its buttons and their text
    check lit(frame, 0, 0, 480, 400) > 10000 # the plasma above it

  test "a swipe and the buttons change the scene's state; a tile opens its effect":
    let toys = newToys("tests/toys-events", 480, 480)
    var config = %*{"effect": "fire", "pixelSize": "4", "seed": "5", "showControls": "true"}
    discard toys.render(config)
    toys.event(config, "swipe", %*{"direction": "left", "x": 240, "y": 240})
    check toys.scene.state{"effect"}.getStr() == "bluefire"
    toys.event(config, "swipe", %*{"direction": "right", "x": 240, "y": 240})
    check toys.scene.state{"effect"}.getStr() == "all"
    # The bar: "<" at its left end; "+" after the size, then FPS and ALL.
    toys.event(config, "tap", %*{"x": 10, "y": 465})
    check toys.scene.state{"effect"}.getStr() == "all"
    toys.event(config, "tap", %*{"x": 460, "y": 465})
    check toys.scene.state{"effect"}.getStr() == "all" # ALL from a single effect
    # All at once: a tap on the middle tile opens it.
    config = %*{"effect": "all", "pixelSize": "4", "seed": "5"}
    discard toys.render(config)
    toys.event(config, "tap", %*{"x": 240, "y": 240})
    check toys.scene.state{"effect"}.getStr() == "blobs"

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
    for effect in @["all"] & @Effects:
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
