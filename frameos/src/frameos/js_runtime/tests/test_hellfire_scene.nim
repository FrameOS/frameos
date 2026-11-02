## The Hellfire sample scene (repo/scenes/samples/Hellfire): the Doom fire
## simulated in JS and written into a canvas with `frameos.putPixels`. Run
## for real through the JS app runtime at a small size, this pins that the
## fire is a fire (hot at the bottom, out at the top), that a seed makes it
## the same on every frame type (what keeps its e2e snapshot stable), that
## the e2e fixture holds the sample's own app, and how long a frame takes.

import std/[json, monotimes, os, strutils, times, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values

const
  Repo = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".."
  SamplePath = Repo / "repo" / "scenes" / "samples" / "Hellfire" / "scenes.json"
  FixturePath = Repo / "e2e" / "scenes" / "jsxHellfire.json"

let
  sample = parseJson(readFile(SamplePath))[0]
  fixture = parseJson(readFile(FixturePath))
  app = sample["apps"]["hellfire"]
  appSource = app["sources"]["app.tsx"].getStr()

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

type Fire = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene
  width, height: int

proc newFire(id: string, width, height: int): Fire =
  let config = FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp")
  result.width = width
  result.height = height
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "fire", appKeyword: "hellfire", scene: result.scene,
    frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image", source = appSource,
    sourceName = "app.tsx", sources = app["sources"])

proc render(fire: Fire, config: JsonNode): Image =
  let context = ExecutionContext(scene: fire.scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: nil, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: false)
  fire.runtime.get(fire.owner, config, context).asImage()

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

suite "Hellfire":
  test "the e2e fixture is the sample's app, seeded":
    let fixtureApp = fixture["apps"]["hellfire"]
    check fixtureApp["sources"] == app["sources"]
    check fixtureApp["fields"] == app["fields"]
    check fixture["nodes"][1]["data"]["config"]["seed"].getStr() == "666"
    check fixture["e2eFrame"] == %*{"width": 480, "height": 480}
    check sample["settings"]["refreshInterval"].getFloat() < 1 # it animates

  test "hot at the bottom, out at the top, chunky pixels":
    # 32x128 cells: the flames climb ~70 rows, so the top is out.
    let fire = newFire("tests/hellfire-shape", 64, 256)
    let frame = fire.render(%*{"pixelSize": "2", "seed": "7", "wind": "1"})
    check frame.width == 64 and frame.height == 256
    var hotBottom, outTop = 0
    for x in 0 ..< 64:
      if hot(frame[x, 255]): inc hotBottom
      if dark(frame[x, 0]): inc outTop
    check hotBottom == 64
    check outTop == 64
    # A square: the four pixels of a bottom cell are one colour.
    check frame[0, 254] == frame[1, 255]
    check frame[40, 254] == frame[41, 255]
    # Not a glowing line: by the warm-up something burns 40 px up.
    var lit = 0
    for x in 0 ..< 64:
      if not dark(frame[x, 216]): inc lit
    check lit > 0

  test "the same seed is the same fire; another seed another; a render moves it":
    let a = newFire("tests/hellfire-a", 64, 64)
    let b = newFire("tests/hellfire-b", 64, 64)
    let c = newFire("tests/hellfire-c", 64, 64)
    let config = %*{"pixelSize": "2", "seed": "666", "wind": "1"}
    let first = a.render(config)
    check same(first, b.render(config))
    check not same(first, c.render(%*{"pixelSize": "2", "seed": "667", "wind": "1"}))
    let second = a.render(config)
    check not same(first, second)
    check same(second, b.render(config))

  test "a frame of a 120x120 fire":
    let fire = newFire("tests/hellfire-time", 480, 480)
    discard fire.render(%*{"pixelSize": "4", "seed": "1"})
    let start = getMonoTime()
    for i in 0 ..< 10:
      discard fire.render(%*{"pixelSize": "4", "seed": "1"})
    let perFrame = (getMonoTime() - start).inMicroseconds.float / 10_000
    checkpoint "a 480x480 frame at pixelSize 4: " & formatFloat(perFrame, ffDecimal, 2) & " ms (JS simulation + putPixels + <img>)"
    echo "hellfire 480x480 / pixelSize 4: ", formatFloat(perFrame, ffDecimal, 2), " ms a frame"
    check perFrame < 1000
