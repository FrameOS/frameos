import blends, chroma, common, images, vmath

# See common.nim's hotInline: per-pixel helpers inlined into -Os callers.
{.pragma: hotInline, inline, codegenDecl: "static inline __attribute__((always_inline)) $# $#$#".}


when defined(release):
  {.push checks: off.}

type
  PaintKind* = enum
    SolidPaint
    ImagePaint
    TiledImagePaint
    LinearGradientPaint
    RadialGradientPaint
    AngularGradientPaint

  Paint* = ref object
    ## Paint used to fill paths.
    kind*: PaintKind
    blendMode*: BlendMode               ## Blend mode.
    opacity*: float32
    # SolidPaint
    color*: Color                       ## Color to fill with.
    # ImagePaint, TiledImagePaint:
    image*: Image                       ## Image to fill with.
    imageMat*: Mat3                     ## Matrix of the filled image.
    # LinearGradientPaint, RadialGradientPaint, AngularGradientPaint:
    gradientHandlePositions*: seq[Vec2] ## Gradient positions (image space).
    gradientStops*: seq[ColorStop]      ## Color stops (gradient space).

  ColorStop* = object
    ## Color stop on a gradient curve.
    color*: Color      ## Color of the stop.
    position*: float32 ## Gradient stop position 0..1.

  SomePaint* = string | Paint | SomeColor

proc newPaint*(kind: PaintKind): Paint {.raises: [].} =
  ## Create a new Paint.
  result = Paint(kind: kind, opacity: 1, imageMat: mat3())

proc copy*(paint: Paint): Paint {.raises: [].} =
  ## Create a new Paint with the same properties.
  result = newPaint(paint.kind)
  result.blendMode = paint.blendMode
  result.opacity = paint.opacity
  result.color = paint.color
  result.image = paint.image
  result.imageMat = paint.imageMat
  result.gradientHandlePositions = paint.gradientHandlePositions
  result.gradientStops = paint.gradientStops

converter parseSomePaint*(paint: SomePaint): Paint {.inline.} =
  ## Given SomePaint, parse it in different ways.
  when type(paint) is string:
    result = newPaint(SolidPaint)
    try:
      result.color = parseHtmlColor(paint)
    except:
      raise newException(PixieError, "Unable to parse color " & paint)
  elif type(paint) is SomeColor:
    result = newPaint(SolidPaint)
    when type(paint) is Color:
      result.color = paint
    else:
      result.color = paint.color()
  elif type(paint) is Paint:
    paint

proc colorStop*(color: Color, position: float32): ColorStop =
  ColorStop(color: color, position: position)

proc gradientColor(paint: Paint, t: float32): ColorRGBX =
  ## Get the gradient color based on `t` - where are we related to a line.
  var index = -1
  for i, stop in paint.gradientStops:
    if stop.position < t:
      index = i
    if stop.position > t:
      break
  var color: Color
  if index == -1:
    # first stop solid
    color = paint.gradientStops[0].color
  elif index + 1 >= paint.gradientStops.len:
    # last stop solid
    color = paint.gradientStops[index].color
  else:
    let
      gs1 = paint.gradientStops[index]
      gs2 = paint.gradientStops[index + 1]
    color = mix(
      gs1.color,
      gs2.color,
      (t - gs1.position) / (gs2.position - gs1.position)
    )
  color.a *= paint.opacity
  color.rgbx()

const
  gradientLutMinSize = 1024
  gradientLutMaxSize = 8192

proc gradientLutSize(extent: float32, pixels: int, exact: bool): int =
  ## Entries in the colour table a per-pixel gradient kernel reads, or 0 to
  ## evaluate `gradientColor` at every pixel.
  ##
  ## `gradientColor` walks the stops, mixes two float colours and converts to
  ## premultiplied bytes: ~100 cycles a pixel, which on a 1200x1600 canvas is
  ## most of a second on an ESP32. A table sampled at more than two entries
  ## per pixel of `extent` (the gradient's length in pixels, t = 0..1) and
  ## read at the nearest entry is at most half an entry off in t, so under a
  ## quarter of a colour level: the same picture, with some pixels rounding a
  ## level the other way (two where alpha ramps too, since premultiplying
  ## rounds again). Small fills evaluate exactly; the table would cost more
  ## than it saves.
  if exact:
    return 0
  var want = gradientLutMaxSize
  if extent < gradientLutMaxSize.float32: # false for NaN, which caps
    want = max(gradientLutMinSize, int(extent * 2))
  if pixels < 2 * want:
    return 0
  want

proc gradientLut(paint: Paint, size: int): seq[ColorRGBX] =
  ## The gradient's colours at t = i / (size - 1).
  result = newSeq[ColorRGBX](size)
  let last = (size - 1).float32
  for i in 0 ..< size:
    result[i] = paint.gradientColor(i.float32 / last)

proc fastSqrt(x: float32): float32 {.hotInline.} =
  ## sqrt to 5e-6 relative, from a reciprocal-square-root seed refined twice.
  ## For the colour-table kernels, whose t is quantised to 1/1024 at best:
  ## where the FPU has no square root (Xtensa) `sqrtf` is a library call of
  ## a hundred-odd cycles, and a radial fill does one per pixel. Nothing to
  ## a host, which does this in a similar time in hardware.
  if not (x > 0): # zero, negative rounding noise, or NaN
    return 0
  var seed = cast[uint32](x)
  seed = 0x5f3759df'u32 - (seed shr 1)
  var y = cast[float32](seed)
  let xh = 0.5'f32 * x
  y = y * (1.5'f32 - xh * y * y)
  y = y * (1.5'f32 - xh * y * y)
  x * y

template lutIndex(t: float32, last: int): int =
  ## Nearest table entry. Outside 0..1 the gradient pads with its end colours,
  ## which are the table's ends; NaN (a degenerate gradient) takes the first
  ## stop, as `gradientColor` does.
  (if not (t > 0): 0 elif t >= 1: last else: int(t * last.float32 + 0.5'f32))

type
  GradientForm = enum
    gfHorizontal, gfVertical, gfLinear, gfRadial, gfAngular

  GradientRows* = object
    ## A gradient a span of a row at a time: the colours `fillGradient`
    ## writes into pixels (x0 ..< x1, y) of an image `width` wide, without
    ## the image. What a fill only partly covers (a shape filled with a
    ## gradient straight into a grey canvas) evaluates only what it covers.
    empty*: bool ## nothing to paint (the paint's opacity is 0)
    paint: Paint
    form: GradientForm
    origin: Vec2
    lut: seq[ColorRGBX] ## colours at t = i / last, when `throughTable`
    last: int
    throughTable: bool
    row0: seq[ColorRGBX] ## a horizontal gradient's one row of colours
    at, to, center: Vec2
    m00, m01, m10, m11, m20, m21, angle: float32
    # For a grey target (`prepareGrey`): `lut` (or `row0`) as the luma and
    # the alpha of each colour under one coverage.
    lumaLut, alphaLut: seq[uint8]
    greyCoverage: uint8
    greyReady*: bool ## `prepareGrey` said yes: `greyRow` may be read
    thresholds: seq[float32] ## a radial table's: entry k holds while t * t is under thresholds[k]
    clearTo, clearFrom: int  ## a radial table's entries up to clearTo, and from clearFrom on, paint nothing

proc toLineSpace(at, to, point: Vec2): float32 {.inline.} =
  ## Convert position on to where it would fall on a line between at and to.
  let
    d = to - at
    det = d.x * d.x + d.y * d.y
  (d.y * (point.y - at.y) + d.x * (point.x - at.x)) / det

proc initGradientRows*(
  paint: Paint, origin: Vec2, exact: bool, pixels, width, height: int
): GradientRows {.raises: [PixieError].} =
  ## The rows of `paint` (a gradient) as `fillGradient` would fill them into
  ## a `width` x `height` image at `origin`; `pixels` decides for the colour
  ## table (see `gradientLutSize`). Reads the paint's opacity as it is now:
  ## keep it until the last row is read.
  var extent: float32
  case paint.kind:
  of LinearGradientPaint:
    if paint.gradientHandlePositions.len != 2:
      raise newException(PixieError, "Linear gradient requires 2 handles")
  of RadialGradientPaint:
    if paint.gradientHandlePositions.len != 3:
      raise newException(PixieError, "Radial gradient requires 3 handles")
  of AngularGradientPaint:
    if paint.gradientHandlePositions.len != 3:
      raise newException(PixieError, "Angular gradient requires 2 handles")
  else:
    raise newException(PixieError, "Paint must be a gradient")
  if paint.gradientStops.len == 0:
    raise newException(PixieError, "Gradient must have at least 1 color stop")

  paint.opacity = clamp(paint.opacity, 0, 1)
  result.paint = paint
  result.origin = origin
  if paint.opacity == 0:
    result.empty = true
    return

  case paint.kind:
  of LinearGradientPaint:
    result.at = paint.gradientHandlePositions[0]
    result.to = paint.gradientHandlePositions[1]
    if result.at.y == result.to.y: # one row of colours, every row alike
      result.form = gfHorizontal
      result.row0 = newSeq[ColorRGBX](width)
      for x in 0 ..< width:
        result.row0[x] = paint.gradientColor(toLineSpace(
          result.at, result.to, vec2(x.float32 + origin.x, origin.y)))
      return
    if result.at.x == result.to.x: # one colour a row
      result.form = gfVertical
      return
    result.form = gfLinear
    extent = dist(result.at, result.to)
  of RadialGradientPaint:
    # t is the distance from the centre in a space where the edge and skew
    # handles are one unit away, so the stops sit on ellipses.
    let
      center = paint.gradientHandlePositions[0]
      edge = paint.gradientHandlePositions[1]
      skew = paint.gradientHandlePositions[2]
      distanceX = dist(center, edge)
      distanceY = dist(center, skew)
      gradientAngle = normalize(center - edge).angle().fixAngle()
      mat = (
        translate(center) *
        rotate(gradientAngle) *
        scale(vec2(distanceX, distanceY))
      ).inverse()
    # `mat * xy` spelled out, with the row term hoisted out of the pixel loop.
    # The additions keep vmath's order so t is the value it always was.
    result.form = gfRadial
    result.m00 = mat[0, 0]
    result.m01 = mat[0, 1]
    result.m10 = mat[1, 0]
    result.m11 = mat[1, 1]
    result.m20 = mat[2, 0]
    result.m21 = mat[2, 1]
    extent = max(distanceX, distanceY)
  else:
    # TODO: make edge between start and end anti-aliased.
    result.form = gfAngular
    result.center = paint.gradientHandlePositions[0]
    result.angle = normalize(
      paint.gradientHandlePositions[1] - result.center).angle().fixAngle()
    # t runs 0..1 around the circle; the outermost pixels of the fill go
    # round it in about pi * (width + height) steps.
    extent = PI.float32 * (width + height).float32

  let lutSize = gradientLutSize(extent, pixels, exact)
  if lutSize > 0:
    result.lut = paint.gradientLut(lutSize)
    result.last = lutSize - 1
    result.throughTable = true
    if result.form == gfRadial:
      # Entry k is the nearest to t * last: for t * last under k + 0.5, so
      # for t * t under ((k + 0.5) / last) squared.
      result.thresholds = newSeq[float32](lutSize)
      let inv = 1'f32 / result.last.float32
      for k in 0 ..< result.last:
        let edge = (k.float32 + 0.5'f32) * inv
        result.thresholds[k] = edge * edge
      result.thresholds[result.last] = Inf
      # A glow fades to nothing at its edge and a vignette starts from
      # nothing: the entries with no ink at either end (`inkSpans`).
      result.clearTo = -1
      while result.clearTo < result.last and result.lut[result.clearTo + 1].a == 0:
        inc result.clearTo
      result.clearFrom = lutSize
      while result.clearFrom > 0 and result.lut[result.clearFrom - 1].a == 0:
        dec result.clearFrom

template forEachT(g: GradientRows, y, x0, x1: int, body: untyped) =
  ## A diagonal, radial or angular gradient's `t` at each pixel `x` of
  ## x0 ..< x1 in row `y`, for a gradient with no table (`gradientColor` at
  ## every pixel) and for an angular one's table.
  let
    origin = g.origin
    rowY = y.float32 + origin.y
  case g.form:
  of gfLinear:
    # toLineSpace, written out: the row's term once, and no Vec2 per pixel
    # (each one calls on an -Os firmware). The same operations in the same
    # order, so the same t.
    let
      dx = g.to.x - g.at.x
      dy = g.to.y - g.at.y
      det = dx * dx + dy * dy
      rowTerm = dy * (rowY - g.at.y)
    for x {.inject.} in x0 ..< x1:
      let t {.inject.} = (rowTerm + dx * (x.float32 + origin.x - g.at.x)) / det
      body
  of gfRadial:
    let
      rowX10 = g.m10 * rowY
      rowX11 = g.m11 * rowY
    for x {.inject.} in x0 ..< x1:
      let
        px0 = x.float32 + origin.x
        px = g.m00 * px0 + rowX10 + g.m20
        py = g.m01 * px0 + rowX11 + g.m21
        t {.inject.} = sqrt(px * px + py * py)
      body
  of gfAngular:
    let f32PI = PI.float32
    for x {.inject.} in x0 ..< x1:
      let t {.inject.} = (normalize(vec2(x.float32 + origin.x, rowY) - g.center).angle() +
        g.angle + f32PI / 2).fixAngle() / 2 / f32PI + 0.5.float32
      body
  else:
    discard

const radialSeedEvery = 32
  ## A radial row's place in the gradient is worked out from its x at every
  ## pixel of the image whose x is a multiple of this, and stepped by one
  ## pixel's worth from there: what a pixel gets depends on where it is
  ## alone, and the steps' rounding never adds up to a thousandth of a table
  ## entry.

template forEachIndex(g: GradientRows, y, x0, x1: int, body: untyped) =
  ## The table entry `index` of each pixel `x` of x0 ..< x1 in row `y`, for a
  ## diagonal, radial or angular gradient read through its table: the entry
  ## nearest to t * last. A division (a diagonal) or a square root (a radial)
  ## a pixel is a library call where the FPU has neither: three such
  ## backgrounds over each other took 2.5 s of a 1872x1404 frame on an
  ## ESP32-S3 with the mask already gone (the reTerminal E1003, 2026-11-18).
  ## So neither is made. The entry may be the neighbour of the one the
  ## division or the root would round to, for a pixel on the line between
  ## two: half an entry in t, a quarter of a colour level at the most.
  let
    origin = g.origin
    rowY = y.float32 + origin.y
    last = g.last
  case g.form:
  of gfLinear:
    # t is linear along a row, so t * last + 0.5 is a sum: in 32.32 fixed
    # point from the row's first pixel (x = 0, so a span starts where any
    # other span of the row would have it), its whole part the entry.
    let
      dx = (g.to.x - g.at.x).float64
      dy = (g.to.y - g.at.y).float64
      scale = last.float64 / (dx * dx + dy * dy)
      first = (dy * (rowY.float64 - g.at.y.float64) + dx * (origin.x.float64 - g.at.x.float64)) * scale + 0.5
      # Past either end of any table, and a row of any width stays in 64 bits.
      step = int64(clamp(dx * scale, -65536.0, 65536.0) * 4294967296.0)
    var at = int64(clamp(first, -268435456.0, 268435456.0) * 4294967296.0) + step * x0.int64
    for x {.inject.} in x0 ..< x1:
      let
        whole = ashr(at, 32)
        index {.inject.} = (if whole < 0: 0 elif whole > last: last else: whole.int)
      body
      at += step
  of gfRadial:
    # The squared distance against the table's thresholds, the entry stepped
    # from the pixel before: next to it, an entry or two away.
    let
      rowX10 = g.m10 * rowY
      rowX11 = g.m11 * rowY
      thresholds = cast[ptr UncheckedArray[float32]](g.thresholds[0].unsafeAddr)
      # Seeded by where the pixel is in the image, not in these rows: a fill
      # that counts its rows from elsewhere reads the same entries.
      originX = origin.x.int
      originFraction = origin.x - originX.float32
    var
      k = -1
      px, py: float32
    for x {.inject.} in x0 ..< x1:
      let imageX = x + originX
      if (imageX and (radialSeedEvery - 1)) == 0 or x == x0:
        let
          seedX = imageX - (imageX and (radialSeedEvery - 1))
          px0 = seedX.float32 + originFraction
        px = g.m00 * px0 + rowX10 + g.m20
        py = g.m01 * px0 + rowX11 + g.m21
        for _ in seedX ..< imageX:
          px += g.m00
          py += g.m01
      let d2 = px * px + py * py
      if k >= 0:
        # A few entries at the most; further than that, or not a number, below.
        var steps = 0
        while d2 >= thresholds[k] and steps < 4:
          inc k
          inc steps
        while k > 0 and d2 < thresholds[k - 1] and steps < 4:
          dec k
          inc steps
        if not (d2 < thresholds[k] and (k == 0 or d2 >= thresholds[k - 1])):
          k = -1
      if k < 0:
        k = lutIndex(fastSqrt(d2), last)
        while d2 >= thresholds[k]:
          inc k
        while k > 0 and d2 < thresholds[k - 1]:
          dec k
      let index {.inject.} = k
      body
      px += g.m00
      py += g.m01
  of gfAngular:
    let f32PI = PI.float32
    for x {.inject.} in x0 ..< x1:
      let index {.inject.} = lutIndex((normalize(vec2(x.float32 + origin.x, rowY) - g.center).angle() +
        g.angle + f32PI / 2).fixAngle() / 2 / f32PI + 0.5.float32, last)
      body
  else:
    discard

proc row*(
  g: GradientRows, y, x0, x1: int, dst: ptr UncheckedArray[ColorRGBX]
) {.raises: [].} =
  ## Pixels x0 ..< x1 of row `y` into `dst[0 ..< x1 - x0]`.
  case g.form:
  of gfHorizontal:
    for x in x0 ..< x1:
      dst[x - x0] = g.row0[x]
  of gfVertical:
    let c = g.paint.gradientColor(
      toLineSpace(g.at, g.to, vec2(g.origin.x, y.float32 + g.origin.y)))
    for i in 0 ..< x1 - x0:
      dst[i] = c
  elif g.throughTable:
    # The table through a plain pointer: a checked seq index a pixel was
    # a call on an -Os firmware.
    let lut = cast[ptr UncheckedArray[ColorRGBX]](g.lut[0].unsafeAddr)
    g.forEachIndex(y, x0, x1):
      dst[x - x0] = lut[index]
  else:
    g.forEachT(y, x0, x1):
      dst[x - x0] = g.paint.gradientColor(t)

proc covered(c: ColorRGBX, coverage: uint8): ColorRGBX {.inline.} =
  ## A colour under a mask's coverage, as the masked fill multiplies it.
  if coverage == 255: c
  else: blendMask(c, rgbx(coverage, coverage, coverage, coverage))

proc prepareGrey*(g: var GradientRows, coverage: uint8): bool {.raises: [].} =
  ## For a fill into a grey image under one `coverage` everywhere (a box of
  ## whole pixels): the luma and the alpha of every colour the rows read,
  ## once, where they come from a table or from a horizontal gradient's one
  ## row. `greyRow` then hands each row out as two bytes a pixel, and the
  ## store needs no colour: blended normally over a grey backdrop G the luma
  ## of the result is exactly luma + G * (255 - alpha) / 255, since the
  ## backdrop adds the same to every channel. False for a gradient evaluated
  ## a pixel at a time (a small image's): its colours come from `row`.
  g.greyCoverage = coverage
  template lines(colors: seq[ColorRGBX]) =
    g.lumaLut = newSeq[uint8](colors.len)
    g.alphaLut = newSeq[uint8](colors.len)
    for i in 0 ..< colors.len:
      let c = colors[i].covered(coverage)
      g.lumaLut[i] = rgbxToGray8(c)
      g.alphaLut[i] = c.a
  case g.form:
  of gfHorizontal: lines(g.row0)
  of gfVertical: discard
  elif g.throughTable: lines(g.lut)
  else: return false
  g.greyReady = true
  true

proc greyRow*(
  g: GradientRows, y, x0, x1: int, luma, alpha: ptr UncheckedArray[uint8]
) {.raises: [].} =
  ## After `prepareGrey`: pixels x0 ..< x1 of row `y` as luma and alpha,
  ## `row`'s colours under the coverage.
  case g.form:
  of gfHorizontal:
    copyMem(luma, g.lumaLut[x0].unsafeAddr, x1 - x0)
    copyMem(alpha, g.alphaLut[x0].unsafeAddr, x1 - x0)
  of gfVertical:
    let c = g.paint.gradientColor(
      toLineSpace(g.at, g.to, vec2(g.origin.x, y.float32 + g.origin.y))).covered(g.greyCoverage)
    let l = rgbxToGray8(c)
    for i in 0 ..< x1 - x0:
      luma[i] = l
      alpha[i] = c.a
  else:
    let
      lumaLut = cast[ptr UncheckedArray[uint8]](g.lumaLut[0].unsafeAddr)
      alphaLut = cast[ptr UncheckedArray[uint8]](g.alphaLut[0].unsafeAddr)
    g.forEachIndex(y, x0, x1):
      luma[x - x0] = lumaLut[index]
      alpha[x - x0] = alphaLut[index]

proc inkSpans*(
  g: GradientRows, y, x0, x1: int, spans: var array[2, tuple[a, b: int]]
): int {.raises: [].} =
  ## The parts of x0 ..< x1 of row `y` where the gradient may paint, at most
  ## two; the rest is certainly transparent and needs no look. All of the
  ## row unless the gradient is a radial one read through a table whose ends
  ## hold no ink: a glow that fades out paints inside an ellipse, a vignette
  ## outside one, and over a page that is most of the page left alone (a
  ## corner glow and a vignette were two thirds of a 1872x1404 frame's
  ## gradient pixels, the reTerminal E1003, 2026-11-18). The ellipse's
  ## crossings of the row are where the squared distance meets the table's
  ## threshold, a quadratic in x; two pixels of margin on the painted side,
  ## since the rows step their distance and this solves for it.
  spans[0] = (x0, x1)
  if g.form != gfRadial or not g.throughTable or (g.clearTo < 0 and g.clearFrom > g.last):
    return 1
  if g.clearFrom == 0:
    return 0
  let
    rowY = y.float32 + g.origin.y
    bx = g.m00 * g.origin.x + g.m10 * rowY + g.m20
    by = g.m01 * g.origin.x + g.m11 * rowY + g.m21
    qa = g.m00 * g.m00 + g.m01 * g.m01
    qb = 2 * (g.m00 * bx + g.m01 * by)
    qc = bx * bx + by * by
    left = x0.float32 - 8
    right = x1.float32 + 8
  if not (qa > 0):
    return 1
  var lo, hi: float32
  template under(threshold: float32): bool =
    # Whether the row comes under `threshold` at all: between lo and hi if so.
    let disc = qb * qb - 4 * qa * (qc - threshold)
    if disc > 0:
      let reach = sqrt(disc)
      lo = clamp((-qb - reach) / (2 * qa), left, right)
      hi = clamp((-qb + reach) / (2 * qa), left, right)
      true
    else:
      false
  var
    a = x0
    b = x1
  if g.clearFrom <= g.last:
    if not under(g.thresholds[g.clearFrom - 1]):
      return 0
    a = max(a, floor(lo).int - 2)
    b = min(b, ceil(hi).int + 3)
    if a >= b:
      return 0
    spans[0] = (a, b)
  if g.clearTo >= 0 and under(g.thresholds[g.clearTo]):
    let
      holeA = max(a, ceil(lo).int + 2)
      holeB = min(b, floor(hi).int - 2)
    if holeB > holeA:
      spans[0] = (a, holeA)
      spans[1] = (holeB, b)
      if holeA <= a:
        spans[0] = spans[1]
        return (if holeB < b: 1 else: 0)
      return (if holeB < b: 2 else: 1)
  1

proc readsPlainRows*(g: GradientRows): bool {.inline, raises: [].} =
  ## Whether a row reads only tables (no paint, no stop): what a second
  ## core's task may run (`rowsRunner`).
  g.form == gfHorizontal or (g.form != gfVertical and g.throughTable)

proc fillGradient*(
  image: Image, paint: Paint, origin = vec2(0, 0), exact = false, pixels = -1
) {.raises: [PixieError].} =
  ## Fills with the Paint gradient. `origin` is where the image's top-left
  ## pixel sits in the gradient's coordinate space: filling a strip at
  ## `origin = (0, y)` lands exactly the colours rows y.. of a whole-surface
  ## fill would, which is what lets `fillPath` paint in strips.
  ##
  ## Radial, angular and diagonal linear gradients read their colours from a
  ## table (see `gradientLutSize`) once the fill is large enough to pay for
  ## one; `exact = true` evaluates the colour ramp at every pixel instead.
  ## `pixels`: the size of the whole fill `image` is a strip of, which is
  ## what decides for the table, so that every strip of one fill decides
  ## alike (the image's own size when -1).
  let g = initGradientRows(paint, origin, exact,
    if pixels >= 0: pixels else: image.width * image.height,
    image.width, image.height)
  if g.empty or image.width == 0:
    return
  if image.format == pfRgbx:
    for y in 0 ..< image.height:
      g.row(y, 0, image.width,
        cast[ptr UncheckedArray[ColorRGBX]](image.data[image.dataIndex(0, y)].addr))
  else:
    # Through the store of the image's format: a 4-bit one dithers each
    # row by its place.
    var colors = newSeq[ColorRGBX](image.width)
    let line = cast[ptr UncheckedArray[ColorRGBX]](colors[0].addr)
    for y in 0 ..< image.height:
      g.row(y, 0, image.width, line)
      let rowIndex = image.dataIndex(0, y)
      for x in 0 ..< image.width:
        image.setPixel(rowIndex + x, colors[x])

when defined(release):
  {.pop.}
