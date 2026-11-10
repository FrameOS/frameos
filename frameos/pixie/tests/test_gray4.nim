## The sixteen-grey surface: every store dithered, in a pixel index that is
## half a byte. What a 4-bit canvas must not lose against the luma canvas it
## replaced is the picture on the panel, so the first checks draw on both and
## compare the 4-bit canvas with the luma canvas put through the same matrix.

import pixie, strformat

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

echo "test_gray4: ok"
