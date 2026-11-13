## The Pixel toys sample scene (repo/scenes/samples/Pixel toys): six effects
## computed cell by cell in JS and returned as `frameos.pixels`. Run for real
## through the JS app runtime (its modules imported from the app's sources),
## this pins that every effect draws and moves, that a seed makes it the same
## on every frame type, which cell size each picks, and the scene's wiring.

import std/[json, monotimes, os, sequtils, strutils, times, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/utils/memory
import frameos/types
import frameos/values

const
  Repo = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".."
  SamplePath = Repo / "repo" / "scenes" / "samples" / "Pixel toys" / "scenes.json"
  Effects = ["fireworks", "fountain", "starfield", "blobs", "plasma", "life"]

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

proc same(a, b: Image): bool =
  if a.width != b.width or a.height != b.height:
    return false
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      if a[x, y] != b[x, y]:
        return false
  true

proc lit(image: Image): int =
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      let c = image[x, y]
      if c.r.int + c.g.int + c.b.int > 3 * 0x30: inc result

suite "Pixel toys":
  test "the effects in the app's options are the effects the scene offers":
    let options = app["fields"][0]["options"].mapIt(it.getStr())
    check options == @Effects
    check sample["fields"][0]["options"].mapIt(it["value"].getStr()) == @Effects
    for effect in Effects:
      check app["sources"].hasKey(effect & ".ts")

  test "effect, quality and the FPS counter are state fields wired into the app":
    var bound: seq[string]
    for edge in sample["edges"]:
      if edge["type"].getStr() == "codeNodeEdge" and edge["target"].getStr() == "toys":
        bound.add edge["source"].getStr() & " -> " & edge["targetHandle"].getStr()
    check bound == @["effect -> fieldInput/effect", "quality -> fieldInput/pixelSize", "showFps -> fieldInput/showFps"]
    for field in sample["fields"]:
      check field["access"].getStr() == "public" and field["persist"].getStr() == "disk"
    check sample["settings"]["refreshInterval"].getFloat() < 1 # it animates

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

  test "switching the effect starts it, and the counter leaves it as it found it":
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
    let switched = plain.render(%*{"effect": "plasma", "pixelSize": "2", "seed": "8"})
    check lit(switched) > 1000

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
