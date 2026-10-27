import std/[os, unittest]
import pixie
import ../image
from ../memory import availableRenderBytesOverride

# "center" on a frame is the photo 1:1 in the middle. It had no streaming
# decode: data/localImage fell back to decoding a photo whole, and on the
# E1004 (1600x1200, 2.4 MB of render memory left beside the canvas) a
# 2.8 MB JPEG from the SD card was refused twice, the full-size copy and then
# the file in one block. With pixie's fitCenter it decodes only the window
# that shows, straight into the canvas.

const fixtures = currentSourcePath().parentDir.parentDir.parentDir / "tests" / "fixtures"

proc differ(a, b: ColorRGBX): int =
  max(max(abs(a.r.int - b.r.int), abs(a.g.int - b.g.int)), abs(a.b.int - b.b.int))

# The references, decoded whole on the host before any test sets a decode
# budget (pixie's is global).
let
  largePath = fixtures / "large-gradient.jpg"
  large = readImage(largePath)
  smallPath = fixtures / "progressive-480x720.jpg"
  small = readImage(smallPath)

suite "a centered photo decodes into the canvas":
  test "the middle of a photo larger than the frame, 1:1, in the E1004's memory":
    let (path, whole) = (largePath, large)
    check (whole.width, whole.height) == (4000, 2600)
    let canvas = newImage(1600, 1200)
    availableRenderBytesOverride = 2424 * 1024
    try:
      check readImageIntoTarget(path, canvas, "center")
    finally:
      availableRenderBytesOverride = 0
    let (x0, y0) = ((4000 - 1600) div 2, (2600 - 1200) div 2)
    var worst = 0
    for (x, y) in [(0, 0), (1599, 0), (0, 1199), (1599, 1199), (800, 600), (400, 900), (1234, 321)]:
      worst = max(worst, differ(canvas[x, y], whole[x0 + x, y0 + y]))
    check worst <= 8

  test "a photo smaller than the frame whole in the middle, the borders left alone":
    let (path, whole) = (smallPath, small)
    let marker = rgbx(9, 99, 199, 255)
    let canvas = newImage(1600, 1200)
    canvas.fill(marker)
    availableRenderBytesOverride = 64 * 1024 * 1024
    try:
      check readImageIntoTarget(path, canvas, "center")
    finally:
      availableRenderBytesOverride = 0
    let (dx, dy) = ((1600 - 480) div 2, (1200 - 720) div 2)
    check canvas[0, 0] == marker
    check canvas[dx - 1, dy + 100] == marker
    check canvas[dx + 480, dy + 100] == marker
    check canvas[dx + 100, dy - 1] == marker
    var worst = 0
    for (x, y) in [(0, 0), (479, 719), (240, 360), (17, 600)]:
      worst = max(worst, differ(canvas[dx + x, dy + y], whole[x, y]))
    check worst <= 8

  test "an anchored placement pins the 1:1 photo to its edge or corner":
    let marker = rgbx(9, 99, 199, 255)
    # A larger photo bottom-right: its own bottom-right corner shows.
    let canvas = newImage(1600, 1200)
    availableRenderBytesOverride = 2424 * 1024
    try:
      check readImageIntoTarget(largePath, canvas, "bottom-right")
    finally:
      availableRenderBytesOverride = 0
    let (x0, y0) = (4000 - 1600, 2600 - 1200)
    var worst = 0
    for (x, y) in [(0, 0), (1599, 1199), (800, 600), (17, 1100)]:
      worst = max(worst, differ(canvas[x, y], large[x0 + x, y0 + y]))
    check worst <= 8
    # A smaller photo top-left: in the corner, the rest of the canvas as it was.
    let topLeft = newImage(1600, 1200)
    topLeft.fill(marker)
    availableRenderBytesOverride = 64 * 1024 * 1024
    try:
      check readImageIntoTarget(smallPath, topLeft, "top-left")
    finally:
      availableRenderBytesOverride = 0
    check topLeft[480, 0] == marker
    check topLeft[0, 720] == marker
    check topLeft[1599, 1199] == marker
    worst = 0
    for (x, y) in [(0, 0), (479, 719), (240, 360)]:
      worst = max(worst, differ(topLeft[x, y], small[x, y]))
    check worst <= 8
