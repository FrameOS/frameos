import chroma, pixie, pixie/decodebudget, pixie/fileformats/svg, vmath

# A path filled with a paint server (gradient, image) goes through a coverage
# mask and a paint image. Under a decode budget those are strip-sized and the
# fill runs strip by strip; with no budget it is one strip, the original
# algorithm. The strips must land the same picture.

const heartShape = """
    M 10,30
    A 20,20 0,0,1 50,30
    A 20,20 0,0,1 90,30
    Q 90,60 50,90
    Q 10,60 10,30 z
  """

proc maxChannelDiff(a, b: Image): (int, int) =
  ## (largest per-channel difference, number of differing pixels)
  doAssert a.width == b.width and a.height == b.height
  var worst, differing: int
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      let
        p = a[x, y]
        q = b[x, y]
        d = max(max(abs(p.r.int - q.r.int), abs(p.g.int - q.g.int)),
                max(abs(p.b.int - q.b.int), abs(p.a.int - q.a.int)))
      if d > 0:
        inc differing
        if d > worst: worst = d
  (worst, differing)

proc verticalGradient(height: int, opacity = 1.0'f32): Paint =
  result = newPaint(LinearGradientPaint)
  result.gradientHandlePositions = @[vec2(0, 0), vec2(0, height.float32)]
  result.gradientStops = @[
    ColorStop(color: color(0.07, 0.19, 0.35, 1), position: 0),
    ColorStop(color: color(0.48, 0.12, 0.29, 1), position: 1)
  ]
  result.opacity = opacity

proc diagonalGradient(width, height: int): Paint =
  result = newPaint(LinearGradientPaint)
  result.gradientHandlePositions = @[vec2(3.5, 2.25), vec2(width.float32 - 7.5, height.float32 - 1.5)]
  result.gradientStops = @[
    ColorStop(color: color(1, 0.8, 0.2, 1), position: 0),
    ColorStop(color: color(0.2, 0.4, 1, 0.6), position: 0.45),
    ColorStop(color: color(0.1, 0.9, 0.5, 1), position: 1)
  ]

proc radialGradient(width, height: int): Paint =
  result = newPaint(RadialGradientPaint)
  result.gradientHandlePositions = @[
    vec2(width.float32 / 2, height.float32 / 2),
    vec2(width.float32, height.float32 / 2),
    vec2(width.float32 / 2, height.float32)
  ]
  result.gradientStops = @[
    ColorStop(color: color(1, 1, 1, 1), position: 0),
    ColorStop(color: color(0, 0, 0, 1), position: 1)
  ]

# Read outside the tight budgets below, which are sized for strips, not PNGs.
let mandrill = readImage("tests/fileformats/png/mandrill.png")

proc imagePaint(): Paint =
  result = newPaint(ImagePaint)
  result.image = mandrill
  result.imageMat = scale(vec2(0.35, 0.35)) * rotate(0.2'f32)

proc backdrop(width, height: int, format = pfRgbx): Image =
  result = if format == pfRgb565: newImage565(width, height) else: newImage(width, height)
  result.fill(rgba(40, 90, 160, 255))
  let paint = newPaint(SolidPaint)
  paint.color = color(1, 1, 1, 0.5)
  result.fillPath("M 0 0 L 300 0 L 0 240 z", paint, scale(vec2(width.float32 / 300, height.float32 / 240)))

const
  W = 300
  H = 240

template withBudget(bytes: int, body: untyped) =
  setDecodeBudgetBytes(bytes)
  try:
    body
  finally:
    setDecodeBudgetBytes(0)
    setDecodeContiguousBudgetBytes(0)

block: # no budget = one strip
  doAssert paintStripRows(W, H) == H
  setDecodeBudgetBytes(512 * 1024 * 1024)
  doAssert paintStripRows(W, H) == H
  setDecodeBudgetBytes(0)
  setDecodeContiguousBudgetBytes(W * 4 * 50)
  doAssert paintStripRows(W, H) == 50
  setDecodeContiguousBudgetBytes(0)
  # A provider is asked once, when the budget is first read.
  var asked {.global.} = 0
  setDecodeContiguousBudgetProvider(proc(): int =
    {.cast(gcsafe).}:
      inc asked
    W * 4 * 40)
  doAssert asked == 0
  doAssert paintStripRows(W, H) == 40
  doAssert paintStripRows(W, H) == 40
  doAssert asked == 1
  setDecodeContiguousBudgetBytes(0)
  doAssert paintStripRows(W, H) == H
  # The pair takes half the budget: budget = 4 * rowBytes * rows.
  setDecodeBudgetBytes(4 * W * 4 * 37)
  doAssert paintStripRows(W, H) == 37
  setDecodeBudgetBytes(1)
  doAssert paintStripRows(W, H) == 4, "tiny budgets keep a floor"
  doAssert paintStripRows(W, 2) == 2, "the floor never exceeds the image"
  setDecodeBudgetBytes(0)

block: # full-canvas vertical gradient rect on integer coordinates: bit-exact
  let reference = backdrop(W, H)
  reference.fillPath("M 0 0 L 300 0 L 300 240 L 0 240 z", verticalGradient(H))
  withBudget(4 * W * 4 * 23): # 23-row strips, the last one partial
    doAssert paintStripRows(W, H) == 23
    let strips = backdrop(W, H)
    strips.fillPath("M 0 0 L 300 0 L 300 240 L 0 240 z", verticalGradient(H))
    let (worst, differing) = maxChannelDiff(reference, strips)
    doAssert worst == 0 and differing == 0,
      "striped gradient rect differs: " & $worst & " in " & $differing & " px"

block: # a rect on integer coordinates, 565 target: bit-exact too
  let reference = backdrop(W, H, pfRgb565)
  reference.fillPath("M 0 0 L 300 0 L 300 240 L 0 240 z", verticalGradient(H))
  withBudget(4 * W * 4 * 23):
    let strips = backdrop(W, H, pfRgb565)
    strips.fillPath("M 0 0 L 300 0 L 300 240 L 0 240 z", verticalGradient(H))
    let (worst, differing) = maxChannelDiff(reference, strips)
    doAssert worst == 0 and differing == 0,
      "striped 565 gradient rect differs: " & $worst & " in " & $differing & " px"

# Antialiased shapes under transforms: the strip translation is exact in
# device space, so the same scanlines get the same coverage and only float32
# rounding of the moved coordinates can nudge an edge sample by a unit or two.
proc checkClose(name: string, reference, strips: Image, maxWorst = 4) =
  let (worst, differing) = maxChannelDiff(reference, strips)
  doAssert worst <= maxWorst, name & ": striped fill differs by " & $worst
  doAssert differing * 200 <= W * H,
    name & ": striped fill differs in " & $differing & " of " & $(W * H) & " px"
  echo name, ": worst=", worst, " differing=", differing

block: # heart with a diagonal gradient, opacity, transform
  proc draw(image: Image) =
    let paint = diagonalGradient(W, H)
    paint.opacity = 0.8
    image.fillPath(heartShape, paint, translate(vec2(20.5, 10.25)) * scale(vec2(2.3, 2.1)))
    image.fillPath(heartShape, radialGradient(W, H), translate(vec2(150, 40)) * scale(vec2(1.4, 1.9)))
  let reference = backdrop(W, H)
  reference.draw()
  withBudget(4 * W * 4 * 9):
    let strips = backdrop(W, H)
    strips.draw()
    checkClose("gradient hearts", reference, strips)

block: # gradient stroke, dashes, opacity
  proc draw(image: Image) =
    let paint = verticalGradient(H, 0.7)
    image.strokePath(
      heartShape, paint, translate(vec2(30, 20)) * scale(vec2(2.4, 2.0)),
      strokeWidth = 9, lineCap = RoundCap, lineJoin = RoundJoin, dashes = @[14'f32, 6'f32])
  let reference = backdrop(W, H)
  reference.draw()
  withBudget(4 * W * 4 * 16):
    let strips = backdrop(W, H)
    strips.draw()
    checkClose("gradient stroke", reference, strips)

block: # image paint and tiled image paint
  proc draw(image: Image) =
    image.fillPath(heartShape, imagePaint(), scale(vec2(2.8, 2.4)))
    let tiled = newPaint(TiledImagePaint)
    tiled.image = mandrill
    tiled.imageMat = scale(vec2(0.05, 0.05))
    tiled.opacity = 0.6
    image.fillPath("M 160 20 L 290 30 L 280 230 L 170 200 z", tiled)
  let reference = backdrop(W, H)
  reference.draw()
  withBudget(4 * W * 4 * 11):
    let strips = backdrop(W, H)
    strips.draw()
    # Image paints resample through the inverse of the strip-translated
    # matrix, so bilinear sample positions round differently than in one
    # pass: a few units on a few pixels, not a shifted picture.
    checkClose("image paints", reference, strips, maxWorst = 8)

block: # a view of a larger image as the target: strips nest in the view
  let owner = newImage(W + 40, H + 60)
  owner.fill(rgba(10, 10, 10, 255))
  let reference = owner.copy()
  reference.view(20, 30, W, H).fillPath(heartShape, diagonalGradient(W, H), scale(vec2(3, 2.4)))
  withBudget(4 * W * 4 * 7):
    owner.view(20, 30, W, H).fillPath(heartShape, diagonalGradient(W, H), scale(vec2(3, 2.4)))
    checkClose("view target", reference, owner)
    # Nothing outside the view was touched.
    for x in 0 ..< owner.width:
      doAssert owner[x, 5] == rgbx(10, 10, 10, 255)
      doAssert owner[x, owner.height - 5] == rgbx(10, 10, 10, 255)

block: # svg with a gradient background renders the same in strips
  let svg = """<svg xmlns="http://www.w3.org/2000/svg" width="300" height="240" viewBox="0 0 300 240">
<linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="240">
<stop offset="0" stop-color="#12305a"/><stop offset="1" stop-color="#7a1f4b"/></linearGradient>
<rect x="0" y="0" width="300" height="240" fill="url(#bg)"/>
<circle cx="150" cy="120" r="70" fill="#ffcc33" fill-opacity="0.7"/>
<path d="M 0 200 Q 150 40 300 200" fill="none" stroke="#33ffaa" stroke-width="6" stroke-opacity="0.8"/>
</svg>"""
  let reference = newImage(parseSvg(svg))
  withBudget(4 * W * 4 * 13):
    let strips = newImage(parseSvg(svg))
    checkClose("svg", reference, strips)
    let composed = backdrop(W, H)
    parseSvg(svg).renderInto(composed)
    let composedReference = backdrop(W, H)
    setDecodeBudgetBytes(0)
    parseSvg(svg).renderInto(composedReference)
    checkClose("svg renderInto", composedReference, composed)

block: # svg with a radial gradient background: rgbx and 565 targets, in strips
  let svg = """<svg xmlns="http://www.w3.org/2000/svg" width="300" height="240" viewBox="0 0 300 240">
<defs><radialGradient id="bg" gradientUnits="userSpaceOnUse" cx="150" cy="120" r="180">
<stop offset="0" stop-color="#7a1f4b"/><stop offset="1" stop-color="#12305a"/></radialGradient>
<radialGradient id="spot" gradientUnits="userSpaceOnUse" cx="90" cy="80" r="60" gradientTransform="rotate(30 90 80) scale(1 0.6)">
<stop offset="0" stop-color="#ffcc33" stop-opacity="0.9"/><stop offset="1" stop-color="#ffcc33" stop-opacity="0"/></radialGradient></defs>
<rect x="0" y="0" width="300" height="240" fill="url(#bg)"/>
<circle cx="150" cy="120" r="70" fill="#ffcc33" fill-opacity="0.7"/>
<path d="M 20 40 Q 120 -20 260 90 L 240 200 z" fill="url(#spot)"/>
</svg>"""
  for format in [pfRgbx, pfRgb565]:
    let reference = backdrop(W, H, format)
    parseSvg(svg).renderInto(reference)
    withBudget(4 * W * 4 * 13):
      let strips = backdrop(W, H, format)
      parseSvg(svg).renderInto(strips)
      # The rotated spot has antialiased edges; where one of those rounds a
      # level differently, a 565 target may cross a bucket (8 or 9 levels).
      checkClose("svg radial " & $format, reference, strips,
        maxWorst = if format == pfRgb565: 9 else: 4)

echo "test_paint_strips: ok"
