## Bilinear resampling of a source rectangle onto a whole target, in fixed
## point. render/zoomPan draws one per frame: pixie's float sampler
## (getRgbaSmooth) cost ~10 µs a pixel on an ESP32-S3, 2.3 s a frame on the
## SenseCAP Indicator's 480x480 panel (2026-10-25).
##
## Each target pixel's centre maps into the rectangle and the four source
## pixels around it are mixed, 8 bits of weight per axis. A source row is
## interpolated across once and kept for the next target row, which at a
## zoom near 1 is the row below. Edges clamp to the outermost pixels, so a
## crop that touches the border has no transparent fringe. The weights are
## on premultiplied colors, which is what mixing them needs.

import pixie

# The indices below are built and clamped here (axisTaps), and the firmware's
# -d:release keeps bound and overflow checks: several per pixel, in a loop
# that runs 230,400 times a frame.
{.push checks: off, stackTrace: off.}

type AxisTap = object
  first: int32  ## the left / upper source pixel, in pixels along the axis
  step: int32   ## 1 to its neighbour, 0 on the last pixel
  weight: uint32 ## of the neighbour, 0..255

proc axisTaps(start, size: float, count, limit: int): seq[AxisTap] =
  result = newSeq[AxisTap](count)
  if count <= 0 or limit <= 0:
    return
  let stride = size / count.float
  for i in 0 ..< count:
    let pos = start + (i.float + 0.5) * stride - 0.5
    var first = floor(pos)
    var weight = int((pos - first) * 256.0)
    var index = first.int
    if index < 0:
      index = 0
      weight = 0
    if index >= limit - 1:
      index = limit - 1
      weight = 0
    result[i] = AxisTap(first: index.int32, step: (if index < limit - 1: 1 else: 0),
      weight: clamp(weight, 0, 255).uint32)

template mix(a, b, weight: uint32): uint32 =
  ## Two RGBX words mixed by `weight`/256 of `b`, two channels per multiply:
  ## each 8-bit channel sits in a 16-bit lane, and 255 * 256 plus the
  ## rounding half still fits it.
  let keep = 256'u32 - weight
  let rb = (((a and 0x00FF00FF'u32) * keep + (b and 0x00FF00FF'u32) * weight +
    0x00800080'u32) shr 8) and 0x00FF00FF'u32
  let ag = ((((a shr 8) and 0x00FF00FF'u32) * keep + ((b shr 8) and 0x00FF00FF'u32) * weight +
    0x00800080'u32) shr 8) and 0x00FF00FF'u32
  rb or (ag shl 8)

proc interpolateRow(source: Image, row: int, columns: seq[AxisTap], into: var seq[uint32]) =
  let pixels = cast[ptr UncheckedArray[uint32]](source.data)
  let start = source.dataIndex(0, row)
  for x in 0 ..< columns.len:
    let tap = columns[x]
    let at = start + tap.first.int
    let left = pixels[at]
    into[x] = if tap.weight == 0: left else: mix(left, pixels[at + tap.step.int], tap.weight)

# 565 onto 565: each pixel spread into a word with a gap above every field
# (green moved to the top half), so one multiply pair mixes all three and the
# result folds back to 565 with no pack, no dither and no rounding per field
# beyond the one constant. 5 bits of weight. About a third of the RGBX path's
# cost per pixel on the S3, whose canvas is 565 on an RGB LCD.

const
  SpreadMask = 0x07E0F81F'u32
  SpreadHalf = 0x00208010'u32 ## 16, the rounding half, in each field

template spread(p: uint16): uint32 =
  (p.uint32 or (p.uint32 shl 16)) and SpreadMask

template fold(v: uint32): uint16 =
  uint16((v or (v shr 16)) and 0xFFFF'u32)

template mix565(a, b, weight: uint32): uint32 =
  ((a * (32'u32 - weight) + b * weight + SpreadHalf) shr 5) and SpreadMask

proc interpolateRow565(source: Image, row: int, columns: seq[AxisTap], into: var seq[uint32]) =
  let pixels = source.data16
  let start = source.dataIndex(0, row)
  for x in 0 ..< columns.len:
    let tap = columns[x]
    let at = start + tap.first.int
    let left = spread(pixels[at])
    let weight = tap.weight shr 3
    into[x] = if weight == 0: left else: mix565(left, spread(pixels[at + tap.step.int]), weight)

proc drawRectBilinear565(target, source: Image, columns, rows: seq[AxisTap]) =
  let width = target.width
  var upper = newSeq[uint32](width)
  var lower = newSeq[uint32](width)
  var upperRow = -1
  var lowerRow = -1
  for y in 0 ..< target.height:
    let tap = rows[y]
    let top = tap.first.int
    let bottom = top + tap.step.int
    let weight = tap.weight shr 3
    if top != upperRow:
      if top == lowerRow:
        swap(upper, lower)
        swap(upperRow, lowerRow)
      else:
        interpolateRow565(source, top, columns, upper)
        upperRow = top
    if weight != 0 and bottom != lowerRow:
      interpolateRow565(source, bottom, columns, lower)
      lowerRow = bottom
    let out16 = target.data16
    let start = target.dataIndex(0, y)
    if weight == 0:
      for x in 0 ..< width:
        out16[start + x] = fold(upper[x])
    else:
      for x in 0 ..< width:
        out16[start + x] = fold(mix565(upper[x], lower[x], weight))

proc toRgb565Copy*(source: Image): Image =
  ## A 565 copy of an RGBX image, dithered once here instead of on every
  ## frame's store (rgbxToRgb565Dithered: smooth skies keep their gradient),
  ## for drawRectBilinear onto a 565 canvas. Half the RGBX image's bytes.
  doAssert source.format == pfRgbx
  result = newImage565(source.width, source.height)
  result.ditherStores = true
  for y in 0 ..< source.height:
    let from0 = source.dataIndex(0, y)
    let to0 = result.dataIndex(0, y)
    for x in 0 ..< source.width:
      result.data16[to0 + x] = rgbxToRgb565Dithered(source.data[from0 + x], to0 + x)

proc drawRectBilinear*(target, source: Image, sx, sy, sw, sh: float) =
  ## Fills all of `target` with the source rectangle (sx, sy, sw, sh), in
  ## source pixels. The source is RGBX (a decoded photo is), onto a target of
  ## any format, a 565 one dithered when it asks for that; or 565
  ## (toRgb565Copy) onto a 565 target.
  doAssert source.format == pfRgbx or
    (source.format == pfRgb565 and target.format == pfRgb565),
    "drawRectBilinear reads an RGBX source, or a 565 one onto a 565 target"
  if source.format == pfRgb565:
    if target.width > 0 and target.height > 0 and source.width > 0 and source.height > 0:
      drawRectBilinear565(target, source, axisTaps(sx, sw, target.width, source.width),
        axisTaps(sy, sh, target.height, source.height))
    return
  let width = target.width
  let height = target.height
  if width <= 0 or height <= 0 or source.width <= 0 or source.height <= 0:
    return
  let columns = axisTaps(sx, sw, width, source.width)
  let rows = axisTaps(sy, sh, height, source.height)
  var upper = newSeq[uint32](width)
  var lower = newSeq[uint32](width)
  var upperRow = -1
  var lowerRow = -1
  for y in 0 ..< height:
    let tap = rows[y]
    let top = tap.first.int
    let bottom = top + tap.step.int
    if top != upperRow:
      if top == lowerRow:
        swap(upper, lower)
        swap(upperRow, lowerRow)
      else:
        interpolateRow(source, top, columns, upper)
        upperRow = top
    if tap.weight != 0 and bottom != lowerRow:
      interpolateRow(source, bottom, columns, lower)
      lowerRow = bottom
    let start = target.dataIndex(0, y)
    let weight = tap.weight
    # One pass per row: the vertical mix goes straight into the canvas.
    template emit(value: untyped) =
      case target.format
      of pfRgbx:
        let pixels = cast[ptr UncheckedArray[uint32]](target.data)
        for x {.inject.} in 0 ..< width:
          pixels[start + x] = value
      of pfRgb565:
        if target.ditherStores:
          for x {.inject.} in 0 ..< width:
            target.data16[start + x] = rgbxToRgb565Dithered(cast[ColorRGBX](value), start + x)
        else:
          for x {.inject.} in 0 ..< width:
            target.data16[start + x] = rgbxToRgb565(cast[ColorRGBX](value))
      of pfGray8:
        for x {.inject.} in 0 ..< width:
          target.data8[start + x] = rgbxToGray8(cast[ColorRGBX](value))
    if weight == 0:
      emit(upper[x])
    else:
      emit(mix(upper[x], lower[x], weight))

{.pop.}
