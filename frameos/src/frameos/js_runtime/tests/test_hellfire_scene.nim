## The Hellfire sample scene (repo/scenes/samples/Hellfire): the Doom fire
## simulated in JS and written into a canvas with `frameos.putPixels`. Run
## for real through the JS app runtime at a small size, this pins that the
## fire is a fire (hot at the bottom, out at the top), that a seed makes it
## the same on every frame type (what keeps its e2e snapshot stable), that
## the e2e fixture holds the sample's own app, and how long a frame takes.

import std/[json, monotimes, os, sequtils, strutils, times, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/utils/memory
import frameos/utils/svg_frames
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

const pixelFrames = """
export function get(app) {
  const cells = new Uint8Array(20 * 12)
  if (Number(app.config.step) >= 1) cells.fill(1, 4 * 20, 6 * 20)
  if (app.config.hole) cells[0] = 9
  return frameos.pixels(cells, { width: Number(app.config.cols) || 20, height: 12, pixelSize: 5, palette: ['#000000', '#ff0000'] })
}
"""

proc intoPanel(fire: Fire, target: Image, config: JsonNode, generation: uint32 = 1,
    background = rgba(0, 255, 0, 255).color): tuple[image: Image, stillOwed: bool] =
  ## One render of a panel buffer, the way the ESP32's render does it.
  let context = ExecutionContext(scene: fire.scene, event: "render", payload: %*{},
    hasImage: true, image: target, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: target, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: true, backgroundPending: true, backgroundColor: background)
  beginPanelFrame(target.bufferPointer, generation)
  let image = fire.runtime.get(fire.owner, config, context).asImage()
  endPanelFrame()
  (image, context.backgroundPending)

suite "frameos.pixels":
  const
    black = rgb565ToRgbx(rgbxToRgb565(rgbx(0, 0, 0, 255)))
    red = rgb565ToRgbx(rgbxToRgb565(rgbx(255, 0, 0, 255)))
    green = rgb565ToRgbx(rgbxToRgb565(rgbx(0, 255, 0, 255)))
    poked = rgb565ToRgbx(rgbxToRgb565(rgbx(0, 0, 255, 255)))

  proc newPanelFire(id: string): Fire =
    result = newFire(id, 100, 60)
    result.runtime = newJsAppRuntime(category = "data", outputType = "image", source = pixelFrames,
      sourceName = "app.tsx")

  test "it is the target, written in place, and a frame that covers it owes no background":
    let fire = newPanelFire("tests/pixels-target")
    let target = newImage565(100, 60)
    target.fill(rgbx(9, 9, 9, 255))
    let (image, owed) = fire.intoPanel(target, %*{"step": 1})
    check cast[pointer](image) == cast[pointer](target)
    check not owed
    check target[50, 19] == black and target[50, 20] == red and target[50, 29] == red and target[50, 30] == black

  test "a frame that leaves anything uncovered pays the background first":
    forgetPanelFrames()
    let narrow = newPanelFire("tests/pixels-narrow")
    let target = newImage565(100, 60)
    discard narrow.intoPanel(target, %*{"step": 0, "cols": 19})
    check target[50, 30] == black
    check target[97, 30] == green # the column it does not reach
    let holed = newPanelFire("tests/pixels-hole")
    let other = newImage565(100, 60)
    discard holed.intoPanel(other, %*{"step": 0, "hole": true})
    check other[2, 2] == green # an index past the palette shows what is under it
    check other[50, 30] == black

  test "each panel buffer writes only the cells that differ from what it holds":
    forgetPanelFrames()
    let fire = newPanelFire("tests/pixels-shadow")
    let target = newImage565(100, 60)
    discard fire.intoPanel(target, %*{"step": 0}) # every cell
    target[50, 2] = rgbx(0, 0, 255, 255)
    discard fire.intoPanel(target, %*{"step": 0}) # the same cells: not one written
    check target[50, 2] == poked
    discard fire.intoPanel(target, %*{"step": 1}) # rows 4 and 5 only
    check target[50, 2] == poked and target[50, 20] == red
    discard fire.intoPanel(target, %*{"step": 0}) # and back
    check target[50, 2] == poked and target[50, 20] == black

  test "and writes them all when anything else may have drawn there":
    forgetPanelFrames()
    let fire = newPanelFire("tests/pixels-others")
    let target = newImage565(100, 60)
    discard fire.intoPanel(target, %*{"step": 0})
    target[50, 2] = rgbx(0, 0, 255, 255)
    discard fire.intoPanel(target, %*{"step": 0}, generation = 2) # the firmware wrote into it
    check target[50, 2] == black
    target[50, 2] = rgbx(0, 0, 255, 255)
    beginPanelFrame(target.bufferPointer, 2) # a settings panel's render in between
    endPanelFrame()
    discard fire.intoPanel(target, %*{"step": 0}, generation = 2)
    check target[50, 2] == black
    let another = newImage565(100, 60) # no record for another buffer
    another.fill(rgbx(0, 0, 255, 255))
    discard fire.intoPanel(another, %*{"step": 0}, generation = 2)
    check another[50, 2] == black

  test "a grid larger than the frame is a whole picture of its own, not a sheared one":
    let fire = newPanelFire("tests/pixels-large")
    fire.scene.frameConfig.width = 40 # 8x6 cells would fit; the app sends 20x12 at 5
    fire.scene.frameConfig.height = 30
    fire.owner.frameConfig.width = 40
    fire.owner.frameConfig.height = 30
    let picture = fire.render(%*{"step": 1})
    check picture.width == 100 and picture.height == 60
    check picture[50, 20].r == 255 and picture[50, 2].r == 0

  test "with no target to take, it is a picture of its own":
    let fire = newPanelFire("tests/pixels-own")
    let picture = fire.render(%*{"step": 1})
    check picture.width == 100 and picture.height == 60
    check picture[50, 20].r == 255 and picture[50, 2].r == 0

# Without a palette a cell is four bytes of RGBA, an ImageData's layout: here
# a Uint32Array, 0xAABBGGRR on a little-endian host (every FrameOS host).
const rgbaFrames = """
export function get(app) {
  const cols = 20, rows = 12
  const px = new Uint32Array(cols * rows).fill(0xff000000)
  if (Number(app.config.step) >= 1) px.fill(0xff0000ff, 4 * cols, 6 * cols)
  if (app.config.hole) px[0] = 0
  px[3 * cols + 7] = 0xff336699
  const options = { width: cols, height: rows, pixelSize: 5 }
  if (app.config.indexed) return frameos.pixels(new Uint8Array(cols * rows), { ...options, palette: ['#000000'] })
  if (app.config.short) return frameos.pixels(new Uint8Array(cols * rows), options)
  if (app.config.unaligned) {
    const bytes = new Uint8Array(px.byteLength + 1)
    bytes.set(new Uint8Array(px.buffer), 1)
    return frameos.pixels(bytes.subarray(1), options)
  }
  return frameos.pixels(px, options)
}
"""

suite "frameos.pixels without a palette":
  const
    black = rgb565ToRgbx(rgbxToRgb565(rgbx(0, 0, 0, 255)))
    red = rgb565ToRgbx(rgbxToRgb565(rgbx(255, 0, 0, 255)))
    green = rgb565ToRgbx(rgbxToRgb565(rgbx(0, 255, 0, 255)))
    poked = rgb565ToRgbx(rgbxToRgb565(rgbx(0, 0, 255, 255)))
    odd = rgbx(0x99, 0x66, 0x33, 255) # the one cell at (7, 3)

  proc newRgbaFire(id: string): Fire =
    result = newFire(id, 100, 60)
    result.runtime = newJsAppRuntime(category = "data", outputType = "image", source = rgbaFrames,
      sourceName = "app.tsx")

  test "RGBA cells are pixels in whatever the panel stores, and covering it owe no background":
    forgetPanelFrames()
    let fire = newRgbaFire("tests/rgba-565")
    let target = newImage565(100, 60)
    target.fill(rgbx(9, 9, 9, 255))
    let (image, owed) = fire.intoPanel(target, %*{"step": 1})
    check cast[pointer](image) == cast[pointer](target)
    check not owed
    check target[50, 19] == black and target[50, 20] == red and target[50, 29] == red and target[50, 30] == black
    check target[37, 17] == rgb565ToRgbx(rgbxToRgb565(odd))
    # Every format a panel or canvas comes in stores what pixie's own setPixel would.
    for (name, made) in [("rgbx", newImage(100, 60)), ("gray8", newImageGray8(100, 60)),
        ("gray4", newImageGray4(100, 60))]:
      forgetPanelFrames()
      let other = newRgbaFire("tests/rgba-" & name)
      discard other.intoPanel(made, %*{"step": 1})
      let expected = newImageLike(made, 100, 60)
      for y in 0 ..< 60:
        for x in 0 ..< 100:
          let color = if x div 5 == 7 and y div 5 == 3: odd elif y div 5 in 4 .. 5: rgbx(255, 0, 0, 255)
            else: rgbx(0, 0, 0, 255)
          expected.setPixel(expected.dataIndex(x, y), color)
      var wrong = 0
      for y in 0 ..< 60:
        for x in 0 ..< 100:
          if made[x, y] != expected[x, y]: inc wrong
      checkpoint name
      check wrong == 0

  test "alpha 0 shows what is under it, and the background is paid":
    forgetPanelFrames()
    let fire = newRgbaFire("tests/rgba-hole")
    let target = newImage565(100, 60)
    let (_, owed) = fire.intoPanel(target, %*{"hole": true})
    check not owed
    check target[2, 2] == green and target[50, 30] == black

  test "a buffer writes only the cells that differ, and an indexed frame in between forgets them":
    forgetPanelFrames()
    let fire = newRgbaFire("tests/rgba-shadow")
    let target = newImage565(100, 60)
    discard fire.intoPanel(target, %*{"step": 0})
    target[50, 2] = rgbx(0, 0, 255, 255)
    discard fire.intoPanel(target, %*{"step": 0})
    check target[50, 2] == poked # the same cells: not one written
    discard fire.intoPanel(target, %*{"step": 1})
    check target[50, 2] == poked and target[50, 20] == red
    discard fire.intoPanel(target, %*{"indexed": true}) # palette cells: another record
    check target[50, 2] == black and target[50, 20] == black
    target[50, 2] = rgbx(0, 0, 255, 255)
    discard fire.intoPanel(target, %*{"step": 0})
    check target[50, 2] == black

  test "a buffer keeps no more than the frame it holds, and nothing for a frame past the cap":
    forgetPanelFrames()
    const sized = """
export function get(app) {
  const n = Number(app.config.n)
  const options = { width: n, height: n, pixelSize: 1 }
  if (app.config.indexed) return frameos.pixels(new Uint8Array(n * n), { ...options, palette: ['#000000'] })
  return frameos.pixels(new Uint32Array(n * n).fill(0xff000000), options)
}
"""
    var fire = newFire("tests/rgba-memory", 300, 300)
    fire.runtime = newJsAppRuntime(category = "data", outputType = "image", source = sized, sourceName = "app.tsx")
    let target = newImage565(300, 300)
    discard fire.intoPanel(target, %*{"n": 240}) # 230 KB of RGBA: kept
    check heldPixelFrameBytesForTest() >= 240 * 240 * 4
    discard fire.intoPanel(target, %*{"n": 20, "indexed": true}) # 400 bytes: and only those
    check heldPixelFrameBytesForTest() < 4096
    discard fire.intoPanel(target, %*{"n": 300}) # 360 KB: past the cap, not kept
    check heldPixelFrameBytesForTest() == 0

  test "bytes at any offset, and too few of them refused":
    forgetPanelFrames()
    let fire = newRgbaFire("tests/rgba-unaligned")
    let target = newImage565(100, 60)
    discard fire.intoPanel(target, %*{"step": 1, "unaligned": true})
    check target[50, 20] == red and target[37, 17] == rgb565ToRgbx(rgbxToRgb565(odd))
    let short = newRgbaFire("tests/rgba-short")
    expect ValueError: # refused: no picture comes back
      discard short.render(%*{"short": true})

# Layers: `frameos.pixels([layer, ...])`, each its own cells, palette, place
# and cell size, painted in order.
const layerFrames = """
export function get(app) {
  const left = new Uint8Array(10 * 12).fill(1)
  const right = new Uint8Array(5 * 6).fill(1)
  const over = new Uint8Array(4 * 4).fill(9) // past its palette: see-through
  over[5] = 0
  const layers = [
    { cells: left, x: 0, y: 0, width: 10, height: 12, palette: ['#000000', '#ff0000'] },
    { cells: right, x: 50, y: 0, width: 5, height: 6, pixelSize: 10, palette: new Uint32Array([0, 0x00ff00]) },
    { cells: over, x: 0, y: 0, width: 4, height: 4, palette: ['#0000ff'] },
  ]
  if (app.config.narrow) layers[1].width = 4
  if (app.config.outside) layers.push({ cells: right, x: 90, y: 0, width: 5, height: 6, pixelSize: 10, palette: ['#fff'] })
  return frameos.pixels(layers, { pixelSize: 5 })
}
"""

suite "frameos.pixels layers":
  const
    red = rgb565ToRgbx(rgbxToRgb565(rgbx(255, 0, 0, 255)))
    green = rgb565ToRgbx(rgbxToRgb565(rgbx(0, 255, 0, 255)))
    blue = rgb565ToRgbx(rgbxToRgb565(rgbx(0, 0, 255, 255)))
    owedGray = rgb565ToRgbx(rgbxToRgb565(rgbx(40, 40, 40, 255)))

  proc newLayerFire(id: string): Fire =
    result = newFire(id, 100, 60)
    result.runtime = newJsAppRuntime(category = "data", outputType = "image", source = layerFrames,
      sourceName = "app.tsx")

  test "each layer in its rectangle, at its cell size, with its palette, later ones on top":
    forgetPanelFrames()
    let fire = newLayerFire("tests/layers")
    let target = newImage565(100, 60)
    let (image, owed) = fire.intoPanel(target, %*{}, background = rgba(40, 40, 40, 255).color)
    check cast[pointer](image) == cast[pointer](target)
    check not owed
    check target[30, 30] == red # the left tile, 5 px cells
    check target[75, 30] == green # the right one, 10 px cells, a Uint32Array palette
    check target[7, 7] == blue # the overlay's one opaque cell, (1, 1) at 5 px
    check target[2, 2] == red # the rest of it is see-through

  test "what the layers leave uncovered shows the background, and a layer outside the frame is refused":
    forgetPanelFrames()
    let fire = newLayerFire("tests/layers-narrow")
    let target = newImage565(100, 60)
    discard fire.intoPanel(target, %*{"narrow": true, "outside": true}, background = rgba(40, 40, 40, 255).color)
    check target[95, 30] == owedGray # the column the narrowed tile leaves
    check target[75, 30] == green # drawn though a layer after it was refused

suite "Hellfire":
  test "the e2e fixture is the sample's app, seeded":
    let fixtureApp = fixture["apps"]["hellfire"]
    check fixtureApp["sources"] == app["sources"]
    check fixtureApp["fields"] == app["fields"]
    check fixture["nodes"][1]["data"]["config"]["seed"].getStr() == "666"
    check fixture["e2eFrame"] == %*{"width": 480, "height": 480}
    check sample["settings"]["refreshInterval"].getFloat() < 1 # it animates

  test "quality and the FPS counter are state fields wired into the app":
    for scene in [sample, fixture]:
      let fields = scene["fields"]
      check fields.len == 2
      check fields[0]["name"].getStr() == "quality" and fields[0]["type"].getStr() == "select"
      check fields[0]["value"].getStr() == "0" # automatic: 4 px on this host, so the snapshot is the same fire
      check fields[0]["options"].mapIt(it["value"].getStr()) == @["0", "8", "4", "2"]
      check fields[1]["name"].getStr() == "showFps" and fields[1]["type"].getStr() == "boolean"
      check fields[1]["value"].getStr() == "false" # a counter is time, and a snapshot is not
      for field in fields:
        check field["access"].getStr() == "public" and field["persist"].getStr() == "disk"
      var bound: seq[string]
      for edge in scene["edges"]:
        if edge["type"].getStr() == "codeNodeEdge" and edge["target"].getStr() == "fire":
          let source = scene["nodes"].filterIt(it["id"].getStr() == edge["source"].getStr())[0]
          if source["type"].getStr() == "state":
            bound.add source["data"]["keyword"].getStr() & " -> " & edge["targetHandle"].getStr()
      check bound == @["quality -> fieldInput/pixelSize", "showFps -> fieldInput/showFps"]
    check app["fields"].filterIt(it["name"].getStr() == "showFps").len == 1

  test "the FPS counter draws over the fire, and only there":
    let plain = newFire("tests/hellfire-plain", 480, 480)
    let counted = newFire("tests/hellfire-counted", 480, 480)
    let config = %*{"pixelSize": "4", "seed": "5", "wind": "1"}
    var withFps = copy(config)
    withFps["showFps"] = %*true
    discard plain.render(config)
    discard counted.render(withFps)
    let a = plain.render(config)
    let b = counted.render(withFps)
    check not same(a, b)
    # The label sits in the top-left corner: white text on a dark box.
    var text = 0
    for y in 8 ..< 40:
      for x in 8 ..< 260:
        let c = b[x, y]
        if c.r > 0xc0 and c.g > 0xc0 and c.b > 0xc0: inc text
    check text > 50
    # Below it, the same fire.
    var differ = 0
    for y in 100 ..< 480:
      for x in 0 ..< 480:
        if a[x, y] != b[x, y]: inc differ
    check differ == 0
    # "true" as a string (a form's value) counts too, as does a fire still
    # being measured: the first render shows the label without a number.
    var asString = copy(config)
    asString["showFps"] = %*"true"
    let c = newFire("tests/hellfire-string", 480, 480).render(asString)
    check not same(c, newFire("tests/hellfire-plain-2", 480, 480).render(config))

  test "the automatic cell size is 4 px, and 8 on an ESP32":
    # The spread is the app's JS: on an ESP32, 8 px cells run at twice the
    # frame rate of 4 px ones. An asked-for size wins on both.
    let config = %*{"pixelSize": "0", "seed": "3", "wind": "1"}
    let host = newFire("tests/hellfire-auto-host", 64, 64).render(config)
    check same(host, newFire("tests/hellfire-four", 64, 64).render(%*{"pixelSize": "4", "seed": "3", "wind": "1"}))
    setSimulatedEmbedded(true)
    defer: setSimulatedEmbedded(false)
    let device = newFire("tests/hellfire-auto-device", 64, 64).render(config)
    check same(device, newFire("tests/hellfire-eight", 64, 64).render(%*{"pixelSize": "8", "seed": "3", "wind": "1"}))
    check not same(host, device)
    check same(newFire("tests/hellfire-asked", 64, 64).render(%*{"pixelSize": "4", "seed": "3", "wind": "1"}), host)

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
    # A square: the four pixels of a bottom cell are one color.
    check frame[0, 254] == frame[1, 255]
    check frame[40, 254] == frame[41, 255]
    # Not a glowing line: by the warm-up something burns 40 px up.
    var lit = 0
    for x in 0 ..< 64:
      if not dark(frame[x, 216]): inc lit
    check lit > 0

  test "the flames stand under half the panel at every cell size":
    # Doom's cooling burns ~72 rows up: a 60-row grid (8 px on a 480 px panel,
    # the ESP32's) was a wall of fire. The cooling follows the grid now.
    for size in ["8", "4", "2"]:
      let fire = newFire("tests/hellfire-height-" & size, 480, 480)
      var frame: Image
      for i in 0 ..< 4:
        frame = fire.render(%*{"pixelSize": size, "seed": "9", "wind": "1"})
      var litTop, litLow = 0
      for x in 0 ..< 480:
        for y in 0 ..< 120:
          if not dark(frame[x, y]): inc litTop
        if not dark(frame[x, 330]): inc litLow
      checkpoint "pixelSize " & size & ": lit in the top quarter " & $litTop & ", at 30% up " & $litLow
      check litTop == 0
      check litLow > 100

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

  test "the counter is drawn when asked for, and leaves the fire as it found it":
    let
      plain = newFire("tests/fire-plain", 64, 256)
      counted = newFire("tests/fire-counted", 64, 256)
      base = %*{"pixelSize": "2", "seed": "666", "wind": "1"}
      asked = %*{"pixelSize": "2", "seed": "666", "wind": "1", "showFps": "true"}
    # A counter needs a second to pass before it has a number. Until then, and
    # after it (in frames compared far below the corner it draws in), the fire
    # underneath is the same fire: the label goes into the heat for the blit
    # and comes out before the next step.
    for i in 0 .. 3:
      let
        a = plain.render(base)
        b = counted.render(asked)
      for y in 64 ..< 256:
        for x in 0 ..< 64:
          check a[x, y] == b[x, y]

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
