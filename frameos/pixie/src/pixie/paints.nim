import chroma, common, images, simd, vmath

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

proc fastSqrt(x: float32): float32 {.inline.} =
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

template fillPerPixel(
  image: Image, paint: Paint, extent: float32, exact: bool, pixels: int,
  rowSetup, tAt: untyped
) =
  ## Writes every pixel of `image` with the gradient colour at the `t` that
  ## `tAt` computes for the injected pixel `x`, `y`; `rowSetup` runs once per
  ## row for whatever `tAt` wants precomputed. Colours come from the table
  ## when `gradientLutSize` says the fill is large enough to pay for one;
  ## `tAt` sees which through the injected `throughTable`.
  let lutSize = gradientLutSize(extent,
    if pixels >= 0: pixels else: image.width * image.height, exact)
  if lutSize == 0:
    let throughTable {.inject.} = false
    for y {.inject.} in 0 ..< image.height:
      let rowIndex = image.dataIndex(0, y)
      rowSetup
      for x {.inject.} in 0 ..< image.width:
        image.setPixel(rowIndex + x, paint.gradientColor(tAt))
  else:
    let
      lut = paint.gradientLut(lutSize)
      last = lutSize - 1
      throughTable {.inject.} = true
    for y {.inject.} in 0 ..< image.height:
      let rowIndex = image.dataIndex(0, y)
      rowSetup
      for x {.inject.} in 0 ..< image.width:
        image.setPixel(rowIndex + x, lut[lutIndex(tAt, last)])

proc fillGradientLinear(
  image: Image, paint: Paint, origin: Vec2, exact: bool, pixels: int
) =
  ## Fills a linear gradient. Pixel (x, y) of `image` takes the colour the
  ## gradient has at `origin + (x, y)`, so a strip of a larger surface can be
  ## filled with exactly the colours the whole surface would get.

  if paint.gradientHandlePositions.len != 2:
    raise newException(PixieError, "Linear gradient requires 2 handles")

  if paint.gradientStops.len == 0:
    raise newException(PixieError, "Gradient must have at least 1 color stop")

  paint.opacity = clamp(paint.opacity, 0, 1)
  if paint.opacity == 0:
    return

  proc toLineSpace(at, to, point: Vec2): float32 {.inline.} =
    ## Convert position on to where it would fall on a line between at and to.
    let
      d = to - at
      det = d.x * d.x + d.y * d.y
    (d.y * (point.y - at.y) + d.x * (point.x - at.x)) / det

  let
    at = paint.gradientHandlePositions[0]
    to = paint.gradientHandlePositions[1]

  if at.y == to.y: # Horizontal gradient: one row of colours, copied down
    if image.height > 0:
      for x in 0 ..< image.width:
        let t = toLineSpace(at, to, vec2(x.float32 + origin.x, origin.y))
        image.unsafe[x, 0] = paint.gradientColor(t)
      let
        rowBytes = image.width * image.bytesPerPixel
        first = image.pixelAddr(image.dataIndex(0, 0))
      for y in 1 ..< image.height:
        copyMem(image.pixelAddr(image.dataIndex(0, y)), first, rowBytes)

  elif at.x == to.x: # Vertical gradient
    for y in 0 ..< image.height:
      let
        xy = vec2(origin.x, y.float32 + origin.y)
        t = toLineSpace(at, to, xy)
        rgbx = paint.gradientColor(t)
      var x: int
      when allowSimd:
        if image.format == pfRgbx:
          when defined(amd64):
            let colorVec = mm_set1_epi32(cast[int32](rgbx))
            for _ in 0 ..< image.width div 4:
              mm_storeu_si128(image.data[image.dataIndex(x, y)].addr, colorVec)
              x += 4
          elif defined(arm64):
            let colorVec = vmovq_n_u32(cast[uint32](rgbx))
            for _ in 0 ..< image.width div 4:
              vst1q_u32(image.data[image.dataIndex(x, y)].addr, colorVec)
              x += 4
      for x in x ..< image.width:
        image.unsafe[x, y] = rgbx

  else:
    image.fillPerPixel(paint, dist(at, to), exact, pixels):
      let rowY = y.float32 + origin.y
    do:
      toLineSpace(at, to, vec2(x.float32 + origin.x, rowY))

proc fillGradientRadial(
  image: Image, paint: Paint, origin: Vec2, exact: bool, pixels: int
) =
  ## Fills a radial gradient: t is the distance from the centre in a space
  ## where the edge and skew handles are one unit away, so the stops sit on
  ## ellipses.

  if paint.gradientHandlePositions.len != 3:
    raise newException(PixieError, "Radial gradient requires 3 handles")

  if paint.gradientStops.len == 0:
    raise newException(PixieError, "Gradient must have at least 1 color stop")

  paint.opacity = clamp(paint.opacity, 0, 1)
  if paint.opacity == 0:
    return

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
    m00 = mat[0, 0]
    m01 = mat[0, 1]
    m10 = mat[1, 0]
    m11 = mat[1, 1]
    m20 = mat[2, 0]
    m21 = mat[2, 1]
  image.fillPerPixel(paint, max(distanceX, distanceY), exact, pixels):
    let
      rowY = y.float32 + origin.y
      rowX10 = m10 * rowY
      rowX11 = m11 * rowY
  do:
    let
      px0 = x.float32 + origin.x
      px = m00 * px0 + rowX10 + m20
      py = m01 * px0 + rowX11 + m21
      d2 = px * px + py * py
    if throughTable: fastSqrt(d2) else: sqrt(d2)

proc fillGradientAngular(
  image: Image, paint: Paint, origin: Vec2, exact: bool, pixels: int
) =
  ## Fills an angular gradient.

  if paint.gradientHandlePositions.len != 3:
    raise newException(PixieError, "Angular gradient requires 2 handles")

  if paint.gradientStops.len == 0:
    raise newException(PixieError, "Gradient must have at least 1 color stop")

  paint.opacity = clamp(paint.opacity, 0, 1)
  if paint.opacity == 0:
    return

  let
    center = paint.gradientHandlePositions[0]
    edge = paint.gradientHandlePositions[1]
    f32PI = PI.float32
  # TODO: make edge between start and end anti-aliased.
  let gradientAngle = normalize(edge - center).angle().fixAngle()
  # t runs 0..1 around the circle; the outermost pixels of the fill go round
  # it in about pi * (width + height) steps.
  image.fillPerPixel(
    paint, f32PI * (image.width + image.height).float32, exact, pixels
  ):
    let rowY = y.float32 + origin.y
  do:
    let
      xy = vec2(x.float32 + origin.x, rowY)
      angle = normalize(xy - center).angle()
    (angle + gradientAngle + f32PI / 2).fixAngle() / 2 / f32PI + 0.5.float32

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
  case paint.kind:
  of LinearGradientPaint:
    image.fillGradientLinear(paint, origin, exact, pixels)
  of RadialGradientPaint:
    image.fillGradientRadial(paint, origin, exact, pixels)
  of AngularGradientPaint:
    image.fillGradientAngular(paint, origin, exact, pixels)
  else:
    raise newException(PixieError, "Paint must be a gradient")

when defined(release):
  {.pop.}
