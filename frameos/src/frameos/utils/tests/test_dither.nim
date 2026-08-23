import std/unittest
import pixie

import ../dither

proc setPixel(image: Image, x, y: int, r, g, b: uint8) =
  let idx = image.dataIndex(x, y)
  image.data[idx].r = r
  image.data[idx].g = g
  image.data[idx].b = b
  image.data[idx].a = 255

suite "dither helpers":
  test "closestPalette picks nearest index and color":
    let palette = @[(0, 0, 0), (255, 255, 255), (200, 10, 10)]
    let closest = closestPalette(palette, 210, 0, 0)
    check closest[0] == 2
    check closest[1] == 200
    check closest[2] == 10
    check closest[3] == 10

  test "toGrayscaleFloat applies weighted conversion":
    let image = newImage(2, 1)
    setPixel(image, 0, 0, 255, 0, 0)
    setPixel(image, 1, 0, 0, 255, 0)
    var grayscale = newSeq[float](2)

    toGrayscaleFloat(image, grayscale, multiple = 2.0)
    check abs(grayscale[0] - 0.42) < 0.01
    check abs(grayscale[1] - 1.44) < 0.01

  test "ditherPaletteIndexed packs bytes for 1 2 4 and 8 bit palettes":
    # This test pins the PACKING with palettes whose entries sit 1 unit
    # apart, where any quantizer jitter changes the picks; turn it off.
    let savedJitter = ditherJitterAmp
    ditherJitterAmp = 0
    defer: ditherJitterAmp = savedJitter
    let bwPalette = @[(0, 0, 0), (255, 255, 255)]
    let bwImage = newImage(8, 1)
    for x in 0 ..< 8:
      if x mod 2 == 0:
        setPixel(bwImage, x, 0, 255, 255, 255)
      else:
        setPixel(bwImage, x, 0, 0, 0, 0)
    let packed1 = ditherPaletteIndexed(bwImage, bwPalette)
    check packed1 == @[170'u8]

    let palette2Bit = @[(0, 0, 0), (80, 80, 80), (160, 160, 160), (255, 255, 255)]
    let image2Bit = newImage(4, 1)
    for x in 0 ..< 4:
      let c = uint8(palette2Bit[x][0])
      setPixel(image2Bit, x, 0, c, c, c)
    let packed2 = ditherPaletteIndexed(image2Bit, palette2Bit)
    check packed2 == @[27'u8] # 00 01 10 11

    var palette4Bit: seq[(int, int, int)] = @[]
    for i in 0 .. 15:
      palette4Bit.add((i * 10, i * 10, i * 10))
    let image4Bit = newImage(2, 1)
    setPixel(image4Bit, 0, 0, uint8(palette4Bit[10][0]), uint8(palette4Bit[10][1]), uint8(palette4Bit[10][2]))
    setPixel(image4Bit, 1, 0, uint8(palette4Bit[3][0]), uint8(palette4Bit[3][1]), uint8(palette4Bit[3][2]))
    let packed4 = ditherPaletteIndexed(image4Bit, palette4Bit)
    check packed4 == @[163'u8] # 0xA3

    var palette8Bit: seq[(int, int, int)] = @[]
    for i in 0 .. 16:
      palette8Bit.add((i, i, i))
    let image8Bit = newImage(2, 1)
    setPixel(image8Bit, 0, 0, 0, 0, 0)
    setPixel(image8Bit, 1, 0, 16, 16, 16)
    let packed8 = ditherPaletteIndexed(image8Bit, palette8Bit)
    check packed8 == @[0'u8, 16'u8]

# ---------------------------------------------------------------------------
# The row-streamed dither must produce the bytes the in-place version did.
# The reference below IS the old implementation, kept here so the equivalence
# is checked rather than remembered.

proc referencePaletteIndexed(image: Image, palette: seq[(int, int, int)]): seq[uint8] =
  let
    img = image.copy
    width = img.width
    height = img.height
    distribution = [7, 3, 5, 1]
    dy = [0, 1, 1, 1]
    dx = [1, -1, 0, 1]
    bits = if palette.len <= 2: 1 elif palette.len <= 4: 2 elif palette.len <= 16: 4 else: 8
    divider = if palette.len <= 2: 8 elif palette.len <= 4: 4 elif palette.len <= 16: 2 else: 1
  proc clip8(value: int): uint8 =
    if value < 0: 0'u8 elif value > 255: 255'u8 else: value.uint8
  let rowWidth = ceil(width.float / divider.float).int
  var output = newSeq[uint8](height * rowWidth)
  for y in 0..<height:
    for x in 0..<width:
      let dataIndex = y * width + x
      let outputIndex = y * rowWidth + x div divider
      let imageR = img.data[dataIndex].r.int
      let imageG = img.data[dataIndex].g.int
      let imageB = img.data[dataIndex].b.int
      # Same threshold modulation as the streamed template: jitter the
      # pick, diffuse the true error.
      let jitter =
        if ditherJitterAmp > 0: ditherJitterFor(dataIndex, ditherJitterAmp)
        else: 0
      let (index, palR, palG, palB) = closestPalette(palette,
        clip8(imageR + jitter).int, clip8(imageG + jitter).int,
        clip8(imageB + jitter).int)
      let errorR = imageR - palR
      let errorG = imageG - palG
      let errorB = imageB - palB
      case bits:
        of 8: output[outputIndex] = index.uint8
        of 4: output[outputIndex] = output[outputIndex] or (index shl ((1 - (x mod 2)) * 4)).uint8
        of 2: output[outputIndex] = output[outputIndex] or (index shl ((3 - (x mod 4)) * 2)).uint8
        of 1: output[outputIndex] = output[outputIndex] or (index shl ((7 - x) mod 8)).uint8
        else: discard
      for i in 0..<4:
        if (x + dx[i] >= 0) and (x + dx[i] < width) and (y + dy[i] < height):
          let errorIndex = (y + dy[i]) * width + (x + dx[i])
          img.data[errorIndex].r = clip8(img.data[errorIndex].r.int + (errorR * distribution[i] div 16))
          img.data[errorIndex].g = clip8(img.data[errorIndex].g.int + (errorG * distribution[i] div 16))
          img.data[errorIndex].b = clip8(img.data[errorIndex].b.int + (errorB * distribution[i] div 16))
  output

proc noisyImage(width, height: int, seed: uint32): Image =
  ## Deterministic pseudo-random colours, with smooth regions too so the
  ## error diffusion has saturating runs to clip on.
  result = newImage(width, height)
  var s = seed
  for y in 0 ..< height:
    for x in 0 ..< width:
      s = s * 1664525'u32 + 1013904223'u32
      let noise = (s shr 24).int
      let grad = (x * 255) div max(1, width - 1)
      let r = if y < height div 2: grad else: noise
      let g = if x < width div 2: 255 - grad else: (noise * 3) mod 256
      let b = (grad + noise) mod 256
      result.unsafe[x, y] = rgbx(r.uint8, g.uint8, b.uint8, 255)

suite "row-streamed dither equals the in-place reference":
  test "palette dither, every bit depth, RGBX and 565 canvases":
    let palettes = @[
      @[(0, 0, 0), (255, 255, 255)],
      saturated4ColorPalette,
      spectra6ColorPalette,
      saturated7ColorPalette,
      (block:
        var p: seq[(int, int, int)] = @[]
        for i in 0 .. 16: p.add((i * 15, i * 15, i * 15))
        p),
    ]
    for (w, h) in [(37, 23), (64, 8), (1, 5), (9, 1)]:
      let image = noisyImage(w, h, uint32(w * 31 + h))
      for palette in palettes:
        check ditherPaletteIndexed(image, palette) == referencePaletteIndexed(image, palette)
        # A 565 canvas holding the quantised picture dithers like the RGBX
        # image holding that same quantised picture.
        let packed = image.toRgb565Image()
        check ditherPaletteIndexed(packed, palette) ==
          referencePaletteIndexed(packed.toRgbxImage(), palette)
        # And a view dithers as the sub-image it addresses.
        if w >= 8 and h >= 4:
          let v = image.view(2, 1, w - 4, h - 2)
          check ditherPaletteIndexed(v, palette) == referencePaletteIndexed(v.copy(), palette)

  test "grey dither equals toGrayscaleFloat + floydSteinberg":
    for maxLevel in [1, 3, 15]:
      for (w, h) in [(37, 23), (64, 8), (1, 5)]:
        let image = noisyImage(w, h, uint32(maxLevel * 7 + w))
        var gray = newSeq[float](w * h)
        image.toGrayscaleFloat(gray, maxLevel.float)
        # The streamed template jitters its quantizer (threshold
        # modulation); the reference must use the same unit to stay
        # comparable.
        gray.floydSteinberg(w, h, jitterUnit = maxLevel / 255)
        var streamed = newSeq[int](w * h)
        image.forEachGrayDithered(maxLevel, x, y, level):
          streamed[y * w + x] = level
        for i in 0 ..< w * h:
          let reference = max(0, min(maxLevel, round(gray[i]).int))
          check streamed[i] == reference
