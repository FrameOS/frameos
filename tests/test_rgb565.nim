## The 565 surface, tested as an oracle: every scenario is drawn onto an RGBX
## canvas and onto a 565 canvas with the same calls, and the RGBX result
## quantised to 565 must come out the same. Where the backdrop is an exactly
## representable colour (white, black) and the drawing is a single layer the
## match is bit-exact, because both paths run the same 8-bit blend and the
## only difference is where the final pack happens. Compound cases (layers
## over layers, non-representable backdrops) are allowed one 5-bit step:
## adjacent 5-bit codes expand 8 or 9 apart, so `oneStep = 9`.

import pixie, pixie/fileformats/png, pixie/fileformats/jpeg, pixie/fileformats/svg, strformat

proc maxChannelDiff(a565, b: Image): int =
  ## Largest per-channel difference between a 565 image and any image, read
  ## back as expanded RGB (alpha ignored — a 565 image has none).
  doAssert a565.format == pfRgb565
  doAssert a565.width == b.width and a565.height == b.height
  for y in 0 ..< a565.height:
    for x in 0 ..< a565.width:
      let
        p = a565.unsafe[x, y]
        q = b.unsafe[x, y]
      result = max(result, abs(p.r.int - q.r.int))
      result = max(result, abs(p.g.int - q.g.int))
      result = max(result, abs(p.b.int - q.b.int))

template both(w, h: int, body: untyped) =
  ## Runs `body` once with `canvas` an RGBX image and once a 565 one, then
  ## yields the pair as (rgbx, packed) for comparison.
  block:
    let rgbxCanvas = newImage(w, h)
    let packedCanvas = newImage565(w, h)
    block:
      let canvas {.inject.} = rgbxCanvas
      body
    block:
      let canvas {.inject.} = packedCanvas
      body
    check(rgbxCanvas, packedCanvas)

var checkTolerance = 0
var checkName = ""
proc check(rgbxCanvas, packedCanvas: Image) =
  let
    oracle = rgbxCanvas.toRgb565Image()
    diff = maxChannelDiff(packedCanvas, oracle)
  doAssert diff <= checkTolerance,
    &"{checkName}: 565 canvas differs from quantised RGBX by {diff} (> {checkTolerance})"

const oneStep = 9

template scenario(name: string, tolerance: int, w, h: int, body: untyped) =
  checkName = name
  checkTolerance = tolerance
  both(w, h, body)

block: # pack / unpack properties
  # Endpoints survive, expansion is exact at 0 and 255.
  doAssert rgbxToRgb565(rgbx(0, 0, 0, 255)) == 0
  doAssert rgbxToRgb565(rgbx(255, 255, 255, 255)) == 0xFFFF
  doAssert rgb565ToRgbx(0) == rgbx(0, 0, 0, 255)
  doAssert rgb565ToRgbx(0xFFFF) == rgbx(255, 255, 255, 255)
  # Round to nearest, bounded error, idempotent round trip.
  for v in 0 .. 255:
    let
      c = rgbx(v.uint8, v.uint8, v.uint8, 255)
      back = rgb565ToRgbx(rgbxToRgb565(c))
    doAssert abs(back.r.int - v) <= 4
    doAssert abs(back.g.int - v) <= 2
    doAssert abs(back.b.int - v) <= 4
    doAssert rgbxToRgb565(back) == rgbxToRgb565(c)
  # Alpha is dropped, premultiplied colour kept, reads come back opaque.
  let half = rgb565ToRgbx(rgbxToRgb565(rgbx(128, 64, 32, 128)))
  doAssert half.a == 255
  doAssert abs(half.r.int - 128) <= 4

block: # construction, views, copies
  let img = newImage565(10, 6)
  doAssert img.format == pfRgb565
  doAssert img.bytesPerPixel == 2
  doAssert img.isOpaque
  doAssert not img.isTransparent
  doAssert img.opaqueBounds == rect(0, 0, 10, 6)
  img.fill(rgba(10, 200, 30, 255))
  doAssert img.isOneColor
  let v = img.view(2, 1, 4, 3)
  doAssert v.format == pfRgb565
  v.fill(rgba(255, 0, 0, 255))
  doAssert img[2, 1] == rgb565ToRgbx(rgbxToRgb565(rgbx(255, 0, 0, 255)))
  doAssert img[1, 1] == rgb565ToRgbx(rgbxToRgb565(rgbx(10, 200, 30, 255)))
  doAssert img[6, 1] == rgb565ToRgbx(rgbxToRgb565(rgbx(10, 200, 30, 255)))
  let c = img.copy()
  doAssert c.format == pfRgb565
  doAssert c.pixelsEqual(img)
  let asRgbx = img.toRgbxImage()
  doAssert asRgbx.format == pfRgbx
  doAssert img.pixelsEqual(asRgbx) # cross-format compare reads both back
  doAssert img.toContiguousSeq()[0] == img[0, 0]
  let sub = img.subImage(2, 1, 4, 3)
  doAssert sub.format == pfRgb565 and sub.pixelsEqual(v)
  # flips and rotate keep the format
  let f = img.copy()
  f.flipHorizontal()
  doAssert f[9 - 2, 1] == img[2, 1]
  f.flipVertical()
  doAssert f[9 - 2, 5 - 1] == img[2, 1]
  let r = img.copy()
  r.rotate90()
  doAssert r.width == 6 and r.height == 10 and r.format == pfRgb565
  # external buffer
  var buf = newSeq[uint16](8 * 4)
  let over = newImage565Over(8, 4, buf[0].addr)
  over.fill(rgba(255, 255, 255, 255))
  doAssert buf[0] == 0xFFFF and buf[31] == 0xFFFF
  doAssert newImage565Over(8, 4, buf[0].addr).isView == false

block: # what a 565 image refuses, and what it converts for
  let img = newImage565(8, 8)
  doAssertRaises PixieError:
    discard img.shadow(vec2(1, 1), 1, 1, rgba(0, 0, 0, 255))
  # Scaling converts through RGBX rather than refusing.
  img.fill(rgba(200, 100, 50, 255))
  let small = img.minifyBy2()
  doAssert small.format == pfRgbx and small.width == 4
  doAssert abs(small[0, 0].r.int - 200) <= 4
  let big = img.magnifyBy2()
  doAssert big.format == pfRgbx and big.width == 16
  let rs = img.resize(4, 4)
  doAssert rs.width == 4

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
  canvas.fillText(font, "565 ok", translate(vec2(4, 4)))

scenario("text stroke over white", 0, 120, 40):
  canvas.fill(rgba(255, 255, 255, 255))
  let font = readFont("tests/fonts/Roboto-Regular_1.ttf")
  font.size = 24
  font.paint = rgba(0, 80, 160, 255)
  canvas.strokeText(font, "565 ok", translate(vec2(4, 4)), strokeWidth = 1.5)

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

scenario("draw with multiply blend", 0, 32, 32):
  canvas.fill(rgba(255, 200, 200, 255))
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

scenario("opacity on canvas", 0, 24, 24):
  canvas.fill(rgba(255, 255, 255, 255))
  canvas.applyOpacity(0.5)

block: # invert on a 565 canvas is the RGB complement
  # (Not oracle-tested: RGBX `invert` also inverts alpha, which turns an
  # opaque canvas into transparent black — rgb 0 everywhere once a driver
  # reads it. A 565 image has no alpha to invert, so it gives the picture.)
  let img = newImage565(24, 24)
  img.fill(rgba(255, 255, 255, 255))
  let p = newPath()
  p.rect(4, 4, 10, 10)
  img.fillPath(p, rgba(0, 0, 0, 255))
  img.invert()
  doAssert img[0, 0] == rgbx(0, 0, 0, 255)
  doAssert img[5, 5] == rgbx(255, 255, 255, 255)
  img.fill(rgba(200, 100, 50, 255))
  img.invert()
  doAssert abs(img[0, 0].r.int - 55) <= 4
  doAssert abs(img[0, 0].g.int - 155) <= 2
  doAssert abs(img[0, 0].b.int - 205) <= 4

scenario("view: draw into a cell writes through, leaves the rest", 0, 40, 40):
  canvas.fill(rgba(255, 255, 255, 255))
  let cell = canvas.view(10, 10, 20, 20)
  cell.fill(rgba(0, 0, 0, 255))
  let p = newPath()
  p.circle(10, 10, 8)
  cell.fillPath(p, rgba(255, 0, 0, 255))

scenario("context API on a 565 canvas", 0, 64, 64):
  canvas.fill(rgba(255, 255, 255, 255))
  let ctx = newContext(canvas)
  ctx.fillStyle = rgba(0, 100, 200, 255)
  ctx.fillRoundedRect(rect(8, 8, 40, 30), 6)
  ctx.strokeStyle = rgba(200, 0, 0, 255)
  ctx.lineWidth = 2
  ctx.strokeRect(rect(4, 4, 56, 56))

scenario("svg renderInto", 0, 64, 64):
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

block: # encoding a 565 canvas round-trips through the expansion
  let img = newImage565(8, 8)
  img.fill(rgba(200, 100, 50, 255))
  let png = decodeImage(encodePng(img))
  doAssert png.width == 8
  doAssert png[0, 0] == img[0, 0]

block: # a 565 image as a draw SOURCE onto RGBX
  let src = newImage565(8, 8)
  src.fill(rgba(200, 100, 50, 255))
  let dst = newImage(16, 16)
  dst.fill(rgba(255, 255, 255, 255))
  dst.draw(src, translate(vec2(4, 4)))
  doAssert dst[5, 5] == src[0, 0]
  doAssert dst[5, 5].a == 255
  dst.draw(src, translate(vec2(2, 2)) * scale(vec2(1.5, 1.5)))
  doAssert dst[8, 8] == src[0, 0]

block: # a 565 picture drawn at its own size onto 565 is its rows, clipped at the edges
  let src = newImage565(12, 10)
  for y in 0 ..< 10:
    for x in 0 ..< 12:
      src[x, y] = rgba((x * 20).uint8, (y * 25).uint8, 90, 255)
  for (dx, dy) in [(3, 2), (-4, -3), (10, 6)]:
    for mode in [NormalBlend, OverwriteBlend]:
      let dst = newImage565(16, 12)
      dst.ditherStores = true
      dst.fill(rgba(255, 255, 255, 255))
      dst.draw(src, translate(vec2(dx.float32, dy.float32)), mode)
      for y in 0 ..< 12:
        for x in 0 ..< 16:
          let want =
            if x - dx in 0 ..< 12 and y - dy in 0 ..< 10: src[x - dx, y - dy]
            else: rgba(255, 255, 255, 255).rgbx
          doAssert dst[x, y] == want, &"{mode} at ({dx}, {dy}): ({x}, {y}) is {dst[x, y]}, not {want}"

echo "test_rgb565 ok"
