## The Color cycling sample scene (repo/scenes/samples/Color cycling):
## pixel-art scenes drawn once as 8-bit palette frames (`frameos.pixels`) and
## animated only by rotating ranges of their palettes. Run for real through
## the JS app runtime, this pins that every scene draws a picture and moves,
## that its cells stay put while its colors move (what lets a panel rewrite
## only the cells whose color changed), that a seed is the same picture on
## every frame type, the automatic cell size, a swipe, and the scene's wiring.

import std/[json, monotimes, os, sequtils, strutils, times, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/utils/memory
import frameos/utils/svg_frames
import frameos/types
import frameos/values

const
  Repo = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".."
  SamplePath = Repo / "repo" / "scenes" / "samples" / "Color cycling" / "scenes.json"
  Scenes = ["falls", "harbor", "rain", "snow", "aurora", "campfire"]

let
  sample = parseJson(readFile(SamplePath))[0]
  app = sample["apps"]["colorCycling"]

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

type Cycling = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene

proc newCycling(id: string, width, height: int): Cycling =
  let config = FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp")
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "cycling", appKeyword: "colorCycling", scene: result.scene,
    frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image",
    source = app["sources"]["app.tsx"].getStr(), sourceName = "app.tsx", sources = app["sources"])

proc render(c: Cycling, config: JsonNode): Image =
  let context = ExecutionContext(scene: c.scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: nil, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: false)
  c.runtime.get(c.owner, config, context).asImage()

proc intoPanel(c: Cycling, target: Image, config: JsonNode) =
  ## One render of an LCD's buffer, the way the ESP32's render does it.
  let context = ExecutionContext(scene: c.scene, event: "render", payload: %*{},
    hasImage: true, image: target, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: target, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: true, backgroundPending: true, backgroundColor: rgba(0, 0, 0, 255).color)
  beginPanelFrame(target.bufferPointer, 1)
  discard c.runtime.get(c.owner, config, context).asImage()
  endPanelFrame()

proc swipe(c: Cycling, config: JsonNode, direction: string, event = "swipe") =
  let context = ExecutionContext(scene: c.scene, event: event, payload: %*{"direction": direction},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
  discard c.runtime.run(c.owner, config, context, isEvent = true)

proc same(a, b: Image): bool =
  if a.width != b.width or a.height != b.height:
    return false
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      if a[x, y] != b[x, y]:
        return false
  true

proc changed(a, b: Image): int =
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      if a[x, y] != b[x, y]: inc result

proc colors(image: Image): int =
  var seen: seq[ColorRGBX]
  for y in countup(0, image.height - 1, 3):
    for x in countup(0, image.width - 1, 3):
      if image[x, y] notin seen:
        seen.add image[x, y]
        if seen.len > 40: return seen.len
  seen.len

proc drift(a, b: Image, x0, y0, x1, y1, step: int): int =
  ## Of the pixels that changed from `a` to `b` in the box, how many more
  ## moved `step` down than up: positive when what moves falls.
  for y in max(y0, step) ..< min(y1, a.height - step):
    for x in x0 ..< x1:
      if a[x, y] == b[x, y]: continue
      if b[x, y + step] == a[x, y]: inc result
      if b[x, y - step] == a[x, y]: dec result

suite "Color cycling":
  test "the scenes the app offers are the scenes the scene offers, wired to its state":
    let options = app["fields"][0]["options"].mapIt(it.getStr())
    check options == @Scenes
    check sample["fields"][0]["options"].mapIt(it["value"].getStr()) == options
    var bound: seq[string]
    for edge in sample["edges"]:
      if edge["type"].getStr() == "codeNodeEdge" and edge["target"].getStr() == "cycling":
        bound.add edge["source"].getStr() & " -> " & edge["targetHandle"].getStr()
    check bound == @["scene -> fieldInput/scene", "quality -> fieldInput/pixelSize"]
    for field in sample["fields"]:
      check field["access"].getStr() == "public" and field["persist"].getStr() == "disk"
    check sample["settings"]["refreshInterval"].getFloat() < 1 # it animates
    check parseJson(app["sources"]["config.json"].getStr())["events"] == %*["swipe", "back", "forward"]

  test "every scene is a picture, and its colors move":
    for scene in Scenes:
      let c = newCycling("tests/cycling-" & scene, 240, 180)
      let config = %*{"scene": scene, "pixelSize": "2", "seed": "3", "msPerRender": "300"}
      let first = c.render(config)
      let second = c.render(config)
      checkpoint scene & ": " & $colors(first) & " colors, " & $changed(first, second) & " pixels moved"
      check first.width == 240 and first.height == 180
      check colors(first) > 12
      check changed(first, second) > 100

  test "rain, snow and water fall, flames rise":
    # A range's colors move toward its higher entries; a scene that numbers
    # a track the other way plays it backwards (rain falling up, once). Each
    # step is one place of the range that moves there.
    for (scene, ms, x0, y0, x1, y1, down) in [("rain", "34", 0, 0, 240, 240, true),
        ("snow", "143", 0, 0, 240, 120, true), ("falls", "50", 100, 110, 140, 170, true),
        ("campfire", "72", 90, 140, 150, 200, false)]:
      let c = newCycling("tests/cycling-way-" & scene, 240, 240)
      let config = %*{"scene": scene, "pixelSize": "2", "seed": "3", "msPerRender": ms}
      let first = c.render(config)
      let second = c.render(config)
      let moved = drift(first, second, x0, y0, x1, y1, 2)
      checkpoint scene & ": " & $moved & " more pixels went down than up"
      check (if down: moved > 20 else: moved < -20)

  test "the cells stay put: only the cells of colors that moved are written":
    # Into an LCD's buffer: a pixel poked where the colors do not cycle (the
    # sky at the top of the falls) is left alone by the next frame, which
    # would write it if a cell there had changed.
    forgetPanelFrames()
    let c = newCycling("tests/cycling-cells", 240, 240)
    let config = %*{"scene": "falls", "pixelSize": "2", "seed": "3", "msPerRender": "300"}
    let target = newImage565(240, 240)
    c.intoPanel(target, config)
    let before = copy(target)
    target[120, 40] = rgbx(255, 0, 255, 255)
    c.intoPanel(target, config)
    check target[120, 40] == rgb565ToRgbx(rgbxToRgb565(rgbx(255, 0, 255, 255)))
    target[120, 40] = before[120, 40]
    check changed(before, target) > 100 # the water fell

  test "a seed is the same picture, and a fixed step the same frames":
    for scene in Scenes:
      let
        a = newCycling("tests/cycling-a-" & scene, 160, 160).render(%*{"scene": scene, "pixelSize": "2", "seed": "21", "msPerRender": "500"})
        b = newCycling("tests/cycling-b-" & scene, 160, 160).render(%*{"scene": scene, "pixelSize": "2", "seed": "21", "msPerRender": "500"})
        c = newCycling("tests/cycling-c-" & scene, 160, 160).render(%*{"scene": scene, "pixelSize": "2", "seed": "22", "msPerRender": "500"})
      checkpoint scene
      check same(a, b)
      check not same(a, c)

  test "the automatic cell size: 240 cells across, 160 on an ESP32":
    let config = %*{"scene": "snow", "pixelSize": "0", "seed": "4", "msPerRender": "1"}
    let host = newCycling("tests/cycling-auto-host", 480, 480).render(config)
    check same(host, newCycling("tests/cycling-two", 480, 480).render(%*{"scene": "snow", "pixelSize": "2", "seed": "4", "msPerRender": "1"}))
    setSimulatedEmbedded(true)
    defer: setSimulatedEmbedded(false)
    let device = newCycling("tests/cycling-auto-device", 480, 480).render(config)
    check same(device, newCycling("tests/cycling-three", 480, 480).render(%*{"scene": "snow", "pixelSize": "3", "seed": "4", "msPerRender": "1"}))

  test "a swipe is the next or previous scene, round the end":
    let c = newCycling("tests/cycling-swipe", 120, 120)
    let config = %*{"scene": "falls", "pixelSize": "4", "seed": "1"}
    discard c.render(config)
    c.swipe(config, "left")
    check c.scene.state{"scene"}.getStr() == "harbor"
    c.swipe(config, "right")
    check c.scene.state{"scene"}.getStr() == "campfire"
    # In from an edge: a touch frame's event map makes it forward or back.
    c.swipe(config, "", "forward")
    check c.scene.state{"scene"}.getStr() == "harbor"
    c.swipe(config, "", "back")
    check c.scene.state{"scene"}.getStr() == "campfire"

  test "a 480x480 scene, drawn and then cycled":
    for scene in Scenes:
      let c = newCycling("tests/cycling-time-" & scene, 480, 480)
      let config = %*{"scene": scene, "pixelSize": "0", "seed": "1"}
      var start = getMonoTime()
      discard c.render(config)
      let drawn = (getMonoTime() - start).inMicroseconds.float / 1000
      start = getMonoTime()
      for i in 0 ..< 10:
        discard c.render(config)
      let perFrame = (getMonoTime() - start).inMicroseconds.float / 10_000
      echo "color cycling ", scene, " 480x480: drawn in ", formatFloat(drawn, ffDecimal, 1), " ms, then ",
        formatFloat(perFrame, ffDecimal, 2), " ms a frame"
      check perFrame < 1000
