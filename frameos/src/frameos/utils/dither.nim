import math, pixie

# 4-color screen colors, as presented by the manufacturer
const desaturated4ColorPalette* = @[
  (0, 0, 0),
  (255, 255, 255),
  (255, 255, 0),
  (255, 0, 0),
]

# 4-color screen colors, as measured on a real display
const saturated4ColorPalette* = @[
  (57, 48, 57),
  (255, 255, 255),
  (208, 190, 71),
  (156, 72, 75),
]

# 6-color Spectra e-ink displays, measured on display and modulated
const spectra6ColorPalette* = @[
  (25, 20, 38),    # 0x0 - black
  (178, 193, 192), # 0x1 - white
  (199, 187, 0),   # 0x2 - yellow
  (107, 17, 25),   # 0x3 - red
  (999, 999, 999), # skips an index!
  (24, 83, 154),   # 0x5 - blue
  (42, 85, 49),    # 0x6 - green
]

# 7-color screen colors, as presented by the manufacturer
# we do not use these colors anywhere. They're presented for reference
const desaturated7ColorPalette* = @[
  (0, 0, 0),
  (255, 255, 255),
  (0, 255, 0),
  (0, 0, 255),
  (255, 0, 0),
  (255, 255, 0),
  (255, 140, 0)
]

# 7-color screen colors, as measured on a real display
# We use these colors for dithering on all waveshare and inky 7-color displays
const saturated7ColorPalette* = @[
  (57, 48, 57),    # dark gray
  (255, 255, 255), # white
  (58, 91, 70),    # khaki green
  (61, 59, 94),    # dark purple
  (156, 72, 75),   # red
  (208, 190, 71),  # yellow
  (177, 106, 73),  # orange-brown
]

proc clip8(value: int): uint8 {.inline.} =
  if value < 0: return 0
  elif value > 255: return 255
  else: return value.uint8

proc toGrayscaleFloat*(image: Image, grayscale: var seq[float], multiple: float = 1.0) =
  let
    width = image.width
    height = image.height
  for y in 0..<height:
    for x in 0..<width:
      let
        index = y * width + x
        p = image.unsafe[x, y]
      grayscale[index] = multiple * (p.r.float * 0.21 + p.g.float * 0.72 + p.b.float * 0.07) / 255.0

proc floydSteinberg*(pixels: var seq[float], width, height: int) =
  let
    distribution = [7.0 / 16.0, 3.0 / 16.0, 5.0 / 16.0, 1.0 / 16.0]
    dy = [0, 1, 1, 1]
    dx = [1, -1, 0, 1]

  for y in 0..<height:
    for x in 0..<width:
      let index = y * width + x
      let value = round(pixels[index])
      let error = pixels[index] - value
      pixels[index] = value

      for i in 0..<4:
        if (x + dx[i] >= 0) and (x + dx[i] < width) and (y + dy[i] < height):
          pixels[(y + dy[i]) * width + (x + dx[i])] += error * distribution[i]

proc closestPalette*(palette: seq[(int, int, int)], r, g, b: int): (int, int, int, int) =
  # TODO: optimize with a lookup table
  var index: int = 0
  var min = 99999999999
  for i in 0..<palette.len:
    let distance = abs(r - palette[i][0]) + abs(g - palette[i][1]) + abs(b - palette[i][2])
    if distance < min:
      min = distance
      index = i
  return (index, palette[index][0], palette[index][1], palette[index][2])

# ---------------------------------------------------------------------------
# Row-streamed dithering.
#
# Floyd–Steinberg only ever reaches one row ahead, so the error state is two
# rows, not a canvas. The templates below walk an image top to bottom with
# exactly that — a few KB for any panel width — and hand each quantised pixel
# to the caller's body. They read the image through pixie's accessors, so
# they work on a view and on a 16-bit canvas as well as on RGBX, and they
# never write to the image: a 565 canvas keeps its 5/6-bit colour and the
# error accumulates at full precision beside it.
#
# The palette walk keeps the arithmetic of the in-place version it replaces
# — integer error split with `div 16`, distributed in the order right,
# down-left, down, down-right, and *clipped into the neighbouring pixel value
# at every step* — so the packed bytes are the same as before on every
# existing panel. The grey walk keeps `toGrayscaleFloat` + `floydSteinberg`
# float64 arithmetic the same way.

template forEachPaletteDithered*(
  image: Image, palette: seq[(int, int, int)],
  x, y, index: untyped, body: untyped
) =
  ## Runs `body` for every pixel in scan order with `x`, `y` and the
  ## palette `index` the dither chose for it.
  block:
    let
      ditherWidth = image.width
      ditherHeight = image.height
    if ditherWidth > 0 and ditherHeight > 0:
      # Adjusted RGB of the current row and the next: the pixel values after
      # the error already pushed into them, which is what the in-place
      # version stored back into the image.
      var
        curRow = newSeq[uint8](ditherWidth * 3)
        nextRow = newSeq[uint8](ditherWidth * 3)
      template loadRow(row: var seq[uint8], ry: int) =
        for rx in 0 ..< ditherWidth:
          let p = image.unsafe[rx, ry]
          row[rx * 3 + 0] = p.r
          row[rx * 3 + 1] = p.g
          row[rx * 3 + 2] = p.b
      template push(row: var seq[uint8], rx: int, er, eg, eb: int, weight: int) =
        row[rx * 3 + 0] = clip8(row[rx * 3 + 0].int + (er * weight div 16))
        row[rx * 3 + 1] = clip8(row[rx * 3 + 1].int + (eg * weight div 16))
        row[rx * 3 + 2] = clip8(row[rx * 3 + 2].int + (eb * weight div 16))
      loadRow(curRow, 0)
      for yy in 0 ..< ditherHeight:
        let hasNext = yy + 1 < ditherHeight
        if hasNext:
          loadRow(nextRow, yy + 1)
        for xx in 0 ..< ditherWidth:
          let
            imageR = curRow[xx * 3 + 0].int
            imageG = curRow[xx * 3 + 1].int
            imageB = curRow[xx * 3 + 2].int
            (palIndex, palR, palG, palB) = closestPalette(palette, imageR, imageG, imageB)
            errorR = imageR - palR
            errorG = imageG - palG
            errorB = imageB - palB
          block:
            let
              x {.inject.} = xx
              y {.inject.} = yy
              index {.inject.} = palIndex
            body
          if xx + 1 < ditherWidth:
            push(curRow, xx + 1, errorR, errorG, errorB, 7)
          if hasNext:
            if xx - 1 >= 0:
              push(nextRow, xx - 1, errorR, errorG, errorB, 3)
            push(nextRow, xx, errorR, errorG, errorB, 5)
            if xx + 1 < ditherWidth:
              push(nextRow, xx + 1, errorR, errorG, errorB, 1)
        swap(curRow, nextRow)

template forEachGrayDithered*(
  image: Image, maxLevel: int,
  x, y, level: untyped, body: untyped
) =
  ## Runs `body` for every pixel in scan order with the dithered grey
  ## `level` in 0 .. maxLevel. Same numbers as `toGrayscaleFloat(maxLevel)`
  ## followed by `floydSteinberg`, without the float-per-pixel canvas.
  block:
    let
      ditherWidth = image.width
      ditherHeight = image.height
      multiple = maxLevel.float
    if ditherWidth > 0 and ditherHeight > 0:
      var
        curRow = newSeq[float](ditherWidth)
        nextRow = newSeq[float](ditherWidth)
      template loadRow(row: var seq[float], ry: int) =
        for rx in 0 ..< ditherWidth:
          let p = image.unsafe[rx, ry]
          row[rx] = multiple * (p.r.float * 0.21 + p.g.float * 0.72 + p.b.float * 0.07) / 255.0
      loadRow(curRow, 0)
      for yy in 0 ..< ditherHeight:
        let hasNext = yy + 1 < ditherHeight
        if hasNext:
          loadRow(nextRow, yy + 1)
        for xx in 0 ..< ditherWidth:
          let
            value = round(curRow[xx])
            error = curRow[xx] - value
          block:
            let
              x {.inject.} = xx
              y {.inject.} = yy
              level {.inject.} = max(0, min(maxLevel, value.int))
            body
          if xx + 1 < ditherWidth:
            curRow[xx + 1] += error * (7.0 / 16.0)
          if hasNext:
            if xx - 1 >= 0:
              nextRow[xx - 1] += error * (3.0 / 16.0)
            nextRow[xx] += error * (5.0 / 16.0)
            if xx + 1 < ditherWidth:
              nextRow[xx + 1] += error * (1.0 / 16.0)
        swap(curRow, nextRow)

proc ditherPaletteIndexed*(image: Image, palette: seq[(int, int, int)]): seq[uint8] =
  ## Dithers to the palette and packs indices MSB-first at 1/2/4/8 bits per
  ## pixel, rows padded to whole bytes. Streams; the image is not modified.
  let
    width = image.width
    height = image.height
    bits = if palette.len <= 2: 1 elif palette.len <= 4: 2 elif palette.len <= 16: 4 else: 8
    divider = if palette.len <= 2: 8 elif palette.len <= 4: 4 elif palette.len <= 16: 2 else: 1

  let rowWidth = ceil(width.float / divider.float).int
  var output = newSeq[uint8](height * rowWidth)

  image.forEachPaletteDithered(palette, x, y, index):
    let outputIndex = y * rowWidth + x div divider
    case bits:
      of 8: output[outputIndex] = index.uint8
      of 4:
        let bitPosition = (1 - (x mod 2)) * 4
        output[outputIndex] = output[outputIndex] or (index shl bitPosition).uint8
      of 2:
        let bitPosition = (3 - (x mod 4)) * 2
        output[outputIndex] = output[outputIndex] or (index shl bitPosition).uint8
      of 1:
        let bitPosition = (7 - x) mod 8
        output[outputIndex] = output[outputIndex] or (index shl bitPosition).uint8
      else: discard

  return output
