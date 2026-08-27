import math, pixie

when defined(frameosEmbedded):
  # The ESP32's internal SRAM, for the few KB of working rows the streamed
  # dither touches four times per pixel: a seq would land in PSRAM through
  # the patched allocator, behind the same cache the canvas and the packed
  # buffer are streaming through. nil when internal RAM has no room — the
  # seq path below is the fallback, never a failure.
  proc fosNimInternalAlloc(size: csize_t): pointer {.importc: "fos_nim_internal_alloc", cdecl.}
  proc fosNimInternalFree(p: pointer) {.importc: "fos_nim_internal_free", cdecl.}

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

# ------------------------------------------------------------ threshold jitter
#
# Floyd-Steinberg on a smooth input is its own artifact source: at slowly
# varying densities the diffusion locks into periodic textures ("worms",
# checker plateaus), and the boundaries where the texture changes read as
# faint bands on the panel even from a full-precision canvas. Perturbing
# only the QUANTIZER'S CHOICE by a small per-pixel hash offset breaks the
# lock-in, while the diffused error stays measured against the true value —
# so the local mean is exact and there is no colour shift. Found via the
# 565 canvas's store dither, whose accidental noise made gradients render
# visibly smoother than the RGBX canvas (2026-08-24 weather-sky bake-off;
# amplitude 8 matched it, 16+ turned grainy).
#
# The amplitude is in 8-bit units and applies to every consumer of the
# dither utils — ESP32 packers, Pi drivers, preview paths — so panels
# render the same picture whatever board drives them. 0 disables.

const DitherJitterDefaultAmp* = 8

var ditherJitterAmp* = DitherJitterDefaultAmp

template ditherJitterFor*(index, amp: int): int =
  ## Deterministic per-pixel offset in [-amp, amp], hashed from the flat
  ## pixel index (a pattern keyed on x alone would repeat row over row).
  ((((index.uint32 * 0x9E3779B1'u32) shr 24).int * (2 * amp + 1)) shr 8) - amp

proc floydSteinberg*(pixels: var seq[float], width, height: int,
    jitterUnit: float = 0.0) =
  ## `jitterUnit` is the float value of one 8-bit unit on this scale (pass
  ## `maxLevel / 255` alongside `toGrayscaleFloat(maxLevel)`); with the
  ## default 0 the quantizer is unperturbed. See the threshold-jitter note
  ## below — the error is always against the true value.
  let
    distribution = [7.0 / 16.0, 3.0 / 16.0, 5.0 / 16.0, 1.0 / 16.0]
    dy = [0, 1, 1, 1]
    dx = [1, -1, 0, 1]

  for y in 0..<height:
    for x in 0..<width:
      let index = y * width + x
      let jitter =
        if jitterUnit > 0 and ditherJitterAmp > 0:
          ditherJitterFor(index, ditherJitterAmp).float * jitterUnit
        else:
          0.0
      let value = round(pixels[index] + jitter)
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
  ##
  ## This is the hot loop of every ESP32 render (1.92 M pixels on a 13.3"
  ## panel) and it is compiled there with `--opt:size` and checks on, so
  ## the shape is deliberately flat: the palette is copied into three plain
  ## int arrays and searched inline (no tuple returns, no seq-of-tuples
  ## indexing), the error rows are walked through unchecked pointers, and a
  ## row is read straight out of the canvas buffer — `rgb565ToRgbx` on a
  ## 565 canvas, the RGBX word otherwise — instead of one `unsafe[]` call
  ## (format branch + `dataIndex`) per pixel. The arithmetic is untouched:
  ## first-minimum Manhattan search, `div 16` error split clipped into the
  ## neighbour at every step, threshold jitter on the pick only — so the
  ## packed bytes are the same as before on every panel
  ## (utils/tests/test_dither.nim checks that against the in-place
  ## reference, on RGBX, 565 and views). Measured on the 2026-08-27 E1004
  ## log the old loop cost ~22 s per 1200x1600 render, half the awake time
  ## of every battery wake.
  block:
    let
      ditherWidth = image.width
      ditherHeight = image.height
    if ditherWidth > 0 and ditherHeight > 0:
      let paletteLen = palette.len
      var
        palRSeq = newSeq[int](paletteLen)
        palGSeq = newSeq[int](paletteLen)
        palBSeq = newSeq[int](paletteLen)
      for i in 0 ..< paletteLen:
        palRSeq[i] = palette[i][0]
        palGSeq[i] = palette[i][1]
        palBSeq[i] = palette[i][2]
      let
        palRs = cast[ptr UncheckedArray[int]](palRSeq[0].addr)
        palGs = cast[ptr UncheckedArray[int]](palGSeq[0].addr)
        palBs = cast[ptr UncheckedArray[int]](palBSeq[0].addr)
      # Adjusted RGB of the current row and the next: the pixel values after
      # the error already pushed into them, which is what the in-place
      # version stored back into the image.
      var
        rowsInternal: pointer = nil
        curRowSeq: seq[uint8]
        nextRowSeq: seq[uint8]
        curRow: ptr UncheckedArray[uint8]
        nextRow: ptr UncheckedArray[uint8]
      when defined(frameosEmbedded):
        rowsInternal = fosNimInternalAlloc(csize_t(ditherWidth * 6))
      if rowsInternal != nil:
        curRow = cast[ptr UncheckedArray[uint8]](rowsInternal)
        nextRow = cast[ptr UncheckedArray[uint8]](cast[uint](rowsInternal) + uint(ditherWidth * 3))
      else:
        curRowSeq = newSeq[uint8](ditherWidth * 3)
        nextRowSeq = newSeq[uint8](ditherWidth * 3)
        curRow = cast[ptr UncheckedArray[uint8]](curRowSeq[0].addr)
        nextRow = cast[ptr UncheckedArray[uint8]](nextRowSeq[0].addr)
      defer:
        when defined(frameosEmbedded):
          if rowsInternal != nil: fosNimInternalFree(rowsInternal)
      let is565 = image.isRgb565
      template loadRow(row: ptr UncheckedArray[uint8], ry: int) =
        # Rows are contiguous within themselves for owners and views alike
        # (`dataIndex` = origin + stride * y + x), so one base index per row
        # and a plain walk is exactly what `unsafe[rx, ry]` would address.
        let rowStart = image.dataIndex(0, ry)
        if is565:
          let src = image.data16
          for rx in 0 ..< ditherWidth:
            let p = rgb565ToRgbx(src[rowStart + rx])
            row[rx * 3 + 0] = p.r
            row[rx * 3 + 1] = p.g
            row[rx * 3 + 2] = p.b
        else:
          let src = image.data
          for rx in 0 ..< ditherWidth:
            let p = src[rowStart + rx]
            row[rx * 3 + 0] = p.r
            row[rx * 3 + 1] = p.g
            row[rx * 3 + 2] = p.b
      template push(row: ptr UncheckedArray[uint8], rx: int, er, eg, eb: int, weight: int) =
        row[rx * 3 + 0] = clip8(row[rx * 3 + 0].int + (er * weight div 16))
        row[rx * 3 + 1] = clip8(row[rx * 3 + 1].int + (eg * weight div 16))
        row[rx * 3 + 2] = clip8(row[rx * 3 + 2].int + (eb * weight div 16))
      loadRow(curRow, 0)
      for yy in 0 ..< ditherHeight:
        let hasNext = yy + 1 < ditherHeight
        if hasNext:
          loadRow(nextRow, yy + 1)
        let rowIndex = yy * ditherWidth
        for xx in 0 ..< ditherWidth:
          let
            imageR = curRow[xx * 3 + 0].int
            imageG = curRow[xx * 3 + 1].int
            imageB = curRow[xx * 3 + 2].int
            # The jitter moves only which palette colour is picked; the
            # error the neighbours inherit is measured against the true
            # value, so the mean stays exact (threshold modulation).
            jitter =
              if ditherJitterAmp > 0:
                ditherJitterFor(rowIndex + xx, ditherJitterAmp)
              else:
                0
            pickR = clip8(imageR + jitter).int
            pickG = clip8(imageG + jitter).int
            pickB = clip8(imageB + jitter).int
          # closestPalette, inlined: first minimum of the Manhattan distance.
          var
            palIndex = 0
            bestDistance = high(int)
          for i in 0 ..< paletteLen:
            let distance = abs(pickR - palRs[i]) + abs(pickG - palGs[i]) + abs(pickB - palBs[i])
            if distance < bestDistance:
              bestDistance = distance
              palIndex = i
          let
            errorR = imageR - palRs[palIndex]
            errorG = imageG - palGs[palIndex]
            errorB = imageB - palBs[palIndex]
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
      let jitterUnit = multiple / 255.0
      for yy in 0 ..< ditherHeight:
        let hasNext = yy + 1 < ditherHeight
        if hasNext:
          loadRow(nextRow, yy + 1)
        for xx in 0 ..< ditherWidth:
          let
            jitter =
              if ditherJitterAmp > 0:
                ditherJitterFor(yy * ditherWidth + xx, ditherJitterAmp).float * jitterUnit
              else:
                0.0
            value = round(curRow[xx] + jitter)
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
