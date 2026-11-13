## `return frameos.pixels(cells, palette, {width, height, pixelSize})`, the
## 8-bit palette mode (docs/scene-guide.md, app_runtime.nim imageFromPixels):
## a byte a cell, an index into up to 256 colors, written straight into the
## panel buffer the planner offers. Rendered for real through the JS app
## runtime, the way the ESP32's render hands it an RGB565 buffer.

import std/[json, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/utils/svg_frames
import frameos/types
import frameos/values

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

type App = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene

# 20x12 cells of 5 px on a 100x60 frame. `step` 1 lights rows 4 and 5;
# `cycle` rotates the palette by that many; `palette` 'typed' hands it over as
# a Uint32Array.
const source = """
export function get(app) {
  const c = app.config
  const n = Number(c.n) || 0
  if (n) return frameos.pixels(new Uint8Array(n * n), [0], { width: n, height: n })
  const cells = new Uint8Array(20 * 12)
  if (Number(c.step) >= 1) cells.fill(1, 4 * 20, 6 * 20)
  cells[0] = 2
  cells[3 * 20 + 7] = Number(c.odd) || 0
  const colors = [0x000000, 0xff0000, 0x00ff00, 0x0000ff]
  const k = Number(c.cycle) || 0
  const palette = colors.map((_, i) => colors[(i + k) % colors.length])
  const options = { width: Number(c.cols) || 20, height: 12, pixelSize: 5 }
  if (c.palette === 'none') return frameos.pixels(cells, [], options)
  if (c.palette === 'short') return frameos.pixels(cells, [0x000000, 0xff0000], options)
  if (c.cells === 'short') return frameos.pixels(cells.subarray(1), palette, options)
  if (c.cells === 'array') return frameos.pixels([...cells], palette, options)
  return frameos.pixels(cells, c.palette === 'typed' ? new Uint32Array(palette) : palette, options)
}
"""

proc newApp(id: string, width = 100, height = 60): App =
  let config = FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp")
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "pixels", appKeyword: "pixels", scene: result.scene,
    frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image", source = source,
    sourceName = "app.tsx")

proc render(app: App, config: JsonNode): Image =
  ## With no target offered: a picture of its own.
  let context = ExecutionContext(scene: app.scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: nil, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: false)
  app.runtime.get(app.owner, config, context).asImage()

proc intoPanel(app: App, target: Image, config: JsonNode, generation: uint32 = 1): tuple[image: Image, stillOwed: bool] =
  ## One render of a panel buffer, the way the ESP32's render does it.
  let context = ExecutionContext(scene: app.scene, event: "render", payload: %*{},
    hasImage: true, image: target, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: target, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: true, backgroundPending: true, backgroundColor: rgba(9, 9, 9, 255).color)
  beginPanelFrame(target.bufferPointer, generation)
  let image = app.runtime.get(app.owner, config, context).asImage()
  endPanelFrame()
  (image, context.backgroundPending)

proc as565(c: ColorRGBX): ColorRGBX = rgb565ToRgbx(rgbxToRgb565(c))

const
  black = rgbx(0, 0, 0, 255)
  red = rgbx(255, 0, 0, 255)
  green = rgbx(0, 255, 0, 255)
  blue = rgbx(0, 0, 255, 255)
  poked = rgbx(200, 100, 50, 255)
  owedGray = rgbx(9, 9, 9, 255)

suite "frameos.pixels":
  test "it is the target, written in place, and a grid that covers it owes no background":
    forgetPanelFrames()
    let app = newApp("tests/pixels-target")
    let target = newImage565(100, 60)
    target.fill(rgbx(1, 2, 3, 255))
    let (image, owed) = app.intoPanel(target, %*{"step": 1})
    check cast[pointer](image) == cast[pointer](target)
    check not owed
    check target[50, 19] == black.as565 and target[50, 20] == red.as565 and target[50, 29] == red.as565
    check target[50, 30] == black.as565
    check target[0, 0] == green.as565 and target[4, 4] == green.as565 and target[5, 5] == black.as565

  test "a grid that stops short pays the background; an index past the palette is black":
    forgetPanelFrames()
    let app = newApp("tests/pixels-short")
    let target = newImage565(100, 60)
    discard app.intoPanel(target, %*{"cols": 19, "palette": "short"})
    check target[97, 30] == owedGray.as565 # the column it does not reach
    check target[50, 30] == black.as565
    check target[2, 2] == black.as565 # index 2, past a palette of two

  test "each panel buffer writes only the cells that differ from what it holds":
    forgetPanelFrames()
    let app = newApp("tests/pixels-known")
    let target = newImage565(100, 60)
    discard app.intoPanel(target, %*{"step": 0}) # every cell
    target[50, 2] = poked
    discard app.intoPanel(target, %*{"step": 0}) # the same cells: not one written
    check target[50, 2] == poked.as565
    discard app.intoPanel(target, %*{"step": 1}) # rows 4 and 5 only
    check target[50, 2] == poked.as565 and target[50, 20] == red.as565 and target[50, 29] == red.as565
    discard app.intoPanel(target, %*{"step": 0}) # and back
    check target[50, 2] == poked.as565 and target[50, 20] == black.as565

  test "a cycled palette rewrites the cells of the colors that moved, and only those":
    forgetPanelFrames()
    let app = newApp("tests/pixels-cycle")
    let target = newImage565(100, 60)
    discard app.intoPanel(target, %*{"step": 1, "palette": "typed"})
    target[50, 2] = poked # a cell of index 0
    target[52, 22] = poked # a cell of index 1
    # Rotated by one, every entry moved: 0 is red, 1 green, 2 blue.
    discard app.intoPanel(target, %*{"step": 1, "cycle": 1})
    check target[50, 2] == red.as565 and target[52, 22] == green.as565 and target[0, 0] == blue.as565
    # The same colors again, from an Array this time: nothing written.
    target[50, 2] = poked
    discard app.intoPanel(target, %*{"step": 1, "cycle": 1, "palette": "typed"})
    check target[50, 2] == poked.as565
    # A palette where only entry 1 changes: the poked cell of index 0 stays.
    let mixed = newApp("tests/pixels-cycle-one")
    let other = newImage565(100, 60)
    discard mixed.intoPanel(other, %*{"step": 1, "odd": 3}) # one cell of index 3 at (7, 3)
    other[50, 2] = poked
    other[52, 22] = poked
    other[37, 17] = poked
    discard mixed.intoPanel(other, %*{"step": 1, "odd": 3, "palette": "short"}) # 2 and 3 go black
    check other[50, 2] == poked.as565 # index 0, black in both
    check other[52, 22] == poked.as565 # index 1, red in both
    check other[37, 17] == black.as565 and other[0, 0] == black.as565 # recolored

  test "and writes them all when anything else may have drawn there":
    forgetPanelFrames()
    let app = newApp("tests/pixels-others")
    let target = newImage565(100, 60)
    discard app.intoPanel(target, %*{"step": 0})
    target[50, 2] = poked
    discard app.intoPanel(target, %*{"step": 0}, generation = 2) # the firmware wrote into it
    check target[50, 2] == black.as565
    target[50, 2] = poked
    beginPanelFrame(target.bufferPointer, 2) # a settings panel's render in between
    endPanelFrame()
    discard app.intoPanel(target, %*{"step": 0}, generation = 2)
    check target[50, 2] == black.as565
    let another = newImage565(100, 60) # no record for another buffer
    another.fill(poked)
    discard app.intoPanel(another, %*{"step": 0}, generation = 2)
    check another[50, 2] == black.as565

  test "every format stores what pixie's own setPixel would":
    for (name, made) in [("rgbx", newImage(100, 60)), ("gray8", newImageGray8(100, 60)),
        ("gray4", newImageGray4(100, 60))]:
      forgetPanelFrames()
      let app = newApp("tests/pixels-" & name)
      discard app.intoPanel(made, %*{"step": 1, "odd": 3})
      let expected = newImageLike(made, 100, 60)
      for y in 0 ..< 60:
        for x in 0 ..< 100:
          let color =
            if x < 5 and y < 5: green
            elif x div 5 == 7 and y div 5 == 3: blue
            elif y div 5 in 4 .. 5: red
            else: black
          expected.setPixel(expected.dataIndex(x, y), color)
      var wrong = 0
      for y in 0 ..< 60:
        for x in 0 ..< 100:
          if made[x, y] != expected[x, y]: inc wrong
      checkpoint name
      check wrong == 0

  test "a buffer keeps no more than the frame it holds, and nothing for a frame past the cap":
    forgetPanelFrames()
    let app = newApp("tests/pixels-memory", 600, 600)
    let target = newImage565(600, 600)
    discard app.intoPanel(target, %*{"n": 500}) # 250 KB: kept
    check heldPixelFrameBytesForTest() >= 500 * 500
    discard app.intoPanel(target, %*{"n": 20}) # and then only 400 bytes
    check heldPixelFrameBytesForTest() < 4096
    discard app.intoPanel(target, %*{"n": 600}) # 360 KB: past the cap, not kept
    check heldPixelFrameBytesForTest() == 0

  test "no palette, no typed array or too few cells is refused":
    for config in [%*{"palette": "none"}, %*{"cells": "short"}, %*{"cells": "array"}]:
      checkpoint $config
      expect ValueError: # no picture comes back
        discard newApp("tests/pixels-refused").render(config)

  test "a grid larger than the frame is a whole picture of its own, not a sheared one":
    let app = newApp("tests/pixels-large", 40, 30) # 8x6 cells would fit; the app sends 20x12 at 5
    let picture = app.render(%*{"step": 1})
    check picture.width == 100 and picture.height == 60
    check picture[50, 20].r == 255 and picture[50, 2].r == 0

  test "with no target to take, it is a picture of its own":
    let picture = newApp("tests/pixels-own").render(%*{"step": 1})
    check picture.width == 100 and picture.height == 60
    check picture[50, 20] == red and picture[50, 2] == black and picture[2, 2] == green
