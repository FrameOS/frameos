## The sixteen-grey surface: every store dithered, in a pixel index that is
## half a byte. What a 4-bit canvas must not lose against the luma canvas it
## replaced is the picture on the panel, so the first checks draw on both and
## compare the 4-bit canvas with the luma canvas put through the same matrix.

import pixie, pixie/blends, std/math, strformat

proc levelAt(image: Image, x, y: int): int =
  image.unsafe[x, y].r.int div 17

proc packed(gray: Image): seq[int] =
  ## A luma canvas through the ordered pack the panel used to get.
  for y in 0 ..< gray.height:
    for x in 0 ..< gray.width:
      result.add grayLevel16Ordered(gray.unsafe[x, y].r,
        OrderedThresholds4x4[(y and 3) * 4 + (x and 3)]).int

proc levels(image: Image): seq[int] =
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      result.add image.levelAt(x, y)

proc sameAsPack(name: string, w, h: int, draw: proc (canvas: Image)) =
  let
    four = newImageGray4(w, h)
    eight = newImageGray8(w, h)
  draw(four)
  draw(eight)
  doAssert four.levels == eight.packed, &"{name}: the 4-bit canvas differs from the packed luma canvas"

proc linearPaint(x0, y0, x1, y1: float32): Paint =
  result = newPaint(LinearGradientPaint)
  result.gradientHandlePositions = @[vec2(x0, y0), vec2(x1, y1)]
  result.gradientStops = @[
    ColorStop(color: color(0, 0, 0, 1), position: 0),
    ColorStop(color: color(1, 1, 1, 1), position: 1)]

block exact_levels_stay_flat:
  for level in 0 .. 15:
    let image = newImageGray4(9, 7)
    let v = uint8(level * 17)
    image.fill(rgbx(v, v, v, 255))
    for got in image.levels:
      doAssert got == level, &"level {level} read back as {got}"
    doAssert image.isOneColor

block a_single_layer_is_the_packed_picture:
  sameAsPack("fill", 16, 12) do (c: Image):
    c.fill(rgba(120, 120, 120, 255))
  sameAsPack("rect", 16, 12) do (c: Image):
    c.fill(rgba(255, 255, 255, 255))
    let p = newPath()
    p.rect(3, 2, 9, 7)
    c.fillPath(p, rgba(90, 90, 90, 255))
  sameAsPack("circle", 32, 32) do (c: Image):
    c.fill(rgba(255, 255, 255, 255))
    let p = newPath()
    p.circle(16, 16, 11.3)
    c.fillPath(p, rgba(0, 0, 0, 255))
  sameAsPack("horizontal gradient", 64, 16) do (c: Image):
    c.fillGradient(linearPaint(0, 0, 64, 0))
  sameAsPack("vertical gradient", 16, 64) do (c: Image):
    c.fillGradient(linearPaint(0, 0, 0, 64))
  sameAsPack("diagonal gradient", 48, 48) do (c: Image):
    c.fillGradient(linearPaint(0, 0, 48, 48))

block a_gradient_stays_smooth:
  # Averaged over the matrix's own 4x4 cell, a slow ramp must climb in far
  # smaller steps than one level of the panel: a plain cut to sixteen greys
  # would hold each level for sixteen columns and then jump by a whole one.
  let
    width = 960
    image = newImageGray4(width, 16)
  image.fillGradient(linearPaint(0, 0, width.float32, 0))
  var
    previous = -1.0
    biggest = 0.0
    distinct_means = 0
  for x in countup(0, width - 4, 4):
    var sum = 0
    for yy in 0 ..< 4:
      for xx in 0 ..< 4:
        sum += image.levelAt(x + xx, yy)
    let mean = sum.float / 16.0
    if previous >= 0:
      doAssert mean >= previous - 1.0 / 8.0, &"the ramp went back at x={x}: {previous} then {mean}"
      biggest = max(biggest, mean - previous)
      if mean != previous: inc distinct_means
    previous = mean
  doAssert biggest <= 2.0 / 16.0 + 1e-9, &"a 4x4 cell stepped by {biggest} of a level"
  doAssert distinct_means > 100, &"only {distinct_means} steps across the ramp"

block a_horizontal_gradient_differs_row_to_row:
  let image = newImageGray4(64, 8)
  image.fillGradient(linearPaint(0, 0, 64, 0))
  var differs = false
  for x in 0 ..< 64:
    if image.levelAt(x, 0) != image.levelAt(x, 1):
      differs = true
  doAssert differs, "the first row was copied down, which prints vertical stripes"

block a_view_dithers_where_it_sits:
  let
    whole = newImageGray4(32, 16)
    canvas = newImageGray4(32, 16)
    part = canvas.view(5, 3, 13, 9)
  whole.fill(rgba(77, 77, 77, 255))
  part.fill(rgba(77, 77, 77, 255))
  for y in 0 ..< 9:
    for x in 0 ..< 13:
      doAssert canvas.levelAt(5 + x, 3 + y) == whole.levelAt(5 + x, 3 + y)
  # And stays in its rectangle, at an odd left edge above all.
  for y in 0 ..< 16:
    for x in 0 ..< 32:
      if x < 5 or x >= 18 or y < 3 or y >= 12:
        doAssert canvas.levelAt(x, y) == 0, &"the view wrote outside itself at {x},{y}"

block odd_width_rows_keep_to_themselves:
  let image = newImageGray4(5, 4)
  doAssert image.stride == 6
  doAssert image.byteSize == 12
  doAssert image.bitsPerPixel == 4
  image.fill(rgba(255, 255, 255, 255))
  for got in image.levels:
    doAssert got == 15
  # A narrow fill at an odd start touches only its own pixels.
  image.fillGray4(0, image.dataIndex(1, 1), 3)
  for x in 0 ..< 5:
    doAssert image.levelAt(x, 1) == (if x in 1 .. 3: 0 else: 15)
  doAssert image.levelAt(0, 2) == 15

block over_a_buffer_it_does_not_own:
  var bytes = newSeq[uint8](8 * 4)
  let image = newImageGray4Over(16, 4, bytes[0].addr)
  image.fill(rgba(255, 255, 255, 255))
  for b in bytes:
    doAssert b == 0xFF
  image.fill(rgba(0, 0, 0, 255))
  image[0, 0] = rgba(255, 255, 255, 255)
  image[3, 0] = rgba(255, 255, 255, 255)
  doAssert bytes[0] == 0xF0 and bytes[1] == 0x0F, "left pixel in the high nibble"

block rows_at_odd_offsets:
  let
    source = newImageGray4(12, 3)
    target = newImageGray4(12, 3)
  for x in 0 ..< 12:
    for y in 0 ..< 3:
      source[x, y] = rgba(uint8(x * 17), uint8(x * 17), uint8(x * 17), 255)
  target.copyPixelRow(target.dataIndex(2, 1), source, source.dataIndex(3, 1), 7)
  for x in 0 ..< 12:
    doAssert target.levelAt(x, 1) == (if x in 2 .. 8: x + 1 else: 0)
  target.copyPixelRow(target.dataIndex(1, 2), source, source.dataIndex(3, 2), 5)
  for x in 0 ..< 12:
    doAssert target.levelAt(x, 2) == (if x in 1 .. 5: x + 2 else: 0)
  doAssert not target.pixelRowsEqual(target.dataIndex(0, 1), source, source.dataIndex(0, 1), 12)
  doAssert target.pixelRowsEqual(target.dataIndex(2, 1), source, source.dataIndex(3, 1), 7)
  target.zeroPixelRow(target.dataIndex(3, 1), 3)
  for x in 2 .. 8:
    doAssert target.levelAt(x, 1) == (if x in 3 .. 5: 0 else: x + 1)

block copies_and_conversions:
  let image = newImageGray4(10, 6)
  image.fillGradient(linearPaint(0, 0, 10, 6))
  doAssert image.copy().pixelsEqual(image)
  doAssert image.levels == image.toRgbxImage().toGray4Image().levels
  let sub = image.subImage(3, 1, 5, 4)
  for y in 0 ..< 4:
    for x in 0 ..< 5:
      doAssert sub.levelAt(x, y) == image.levelAt(3 + x, 1 + y)
  doAssert image.copy().newImageLike(4, 4).format == pfGray4

block flips:
  let image = newImageGray4(7, 3)
  for y in 0 ..< 3:
    for x in 0 ..< 7:
      let v = uint8((x + y) * 17)
      image[x, y] = rgba(v, v, v, 255)
  let horizontal = image.copy()
  horizontal.flipHorizontal()
  let vertical = image.copy()
  vertical.flipVertical()
  for y in 0 ..< 3:
    for x in 0 ..< 7:
      doAssert horizontal.levelAt(6 - x, y) == image.levelAt(x, y)
      doAssert vertical.levelAt(x, 2 - y) == image.levelAt(x, y)

block rotate_in_place:
  let image = newImageGray4(4, 2)
  for y in 0 ..< 2:
    for x in 0 ..< 4:
      let v = uint8((x + y * 4) * 17)
      image[x, y] = rgba(v, v, v, 255)
  image.rotate90()
  doAssert image.width == 2 and image.height == 4
  doAssert image.levelAt(1, 0) == 0 and image.levelAt(0, 0) == 4
  doAssert image.levelAt(1, 3) == 3 and image.levelAt(0, 3) == 7

block drawing_onto_and_from:
  let
    canvas = newImageGray4(12, 12)
    panel = newImageGray4(5, 5)
    rgbx = newImage(5, 5)
  canvas.fill(rgba(255, 255, 255, 255))
  panel.fill(rgba(0, 0, 0, 255))
  canvas.draw(panel, translate(vec2(3, 2)))
  for y in 0 ..< 12:
    for x in 0 ..< 12:
      doAssert canvas.levelAt(x, y) == (if x in 3 .. 7 and y in 2 .. 6: 0 else: 15)
  rgbx.fill(rgba(255, 255, 255, 128))
  canvas.fill(rgba(0, 0, 0, 255))
  canvas.draw(rgbx)
  let drawn = canvas.levelAt(0, 0)
  doAssert drawn in 7 .. 8, &"half white over black read back as level {drawn}"

block a_blend_over_a_dithered_backdrop_keeps_its_mean:
  # The canvas reads back levels, not the 256 greys that made them.
  var worst = 0.0
  for grey in countup(0, 255, 3):
    for (top, alpha) in [(255, 128), (0, 128), (255, 64), (0, 200)]:
      let image = newImageGray4(16, 16)
      image.fill(rgba(grey.uint8, grey.uint8, grey.uint8, 255))
      let a = alpha.float / 255.0
      let layer = newImage(16, 16)
      layer.fill(rgba(top.uint8, top.uint8, top.uint8, alpha.uint8))
      image.draw(layer)
      var sum = 0
      for got in image.levels:
        sum += got
      let
        mean = sum.float / 256.0
        wanted = (top.float * a + grey.float * (1.0 - a)) / 17.0
      worst = max(worst, abs(mean - wanted))
  doAssert worst <= 0.75, &"a layer moved the mean by {worst} of a level"
  echo &"worst blended mean error: {worst:.3f} of a level"

block whole_image_operations:
  let image = newImageGray4(6, 3)
  image.fill(rgba(255, 255, 255, 255))
  image.applyOpacity(0.0)
  for got in image.levels:
    doAssert got == 0
  image.invert()
  for got in image.levels:
    doAssert got == 15
  image.fill(rgba(17, 17, 17, 255))
  image.ceil()
  for got in image.levels:
    doAssert got == 15
  image.fill(rgba(255, 255, 255, 255))
  image.blur(1.0)
  for got in image.levels:
    doAssert got in 12 .. 15

proc narrowCanvas(kind, w, h: int): Image =
  ## 0: 8-bit grey, 1: 4-bit grey, 2: 565, 3: 565 with dithered stores.
  case kind
  of 0: newImageGray8(w, h)
  of 1: newImageGray4(w, h)
  else:
    let image = newImage565(w, h)
    image.ditherStores = kind == 3
    image

block gradient_fills_onto_narrow_canvases_match_the_paint_image:
  # A gradient fills a grey or 565 canvas from the coverage straight,
  # without the paint image: the pixels must be the ones the paint image,
  # its mask multiply and a normal composite give, for any shape, stop alpha
  # and paint opacity, on both greys and both 565s, a view among them.
  proc reference(canvas: Image, path: Path, paint: Paint) =
    # The paint image's way, over the shape's box as it always was.
    let
      bounds = path.computeBounds()
      x0 = clamp(floor(bounds.x).int - 1, 0, canvas.width)
      y0 = clamp(floor(bounds.y).int - 1, 0, canvas.height)
      x1 = clamp(ceil(bounds.x + bounds.w).int + 1, x0, canvas.width)
      y1 = clamp(ceil(bounds.y + bounds.h).int + 1, y0, canvas.height)
      whole = x1 - x0 == canvas.width and y1 - y0 == canvas.height
      mask = newImage(x1 - x0, y1 - y0)
      fill = newImage(x1 - x0, y1 - y0)
      opacity = paint.opacity
    mask.fillPath(path, color(1, 1, 1, 1),
      if whole: mat3() else: translate(vec2(-x0.float32, -y0.float32)))
    if opacity != 1:
      mask.applyOpacity(opacity)
    paint.opacity = 1
    fill.fillGradient(paint, vec2(x0.float32, y0.float32),
      pixels = canvas.width * canvas.height)
    paint.opacity = opacity
    for y in 0 ..< y1 - y0:
      for x in 0 ..< x1 - x0:
        let source = blendMask(fill.unsafe[x, y], mask.unsafe[x, y])
        canvas.unsafe[x + x0, y + y0] = blendNormal(canvas.unsafe[x + x0, y + y0], source)

  proc paints(): seq[Paint] =
    var p = linearPaint(3, 2, 61, 37)
    p.gradientStops[1].color.a = 0.4
    result.add p
    result.add linearPaint(0, 5, 64, 5) # horizontal
    result.add linearPaint(7, 0, 7, 40) # vertical
    p = newPaint(RadialGradientPaint)
    p.gradientHandlePositions = @[vec2(30, 20), vec2(55, 20), vec2(30, 38)]
    p.gradientStops = @[
      ColorStop(color: color(1, 0.8, 0.6, 0.9), position: 0),
      ColorStop(color: color(0.1, 0.2, 0.3, 0), position: 1)]
    p.opacity = 0.7
    result.add p
    p = newPaint(AngularGradientPaint)
    p.gradientHandlePositions = @[vec2(32, 20), vec2(50, 10), vec2(32, 40)]
    p.gradientStops = @[
      ColorStop(color: color(0, 0, 0, 1), position: 0),
      ColorStop(color: color(1, 1, 1, 1), position: 1)]
    result.add p

  let shapes = [
    "M 0 0 h 64 v 41 h -64 z", # the whole canvas
    "M 3.5 2.25 h 50.5 v 30.75 h -50.5 z", # a box, soft edges
    "M 32 4 C 52 4 60 30 32 38 C 4 30 12 4 32 4 z M 32 12 L 40 26 L 24 26 z"]
  for w in [64, 37]:
    for d in shapes:
      for i, paint in paints():
        for kind in 0 .. 3:
          let
            got = narrowCanvas(kind, w, 41)
            want = narrowCanvas(kind, w, 41)
          got.fill(rgba(90, 120, 60, 255))
          want.fill(rgba(90, 120, 60, 255))
          let path = parsePath(d)
          got.fillPath(path, paint)
          want.reference(path, paint)
          for y in 0 ..< 41:
            for x in 0 ..< w:
              doAssert got.unsafe[x, y] == want.unsafe[x, y],
                &"paint {i} canvas {kind} w={w} {d}: ({x}, {y}) " &
                &"{got.unsafe[x, y]} != {want.unsafe[x, y]}"
  # Onto a view: where it sits decides the dither.
  let
    owner = newImageGray4(64, 41)
    refOwner = newImageGray4(64, 41)
    path = parsePath(shapes[2])
    paint = paints()[0]
  owner.fill(rgba(200, 200, 200, 255))
  refOwner.fill(rgba(200, 200, 200, 255))
  owner.view(5, 3, 40, 30).fillPath(path, paint)
  refOwner.view(5, 3, 40, 30).reference(path, paint)
  doAssert owner.levels == refOwner.levels, "a gradient into a view"

block rgbx_rows_onto_narrow_canvases:
  # An RGBX picture drawn onto grey or 565, normally and overwriting: the
  # row kernels against the per-pixel accessors.
  let picture = newImage(23, 9)
  for y in 0 ..< 9:
    for x in 0 ..< 23:
      let a = uint8((x * 37 + y * 11) mod 256)
      picture.unsafe[x, y] = rgbx(min(a, uint8(x * 9)), min(a, uint8(y * 20)), a div 2, a)
  for kind in 0 .. 3:
    for mode in [NormalBlend, OverwriteBlend]:
      let
        got = narrowCanvas(kind, 31, 13)
        want = narrowCanvas(kind, 31, 13)
      got.fill(rgba(120, 140, 100, 255))
      want.fill(rgba(120, 140, 100, 255))
      got.draw(picture, translate(vec2(5, 3)), mode)
      for y in 0 ..< 9:
        for x in 0 ..< 23:
          let s = picture.unsafe[x, y]
          want.unsafe[x + 5, y + 3] =
            if mode == OverwriteBlend: s else: blendNormal(want.unsafe[x + 5, y + 3], s)
      for y in 0 ..< 13:
        for x in 0 ..< 31:
          doAssert got.unsafe[x, y] == want.unsafe[x, y],
            &"canvas {kind} {mode}: ({x}, {y})"

echo "test_gray4: ok"
