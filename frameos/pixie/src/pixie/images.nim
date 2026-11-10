import blends, bumpy, chroma, common, internal, rgb565, simd, vmath

export Image, copy, dataIndex, newImage

const h = 0.5.float32

type UnsafeImage = distinct Image

when defined(release):
  {.push checks: off.}

proc `$`*(image: Image): string {.raises: [].} =
  ## Prints the image size.
  "<Image " & $image.width & "x" & $image.height & ">"

proc inside*(image: Image, x, y: int): bool {.inline, raises: [].} =
  ## Returns true if (x, y) is inside the image.
  x >= 0 and x < image.width and y >= 0 and y < image.height

template unsafe*(src: Image): UnsafeImage =
  cast[UnsafeImage](src)

template `[]`*(view: UnsafeImage, x, y: int): ColorRGBX =
  ## Gets a color from (x, y) coordinates.
  ## * No bounds checking *
  ## Make sure that x, y are in bounds.
  ## Failure in the assumptions will cause unsafe memory reads.
  ##
  ## Returns by value (it used to return `var`): a 565 image has no
  ## `ColorRGBX` in memory to hand out a reference to, and reading through
  ## this is the one accessor that works on every storage format.
  (block:
    let img {.inject.} = cast[Image](view)
    img.getPixel(img.dataIndex(x, y)))

template `[]=`*(view: UnsafeImage, x, y: int, color: ColorRGBX) =
  ## Sets a color from (x, y) coordinates.
  ## * No bounds checking *
  ## Make sure that x, y are in bounds.
  ## Failure in the assumptions will cause unsafe memory writes.
  block:
    let img = cast[Image](view)
    img.setPixel(img.dataIndex(x, y), color)

proc `[]`*(image: Image, x, y: int): ColorRGBX {.inline, raises: [].} =
  ## Gets a pixel at (x, y) or returns transparent black if outside of bounds.
  if image.inside(x, y):
    return image.unsafe[x, y]

proc `[]=`*(image: Image, x, y: int, color: SomeColor) {.inline, raises: [].} =
  ## Sets a pixel at (x, y) or does nothing if outside of bounds.
  if image.inside(x, y):
    image.unsafe[x, y] = color.asRgbx()

proc getColor*(image: Image, x, y: int): Color {.inline, raises: [].} =
  ## Gets a color at (x, y) or returns transparent black if outside of bounds.
  image[x, y].color()

proc setColor*(image: Image, x, y: int, color: Color) {.inline, raises: [].} =
  ## Sets a color at (x, y) or does nothing if outside of bounds.
  image[x, y] = color.rgbx()

proc fill*(image: Image, color: SomeColor) {.inline, raises: [].} =
  ## Fills the image with the color.
  # An owner is a single span, so this stays the one memset it always was.
  # A view fills row by row, which is how a tiled render clears its cell.
  if image.format == pfRgb565:
    let packed = rgbxToRgb565(color.asRgbx())
    image.forEachSpan:
      fillUnsafe16(image.data16, packed, spanStart, spanLen)
    return
  if image.format == pfGray8:
    let luma = rgbxToGray8(color.asRgbx())
    image.forEachSpan:
      fillUnsafe8(image.data8, luma, spanStart, spanLen)
    return
  if image.format == pfGray4:
    let luma = rgbxToGray8(color.asRgbx())
    image.forEachSpan:
      image.fillGray4(luma, spanStart, spanLen)
    return
  image.forEachSpan:
    fillUnsafe(image.data, color, spanStart, spanLen)

iterator items*(image: Image): ColorRGBX =
  ## Every pixel, left to right then top to bottom.
  ##
  ## `for c in image.data` used to work because `data` was a seq; it is a
  ## pointer now, and a pointer has no length to iterate. This is the
  ## replacement, and it is correct for a view — where walking the buffer flat
  ## would have wandered into the neighbouring rows.
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      yield image.unsafe[x, y]

iterator pairs*(image: Image): (int, ColorRGBX) =
  ## Every pixel with its index in this image, not in the buffer behind it.
  var i = 0
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      yield (i, image.unsafe[x, y])
      inc i

proc pixelsEqual*(a, b: Image): bool {.raises: [].} =
  ## Compares two images by their pixels.
  ##
  ## Deliberately not `==`. `Image` is a ref, so `==` already means "the same
  ## object", and callers rely on that — "did the producer draw straight into
  ## my canvas?" is an identity question, and answering it by comparing every
  ## pixel would be both wrong and O(n).
  ##
  ## This exists because `a.data == b.data` no longer compares contents either:
  ## `data` is a pointer now, so that compares addresses and is quietly false
  ## for two images that hold the same picture.
  if a.isNil or b.isNil:
    return a.isNil and b.isNil
  if a.width != b.width or a.height != b.height:
    return false
  if a.format != b.format:
    # Different storage, same picture? Compare what each would read back.
    for y in 0 ..< a.height:
      for x in 0 ..< a.width:
        if a.unsafe[x, y] != b.unsafe[x, y]:
          return false
    return true
  for y in 0 ..< a.height:
    if not a.pixelRowsEqual(a.dataIndex(0, y), b, b.dataIndex(0, y), a.width):
      return false
  true

proc isOneColor*(image: Image): bool {.hasSimd, raises: [].} =
  ## Checks if the entire image is the same color.
  # This is an optimization hint with no callers inside pixie, so a view gets
  # the conservative answer rather than a row walk. The SIMD variants bail out
  # the same way — the dispatch the hasSimd pragma inserts runs before this.
  if image.format != pfRgbx:
    return image.isOneColor565()
  if image.isView:
    return false
  result = true
  let color = cast[uint32](image.data[0])
  for i in 0 ..< image.dataLen:
    if cast[uint32](image.data[i]) != color:
      return false

proc isTransparent*(image: Image): bool {.hasSimd, raises: [].} =
  ## Checks if this image is fully transparent or not.
  # Conservative for a view, for the same reason as isOneColor. A 565 image
  # has no alpha and reads back opaque, so it is never transparent.
  if image.isView or image.format != pfRgbx:
    return false
  result = true
  for i in 0 ..< image.dataLen:
    if image.data[i].a != 0:
      return false

proc isOpaque*(image: Image): bool {.raises: [].} =
  ## Checks if the entire image is opaque (alpha values are all 255).
  # No image-level SIMD variant can bypass this walk, so unlike isOneColor and
  # isTransparent a view can be answered exactly instead of conservatively.
  if image.format != pfRgbx:
    return true
  result = true
  image.forEachSpan:
    if not isOpaque(image.data, spanStart, spanLen):
      return false

proc flipHorizontal*(image: Image) {.raises: [].} =
  ## Flips the image around the Y axis.
  let halfWidth = image.width div 2
  for y in 0 ..< image.height:
    var
      left = image.dataIndex(0, y)
      right = left + image.width - 1
    if image.format == pfRgb565:
      for x in 0 ..< halfWidth:
        swap(image.data16[left], image.data16[right])
        inc left
        dec right
    elif image.format == pfGray8:
      for x in 0 ..< halfWidth:
        swap(image.data8[left], image.data8[right])
        inc left
        dec right
    elif image.format == pfGray4:
      for x in 0 ..< halfWidth:
        let level = gray4Level(image.data8, left)
        gray4Put(image.data8, left, gray4Level(image.data8, right))
        gray4Put(image.data8, right, level)
        inc left
        dec right
    else:
      for x in 0 ..< halfWidth:
        swap(image.data[left], image.data[right])
        inc left
        dec right

proc flipVertical*(image: Image) {.raises: [].} =
  ## Flips the image around the X axis.
  let halfHeight = image.height div 2
  for y in 0 ..< halfHeight:
    let
      topStart = image.dataIndex(0, y)
      bottomStart = image.dataIndex(0, image.height - y - 1)
    if image.format == pfRgb565:
      for x in 0 ..< image.width:
        swap(image.data16[topStart + x], image.data16[bottomStart + x])
    elif image.format == pfGray8:
      for x in 0 ..< image.width:
        swap(image.data8[topStart + x], image.data8[bottomStart + x])
    elif image.format == pfGray4:
      for x in 0 ..< image.width:
        let level = gray4Level(image.data8, topStart + x)
        gray4Put(image.data8, topStart + x, gray4Level(image.data8, bottomStart + x))
        gray4Put(image.data8, bottomStart + x, level)
    else:
      for x in 0 ..< image.width:
        swap(image.data[topStart + x], image.data[bottomStart + x])

proc rotate90*(image: Image) {.raises: [PixieError].} =
  ## Rotates the image 90 degrees clockwise.
  # Rotating swaps the dimensions, which a view cannot express: its rectangle
  # lives inside someone else's buffer and cannot change shape there.
  if image.isView:
    raise newException(PixieError, "Cannot rotate90 a view, copy it first")

  let rotated = image.newImageLike(image.height, image.width)
  for y in 0 ..< rotated.height:
    for x in 0 ..< rotated.width:
      rotated.setPixel(rotated.dataIndex(x, y),
        image.getPixel(image.dataIndex(y, image.height - x - 1)))
  # The pixels are copied back rather than the buffer handed over, because an
  # image's storage belongs to it: rebinding it to the temporary's would leave
  # this image pointing at pixels that die with the temporary. The pixel count
  # is unchanged, so the existing buffer still fits. (A 4-bit image's rows
  # are whole bytes, so an odd width can need more once turned.)
  if rotated.byteSize > image.byteSize:
    raise newException(PixieError, "Cannot rotate90 this pfGray4 image in place: an odd width needs more bytes")
  let bytes = rotated.byteSize
  swap(image.width, image.height)
  image.stride = rotated.stride
  copyMem(image.bufferPointer, rotated.bufferPointer, bytes)

proc subImage*(image: Image, x, y, w, h: int): Image {.raises: [PixieError].} =
  ## Gets a sub image from this image.
  if x < 0 or x + w > image.width:
    raise newException(
      PixieError,
      "Params x: " & $x & " w: " & $w & " invalid, image width is " & $image.width
    )
  if y < 0 or y + h > image.height:
    raise newException(
      PixieError,
      "Params y: " & $y & " h: " & $h & " invalid, image height is " & $image.height
    )

  result = image.newImageLike(w, h)
  if image.format != pfRgbx:
    for y2 in 0 ..< h:
      result.copyPixelRow(result.dataIndex(0, y2), image, image.dataIndex(x, y + y2), w)
    return
  for y2 in 0 ..< h:
    copyMem(
      result.data[result.dataIndex(0, y2)].addr,
      image.data[image.dataIndex(x, y + y2)].addr,
      w * 4
    )

proc subImage*(image: Image, rect: Rect): Image {.raises: [PixieError].} =
  ## Gets a sub image from this image via rectangle.
  ## Rectangle is snapped/expanded to whole pixels first.
  let r = rect.snapToPixels()
  image.subImage(r.x.int, r.y.int, r.w.int, r.h.int)

proc diff*(master, image: Image): (float32, Image) {.raises: [PixieError].} =
  ## Compares the parameters and returns a score and image of the difference.
  let
    w = max(master.width, image.width)
    h = max(master.height, image.height)
    diffImage = newImage(w, h)

  var
    diffScore = 0
    diffTotal = 0
  for x in 0 ..< w:
    for y in 0 ..< h:
      let
        m = master[x, y]
        u = image[x, y]
        diff = (m.r.int - u.r.int) + (m.g.int - u.g.int) + (m.b.int - u.b.int)
      var c: ColorRGBX
      c.r = abs(m.a.int - u.a.int).clamp(0, 255).uint8
      c.g = diff.clamp(0, 255).uint8
      c.b = (-diff).clamp(0, 255).uint8
      c.a = 255
      diffImage.unsafe[x, y] = c
      diffScore += abs(m.r.int - u.r.int) +
        abs(m.g.int - u.g.int) +
        abs(m.b.int - u.b.int) +
        abs(m.a.int - u.a.int)
      diffTotal += 255 * 4

  (100 * diffScore.float32 / diffTotal.float32, diffImage)

proc minifyBy2*(
  image: Image, power = 1
): Image {.hasSimd, raises: [PixieError].} =
  ## Scales the image down by an integer scale.
  if power < 0:
    raise newException(PixieError, "Cannot minifyBy2 with negative power")
  if power == 0:
    return image.copy()

  # The box filter below averages raw RGBX; a 565 source is expanded first so
  # the averaging happens at 8 bits and the result is an ordinary RGBX image.
  var src = if image.format != pfRgbx: image.toRgbxImage() else: image
  for _ in 1 .. power:
    # When minifying an image of odd size, round the result image size up
    # so a 99 x 99 src image returns a 50 x 50 image.
    let
      srcWidthIsOdd = (src.width mod 2) != 0
      srcHeightIsOdd = (src.height mod 2) != 0
      resultEvenWidth = src.width div 2
      resultEvenHeight = src.height div 2
    result = newImage(
      if srcWidthIsOdd: resultEvenWidth + 1 else: resultEvenWidth,
      if srcHeightIsOdd: resultEvenHeight + 1 else: resultEvenHeight
    )
    for y in 0 ..< resultEvenHeight:
      let
        topRowStart = src.dataIndex(0, y * 2)
        bottomRowStart = src.dataIndex(0, y * 2 + 1)
      for x in 0 ..< resultEvenWidth:
        let
          a = src.data[topRowStart + x * 2]
          b = src.data[topRowStart + x * 2 + 1]
          c = src.data[bottomRowStart + x * 2 + 1]
          d = src.data[bottomRowStart + x * 2]
          mixed = rgbx(
            ((a.r.uint32 + b.r + c.r + d.r + 2) div 4).uint8,
            ((a.g.uint32 + b.g + c.g + d.g + 2) div 4).uint8,
            ((a.b.uint32 + b.b + c.b + d.b + 2) div 4).uint8,
            ((a.a.uint32 + b.a + c.a + d.a + 2) div 4).uint8
          )
        result.data[result.dataIndex(x, y)] = mixed

      if srcWidthIsOdd:
        let rgbx = mix(
          src.data[src.dataIndex(src.width - 1, y * 2 + 0)],
          src.data[src.dataIndex(src.width - 1, y * 2 + 1)],
          0.5
        ) * 0.5
        result.data[result.dataIndex(result.width - 1, y)] = rgbx

    if srcHeightIsOdd:
      for x in 0 ..< resultEvenWidth:
        let rgbx = mix(
          src.data[src.dataIndex(x * 2 + 0, src.height - 1)],
          src.data[src.dataIndex(x * 2 + 1, src.height - 1)],
          0.5
        ) * 0.5
        result.data[result.dataIndex(x, result.height - 1)] = rgbx

      if srcWidthIsOdd:
        result.data[result.dataIndex(result.width - 1, result.height - 1)] =
          src.data[src.dataIndex(src.width - 1, src.height - 1)] * 0.25

    # Set src as this result for if we do another power
    src = result

proc magnifyBy2*(
  image: Image, power = 1
): Image {.hasSimd, raises: [PixieError].} =
  ## Scales image up by 2 ^ power.
  if power < 0:
    raise newException(PixieError, "Cannot magnifyBy2 with negative power")

  let
    scale = 2 ^ power
    image = if image.format != pfRgbx: image.toRgbxImage() else: image
  result = newImage(image.width * scale, image.height * scale)

  for y in 0 ..< image.height:
    # Write one row of pixels duplicated by scale
    let
      sourceRowStart = image.dataIndex(0, y)
      resultRowStart = result.dataIndex(0, y * scale)
    for x in 0 ..< image.width:
      let
        rgbx = image.data[sourceRowStart + x]
        resultIdx = resultRowStart + x * scale
      for i in 0 ..< scale:
        result.data[resultIdx + i] = rgbx
    # Copy that row of pixels into (scale - 1) more rows
    for i in 1 ..< scale:
      copyMem(
        result.data[resultRowStart + result.width * i].addr,
        result.data[resultRowStart].addr,
        result.width * 4
      )

proc applyOpacity*(image: Image, opacity: float32) {.hasSimd, raises: [].} =
  ## Multiplies alpha of the image by opacity.
  let opacity = round(255 * opacity).uint16
  if opacity == 255:
    return

  if opacity == 0:
    image.fill(rgbx(0, 0, 0, 0))
    return

  if image.format != pfRgbx:
    image.applyOpacity565(opacity)
    return

  image.forEachSpan:
    for i in spanStart ..< spanStart + spanLen:
      var rgbx = image.data[i]
      rgbx.r = ((rgbx.r * opacity) div 255).uint8
      rgbx.g = ((rgbx.g * opacity) div 255).uint8
      rgbx.b = ((rgbx.b * opacity) div 255).uint8
      rgbx.a = ((rgbx.a * opacity) div 255).uint8
      image.data[i] = rgbx

proc invert*(image: Image) {.hasSimd, raises: [].} =
  ## Inverts all of the colors and alpha.
  if image.format != pfRgbx:
    image.invert565()
    return
  image.forEachSpan:
    for i in spanStart ..< spanStart + spanLen:
      var rgbx = image.data[i]
      rgbx.r = 255 - rgbx.r
      rgbx.g = 255 - rgbx.g
      rgbx.b = 255 - rgbx.b
      rgbx.a = 255 - rgbx.a
      # Inverting rgbx(50, 100, 150, 200) becomes rgbx(205, 155, 105, 55). This
      # is not a valid premultiplied alpha color, so convert back here. Both
      # steps are per pixel, so folding the conversion into this pass gives the
      # same result as the separate whole-buffer pass it replaces — and unlike
      # that pass it follows the image's rows rather than the buffer.
      if rgbx.a != 255:
        rgbx.r = ((rgbx.r.uint32 * rgbx.a + 127) div 255).uint8
        rgbx.g = ((rgbx.g.uint32 * rgbx.a + 127) div 255).uint8
        rgbx.b = ((rgbx.b.uint32 * rgbx.a + 127) div 255).uint8
      image.data[i] = rgbx

proc ceil*(image: Image) {.hasSimd, raises: [].} =
  ## A value of 0 stays 0. Anything else turns into 255.
  if image.format != pfRgbx:
    image.ceil565()
    return
  image.forEachSpan:
    for i in spanStart ..< spanStart + spanLen:
      var rgbx = image.data[i]
      rgbx.r = if rgbx.r == 0: 0 else: 255
      rgbx.g = if rgbx.g == 0: 0 else: 255
      rgbx.b = if rgbx.b == 0: 0 else: 255
      rgbx.a = if rgbx.a == 0: 0 else: 255
      image.data[i] = rgbx

proc blur*(
  image: Image, radius: float32, outOfBounds: SomeColor = color(0, 0, 0, 0)
) {.raises: [PixieError].} =
  ## Applies Gaussian blur to the image given a radius.
  let radius = round(radius).int
  if radius == 0:
    return
  if radius < 0:
    raise newException(PixieError, "Cannot apply negative blur")

  if image.format != pfRgbx:
    # Blur at 8 bits in an RGBX copy and quantise the result back in. The
    # copy is the price of not writing a second blur; a 565 or grey canvas
    # is blurred rarely enough that paying it beats carrying that code.
    let tmp = image.toRgbxImage()
    tmp.blur(radius.float32, outOfBounds)
    for y in 0 ..< image.height:
      let
        src = tmp.dataIndex(0, y)
        dst = image.dataIndex(0, y)
      if image.format == pfGray4:
        for x in 0 ..< image.width:
          image.storeGray4(dst + x, rgbxToGray8(tmp.data[src + x]))
      elif image.format == pfGray8:
        for x in 0 ..< image.width:
          image.data8[dst + x] = rgbxToGray8(tmp.data[src + x])
      else:
        for x in 0 ..< image.width:
          image.data16[dst + x] = rgbxToRgb565(tmp.data[src + x])
    return

  let
    kernel = gaussianKernel(radius)
    outOfBounds = outOfBounds.asRgbx()

  proc `*`(sample: ColorRGBX, a: uint32): array[4, uint32] {.inline.} =
    [
      sample.r * a,
      sample.g * a,
      sample.b * a,
      sample.a * a
    ]

  template `+=`(values: var array[4, uint32], sample: array[4, uint32]) =
    values[0] += sample[0]
    values[1] += sample[1]
    values[2] += sample[2]
    values[3] += sample[3]

  template rgbx(values: array[4, uint32]): ColorRGBX =
    rgbx(
      (values[0] div 256 div 255).uint8,
      (values[1] div 256 div 255).uint8,
      (values[2] div 256 div 255).uint8,
      (values[3] div 256 div 255).uint8
    )

  # Blur in the X direction. Store with dimensions swapped for reading later.
  let blurX = newImage(image.height, image.width)
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      var values: array[4, uint32]
      for xx in x - radius ..< min(x + radius, 0):
        values += outOfBounds * kernel[xx - x + radius]
      var idx = image.dataIndex(0, y)
      for xx in max(x - radius, 0) .. min(x + radius, image.width - 1):
        values += image.data[idx + xx] * kernel[xx - x + radius]
      for xx in max(x - radius, image.width) .. x + radius:
        values += outOfBounds * kernel[xx - x + radius]
      blurX.unsafe[y, x] = rgbx(values)

  # Blur in the Y direction.
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      var values: array[4, uint32]
      for yy in y - radius ..< min(y + radius, 0):
        values += outOfBounds * kernel[yy - y + radius]
      var idx = blurX.dataIndex(0, x)
      for yy in max(y - radius, 0) .. min(y + radius, image.height - 1):
        values += blurX.data[idx + yy] * kernel[yy - y + radius]
      for yy in max(y - radius, image.height) .. y + radius:
        values += outOfBounds * kernel[yy - y + radius]
      image.unsafe[x, y] = rgbx(values)

proc getRgbaSmooth*(
  image: Image, x, y: float32, wrapped = false
): ColorRGBX {.raises: [].} =
  ## Gets a interpolated color with float point coordinates.
  ## Pixels outside the image are transparent.
  let
    x0 = x.floor.int
    y0 = y.floor.int
    x1 = x0 + 1
    y1 = y0 + 1
    xFractional = x - x.floor
    yFractional = y - y.floor

  var x0y0, x1y0, x0y1, x1y1: ColorRGBX
  if wrapped:
    x0y0 = image.unsafe[x0 mod image.width, y0 mod image.height]
    x1y0 = image.unsafe[x1 mod image.width, y0 mod image.height]
    x0y1 = image.unsafe[x0 mod image.width, y1 mod image.height]
    x1y1 = image.unsafe[x1 mod image.width, y1 mod image.height]
  else:
    x0y0 = image[x0, y0]
    x1y0 = image[x1, y0]
    x0y1 = image[x0, y1]
    x1y1 = image[x1, y1]

  var topMix = x0y0
  if xFractional > 0 and x0y0 != x1y0:
    topMix = mix(x0y0, x1y0, xFractional)

  var bottomMix = x0y1
  if xFractional > 0 and x0y1 != x1y1:
    bottomMix = mix(x0y1, x1y1, xFractional)

  if yFractional != 0 and topMix != bottomMix:
    mix(topMix, bottomMix, yFractional)
  else:
    topMix

proc drawCorrect(
  a, b: Image, transform = mat3(), blendMode: BlendMode, tiled: bool
) =
  ## Draws one image onto another using a matrix transform and color blending.
  ## This proc is not about performance, it should be as simple as possible.
  var
    inverseTransform = transform.inverse()
    # Compute movement vectors
    p = inverseTransform * vec2(0 + h, 0 + h)
    dx = inverseTransform * vec2(1 + h, 0 + h) - p
    dy = inverseTransform * vec2(0 + h, 1 + h) - p
    filterBy2 = max(dx.length, dy.length)
    b = b

  while filterBy2 >= 2.0:
    b = b.minifyBy2()
    p /= 2
    dx /= 2
    dy /= 2
    filterBy2 /= 2
    inverseTransform = scale(vec2(0.5, 0.5)) * inverseTransform

  while filterBy2 <= 0.5:
    b = b.magnifyBy2()
    p *= 2
    dx *= 2
    dy *= 2
    filterBy2 *= 2
    inverseTransform = scale(vec2(2, 2)) * inverseTransform

  let blender = blendMode.blender()
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      let
        samplePos = inverseTransform * vec2(x.float32 + h, y.float32 + h)
        xFloat = samplePos.x - h
        yFloat = samplePos.y - h
        backdrop = a.unsafe[x, y]
        sample = b.getRgbaSmooth(xFloat, yFloat, tiled)
        blended = blender(backdrop, sample)
      a.unsafe[x, y] = blended

proc blendLine(
  a, b: ptr UncheckedArray[ColorRGBX], len: int, blender: Blender
) {.inline.} =
  for i in 0 ..< len:
    a[i] = blender(a[i], b[i])

proc blendLineOverwrite(
  a, b: ptr UncheckedArray[ColorRGBX], len: int
) {.inline.} =
  copyMem(a[0].addr, b[0].addr, len * 4)

proc blendLineNormal(
  a, b: ptr UncheckedArray[ColorRGBX], len: int
) {.hasSimd.} =
  for i in 0 ..< len:
    a[i] = blendNormal(a[i], b[i])

proc blendLineMask(a, b: ptr UncheckedArray[ColorRGBX], len: int) {.hasSimd.} =
  for i in 0 ..< len:
    a[i] = blendMask(a[i], b[i])

template rowAddr(image: Image, x, y: int): pointer =
  ## Address of pixel (x, y) whatever the storage format.
  image.pixelAddr(image.dataIndex(x, y))

template zeroRows(image: Image, y, h: int) =
  ## Clears `h` whole rows starting at row `y`. One memset when the rows are
  ## back to back, which is every owner, and one per row for a strided view —
  ## whose rows must not be zeroed through, since the gaps belong to the parent.
  ## Zero is "transparent black" for RGBX and "black" for 565 — the same
  ## answer once a driver reads the colour off either.
  if image.isContiguous:
    image.zeroPixelRow(image.dataIndex(0, y), h * image.width)
  else:
    for yy in y ..< y + h:
      image.zeroPixelRow(image.dataIndex(0, yy), image.width)

proc blendLineAny(
  a: Image, ax, ay: int, b: Image, bx, by: int, len: int, blendMode: BlendMode
) =
  ## One row of `b` blended onto one row of `a` through the format-aware
  ## accessors: the slow generic path that exists so that any mix of RGBX and
  ## 565 on either side is correct. The RGBX/RGBX case never comes here.
  var
    ai = a.dataIndex(ax, ay)
    bi = b.dataIndex(bx, by)
  case blendMode:
  of OverwriteBlend:
    for _ in 0 ..< len:
      a.setPixel(ai, b.getPixel(bi))
      inc ai
      inc bi
  of NormalBlend:
    for _ in 0 ..< len:
      a.setPixel(ai, blendNormal(a.getPixel(ai), b.getPixel(bi)))
      inc ai
      inc bi
  of MaskBlend:
    for _ in 0 ..< len:
      a.setPixel(ai, blendMask(a.getPixel(ai), b.getPixel(bi)))
      inc ai
      inc bi
  else:
    let blender = blendMode.blender()
    for _ in 0 ..< len:
      a.setPixel(ai, blender(a.getPixel(ai), b.getPixel(bi)))
      inc ai
      inc bi

proc blendSampleLineAny(
  a: Image, ax, ay: int, samples: ptr UncheckedArray[ColorRGBX], len: int,
  blendMode: BlendMode
) =
  ## `blendLineAny` where the source row is already an RGBX scratch line.
  var ai = a.dataIndex(ax, ay)
  case blendMode:
  of OverwriteBlend:
    for i in 0 ..< len:
      a.setPixel(ai, samples[i])
      inc ai
  of NormalBlend:
    for i in 0 ..< len:
      a.setPixel(ai, blendNormal(a.getPixel(ai), samples[i]))
      inc ai
  of MaskBlend:
    for i in 0 ..< len:
      a.setPixel(ai, blendMask(a.getPixel(ai), samples[i]))
      inc ai
  else:
    let blender = blendMode.blender()
    for i in 0 ..< len:
      a.setPixel(ai, blender(a.getPixel(ai), samples[i]))
      inc ai

# A picture stretched into an axis-aligned rectangle, in fixed point. The
# general `draw` below samples every target pixel through the float accessors
# (`getRgbaSmooth`, about 11 µs a pixel on an ESP32-S3: 40 s for a 1848x1179
# window) and, to scale more than twice, first doubles or halves the whole
# picture into a new image. Here each axis gets a table of source pixels and
# 16-bit weights once, a source row is resampled across once and kept while
# the rows below still need it, and nothing the size of the picture is made.

{.push checks: off, stackTrace: off.}

type ScaleTaps = object
  ## Per output pixel along one axis: `count` source pixels from `first`,
  ## with weights from `start` in `weights`, 16.16 fractions summing to 65536.
  first, count, start: seq[int32]
  weights: seq[uint32]
  longest: int

proc scaleTaps(origin, size: float64, sourceSize, first, last: int): ScaleTaps =
  ## Output pixels [first, last) of a picture `sourceSize` pixels long drawn
  ## over [origin, origin + size). Made smaller, each output pixel is the
  ## average of the source it covers, a partly covered pixel by its share (a
  ## box filter: every source pixel counts, so nothing aliases however far it
  ## shrinks). As large or larger, the two source pixels nearest its centre,
  ## mixed by distance (bilinear), the outermost pixel held at each edge.
  let n = max(0, last - first)
  result.first = newSeq[int32](n)
  result.count = newSeq[int32](n)
  result.start = newSeq[int32](n)
  result.weights = newSeqOfCap[uint32](n * 2)
  let ratio = sourceSize.float64 / size # source pixels per output pixel
  for i in 0 ..< n:
    let t = (first + i).float64
    result.start[i] = result.weights.len.int32
    if ratio > 1:
      let
        a = max((t - origin) * ratio, 0.0)
        b = min((t + 1 - origin) * ratio, sourceSize.float64)
      if b <= a:
        let at = clamp(floor((t + 0.5 - origin) * ratio).int, 0, sourceSize - 1)
        result.first[i] = at.int32
        result.count[i] = 1
        result.weights.add 65536
      else:
        let
          lo = clamp(floor(a).int, 0, sourceSize - 1)
          hi = clamp(ceil(b).int, lo + 1, sourceSize)
          span = b - a
        var
          total = 0'i64
          largest = -1
        result.first[i] = lo.int32
        result.count[i] = int32(hi - lo)
        for k in lo ..< hi:
          let
            overlap = min(b, (k + 1).float64) - max(a, k.float64)
            w = uint32(max(0.0, overlap / span * 65536.0 + 0.5))
          if largest < 0 or w > result.weights[largest]:
            largest = result.weights.len
          result.weights.add w
          total += w.int64
        # The rounding's difference goes to the largest share: exactly 65536.
        result.weights[largest] = uint32(result.weights[largest].int64 + 65536 - total)
    else:
      var
        pos = (t + 0.5 - origin) * ratio - 0.5
        at = floor(pos).int
        frac = pos - floor(pos)
      if at < 0:
        at = 0
        frac = 0
      if at >= sourceSize - 1:
        at = sourceSize - 1
        frac = 0
      let w = uint32(frac * 65536.0 + 0.5)
      if w == 0:
        result.first[i] = at.int32
        result.count[i] = 1
        result.weights.add 65536
      elif w >= 65536:
        result.first[i] = int32(at + 1)
        result.count[i] = 1
        result.weights.add 65536
      else:
        result.first[i] = at.int32
        result.count[i] = 2
        result.weights.add 65536 - w
        result.weights.add w
    result.longest = max(result.longest, result.count[i].int)

template packChannels(r, g, b, a: uint32): uint32 =
  ((r + 32768) shr 16) or (((g + 32768) shr 16) shl 8) or
    (((b + 32768) shr 16) shl 16) or (((a + 32768) shr 16) shl 24)

proc sourceWord(source: Image, index: int): uint32 {.noinline.} =
  ## A pixel of a 565 or grey picture as an RGBX word. Out of line: the
  ## format-aware read is long, and flash is the firmware's budget.
  cast[uint32](source.getPixel(index))

proc resampleRow(source: Image, row: int, taps: ScaleTaps, dest: ptr UncheckedArray[uint32]) =
  ## Source row `row` across the output columns: premultiplied RGBX words,
  ## whatever the source's format.
  let
    n = taps.first.len
    base = source.dataIndex(0, row)
  template across(read: untyped) =
    for i in 0 ..< n:
      let
        count = taps.count[i].int
        first = base + taps.first[i].int
      if count == 1:
        dest[i] = read(first)
      else:
        var r, g, b, a: uint32
        let at = taps.start[i].int
        for k in 0 ..< count:
          let
            p = read(first + k)
            w = taps.weights[at + k]
          r += (p and 0xFF) * w
          g += ((p shr 8) and 0xFF) * w
          b += ((p shr 16) and 0xFF) * w
          a += (p shr 24) * w
        dest[i] = packChannels(r, g, b, a)
  if source.format == pfRgbx:
    let pixels = cast[ptr UncheckedArray[uint32]](source.data)
    template word(j: int): uint32 = pixels[j]
    across(word)
  else:
    template word(j: int): uint32 = sourceWord(source, j)
    across(word)

proc drawResampled*(
  a, b: Image, x, y, width, height: float64, opacity = 1.0
) {.raises: [].} =
  ## Draws `b` stretched into the rectangle (`x`, `y`, `width`, `height`) of
  ## `a`, in `a`'s pixels, over what `a` holds (normal blending), faded by
  ## `opacity`; any format on either side. A target pixel is drawn when its
  ## centre falls inside the rectangle, and only the part of the rectangle
  ## inside `a` is visited: a view of the target draws exactly the pixels a
  ## whole draw would put there. Larger than the picture it is bilinear,
  ## smaller a box filter (`scaleTaps`); at its own size on whole pixels, a
  ## copy. Memory: two tables, a few resampled rows and one output row.
  if width <= 0 or height <= 0 or b.width <= 0 or b.height <= 0 or opacity <= 0 or
      width.isNaN or height.isNaN or x.isNaN or y.isNaN:
    return
  let
    x0 = clamp(ceil(x - 0.5), 0.0, a.width.float64).int
    x1 = clamp(ceil(x + width - 0.5), 0.0, a.width.float64).int
    y0 = clamp(ceil(y - 0.5), 0.0, a.height.float64).int
    y1 = clamp(ceil(y + height - 0.5), 0.0, a.height.float64).int
  if x1 <= x0 or y1 <= y0:
    return
  let
    columns = scaleTaps(x, width, b.width, x0, x1)
    rows = scaleTaps(y, height, b.height, y0, y1)
    span = x1 - x0
    fade = uint64(min(opacity, 1.0) * 65536.0 + 0.5) # 65536: opaque
    ringSize = max(1, rows.longest)
  # One seq type for every scratch buffer (each one more is code on a device
  # whose flash is the budget): the resampled rows, then the output row, then
  # per ring slot the source row it holds, then this row's weights and where
  # in the ring each of its source rows is.
  var scratch = newSeq[uint32]((ringSize + 1) * span + 3 * ringSize)
  let
    base = cast[ptr UncheckedArray[uint32]](scratch[0].addr)
    line = cast[ptr UncheckedArray[uint32]](scratch[ringSize * span].addr)
    ringRow = cast[ptr UncheckedArray[uint32]](scratch[(ringSize + 1) * span].addr)
    weights = cast[ptr UncheckedArray[uint32]](scratch[(ringSize + 1) * span + ringSize].addr)
    offsets = cast[ptr UncheckedArray[uint32]](scratch[(ringSize + 1) * span + 2 * ringSize].addr)
  for slot in 0 ..< ringSize:
    ringRow[slot] = high(uint32)
  for yy in y0 ..< y1:
    let
      i = yy - y0
      count = rows.count[i].int
      first = rows.first[i].int
    # The source rows this one mixes, each resampled across once while the
    # rows after it still use it (a span's rows are consecutive, and no
    # longer than the ring: no two share a slot).
    for k in 0 ..< count:
      let
        r = first + k
        slot = r mod ringSize
      if ringRow[slot] != r.uint32:
        resampleRow(b, r, columns, cast[ptr UncheckedArray[uint32]](base[slot * span].addr))
        ringRow[slot] = r.uint32
      offsets[k] = uint32(slot * span)
      weights[k] = uint32((rows.weights[rows.start[i].int + k].uint64 * fade + 32768) shr 16)
    var samples = cast[ptr UncheckedArray[uint32]](base[offsets[0].int].addr)
    if count > 1 or fade != 65536:
      for j in 0 ..< span:
        var r, g, bl, al: uint32
        for k in 0 ..< count:
          let
            p = base[offsets[k].int + j]
            w = weights[k]
          r += (p and 0xFF) * w
          g += ((p shr 8) and 0xFF) * w
          bl += ((p shr 16) and 0xFF) * w
          al += (p shr 24) * w
        line[j] = packChannels(r, g, bl, al)
      samples = line
    let colors = cast[ptr UncheckedArray[ColorRGBX]](samples)
    if a.format == pfRgbx:
      blendLineNormal(a.getUncheckedArray(x0, yy), colors, span)
    else:
      # pixie's own format-aware blend and store, an opaque row stored as is.
      var opaque = true
      for j in 0 ..< span:
        if colors[j].a != 255:
          opaque = false
          break
      blendSampleLineAny(a, x0, yy, colors, span, if opaque: OverwriteBlend else: NormalBlend)

{.pop.}

proc blendRect(a, b: Image, pos: Ivec2, blendMode: BlendMode) =
  let
    px = pos.x.int
    py = pos.y.int

  if px >= a.width or px + b.width <= 0 or py >= a.height or py + b.height <= 0:
    if blendMode == MaskBlend:
      a.fill(rgbx(0, 0, 0, 0))
    return

  let
    xStart = max(-px, 0)
    yStart = max(-py, 0)
    xEnd = min(b.width, a.width - px)
    yEnd = min(b.height, a.height - py)

  if a.format == pfGray4 and b.format == pfGray4 and blendMode in {NormalBlend, OverwriteBlend}:
    # A 4-bit picture is opaque and dithered already: its levels, as they are.
    for y in yStart ..< yEnd:
      a.copyPixelRow(a.dataIndex(xStart + px, y + py), b, b.dataIndex(xStart, y), xEnd - xStart)
    return

  if b.format == pfRgb565 and blendMode in {NormalBlend, OverwriteBlend}:
    # A 565 picture is opaque, so drawn normally it overwrites: onto 565,
    # its rows copied as they are (a canvas a frame shows at its own size);
    # onto RGBX, each pixel expanded, with nothing to blend.
    for y in yStart ..< yEnd:
      if a.format == pfRgb565:
        copyMem(a.rowAddr(xStart + px, y + py), b.rowAddr(xStart, y),
          (xEnd - xStart) * 2)
      else:
        blendLineAny(a, xStart + px, y + py, b, xStart, y, xEnd - xStart, OverwriteBlend)
    return

  if a.format != pfRgbx or b.format != pfRgbx:
    # Any 565 on either side: the raw-pointer kernels below assume 4-byte
    # pixels, so go through the accessors. The mask clears stay the same.
    if blendMode == MaskBlend and yStart + py > 0:
      a.zeroRows(0, yStart + py)
    for y in yStart ..< yEnd:
      if blendMode == MaskBlend:
        if xStart + px > 0:
          a.zeroPixelRow(a.dataIndex(0, y + py), xStart + px)
        if xEnd + px < a.width:
          a.zeroPixelRow(a.dataIndex(xEnd + px, y + py), a.width - (xEnd + px))
      blendLineAny(a, xStart + px, y + py, b, xStart, y, xEnd - xStart, blendMode)
    if blendMode == MaskBlend and yEnd + py < a.height:
      a.zeroRows(yEnd + py, a.height - (yEnd + py))
    return

  case blendMode:
  of NormalBlend:
    for y in yStart ..< yEnd:
      blendLineNormal(
        a.getUncheckedArray(xStart + px, y + py),
        b.getUncheckedArray(xStart, y),
        xEnd - xStart
      )
  of OverwriteBlend:
    for y in yStart ..< yEnd:
      blendLineOverwrite(
        a.getUncheckedArray(xStart + px, y + py),
        b.getUncheckedArray(xStart, y),
        xEnd - xStart
      )
  of MaskBlend:
    {.linearScanEnd.}
    if yStart + py > 0:
      a.zeroRows(0, yStart + py)
    for y in yStart ..< yEnd:
      if xStart + px > 0:
        zeroMem(a.data[a.dataIndex(0, y + py)].addr, (xStart + px) * 4)
      blendLineMask(
        a.getUncheckedArray(xStart + px, y + py),
        b.getUncheckedArray(xStart, y),
        xEnd - xStart
      )
      if xEnd + px < a.width:
        zeroMem(
          a.data[a.dataIndex(xEnd + px, y + py)].addr,
          (a.width - (xEnd + px)) * 4
        )
    if yEnd + py < a.height:
      a.zeroRows(yEnd + py, a.height - (yEnd + py))
  else:
    let blender = blendMode.blender()
    for y in yStart ..< yEnd:
      blendLine(
        a.getUncheckedArray(xStart + px, y + py),
        b.getUncheckedArray(xStart, y),
        xEnd - xStart,
        blender
      )

proc drawSmooth(a, b: Image, transform: Mat3, blendMode: BlendMode) =
  let
    corners = [
      transform * vec2(0, 0),
      transform * vec2(b.width.float32, 0),
      transform * vec2(b.width.float32, b.height.float32),
      transform * vec2(0, b.height.float32)
    ]
    perimeter = [
      segment(corners[0], corners[1]),
      segment(corners[1], corners[2]),
      segment(corners[2], corners[3]),
      segment(corners[3], corners[0])
    ]
    inverseTransform = transform.inverse()
    # Compute movement vectors
    p = inverseTransform * vec2(0 + h, 0 + h)
    dx = inverseTransform * vec2(1 + h, 0 + h) - p
    dy = inverseTransform * vec2(0 + h, 1 + h) - p

  # Determine where we should start and stop drawing in the y dimension
  var
    yStart = a.height
    yEnd = 0
  for segment in perimeter:
    yStart = min(yStart, segment.at.y.floor.int)
    yEnd = max(yEnd, segment.at.y.ceil.int)
  yStart = yStart.clamp(0, a.height)
  yEnd = yEnd.clamp(0, a.height)

  if blendMode == MaskBlend and yStart > 0:
    a.zeroRows(0, yStart)

  var sampleLine = newSeq[ColorRGBX](a.width)
  for y in yStart ..< yEnd:
    # Determine where we should start and stop drawing in the x dimension
    var
      xMin = a.width.float32
      xMax = 0.float32
    for yOffset in [0.float32, 1]:
      let scanLine = Line(
        a: vec2(-1000, y.float32 + yOffset),
        b: vec2(1000, y.float32 + yOffset)
      )
      for segment in perimeter:
        var at: Vec2
        if scanline.intersects(segment, at) and segment.to != at:
          xMin = min(xMin, at.x)
          xMax = max(xMax, at.x)

    let
      xStart = clamp(xMin.floor.int, 0, a.width)
      xEnd = clamp(xMax.ceil.int, 0, a.width)

    if xEnd - xStart == 0:
      continue

    var srcPos = p + dx * xStart.float32 + dy * y.float32
    srcPos = vec2(srcPos.x - h, srcPos.y - h)
    for x in xStart ..< xEnd:
      sampleLine[x] = b.getRgbaSmooth(srcPos.x, srcPos.y)
      srcPos += dx

    if a.format != pfRgbx:
      # The sample line is RGBX whatever `b` is (getRgbaSmooth reads through
      # the accessors); only the store into `a` needs the format-aware path.
      if blendMode == MaskBlend and xStart > 0:
        a.zeroPixelRow(a.dataIndex(0, y), xStart)
      blendSampleLineAny(
        a, xStart, y,
        cast[ptr UncheckedArray[ColorRGBX]](sampleLine[xStart].addr),
        xEnd - xStart, blendMode
      )
      if blendMode == MaskBlend and a.width - xEnd > 0:
        a.zeroPixelRow(a.dataIndex(xEnd, y), a.width - xEnd)
      continue

    case blendMode:
    of NormalBlend:
      blendLineNormal(
        a.getUncheckedArray(xStart, y),
        cast[ptr UncheckedArray[ColorRGBX]](sampleLine[xStart].addr),
        xEnd - xStart
      )

    of OverwriteBlend:
      blendLineOverwrite(
        a.getUncheckedArray(xStart, y),
        cast[ptr UncheckedArray[ColorRGBX]](sampleLine[xStart].addr),
        xEnd - xStart
      )

    of MaskBlend:
      {.linearScanEnd.}
      if blendMode == MaskBlend and xStart > 0:
        zeroMem(a.data[a.dataIndex(0, y)].addr, xStart * 4)

      blendLineMask(
        a.getUncheckedArray(xStart, y),
        cast[ptr UncheckedArray[ColorRGBX]](sampleLine[xStart].addr),
        xEnd - xStart
      )

      if blendMode == MaskBlend and a.width - xEnd > 0:
        zeroMem(a.data[a.dataIndex(xEnd, y)].addr, (a.width - xEnd) * 4)
    else:
      blendLine(
        a.getUncheckedArray(xStart, y),
        cast[ptr UncheckedArray[ColorRGBX]](sampleLine[xStart].addr),
        xEnd - xStart,
        blendMode.blender()
      )

  if blendMode == MaskBlend and a.height - yEnd > 0:
    a.zeroRows(yEnd, a.height - yEnd)

proc draw*(
  a, b: Image, transform = mat3(), blendMode = NormalBlend
) {.raises: [PixieError].} =
  ## Draws one image onto another using a matrix transform and color blending.
  var
    transform = transform
    inverseTransform = transform.inverse()
    # Compute movement vectors
    p = inverseTransform * vec2(0 + h, 0 + h)
    dx = inverseTransform * vec2(1 + h, 0 + h) - p
    dy = inverseTransform * vec2(0 + h, 1 + h) - p
    filterBy2 = max(dx.length, dy.length)
    b = b

  while filterBy2 >= 2.0:
    b = b.minifyBy2()
    p /= 2
    dx /= 2
    dy /= 2
    filterBy2 /= 2
    transform = transform * scale(vec2(2, 2))

  while filterBy2 <= 0.5:
    b = b.magnifyBy2()
    p *= 2
    dx *= 2
    dy *= 2
    filterBy2 *= 2
    transform = transform * scale(vec2(1/2, 1/2))

  let
    hasRotationOrScaling = not(dx == vec2(1, 0) and dy == vec2(0, 1))
    smooth = not(
      dx.length == 1.0 and
      dy.length == 1.0 and
      transform[2, 0].fractional == 0.0 and
      transform[2, 1].fractional == 0.0
    )

  if hasRotationOrScaling or smooth:
    a.drawSmooth(b, transform, blendMode)
  else:
    a.blendRect(b, ivec2(transform[2, 0].int32, transform[2, 1].int32), blendMode)

proc drawTiled*(
  dst, src: Image, mat: Mat3, blendMode = NormalBlend
) {.raises: [PixieError].} =
  dst.drawCorrect(src, mat, blendMode, true)

proc resize*(srcImage: Image, width, height: int): Image {.raises: [PixieError].} =
  ## Resize an image to a given height and width.
  if width == srcImage.width and height == srcImage.height:
    result = srcImage.copy()
  else:
    result = newImage(width, height)
    result.draw(
      srcImage,
      scale(vec2(
        width.float32 / srcImage.width.float32,
        height.float32 / srcImage.height.float32
      )),
      OverwriteBlend
    )

proc spread(image: Image, spread: float32) {.raises: [PixieError].} =
  ## Grows the mask by spread.
  image.requireRgbx("spread")
  let spread = round(spread).int
  if spread == 0:
    return

  if spread > 0:
    # Spread in the X direction. Store with dimensions swapped for reading later.
    let spreadX = newImage(image.height, image.width)
    for y in 0 ..< image.height:
      for x in 0 ..< image.width:
        var maxValue: uint8
        for xx in max(x - spread, 0) .. min(x + spread, image.width - 1):
          let value = image.unsafe[xx, y].a
          if value > maxValue:
            maxValue = value
          if maxValue == 255:
            break
        spreadX.unsafe[y, x] = rgbx(0, 0, 0, maxValue)

    # Spread in the Y direction and modify mask.
    for y in 0 ..< image.height:
      for x in 0 ..< image.width:
        var maxValue: uint8
        for yy in max(y - spread, 0) .. min(y + spread, image.height - 1):
          let value = spreadX.unsafe[yy, x].a
          if value > maxValue:
            maxValue = value
          if maxValue == 255:
            break
        image.unsafe[x, y] = rgbx(0, 0, 0, maxValue)

  elif spread < 0:
    let spread = -spread

    # Spread in the X direction. Store with dimensions swapped for reading later.
    let spreadX = newImage(image.height, image.width)
    for y in 0 ..< image.height:
      for x in 0 ..< image.width:
        var minValue: uint8 = 255
        for xx in max(x - spread, 0) .. min(x + spread, image.width - 1):
          let value = image.unsafe[xx, y].a
          if value < minValue:
            minValue = value
          if minValue == 0:
            break
        spreadX.unsafe[y, x] = rgbx(0, 0, 0, minValue)

    # Spread in the Y direction and modify mask.
    for y in 0 ..< image.height:
      for x in 0 ..< image.width:
        var minValue: uint8 = 255
        for yy in max(y - spread, 0) .. min(y + spread, image.height - 1):
          let value = spreadX.unsafe[yy, x].a
          if value < minValue:
            minValue = value
          if minValue == 0:
            break
        image.unsafe[x, y] = rgbx(0, 0, 0, minValue)

proc shadow*(
  image: Image, offset: Vec2, spread, blur: float32, color: SomeColor
): Image {.raises: [PixieError].} =
  ## Create a shadow of the image with the offset, spread and blur.
  image.requireRgbx("shadow")
  var mask: Image
  if offset == vec2(0, 0):
    mask = image.copy()
  else:
    mask = newImage(image.width, image.height)
    mask.draw(image, translate(offset), OverwriteBlend)

  mask.spread(spread)
  mask.blur(blur)

  result = newImage(mask.width, mask.height)
  result.fill(color)
  result.draw(mask, blendMode = MaskBlend)

proc superImage*(image: Image, x, y, w, h: int): Image {.raises: [PixieError].} =
  ## Either cuts a sub image or returns a super image with padded transparency.
  if x >= 0 and x + w <= image.width and y >= 0 and y + h <= image.height:
    result = image.subImage(x, y, w, h)
  elif abs(x) >= image.width or abs(y) >= image.height:
    # Nothing to copy, just an empty new image
    result = newImage(w, h)
  else:
    result = newImage(w, h)
    result.draw(image, translate(vec2(-x.float32, -y.float32)), OverwriteBlend)

proc opaqueBounds*(image: Image): Rect =
  ## Returns the bounds of opaque pixels.
  ## Some images have transparency around them, use this to find just the
  ## visible part of the image and then use subImage to cut it out.
  ## Returns zero rect if whole image is transparent.
  ## Returns just the size of the image if no edge is transparent.
  if image.format != pfRgbx:
    # Opaque by construction, so every pixel counts.
    return rect(0, 0, image.width.float32, image.height.float32)
  var
    xMin = image.width
    xMax = 0
    yMin = image.height
    yMax = 0
  # Find the trim coordinates.
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      if image.unsafe[x, y].a != 0:
        xMin = min(xMin, x)
        xMax = max(xMax, x + 1)
        yMin = min(yMin, y)
        yMax = max(yMax, y + 1)
  if xMax <= xMin or yMax <= yMin:
    return rect(0, 0, 0, 0)
  rect(
    xMin.float32,
    yMin.float32,
    (xMax - xMin).float32,
    (yMax - yMin).float32
  )

when defined(release):
  {.pop.}
