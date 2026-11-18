import chroma, pixie, pixie/blends, pixie/paths, vmath

# A gradient blended normally into a grey or 565 image over a box of whole
# pixels is filled row by row from the gradient, without the coverage mask
# every other shape goes through (paths.nim, fillGradientBox): a page's
# background. It must land exactly the picture the mask lands. The same
# rectangle with one more point on an edge is no box to the fill and has the
# same coverage, so it is the mask's picture to compare with.

proc box(x, y, w, h: float32): Path =
  result = newPath()
  result.rect(x, y, w, h)

proc sameThroughMask(x, y, w, h: float32): Path =
  result = newPath()
  result.moveTo(x, y)
  result.lineTo(x + w / 2, y)
  result.lineTo(x + w, y)
  result.lineTo(x + w, y + h)
  result.lineTo(x, y + h)
  result.closePath()

proc stops(translucent: bool): seq[ColorStop] =
  if translucent:
    @[ColorStop(color: color(1, 0.8, 0.2, 0.9), position: 0),
      ColorStop(color: color(0.2, 0.4, 1, 0.0), position: 0.45),
      ColorStop(color: color(0.1, 0.9, 0.5, 1), position: 1)]
  else:
    @[ColorStop(color: color(0.07, 0.19, 0.35, 1), position: 0),
      ColorStop(color: color(0.95, 0.9, 0.7, 1), position: 0.6),
      ColorStop(color: color(0.48, 0.12, 0.29, 1), position: 1)]

type Kind = enum
  horizontal, vertical, diagonal, radial, angular,
  glow,     ## a radial that fades to nothing at its edge: most of a page is outside it
  vignette  ## a radial with nothing in its middle

proc gradient(kind: Kind, w, h: float32, translucent: bool, opacity: float32): Paint =
  case kind
  of horizontal:
    result = newPaint(LinearGradientPaint)
    result.gradientHandlePositions = @[vec2(4, 9), vec2(w - 11, 9)]
  of vertical:
    result = newPaint(LinearGradientPaint)
    result.gradientHandlePositions = @[vec2(7, 3), vec2(7, h - 5)]
  of diagonal:
    result = newPaint(LinearGradientPaint)
    result.gradientHandlePositions = @[vec2(3.5, 2.25), vec2(w - 7.5, h - 1.5)]
  of radial:
    result = newPaint(RadialGradientPaint)
    result.gradientHandlePositions = @[vec2(w * 0.4, h * 0.55), vec2(w * 0.95, h * 0.55), vec2(w * 0.4, h * 1.1)]
  of angular:
    result = newPaint(AngularGradientPaint)
    result.gradientHandlePositions = @[vec2(w * 0.5, h * 0.5), vec2(w, h * 0.5), vec2(w * 0.5, h)]
  of glow:
    let r = min(w, h) * 0.52
    result = newPaint(RadialGradientPaint)
    result.gradientHandlePositions = @[vec2(w, 0), vec2(w - r, 0), vec2(w, r)]
  of vignette:
    let r = max(w, h) * 0.6
    result = newPaint(RadialGradientPaint)
    result.gradientHandlePositions = @[vec2(w * 0.5, h * 0.5), vec2(w * 0.5 + r, h * 0.5), vec2(w * 0.5, h * 0.5 + r * 0.8)]
  result.gradientStops = case kind
    of glow:
      @[ColorStop(color: color(1, 0.8, 0.2, 0.6), position: 0),
        ColorStop(color: color(1, 0.8, 0.2, 0.2), position: 0.46),
        ColorStop(color: color(1, 0.8, 0.2, 0), position: 1)]
    of vignette:
      @[ColorStop(color: color(0, 0, 0, 0), position: 0),
        ColorStop(color: color(0, 0, 0, 0), position: 0.52),
        ColorStop(color: color(0, 0, 0, if translucent: 0.5 else: 1), position: 1)]
    else: stops(translucent)
  result.opacity = opacity

type Target = enum gray4, gray8, rgb565, rgb565Dithered

proc canvas(target: Target, w, h: int): Image =
  result = case target
    of gray4: newImageGray4(w, h)
    of gray8: newImageGray8(w, h)
    else: newImage565(w, h)
  result.ditherStores = target == rgb565Dithered
  # Something under the gradient for it to blend with.
  result.fill(rgba(40, 90, 160, 255))
  let paint = newPaint(SolidPaint)
  paint.color = color(1, 1, 1, 0.5)
  result.fillPath("M 0 0 L 300 0 L 0 240 z", paint, scale(vec2(w.float32 / 300, h.float32 / 240)))
  paint.color = color(0, 0, 0, 0.7)
  result.fillPath("M 300 240 L 300 100 L 120 240 z", paint, scale(vec2(w.float32 / 300, h.float32 / 240)))

proc differing(a, b: Image): int =
  doAssert a.width == b.width and a.height == b.height
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      if a[x, y] != b[x, y]:
        inc result

var cases = 0

proc check(target: Target, w, h: int, kind: Kind, translucent: bool, opacity: float32,
    x, y, bw, bh: float32, transform = mat3(), viewed = false, boxed = true) =
  let
    paint = gradient(kind, w.float32, h.float32, translucent, opacity)
    a = canvas(target, w, h)
    b = canvas(target, w, h)
    label = $target & " " & $w & "x" & $h & " " & $kind & (if translucent: " translucent" else: "") &
      " opacity " & $opacity & " box " & $x & "," & $y & " " & $bw & "x" & $bh & (if viewed: " in a view" else: "")
  let before = gradientBoxFills
  if viewed:
    # A view starts where it starts in the owner's buffer: an odd pixel of a
    # sixteen-grey byte, a row of the dither's cell that is not its first.
    a.view(3, 5, w - 7, h - 9).fillPath(box(x, y, bw, bh), paint, transform)
    b.view(3, 5, w - 7, h - 9).fillPath(sameThroughMask(x, y, bw, bh), paint, transform)
  else:
    a.fillPath(box(x, y, bw, bh), paint, transform)
    b.fillPath(sameThroughMask(x, y, bw, bh), paint, transform)
  doAssert gradientBoxFills - before == (if boxed: 1 else: 0),
    label & ": " & $(gradientBoxFills - before) & " fills went the box's way"
  doAssert paint.opacity == opacity, label & ": the paint's opacity was not put back"
  let d = differing(a, b)
  doAssert d == 0, label & ": " & $d & " pixels differ from the masked fill"
  # And it drew: the box is not the canvas it started as (a glow or a
  # vignette may leave a box that is outside its ink as it was).
  if kind notin {glow, vignette}:
    doAssert differing(a, canvas(target, w, h)) > 0, label & ": nothing was drawn"
  inc cases

const
  W = 300
  H = 240

for target in Target:
  for kind in Kind:
    for translucent in [false, true]:
      for opacity in [1'f32, 0.4'f32]:
        # The whole image, as a page's background is.
        check(target, W, H, kind, translucent, opacity, 0, 0, W, H)
        # A box inside it, from an odd pixel, an odd number of them wide.
        check(target, W, H, kind, translucent, opacity, 37, 21, 151, 99)
    # Larger than the image: clipped to it.
    check(target, W, H, kind, true, 1, -20, -30, W + 55, H + 70)
    # Under a transform that keeps it a box of whole pixels.
    check(target, W, H, kind, true, 0.7, 5, 4, 60, 50, translate(vec2(10, 20)) * scale(vec2(2, 2)))
    # Into a view.
    check(target, W, H, kind, true, 0.7, 10, 6, 121, 77, viewed = true)
    check(target, W, H, kind, false, 1, 0, 0, W - 7, H - 9, viewed = true)
    # Not on whole pixels: the masked fill both times, and the same picture.
    check(target, W, H, kind, true, 1, 10.5, 6.25, 121, 77, boxed = false)
    # A small image's gradient has no table: a grey target's goes through the
    # mask unless one row or one colour a row says it all.
    check(target, 40, 30, kind, true, 0.6, 3, 2, 31, 25,
      boxed = target in {rgb565, rgb565Dithered} or kind in {horizontal, vertical})

# Any other shape goes through a mask of its coverage, a byte a pixel, and
# the same rows. Against the composite spelled out: the shape as a mask's
# alpha, the gradient as a picture, the one multiplied by the other and
# blended normally over what was there, a pixel at a time. Where the shape
# covers a pixel whole the two are the same pixel. Along its edge the fill's
# mask is rasterized in the shape's own box, and the moved coordinates can
# round an antialiased sample one step the other way (`paintThroughMask`):
# there a pixel may differ, a few of them.
proc composite(target: Target, w, h: int, paint: Paint, draw: proc(mask: Image)): tuple[image, mask: Image] =
  result.image = canvas(target, w, h)
  result.mask = newImage(w, h)
  let
    colors = newImage(w, h)
    opacity = paint.opacity
  draw(result.mask)
  if opacity != 1:
    result.mask.applyOpacity(opacity)
  paint.opacity = 1
  colors.fillGradient(paint, pixels = w * h)
  paint.opacity = opacity
  for y in 0 ..< h:
    for x in 0 ..< w:
      let m = result.mask[x, y].a
      if m != 0:
        var c = colors[x, y]
        if m != 255:
          c = blendMask(c, rgbx(m, m, m, m))
        if c.a != 0:
          result.image[x, y] = blendNormal(result.image[x, y], c)

var
  shapes = 0
  edgeNudges = 0
proc checkShape(target: Target, kind: Kind, translucent: bool, opacity: float32, name: string,
    fill: proc(image: Image, paint: Paint), boxed = false) =
  let
    paint = gradient(kind, W.float32, H.float32, translucent, opacity)
    drawn = canvas(target, W, H)
    white = newPaint(SolidPaint)
    whole = round(255 * opacity).uint8
    label = $target & " " & $kind & (if translucent: " translucent" else: "") & " opacity " & $opacity & " " & name
  white.color = color(1, 1, 1, 1)
  let before = gradientBoxFills
  fill(drawn, paint)
  doAssert gradientBoxFills - before == (if boxed: 1 else: 0), name & (if boxed: " is a box" else: " is no box")
  let expected = composite(target, W, H, paint, proc(mask: Image) = fill(mask, white))
  var inside, edge, edgePixels: int
  for y in 0 ..< H:
    for x in 0 ..< W:
      let m = expected.mask[x, y].a
      if m != 0 and m != whole:
        inc edgePixels
      if drawn[x, y] != expected.image[x, y]:
        if m == whole or m == 0:
          # Its neighbours in the mask say whether the fill's own mask could
          # have a sample here: one pixel off the edge is still the edge.
          var nearEdge = false
          for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            let (nx, ny) = (x + dx, y + dy)
            if nx >= 0 and ny >= 0 and nx < W and ny < H and expected.mask[nx, ny].a != m:
              nearEdge = true
          if nearEdge: inc edge else: inc inside
        else:
          inc edge
  doAssert inside == 0, label & ": " & $inside & " pixels the shape covers whole differ from the composite"
  doAssert edge * 20 <= edgePixels + 20, label & ": " & $edge & " of " & $edgePixels & " edge pixels differ"
  if kind notin {glow, vignette} or name == "the page":
    doAssert differing(drawn, canvas(target, W, H)) > 0, label & ": nothing was drawn"
  edgeNudges += edge
  inc shapes

proc roundedRect(): Path =
  result = newPath()
  result.roundedRect(21, 17, 231, 190, 18, 18, 18, 18)

proc disc(): Path =
  result = newPath()
  result.ellipse(150, 118, 131, 97)

for target in Target:
  # An angular gradient's table is sized by the box it fills, which the
  # composite above does not know: the others.
  for kind in [horizontal, vertical, diagonal, radial, glow, vignette]:
    # A box, which has no edge to round: the composite's every pixel.
    checkShape(target, kind, true, 1, "the page",
      proc(image: Image, paint: Paint) = image.fillPath(box(0, 0, W, H), paint), boxed = true)
    checkShape(target, kind, false, 0.6, "a box",
      proc(image: Image, paint: Paint) = image.fillPath(box(37, 21, 151, 199), paint), boxed = true)
    for translucent in [false, true]:
      for opacity in [1'f32, 0.4'f32]:
        checkShape(target, kind, translucent, opacity, "a rounded rectangle",
          proc(image: Image, paint: Paint) = image.fillPath(roundedRect(), paint))
        checkShape(target, kind, translucent, opacity, "a disc",
          proc(image: Image, paint: Paint) = image.fillPath(disc(), paint))
    checkShape(target, kind, true, 0.8, "a triangle off the image's edge",
      proc(image: Image, paint: Paint) = image.fillPath("M -30 20 L 330 90 L 120 300 z", paint))
    checkShape(target, kind, true, 1, "a stroke",
      proc(image: Image, paint: Paint) = image.strokePath(disc(), paint, strokeWidth = 9))

# The rows shared between two workers, as a host with a second core for them
# runs the job: blocks in turn, each worker with its own scratch.
var blocksRun = 0
proc twoWorkers(fn: RowsProc, ctx: pointer, rows, blockRows: int32) {.cdecl, gcsafe, raises: [].} =
  var
    first = 0'i32
    worker = 0'i32
  while first < rows:
    let last = min(rows, first + blockRows)
    fn(ctx, worker, first, last)
    worker = 1 - worker
    first = last
    {.cast(gcsafe).}:
      inc blocksRun

rowsRunner = twoWorkers
rowsWorkers = 2
for target in Target:
  for kind in Kind:
    check(target, W, H, kind, true, 0.8, 0, 0, W, H)
    check(target, W, H, kind, false, 1, 37, 21, 151, 99)
    if kind != angular:
      checkShape(target, kind, true, 0.8, "a disc, shared",
        proc(image: Image, paint: Paint) = image.fillPath(disc(), paint))
doAssert blocksRun > 0, "no job was shared between the workers"
rowsRunner = nil
rowsWorkers = 1

echo "gradient boxes: ", cases, " fills match the masked fill, ", shapes, " shapes the composite (",
  edgeNudges, " edge pixels a step off)"
