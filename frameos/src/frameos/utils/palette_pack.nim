## A colour e-paper panel's packed picture (the ESP32's formats 5, 6 and 7:
## palette indices, 2 or 4 bits a pixel), dithered out of the scene canvas by
## `forEachPaletteDithered` — into a buffer of its own, or into the canvas's
## own bytes (docs/realtime-rendering.md, "The picture in the canvas").
##
## Why the canvas can hold its own picture: the dither reads canvas row y + 1
## into its error row BEFORE it hands out the first pixel of row y, and reads
## nothing of the canvas after that until row y + 2. So while row y is packed,
## every canvas byte below C * (y + 2) has been read already (C the canvas's
## bytes a row, R the picture's). Packed row y is the bytes R * y ..< R * (y + 1),
## and with R <= C those lie below C * (y + 1): bytes of rows that are read.
## The writes trail the reads by at least one canvas row the whole way down.
## That holds in scan order only: a turned pack writes down the panel's columns
## (the last canvas row lands in the first packed bytes), so it never runs in
## place (`packsInPlace`). test_palette_pack.nim packs the same canvas both
## ways and compares the bytes.
##
## Nothing is cleared first: in scan order the first pixel of each packed byte
## stores it and the rest OR into it, which is what clearing the buffer and
## ORing every pixel gives, byte for byte — and a clear up front would wipe
## canvas rows not read yet. A turned pack, which visits a byte's pixels in
## another order, clears its buffer first as before.

import std/atomics
import pixie
import dither

when defined(frameosEmbedded):
  proc fosNimInternalAlloc(size: csize_t): pointer {.importc: "fos_nim_internal_alloc", cdecl.}
  proc fosNimInternalFree(p: pointer) {.importc: "fos_nim_internal_free", cdecl.}

# The firmware is built for size; this loop runs over every pixel of a frame
# and is compiled at -O2 there, as embedded_main.nim's packers are.
when defined(frameosEmbedded):
  {.pragma: hotLoop, codegenDecl: "__attribute__((optimize(\"O2\"))) $# $#$#".}
else:
  {.pragma: hotLoop.}

proc paletteBits*(paletteLen: int): int =
  if paletteLen <= 2: 1 elif paletteLen <= 4: 2 elif paletteLen <= 16: 4 else: 8

proc paletteRowBytes*(panelWidth, paletteLen: int): int =
  ## The packed picture's bytes a row.
  let pixelsPerByte = 8 div paletteBits(paletteLen)
  (panelWidth + pixelsPerByte - 1) div pixelsPerByte

proc canvasRowBytes(image: Image): int =
  case image.format
  of pfRgbx: image.width * 4
  of pfRgb565: image.width * 2
  of pfGray8: image.width
  of pfGray4: (image.width + 1) div 2

proc packsInPlace*(image: Image; paletteLen, panelWidth, panelHeight, rotate: int): bool =
  ## Whether the picture can be packed into `image`'s own bytes: unturned, the
  ## panel's size, the canvas's rows from the start of its buffer one after
  ## another (not a view), and no more picture bytes a row than canvas bytes.
  not image.isNil and rotate == 0 and not image.isView and image.width == panelWidth and
    image.height == panelHeight and image.dataIndex(0, 0) == 0 and
    paletteRowBytes(panelWidth, paletteLen) <= canvasRowBytes(image)

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

# ------------------------------------------------------------- on both cores
#
# A scan-order pack is a job of rows both cores take (pixie's `rowsRunner`,
# fos_rows.c on an ESP32), one row at a time, handed out in order. On the
# reTerminal E1004 (1200x1600, Spectra 6) the pack was 4.1 s of every render
# on one core (the hardware bench, 2026-11-21).
#
# Floyd-Steinberg carries error down a row and into the next, so rows cannot
# simply be split. Pixel x of row y may run once the row above has finished
# pixel x + 2: by then every push into row y at x and x + 1 has landed (from
# pixels x - 1 .. x + 2 above), so each pixel's three neighbours below and
# the one to its right get their error in the order the one-core loop gives
# them. Each push clips, so the order is the arithmetic, and the bytes are
# the one-core loop's, bit for bit (test_palette_pack.nim runs both on two
# threads and compares).
#
# The adjusted rows are a ring of four. Rows are handed out in order and a
# worker holds one at a time, so when a worker takes row y, every row up to
# y - 2 is finished: the buffer row y + 1 goes into last held row y - 3. Row
# y loads row y + 1 before its first pixel, and row y + 1's first pixel waits
# for row y's third, so a row is never read before it is loaded.
#
# How far a row has got is `slots[y and 3]`: y * width + pixels done, which
# only grows in a slot (row y + 4 starts past where row y ended).

const
  paletteRing = 4
  paletteRowsSharedPixels = 64 * 1024 ## a smaller picture is not worth waking the other core for
  palettePublishEvery = 8 ## pixels between two progress stores

when not defined(frameosEmbedded):
  # The wait for the row above spins. On an ESP32 the two workers are tasks
  # pinned to the two cores (fos_rows.c), so the row it waits for is always
  # running and the spin is a few cycles: that path stays a bare spin. On a
  # host the two are threads the scheduler may put on one core (a busy CI
  # runner, a Pi doing other work): a bare spin then burns the waiter's whole
  # slice while the row it waits for cannot run, a slice per row handed over
  # (test_palette_pack.nim's 2x40000 picture: four minutes on one CPU). After
  # a short spin the waiter gives the core away.
  proc schedYield(): cint {.importc: "sched_yield", header: "<sched.h>".}

  const paletteSpinsBeforeYield = 256

  template paletteWaitedOnce(spins: var int) =
    inc spins
    if spins >= paletteSpinsBeforeYield:
      spins = 0
      discard schedYield()

type PaletteRowsJob = object
  width, height: int
  format: PixelFormat
  rgbx: ptr UncheckedArray[ColorRGBX]
  data16: ptr UncheckedArray[uint16]
  data8: ptr UncheckedArray[uint8]
  base, step: int ## dataIndex(0, y) = base + step * y
  palR, palG, palB: ptr UncheckedArray[int]
  paletteLen: int
  jitterAmp: int
  rows: ptr UncheckedArray[uint8] ## `paletteRing` adjusted rows, 3 bytes a pixel
  buf: ptr UncheckedArray[uint8]
  rowBytes, bits, pixelsPerByte: int
  slots: array[paletteRing, Atomic[int]]

template paletteClip(value: int): uint8 =
  (let v = value; if v < 0: 0'u8 elif v > 255: 255'u8 else: v.uint8)

proc loadPaletteRow(job: ptr PaletteRowsJob, row: ptr UncheckedArray[uint8], ry: int) {.hotLoop.} =
  ## forEachPaletteDithered's loadRow: the canvas row as 8-bit RGB.
  let
    rowStart = job.base + job.step * ry
    width = job.width
  case job.format
  of pfRgb565:
    let src = job.data16
    for rx in 0 ..< width:
      let
        p = src[rowStart + rx].uint32
        r5 = (p shr 11) and 31
        g6 = (p shr 5) and 63
        b5 = p and 31
      row[rx * 3 + 0] = ((r5 shl 3) or (r5 shr 2)).uint8
      row[rx * 3 + 1] = ((g6 shl 2) or (g6 shr 4)).uint8
      row[rx * 3 + 2] = ((b5 shl 3) or (b5 shr 2)).uint8
  of pfGray8:
    let src = job.data8
    for rx in 0 ..< width:
      let luma = src[rowStart + rx]
      row[rx * 3 + 0] = luma
      row[rx * 3 + 1] = luma
      row[rx * 3 + 2] = luma
  of pfGray4:
    let src = job.data8
    for rx in 0 ..< width:
      let luma = gray4Level(src, rowStart + rx) * 17
      row[rx * 3 + 0] = luma
      row[rx * 3 + 1] = luma
      row[rx * 3 + 2] = luma
  of pfRgbx:
    let src = job.rgbx
    for rx in 0 ..< width:
      let p = src[rowStart + rx]
      row[rx * 3 + 0] = p.r
      row[rx * 3 + 1] = p.g
      row[rx * 3 + 2] = p.b

proc ditherPaletteRow(job: ptr PaletteRowsJob, y: int) {.hotLoop.} =
  ## One row, pixel by pixel behind the row above (see above). Not inlined into
  ## the job: an -O2 function of its own, as the firmware's other pixel loops.
  let
    width = job.width
    stride = width * 3
    cur = cast[ptr UncheckedArray[uint8]](job.rows[(y and (paletteRing - 1)) * stride].addr)
    next = cast[ptr UncheckedArray[uint8]](job.rows[((y + 1) and (paletteRing - 1)) * stride].addr)
    hasNext = y + 1 < job.height
    rowIndex = y * width
    mine = job.slots[y and (paletteRing - 1)].addr
    above = job.slots[(y - 1) and (paletteRing - 1)].addr
    aboveBase = (y - 1) * width
    palR = job.palR
    palG = job.palG
    palB = job.palB
    paletteLen = job.paletteLen
    amp = job.jitterAmp
    buf = job.buf
    bits = job.bits
    pixelsPerByte = job.pixelsPerByte
    outRow = y * job.rowBytes
  if y == 0:
    job.loadPaletteRow(cur, 0)
  if hasNext:
    job.loadPaletteRow(next, y + 1)
  # Pixels of the row above known done (0 for the first row: none needed).
  var ready = if y == 0: width else: 0
  when not defined(frameosEmbedded):
    var spins = 0
  template push(row: ptr UncheckedArray[uint8], rx: int, er, eg, eb: int, weight: int) =
    row[rx * 3 + 0] = paletteClip(row[rx * 3 + 0].int + (er * weight div 16))
    row[rx * 3 + 1] = paletteClip(row[rx * 3 + 1].int + (eg * weight div 16))
    row[rx * 3 + 2] = paletteClip(row[rx * 3 + 2].int + (eb * weight div 16))
  for xx in 0 ..< width:
    let need = min(xx + 3, width)
    while ready < need:
      ready = above[].load(moAcquire) - aboveBase
      when not defined(frameosEmbedded):
        if ready < need:
          paletteWaitedOnce(spins)
    let
      imageR = cur[xx * 3 + 0].int
      imageG = cur[xx * 3 + 1].int
      imageB = cur[xx * 3 + 2].int
      jitter = if amp > 0: ditherJitterFor(rowIndex + xx, amp) else: 0
      pickR = paletteClip(imageR + jitter).int
      pickG = paletteClip(imageG + jitter).int
      pickB = paletteClip(imageB + jitter).int
    var
      palIndex = 0
      bestDistance = high(int)
    for i in 0 ..< paletteLen:
      let distance = abs(pickR - palR[i]) + abs(pickG - palG[i]) + abs(pickB - palB[i])
      if distance < bestDistance:
        bestDistance = distance
        palIndex = i
    let
      errorR = imageR - palR[palIndex]
      errorG = imageG - palG[palIndex]
      errorB = imageB - palB[palIndex]
      outputIndex = outRow + xx div pixelsPerByte
      value =
        case bits
        of 8: palIndex.uint8
        of 4: (palIndex shl ((1 - (xx mod 2)) * 4)).uint8
        of 2: (palIndex shl ((3 - (xx mod 4)) * 2)).uint8
        else: (palIndex shl (7 - (xx mod 8))).uint8
    if xx mod pixelsPerByte == 0:
      buf[outputIndex] = value
    else:
      buf[outputIndex] = buf[outputIndex] or value
    if xx + 1 < width:
      push(cur, xx + 1, errorR, errorG, errorB, 7)
    if hasNext:
      if xx - 1 >= 0:
        push(next, xx - 1, errorR, errorG, errorB, 3)
      push(next, xx, errorR, errorG, errorB, 5)
      if xx + 1 < width:
        push(next, xx + 1, errorR, errorG, errorB, 1)
    if (xx + 1) mod palettePublishEvery == 0:
      mine[].store(rowIndex + xx + 1, moRelease)
  mine[].store(rowIndex + width, moRelease)

proc paletteRowsJob(ctx: pointer, worker, first, last: int32) {.cdecl, gcsafe, raises: [], hotLoop.} =
  ## Rows [first, last), in order, on either core: plain pointers, nothing
  ## allocated, nothing that raises.
  let job = cast[ptr PaletteRowsJob](ctx)
  for y in first.int ..< last.int:
    if worker == 0:
      breathe()
    job.ditherPaletteRow(y)

proc packPaletteRows(
    image: Image;
    buf: ptr UncheckedArray[uint8];
    palette: seq[(int, int, int)];
    rowBytes: int
  ) =
  ## The scan-order pack as rows both cores take.
  let
    width = image.width
    height = image.height
    bits = paletteBits(palette.len)
  var palRSeq, palGSeq, palBSeq = newSeq[int](palette.len)
  for i in 0 ..< palette.len:
    palRSeq[i] = palette[i][0]
    palGSeq[i] = palette[i][1]
    palBSeq[i] = palette[i][2]
  let ringBytes = paletteRing * width * 3
  var
    rowsInternal: pointer = nil
    rowsSeq: seq[uint8]
  when defined(frameosEmbedded):
    rowsInternal = fosNimInternalAlloc(csize_t(ringBytes))
  if rowsInternal.isNil:
    rowsSeq = newSeq[uint8](ringBytes)
  defer:
    when defined(frameosEmbedded):
      if not rowsInternal.isNil: fosNimInternalFree(rowsInternal)
  var job = PaletteRowsJob(
    width: width, height: height, format: image.format,
    rgbx: (if image.format == pfRgbx: image.data else: nil),
    data16: (if image.format == pfRgb565: image.data16 else: nil),
    data8: (if image.format in {pfGray8, pfGray4}: image.data8 else: nil),
    base: image.dataIndex(0, 0),
    step: image.dataIndex(0, 1) - image.dataIndex(0, 0),
    palR: cast[ptr UncheckedArray[int]](palRSeq[0].addr),
    palG: cast[ptr UncheckedArray[int]](palGSeq[0].addr),
    palB: cast[ptr UncheckedArray[int]](palBSeq[0].addr),
    paletteLen: palette.len,
    jitterAmp: ditherJitterAmp,
    rows: (if rowsInternal.isNil: cast[ptr UncheckedArray[uint8]](rowsSeq[0].addr)
           else: cast[ptr UncheckedArray[uint8]](rowsInternal)),
    buf: buf, rowBytes: rowBytes, bits: bits, pixelsPerByte: 8 div bits)
  for i in 0 ..< paletteRing:
    job.slots[i].store(low(int) div 2, moRelaxed)
  runRows(paletteRowsJob, job.addr, height, 1, width * height >= paletteRowsSharedPixels)

proc packPalette*(
    image: Image;
    buf: ptr UncheckedArray[uint8];
    bufLen: int;
    palette: seq[(int, int, int)];
    panelWidth, panelHeight, rotate: int
  ): bool {.hotLoop.} =
  ## `image` dithered into `palette`'s indices, packed for the panel. `buf` may
  ## be `image`'s own buffer where `packsInPlace` says so. False, and nothing
  ## written, when `bufLen` is not the panel's picture or the canvas cannot
  ## hold it.
  let
    width = image.width
    height = image.height
    bits = paletteBits(palette.len)
    pixelsPerByte = 8 div bits
    rowBytes = paletteRowBytes(panelWidth, palette.len)
  if rowBytes * panelHeight != bufLen:
    return false
  if cast[pointer](buf) == image.bufferPointer and
      not packsInPlace(image, palette.len, panelWidth, panelHeight, rotate):
    return false
  # Scan order over the whole panel: each byte's first pixel comes first.
  let scanOrder = rotate == 0 and width == panelWidth and height == panelHeight
  if scanOrder and width > 0 and height > 0 and palette.len > 0:
    packPaletteRows(image, buf, palette, rowBytes)
    return true
  if not scanOrder:
    for i in 0 ..< bufLen:
      buf[i] = 0

  image.forEachPaletteDithered(palette, x, y, index):
    # panelPoint, as two plain ints: its tuple was four zeroed temporaries
    # a pixel, each a call from this -O2 loop (dither.clip8).
    let
      px = case rotate
        of 90: height - 1 - y
        of 180: width - 1 - x
        of 270: y
        else: x
      py = case rotate
        of 90: x
        of 180: height - 1 - y
        of 270: width - 1 - x
        else: y
      outputIndex = py * rowBytes + px div pixelsPerByte
      value =
        case bits
        of 8: index.uint8
        of 4: (index shl ((1 - (px mod 2)) * 4)).uint8
        of 2: (index shl ((3 - (px mod 4)) * 2)).uint8
        else: (index shl (7 - (px mod 8))).uint8
    if scanOrder and px mod pixelsPerByte == 0:
      buf[outputIndex] = value
    else:
      buf[outputIndex] = buf[outputIndex] or value

  true

{.pop.}
