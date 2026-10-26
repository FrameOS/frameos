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
##
## A 565 canvas that asks for dithered stores (an RGB LCD's) gets every pixel
## rounded against a 4x4 threshold fixed to the screen. The source stays
## RGBX. A 565 copy of it, dithered once, drew in two thirds of the time, but
## each frame resampled the copy's noise at a new phase and rounded it again:
## between two frames of a sky the changed pixels formed a grid of lines that
## slid with the zoom, banding on the glass while the picture moved
## (2026-10-26).
##
## On the ESP32 the rows are shared between both cores (fos_rows.c).

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

# RGBX to 565 for a canvas that asks for dithered stores, against a 4x4
# Bayer threshold fixed to the screen. Each channel is first scaled into
# 0..248 (0..252 for green), so adding a threshold of up to one step never
# carries into the next field and red and blue go in one word.
const Bayer4 = [[0'u32, 8, 2, 10], [12'u32, 4, 14, 6], [3'u32, 11, 1, 9], [15'u32, 7, 13, 5]]

type DitherRow = array[4, uint32] ## per x mod 4: red and blue's threshold, or green's

proc ditherRow(y: int): tuple[rb, g: DitherRow] =
  for i in 0 ..< 4:
    let cell = Bayer4[y and 3][i]
    result.rb[i] = (cell shr 1) or ((cell shr 1) shl 16)
    result.g[i] = cell shr 2

template packDithered(value, rbStep, gStep: uint32): uint16 =
  let v = value
  var rb = v and 0x00FF00FF'u32
  rb = rb - ((rb shr 5) and 0x00070007'u32) + rbStep
  var g = (v shr 8) and 0xFF'u32
  g = g - (g shr 6) + gStep
  uint16(((rb shr 3) and 0x1F'u32) shl 11 or (g shr 2) shl 5 or ((rb shr 19) and 0x1F'u32))

type
  RowJob = object
    ## What a worker reads, as plain values and pointers: the second core's
    ## worker must not touch a ref. The loops read through these locals
    ## because the firmware builds with -fno-strict-aliasing, where a field
    ## of a seq or an Image read in the loop is read again after every store.
    source: ptr UncheckedArray[uint32]
    sourceOrigin, sourceStride: int
    target: pointer
    targetOrigin, targetStride: int
    format: PixelFormat
    dither: bool
    width: int
    columns, rows: ptr UncheckedArray[AxisTap]
    scratch: ptr UncheckedArray[uint32] ## two rows per worker

  RowsProc = proc(ctx: pointer, worker, first, last: int32) {.cdecl, gcsafe, raises: [].}

proc interpolateRow(job: ptr RowJob, row: int, dest: ptr UncheckedArray[uint32]) =
  let pixels = job.source
  let taps = job.columns
  let start = job.sourceOrigin + job.sourceStride * row
  for x in 0 ..< job.width:
    let tap = taps[x]
    let at = start + tap.first.int
    let left = pixels[at]
    dest[x] = if tap.weight == 0: left else: mix(left, pixels[at + tap.step.int], tap.weight)

proc storeRow565Dithered(out16: ptr UncheckedArray[uint16], upper, lower: ptr UncheckedArray[uint32],
    width, y: int, weight: uint32) =
  ## The vertical mix, the threshold for the pixel's place on the screen and
  ## the pack; two pixels a store where the row is word aligned.
  let (rbSteps, gSteps) = ditherRow(y)
  let (rb0, rb1, rb2, rb3) = (rbSteps[0], rbSteps[1], rbSteps[2], rbSteps[3])
  let (g0, g1, g2, g3) = (gSteps[0], gSteps[1], gSteps[2], gSteps[3])
  template fill(pixel: untyped) =
    var x = 0
    if (cast[uint](out16) and 3) == 0:
      let out32 = cast[ptr UncheckedArray[uint32]](out16)
      while x + 4 <= width:
        out32[x shr 1] = packDithered(pixel(x), rb0, g0).uint32 or
          (packDithered(pixel(x + 1), rb1, g1).uint32 shl 16)
        out32[(x shr 1) + 1] = packDithered(pixel(x + 2), rb2, g2).uint32 or
          (packDithered(pixel(x + 3), rb3, g3).uint32 shl 16)
        x += 4
    while x < width:
      out16[x] = packDithered(pixel(x), rbSteps[x and 3], gSteps[x and 3])
      inc x
  template straight(i: int): uint32 = upper[i]
  template mixed(i: int): uint32 = mix(upper[i], lower[i], weight)
  if weight == 0:
    fill(straight)
  else:
    fill(mixed)

proc storeRow(job: ptr RowJob, y: int, upper, lower: ptr UncheckedArray[uint32], weight: uint32) =
  ## One target row: the vertical mix goes straight into the canvas.
  let width = job.width
  let start = job.targetOrigin + job.targetStride * y
  case job.format
  of pfRgbx:
    let out32 = cast[ptr UncheckedArray[uint32]](job.target)
    if weight == 0:
      for x in 0 ..< width:
        out32[start + x] = upper[x]
    else:
      for x in 0 ..< width:
        out32[start + x] = mix(upper[x], lower[x], weight)
  of pfRgb565:
    let out16 = cast[ptr UncheckedArray[uint16]](job.target)
    if job.dither:
      storeRow565Dithered(cast[ptr UncheckedArray[uint16]](out16[start].addr), upper, lower,
        width, y, weight)
    else:
      for x in 0 ..< width:
        let value = if weight == 0: upper[x] else: mix(upper[x], lower[x], weight)
        out16[start + x] = rgbxToRgb565(cast[ColorRGBX](value))
  of pfGray8:
    let out8 = cast[ptr UncheckedArray[uint8]](job.target)
    for x in 0 ..< width:
      let value = if weight == 0: upper[x] else: mix(upper[x], lower[x], weight)
      out8[start + x] = rgbxToGray8(cast[ColorRGBX](value))

proc drawRows(ctx: pointer, worker, first, last: int32) {.cdecl, gcsafe, raises: [].} =
  ## Target rows [first, last) with this worker's two cached source rows.
  let job = cast[ptr RowJob](ctx)
  let width = job.width
  var upper = cast[ptr UncheckedArray[uint32]](job.scratch[worker.int * 2 * width].addr)
  var lower = cast[ptr UncheckedArray[uint32]](job.scratch[(worker.int * 2 + 1) * width].addr)
  var upperRow = -1
  var lowerRow = -1
  for y in first.int ..< last.int:
    let tap = job.rows[y]
    let top = tap.first.int
    let bottom = top + tap.step.int
    if top != upperRow:
      if top == lowerRow:
        swap(upper, lower)
        swap(upperRow, lowerRow)
      else:
        interpolateRow(job, top, upper)
        upperRow = top
    if tap.weight != 0 and bottom != lowerRow:
      interpolateRow(job, bottom, lower)
      lowerRow = bottom
    storeRow(job, y, upper, lower, tap.weight)

when defined(frameosEmbedded):
  proc rowsWorkers(): int32 {.importc: "fos_rows_workers", cdecl.}
  proc runRows(fn: RowsProc, ctx: pointer, rows, blockRows: int32) {.importc: "fos_rows_run", cdecl.}
elif defined(testing):
  var testRowBlocks* = 0 ## > 0: draw in blocks of this many rows, workers 0 and 1 in turn
  proc rowsWorkers(): int32 = 2
  proc runRows(fn: RowsProc, ctx: pointer, rows, blockRows: int32) =
    if testRowBlocks <= 0:
      fn(ctx, 0, 0, rows)
      return
    var first = 0'i32
    while first < rows:
      let last = min(rows, first + testRowBlocks.int32)
      fn(ctx, (first div testRowBlocks.int32) and 1, first, last)
      first = last
else:
  proc rowsWorkers(): int32 = 1
  proc runRows(fn: RowsProc, ctx: pointer, rows, blockRows: int32) = fn(ctx, 0, 0, rows)

const BlockRows = 32 ## a worker's share at a time; each block caches its first two source rows afresh

proc drawRectBilinear*(target, source: Image, sx, sy, sw, sh: float) =
  ## Fills all of `target` with the RGBX source rectangle (sx, sy, sw, sh),
  ## in source pixels, onto a target of any format; a 565 one dithered when
  ## it asks for that.
  doAssert source.format == pfRgbx, "drawRectBilinear reads an RGBX source"
  let width = target.width
  let height = target.height
  if width <= 0 or height <= 0 or source.width <= 0 or source.height <= 0:
    return
  let columns = axisTaps(sx, sw, width, source.width)
  let rows = axisTaps(sy, sh, height, source.height)
  let workers = rowsWorkers()
  var scratch = newSeq[uint32](2 * workers.int * width)
  var job = RowJob(
    source: cast[ptr UncheckedArray[uint32]](source.data),
    sourceOrigin: source.origin,
    sourceStride: source.stride,
    targetOrigin: target.origin,
    targetStride: target.stride,
    format: target.format,
    dither: target.ditherStores,
    width: width,
    columns: cast[ptr UncheckedArray[AxisTap]](columns[0].unsafeAddr),
    rows: cast[ptr UncheckedArray[AxisTap]](rows[0].unsafeAddr),
    scratch: cast[ptr UncheckedArray[uint32]](scratch[0].addr))
  job.target =
    case target.format
    of pfRgbx: cast[pointer](target.data)
    of pfRgb565: cast[pointer](target.data16)
    of pfGray8: cast[pointer](target.data8)
  runRows(drawRows, job.addr, height.int32, BlockRows)

{.pop.}
