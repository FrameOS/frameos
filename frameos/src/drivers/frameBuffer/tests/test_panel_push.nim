import std/unittest
import pixie
import ../panel_push

proc layout565(width, height: int, padding = 0): PanelLayout =
  PanelLayout(width: width, height: height, bytesPerPixel: 2, lineLength: width * 2 + padding)

proc layout32(width, height: int): PanelLayout =
  # The common Pi HDMI mode: BGRX, no alpha.
  PanelLayout(width: width, height: height, bytesPerPixel: 4, lineLength: width * 4,
    redByte: 2, greenByte: 1, blueByte: 0, alphaByte: 3)

proc paint(image: Image, x, y, w, h: int, color: ColorRGBA) =
  for yy in y ..< y + h:
    for xx in x ..< x + w:
      image.setColor(xx, yy, color.color)

proc changedRows(changed: seq[bool]): seq[int] =
  for y, c in changed:
    if c:
      result.add y

suite "the framebuffer writes what changed":
  test "a 16 bpp panel in pixie's order takes RGB565 as it is":
    check isRgb565(16, 11, 5, 5, 6, 0, 5)
    check not isRgb565(16, 0, 5, 5, 6, 11, 5) # BGR565
    check not isRgb565(32, 16, 8, 8, 8, 0, 8)

  test "the first frame writes every row, the same frame again writes none":
    var shadow: PanelShadow
    var scratch: seq[uint8]
    shadow.prepare(layout565(8, 6))
    let canvas = newImage565(8, 6)
    canvas.fill(rgba(10, 200, 30, 255))
    check changedRows(shadow.stageImage(canvas, scratch)) == @[0, 1, 2, 3, 4, 5]
    check changedRuns(shadow.stageImage(canvas, scratch)).len == 0

  test "a dot that moves rewrites only the rows it was and is on":
    var shadow: PanelShadow
    var scratch: seq[uint8]
    shadow.prepare(layout565(16, 12))
    let canvas = newImage565(16, 12)
    canvas.fill(rgba(32, 32, 32, 255))
    canvas.paint(2, 1, 3, 2, rgba(214, 69, 69, 255))
    discard shadow.stageImage(canvas, scratch)
    canvas.paint(2, 1, 3, 2, rgba(32, 32, 32, 255))
    canvas.paint(9, 8, 3, 2, rgba(214, 69, 69, 255))
    let changed = shadow.stageImage(canvas, scratch)
    check changedRows(changed) == @[1, 2, 8, 9]
    check changedRuns(changed) == @[(first: 1, last: 2), (first: 8, last: 9)]

  test "the shadow holds the panel's bytes, padding as zeros":
    var shadow: PanelShadow
    var scratch: seq[uint8]
    shadow.prepare(layout565(4, 2, padding = 4))
    let canvas = newImage565(4, 2)
    canvas.fill(rgba(255, 255, 255, 255))
    discard shadow.stageImage(canvas, scratch)
    check shadow.bytes.len == 2 * 12
    for y in 0 ..< 2:
      for i in 0 ..< 8:
        check shadow.bytes[y * 12 + i] == 0xFF
      for i in 8 ..< 12:
        check shadow.bytes[y * 12 + i] == 0

  test "an invalid shadow writes everything again":
    var shadow: PanelShadow
    var scratch: seq[uint8]
    shadow.prepare(layout565(4, 3))
    let canvas = newImage565(4, 3)
    discard shadow.stageImage(canvas, scratch)
    shadow.invalidate()
    check changedRows(shadow.stageImage(canvas, scratch)) == @[0, 1, 2]

  test "a new layout forgets the old shadow":
    var shadow: PanelShadow
    var scratch: seq[uint8]
    shadow.prepare(layout565(4, 3))
    discard shadow.stageImage(newImage565(4, 3), scratch)
    check shadow.valid
    shadow.prepare(layout565(5, 3))
    check not shadow.valid

  test "an RGBA frame converts as before, then diffs":
    var shadow: PanelShadow
    var scratch: seq[uint8]
    shadow.prepare(layout565(3, 2))
    let image = newImage(3, 2)
    image.fill(rgba(255, 128, 8, 255))
    check changedRows(shadow.stageImage(image, scratch)) == @[0, 1]
    # 255>>3 = 31, 128>>2 = 32, 8>>3 = 1 -> 0xFC01, little-endian
    check shadow.bytes[0] == 0x01
    check shadow.bytes[1] == 0xFC
    image.setColor(1, 1, rgba(0, 0, 0, 255).color)
    check changedRows(shadow.stageImage(image, scratch)) == @[1]

  test "a 32 bpp panel gets BGRX with the spare byte zeroed":
    var shadow: PanelShadow
    var scratch: seq[uint8]
    shadow.prepare(layout32(2, 1))
    let image = newImage(2, 1)
    image.fill(rgba(10, 20, 30, 255))
    discard shadow.stageImage(image, scratch)
    check shadow.bytes[0 .. 3] == @[30'u8, 20, 10, 0]

  test "a 565 canvas on a panel that is 32 bpp now is expanded, not misread":
    var shadow: PanelShadow
    var scratch: seq[uint8]
    shadow.prepare(layout32(2, 1))
    let canvas = newImage565(2, 1)
    canvas.fill(rgba(255, 255, 255, 255))
    discard shadow.stageImage(canvas, scratch)
    check shadow.bytes[0 .. 3] == @[255'u8, 255, 255, 0]

  test "changedRuns joins neighbours and keeps the last row":
    check changedRuns([true, true, false, true]) == @[(first: 0, last: 1), (first: 3, last: 3)]
    check changedRuns([false, false]).len == 0
