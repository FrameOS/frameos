## The 8-bit luma surface, tested as an oracle like test_rgb565.nim: every
## scenario is drawn onto an RGBX canvas and onto a grey canvas with the same
## calls, and the RGBX result reduced to luma must come out the same. Over
## white or black a single layer matches bit for bit. Elsewhere one luma step
## either way is allowed (`oneStep`): the RGBX canvas blends antialiased
## coverage with SIMD kernels that round differently from the scalar blend
## the narrow formats share, and layers over layers round at different
## steps. Over a coloured backdrop two (`twoSteps`): the grey canvas holds the
## backdrop's luma, rounded once before anything is blended onto it. Both are
## far below one step of a 16-grey panel (17).

import pixie, pixie/fileformats/png, pixie/fileformats/jpeg, pixie/fileformats/svg, strformat

proc maxLumaDiff(gray, b: Image): int =
  ## Largest luma difference between a grey image and any image.
  doAssert gray.format == pfGray8
  doAssert gray.width == b.width and gray.height == b.height
  for y in 0 ..< gray.height:
    for x in 0 ..< gray.width:
      let
        p = gray.unsafe[x, y]
        q = rgbxToGray8(b.unsafe[x, y])
      doAssert p.r == p.g and p.g == p.b and p.a == 255
      result = max(result, abs(p.r.int - q.int))

var checkTolerance = 0
var checkName = ""
proc check(rgbxCanvas, grayCanvas: Image) =
  let diff = maxLumaDiff(grayCanvas, rgbxCanvas)
  doAssert diff <= checkTolerance,
    &"{checkName}: grey canvas differs from the RGBX canvas's luma by {diff} (> {checkTolerance})"

template both(w, h: int, body: untyped) =
  block:
    let rgbxCanvas = newImage(w, h)
    let grayCanvas = newImageGray8(w, h)
    block:
      let canvas {.inject.} = rgbxCanvas
      body
    block:
      let canvas {.inject.} = grayCanvas
      body
    check(rgbxCanvas, grayCanvas)

const
  oneStep = 1
  twoSteps = 2

template scenario(name: string, tolerance: int, w, h: int, body: untyped) =
  checkName = name
  checkTolerance = tolerance
  both(w, h, body)

block: # pack / unpack properties
  doAssert rgbxToGray8(rgbx(0, 0, 0, 255)) == 0
  doAssert rgbxToGray8(rgbx(255, 255, 255, 255)) == 255
  doAssert gray8ToRgbx(0) == rgbx(0, 0, 0, 255)
  doAssert gray8ToRgbx(255) == rgbx(255, 255, 255, 255)
  # Every grey is exact, and a round trip changes nothing.
  for v in 0 .. 255:
    doAssert rgbxToGray8(gray8ToRgbx(v.uint8)) == v.uint8
  # BT.601 weights: green counts most, blue least.
  doAssert rgbxToGray8(rgbx(255, 0, 0, 255)) == 77
  doAssert rgbxToGray8(rgbx(0, 255, 0, 255)) == 149
  doAssert rgbxToGray8(rgbx(0, 0, 255, 255)) == 29
  # Alpha is dropped, the premultiplied colour kept: half-transparent white
  # over nothing is a mid grey, and reads come back opaque.
  doAssert rgbxToGray8(rgbx(128, 128, 128, 128)) == 128
  doAssert gray8ToRgbx(rgbxToGray8(rgbx(128, 128, 128, 128))).a == 255

block: # construction, views, copies
  let img = newImageGray8(10, 6)
  doAssert img.format == pfGray8
  doAssert img.bytesPerPixel == 1
  doAssert img.byteSize == 60
  doAssert img.isOpaque
  doAssert not img.isTransparent
  doAssert img.opaqueBounds == rect(0, 0, 10, 6)
  img.fill(rgba(10, 200, 30, 255))
  doAssert img.isOneColor
  let v = img.view(2, 1, 4, 3)
  doAssert v.format == pfGray8
  v.fill(rgba(255, 0, 0, 255))
  doAssert img[2, 1] == gray8ToRgbx(77)
  doAssert img[1, 1] == gray8ToRgbx(rgbxToGray8(rgbx(10, 200, 30, 255)))
  doAssert img[6, 1] == img[1, 1]
  doAssert not img.isOneColor
  let c = img.copy()
  doAssert c.format == pfGray8
  doAssert c.pixelsEqual(img)
  let asRgbx = img.toRgbxImage()
  doAssert asRgbx.format == pfRgbx
  doAssert img.pixelsEqual(asRgbx)
  doAssert img.toContiguousSeq()[0] == img[0, 0]
  let as565 = img.toRgb565Image()
  doAssert as565.format == pfRgb565 and abs(as565[2, 1].r.int - 77) <= 4
  let sub = img.subImage(2, 1, 4, 3)
  doAssert sub.format == pfGray8 and sub.pixelsEqual(v)
  let f = img.copy()
  f.flipHorizontal()
  doAssert f[9 - 2, 1] == img[2, 1]
  f.flipVertical()
  doAssert f[9 - 2, 5 - 1] == img[2, 1]
  let r = img.copy()
  r.rotate90()
  doAssert r.width == 6 and r.height == 10 and r.format == pfGray8
  doAssert r[5 - 1, 2] == img[2, 1]
  # A grey image over a buffer the caller owns.
  var buf = newSeq[uint8](8 * 4)
  let over = newImageGray8Over(8, 4, buf[0].addr)
  over.fill(rgba(255, 255, 255, 255))
  doAssert buf[0] == 255 and buf[31] == 255
  doAssert not over.isView
  doAssert over.bufferPointer == buf[0].addr
  # And the RGBX copy of an RGBX image to grey.
  let colour = newImage(4, 4)
  colour.fill(rgba(0, 255, 0, 255))
  doAssert colour.toGray8Image()[1, 1] == gray8ToRgbx(149)

block: # what a grey image refuses, and what it converts for
  let img = newImageGray8(8, 8)
  doAssertRaises PixieError:
    discard img.shadow(vec2(1, 1), 1, 1, rgba(0, 0, 0, 255))
  img.fill(rgba(200, 200, 200, 255))
  let small = img.minifyBy2()
  doAssert small.format == pfRgbx and small.width == 4 and small[0, 0].r == 200
  let big = img.magnifyBy2()
  doAssert big.format == pfRgbx and big.width == 16
  doAssert img.resize(4, 4).width == 4
  # Blur goes through an RGBX copy: the same blur, reduced to luma.
  let blurred = img.toRgbxImage()
  blurred.blur(1)
  img.blur(1)
  for y in 0 ..< 8:
    for x in 0 ..< 8:
      doAssert img[x, y] == gray8ToRgbx(rgbxToGray8(blurred[x, y]))

scenario("fill", 0, 16, 16):
  canvas.fill(rgba(200, 100, 50, 255))

scenario("fill transparent is black", 0, 8, 8):
  canvas.fill(rgba(0, 0, 0, 0))

scenario("AA circle over white", 0, 64, 64):
  canvas.fill(rgba(255, 255, 255, 255))
  let p = newPath()
  p.circle(32, 32, 20)
  canvas.fillPath(p, rgba(30, 60, 200, 255))

scenario("AA circle translucent over white", 0, 64, 64):
  canvas.fill(rgba(255, 255, 255, 255))
  let p = newPath()
  p.circle(32, 32, 20)
  canvas.fillPath(p, rgba(30, 60, 200, 120))

scenario("AA circle translucent over a grey", oneStep, 64, 64):
  canvas.fill(rgba(120, 120, 120, 255))
  let p = newPath()
  p.circle(32, 32, 20)
  canvas.fillPath(p, rgba(220, 30, 90, 150))

scenario("AA circle translucent over a colour", twoSteps, 64, 64):
  canvas.fill(rgba(200, 100, 50, 255))
  let p = newPath()
  p.circle(32, 32, 20)
  canvas.fillPath(p, rgba(30, 60, 200, 120))

scenario("AA stroke over black", 0, 64, 64):
  canvas.fill(rgba(0, 0, 0, 255))
  let p = newPath()
  p.rect(10.5, 10.5, 40, 30)
  canvas.strokePath(p, rgba(255, 200, 0, 255), strokeWidth = 3)

scenario("non-AA axis-aligned rect", 0, 32, 32):
  canvas.fill(rgba(255, 255, 255, 255))
  let p = newPath()
  p.rect(4, 4, 20, 12)
  canvas.fillPath(p, rgba(0, 128, 0, 255))

scenario("full-width rows (the partition fill)", 0, 32, 32):
  canvas.fill(rgba(255, 255, 255, 255))
  let p = newPath()
  p.rect(0, 8, 32, 12)
  canvas.fillPath(p, rgba(40, 80, 120, 255))

scenario("two overlapping AA layers", oneStep, 64, 64):
  canvas.fill(rgba(255, 255, 255, 255))
  let p = newPath()
  p.circle(28, 32, 18)
  canvas.fillPath(p, rgba(255, 0, 0, 160))
  let q = newPath()
  q.circle(40, 32, 18)
  canvas.fillPath(q, rgba(0, 0, 255, 160))

scenario("text over white", 0, 120, 40):
  canvas.fill(rgba(255, 255, 255, 255))
  let font = readFont("tests/fonts/Roboto-Regular_1.ttf")
  font.size = 24
  canvas.fillText(font, "gray8 ok", translate(vec2(4, 4)))

scenario("text stroke over white", 0, 120, 40):
  canvas.fill(rgba(255, 255, 255, 255))
  let font = readFont("tests/fonts/Roboto-Regular_1.ttf")
  font.size = 24
  font.paint = rgba(0, 80, 160, 255)
  canvas.strokeText(font, "gray8 ok", translate(vec2(4, 4)), strokeWidth = 1.5)

scenario("draw image overwrite (blendRect path)", 0, 40, 40):
  canvas.fill(rgba(255, 255, 255, 255))
  let src = newImage(16, 16)
  src.fill(rgba(200, 40, 40, 255))
  canvas.draw(src, translate(vec2(8, 8)), OverwriteBlend)

scenario("draw translucent image normal (blendRect path)", 0, 40, 40):
  canvas.fill(rgba(255, 255, 255, 255))
  let src = newImage(16, 16)
  src.fill(rgba(200, 40, 40, 100))
  canvas.draw(src, translate(vec2(8, 8)), NormalBlend)

scenario("draw image scaled (drawSmooth path)", 0, 40, 40):
  canvas.fill(rgba(255, 255, 255, 255))
  let src = newImage(16, 16)
  src.fill(rgba(20, 140, 40, 255))
  canvas.draw(src, translate(vec2(5, 5)) * scale(vec2(1.7, 1.3)), NormalBlend)

scenario("draw image rotated (drawSmooth path)", 0, 64, 64):
  canvas.fill(rgba(255, 255, 255, 255))
  let src = newImage(20, 20)
  src.fill(rgba(20, 40, 140, 200))
  canvas.draw(src, translate(vec2(32, 32)) * rotate(0.4.float32) * translate(vec2(-10, -10)))

scenario("draw with multiply over a grey", 0, 32, 32):
  # Multiply, screen and the other per-channel modes are exact over a grey
  # backdrop; over a coloured one the backdrop's hue is not there to blend.
  canvas.fill(rgba(200, 200, 200, 255))
  let src = newImage(16, 16)
  src.fill(rgba(100, 255, 100, 255))
  canvas.draw(src, translate(vec2(8, 8)), MultiplyBlend)

scenario("mask blend blackens outside", 0, 32, 32):
  canvas.fill(rgba(255, 255, 255, 255))
  let src = newImage(16, 16)
  src.fill(rgba(255, 255, 255, 255))
  canvas.draw(src, translate(vec2(8, 8)), MaskBlend)

scenario("gradient", 0, 40, 40):
  let paint = newPaint(LinearGradientPaint)
  paint.gradientHandlePositions = @[vec2(0, 0), vec2(40, 0)]
  paint.gradientStops = @[
    ColorStop(color: color(1, 0, 0, 1), position: 0),
    ColorStop(color: color(0, 0, 1, 1), position: 1)
  ]
  canvas.fillGradient(paint)

scenario("opacity on canvas", oneStep, 24, 24):
  canvas.fill(rgba(255, 255, 255, 255))
  canvas.applyOpacity(0.5)

block: # invert on a grey canvas is the complement
  let img = newImageGray8(24, 24)
  img.fill(rgba(255, 255, 255, 255))
  let p = newPath()
  p.rect(4, 4, 10, 10)
  img.fillPath(p, rgba(0, 0, 0, 255))
  img.invert()
  doAssert img[0, 0] == rgbx(0, 0, 0, 255)
  doAssert img[5, 5] == rgbx(255, 255, 255, 255)
  img.fill(rgba(200, 200, 200, 255))
  img.invert()
  doAssert img[0, 0] == gray8ToRgbx(55)
  img.ceil()
  doAssert img[0, 0] == gray8ToRgbx(255)

scenario("view: draw into a cell writes through, leaves the rest", 0, 40, 40):
  canvas.fill(rgba(255, 255, 255, 255))
  let cell = canvas.view(10, 10, 20, 20)
  cell.fill(rgba(0, 0, 0, 255))
  let p = newPath()
  p.circle(10, 10, 8)
  cell.fillPath(p, rgba(255, 0, 0, 255))

scenario("context API on a grey canvas", 0, 64, 64):
  canvas.fill(rgba(255, 255, 255, 255))
  let ctx = newContext(canvas)
  ctx.fillStyle = rgba(0, 100, 200, 255)
  ctx.fillRoundedRect(rect(8, 8, 40, 30), 6)
  ctx.strokeStyle = rgba(200, 0, 0, 255)
  ctx.lineWidth = 2
  ctx.strokeRect(rect(4, 4, 56, 56))

scenario("svg renderInto", oneStep, 64, 64):
  canvas.fill(rgba(255, 255, 255, 255))
  let svg = parseSvg(
    """<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">""" &
    """<circle cx="32" cy="32" r="20" fill="#2060c0"/>""" &
    """<rect x="4" y="4" width="20" height="10" fill="#c02020" opacity="0.5"/>""" &
    """</svg>""")
  svg.renderInto(canvas)

scenario("gradient-paint fillPath (mask+fill scratch path)", oneStep, 64, 64):
  canvas.fill(rgba(255, 255, 255, 255))
  let paint = newPaint(LinearGradientPaint)
  paint.gradientHandlePositions = @[vec2(8, 0), vec2(56, 0)]
  paint.gradientStops = @[
    ColorStop(color: color(1, 0, 0, 1), position: 0),
    ColorStop(color: color(0, 0, 1, 1), position: 1)
  ]
  let p = newPath()
  p.circle(32, 32, 24)
  canvas.fillPath(p, paint)

scenario("decode PNG scaled into", 0, 30, 20):
  canvas.fill(rgba(255, 255, 255, 255))
  let data = readFile("tests/fileformats/png/lenna.png")
  discard decodeImageScaledInto(data, canvas, fitCover)

scenario("decode JPEG scaled into", 0, 30, 20):
  canvas.fill(rgba(255, 255, 255, 255))
  let data = readFile("tests/fileformats/jpeg/masters/mandrill.jpg")
  discard decodeImageScaledInto(data, canvas, fitContain)

proc sourceOf(data: string): PngSourceProc =
  var pos = 0
  result = proc (dst: pointer, maxBytes: int): int =
    let n = min(min(4096, maxBytes), data.len - pos)
    if n <= 0:
      return 0
    copyMem(dst, data[pos].unsafeAddr, n)
    pos += n
    n

scenario("decode PNG streamed into", 0, 33, 21):
  canvas.fill(rgba(255, 255, 255, 255))
  let data = readFile("tests/fileformats/png/lenna.png")
  decodePngStreamScaledInto(sourceOf(data), data.len, canvas, fitStretch)

block: # encoding a grey canvas round-trips through the expansion
  let img = newImageGray8(8, 8)
  img.fill(rgba(200, 100, 50, 255))
  let png = decodeImage(encodePng(img))
  doAssert png.width == 8
  doAssert png[0, 0] == img[0, 0]

block: # a grey image as a draw SOURCE, onto RGBX and onto 565
  let src = newImageGray8(8, 8)
  src.fill(rgba(90, 90, 90, 255))
  let dst = newImage(16, 16)
  dst.fill(rgba(255, 255, 255, 255))
  dst.draw(src, translate(vec2(4, 4)))
  doAssert dst[5, 5] == src[0, 0]
  let dst565 = newImage565(16, 16)
  dst565.draw(src, translate(vec2(4, 4)))
  doAssert abs(dst565[5, 5].g.int - 90) <= 2

echo "test_gray8 ok"
