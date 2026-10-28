## What the framebuffer driver writes to /dev/fb0, and how little.
##
## The driver keeps a copy of what the panel shows, in the panel's own layout
## (`PanelShadow`, `lineLength * height` bytes). A frame is staged into it a
## row at a time; a row that matches what is there already costs a compare
## and nothing else, and only the runs of rows that changed are written. On a
## HyperPixel 4.0 Square a touch that moves a dot and a line of text rewrites
## a few dozen rows of 1440 bytes instead of 1 MB.
##
## An RGB565 panel given a `pfRgb565` image (the runner's panel canvas,
## frameos/driver_render_hint) stages its rows as they are: the canvas holds
## exactly the panel's bytes. Anything else is converted a row at a time on
## the way in, as before.
##
## The shadow is only as good as the assumption that nothing else writes the
## framebuffer. Anything that may have (a failed write, a blank, a resize)
## invalidates it, and the driver lets it go stale for a minute at most
## (`FullWriteSeconds`), so a console that drew over the panel heals.

import pixie

# These loops are the hottest a frame has, and the driver libraries are built
# for size (-Os, one set of C flags for every file): with Nim's checks on, each
# index sum is a branch gcc does not hoist at -Os, which made a turned 800x480
# frame 14 ms on a Pi 5. Every index here comes from the layout the shadow was
# prepared for, so the checks are off for the module.
{.push overflowChecks: off, boundChecks: off, rangeChecks: off.}

const FullWriteSeconds* = 60.0
  ## The longest a shadow is trusted between full writes.

type
  PanelLayout* = object
    width*, height*: int
    bytesPerPixel*: int
    lineLength*: int ## bytes per row on the panel, padding included
    redByte*, greenByte*, blueByte*, alphaByte*: int ## for 24/32 bpp
    hasAlpha*: bool

  PanelShadow* = object
    bytes*: seq[uint8]
    layout*: PanelLayout
    valid*: bool
    lastFullWrite*: float ## caller's monotonic seconds

proc rowBytes*(layout: PanelLayout): int =
  layout.width * layout.bytesPerPixel

proc isRgb565*(bitsPerPixel, redOffset, redLength, greenOffset, greenLength,
    blueOffset, blueLength: uint32): bool =
  ## A 16 bpp framebuffer in pixie's 565 order (red high, blue low).
  bitsPerPixel == 16 and redOffset == 11 and redLength == 5 and greenOffset == 5 and
    greenLength == 6 and blueOffset == 0 and blueLength == 5

proc prepare*(shadow: var PanelShadow, layout: PanelLayout) =
  ## Sizes the shadow for `layout`; a change of layout forgets what it held.
  let size = layout.lineLength * layout.height
  if shadow.bytes.len != size or shadow.layout != layout:
    shadow.bytes = newSeq[uint8](size)
    shadow.layout = layout
    shadow.valid = false

proc invalidate*(shadow: var PanelShadow) =
  shadow.valid = false

proc stageRow(shadow: var PanelShadow, y: int, row: pointer): bool =
  ## Copies one panel row into the shadow; true when it differed (or the
  ## shadow knew nothing). The padding after the row stays as it was: zeros.
  let dst = addr shadow.bytes[y * shadow.layout.lineLength]
  let n = shadow.layout.rowBytes
  if shadow.valid and equalMem(dst, row, n):
    return false
  copyMem(dst, row, n)
  true

template pack565(color: ColorRGBX): uint16 =
  ((uint16(color.r) shr 3) shl 11) or ((uint16(color.g) shr 2) shl 5) or (uint16(color.b) shr 3)

type WordShifts = object
  ## A 32 bpp layout's byte offsets as bit shifts, worked out once per frame.
  red, green, blue, alpha: uint32
  alphaMask: uint32 ## 0 when the panel has no alpha byte: the spare byte is 0

proc wordShifts(layout: PanelLayout): WordShifts =
  WordShifts(red: uint32(layout.redByte * 8), green: uint32(layout.greenByte * 8),
    blue: uint32(layout.blueByte * 8), alpha: uint32(layout.alphaByte * 8),
    alphaMask: if layout.hasAlpha: 0xFF'u32 shl uint32(layout.alphaByte * 8) else: 0'u32)

template packWord(shifts: WordShifts, color: ColorRGBX): uint32 =
  ## A 32 bpp pixel as one little-endian word (every Pi is little-endian):
  ## byte k of the pixel is bits 8k of the word.
  (uint32(color.r) shl shifts.red) or (uint32(color.g) shl shifts.green) or
    (uint32(color.b) shl shifts.blue) or ((uint32(color.a) shl shifts.alpha) and shifts.alphaMask)

proc convertRow(layout: PanelLayout, pixels: ptr UncheckedArray[ColorRGBX], row: int,
    dst: ptr UncheckedArray[uint8]) =
  ## The old full-frame conversion, one row at a time.
  if layout.bytesPerPixel == 2:
    let words = cast[ptr UncheckedArray[uint16]](dst)
    for x in 0 ..< layout.width:
      words[x] = pack565(pixels[row + x])
    return
  if layout.bytesPerPixel == 4:
    # One store per pixel, not four (the row buffer is word-aligned).
    let words = cast[ptr UncheckedArray[uint32]](dst)
    let shifts = layout.wordShifts
    for x in 0 ..< layout.width:
      words[x] = shifts.packWord(pixels[row + x])
    return
  # The hottest loop on an HDMI frame (2 M pixels at 1080p): the layout is
  # decided once per row, never per pixel. A 32 bpp framebuffer with no alpha
  # channel (the common Pi case) still has a fourth byte per pixel; it is
  # written as 0.
  let (redByte, greenByte, blueByte) = (layout.redByte, layout.greenByte, layout.blueByte)
  let step = layout.bytesPerPixel
  var j = 0
  if layout.hasAlpha:
    let alphaByte = layout.alphaByte
    for x in 0 ..< layout.width:
      let color = pixels[row + x]
      dst[j + redByte] = color.r
      dst[j + greenByte] = color.g
      dst[j + blueByte] = color.b
      dst[j + alphaByte] = color.a
      j += step
  elif step == 4:
    let fillByte = 6 - redByte - greenByte - blueByte # the one offset no color took
    for x in 0 ..< layout.width:
      let color = pixels[row + x]
      dst[j + redByte] = color.r
      dst[j + greenByte] = color.g
      dst[j + blueByte] = color.b
      dst[j + fillByte] = 0
      j += 4
  else:
    for x in 0 ..< layout.width:
      let color = pixels[row + x]
      dst[j + redByte] = color.r
      dst[j + greenByte] = color.g
      dst[j + blueByte] = color.b
      j += step

proc turnedDimensions*(width, height, rotation: int): tuple[width, height: int] =
  ## A frame's size once turned by `rotation` degrees.
  if rotation in [90, 270]: (height, width) else: (width, height)

template sourceIndex(image: Image, rotation, x, y: int): int =
  ## Where panel pixel (x, y) comes from in the unturned `image`: the same
  ## mapping as utils/image.nim `rotateDegrees`.
  case rotation
  of 90: image.dataIndex(y, image.height - 1 - x)
  of 180: image.dataIndex(image.width - 1 - x, image.height - 1 - y)
  of 270: image.dataIndex(image.width - 1 - y, x)
  else: image.dataIndex(x, y)

const TurnBlock = 16
  ## Panel rows gathered together when a frame is turned by 90 or 270: the
  ## 16 pixels a column of the block needs are neighbours in one source row
  ## (one 64-byte line at RGBX), where gathering a single panel row would read
  ## one pixel from each of `height` source rows.

template gatherTurned[S, T](image: Image, src: ptr UncheckedArray[S], rotation, width, y0, n: int,
    rows: ptr UncheckedArray[T], convert: untyped = it) =
  ## Fills `n` panel rows from y0 into `rows` (row k at k * width), reading
  ## the unturned source a row at a time. The mapping is rotateDegrees'.
  case rotation
  of 90:
    # panel (x, y) = source (y, h - 1 - x): row h-1-x, columns y0 ..< y0+n
    for x in 0 ..< width:
      let base = image.dataIndex(y0, image.height - 1 - x)
      for k in 0 ..< n:
        rows[k * width + x] = (let it {.inject.} = src[base + k]; convert)
  of 270:
    # panel (x, y) = source (w - 1 - y, x): row x, columns w-1-y0 down
    for x in 0 ..< width:
      let base = image.dataIndex(image.width - 1 - y0, x)
      for k in 0 ..< n:
        rows[k * width + x] = (let it {.inject.} = src[base - k]; convert)
  else:
    # 180: panel (x, y) = source (w - 1 - x, h - 1 - y), a row read backwards
    for k in 0 ..< n:
      let base = image.dataIndex(image.width - 1, image.height - 1 - (y0 + k))
      for x in 0 ..< width:
        rows[k * width + x] = (let it {.inject.} = src[base - x]; convert)

proc stageImage*(shadow: var PanelShadow, image: Image, scratch: var seq[uint8],
    rotation = 0): seq[bool] =
  ## Stages a frame into the shadow and returns, per row, whether it changed.
  ## `image` is the layout's size once turned by `rotation` (0, 90, 180 or
  ## 270): the frame is turned on its way in, a block of rows at a time,
  ## instead of by a whole-frame pass first. A `pfRgb565` image on a 2-byte
  ## layout is taken as the panel's own bytes; anything else is converted.
  ## `image` is only read through raw pointers: the driver may be a library
  ## with its own runtime (frameBuffer.nim, the note on `render`), so it never
  ## owns the host's ref.
  let layout = shadow.layout
  let width = layout.width
  result = newSeq[bool](layout.height)
  if scratch.len < layout.rowBytes:
    scratch.setLen(layout.rowBytes)
  let dst = cast[ptr UncheckedArray[uint8]](scratch[0].addr)
  if rotation == 0:
    if image.isRgb565 and layout.bytesPerPixel == 2:
      for y in 0 ..< layout.height:
        result[y] = shadow.stageRow(y, image.data16[image.dataIndex(0, y)].addr)
    elif image.isRgb565:
      # A 565 canvas on a panel that changed mode under it: expand, then convert.
      var expanded = newSeq[ColorRGBX](width)
      let pixels = cast[ptr UncheckedArray[ColorRGBX]](expanded[0].addr)
      for y in 0 ..< layout.height:
        let src = image.dataIndex(0, y)
        for x in 0 ..< width:
          expanded[x] = rgb565ToRgbx(image.data16[src + x])
        convertRow(layout, pixels, 0, dst)
        result[y] = shadow.stageRow(y, dst)
    else:
      let pixels = cast[ptr UncheckedArray[ColorRGBX]](image.data[image.dataIndex(0, 0)].addr)
      for y in 0 ..< layout.height:
        convertRow(layout, pixels, y * image.stride, dst)
        result[y] = shadow.stageRow(y, dst)
  elif image.isRgb565:
    var turned = newSeq[uint16](TurnBlock * width)
    let turnedPtr = cast[ptr UncheckedArray[uint16]](turned[0].addr)
    var expanded: seq[ColorRGBX]
    if layout.bytesPerPixel != 2:
      expanded = newSeq[ColorRGBX](width)
    for y0 in countup(0, layout.height - 1, TurnBlock):
      let n = min(TurnBlock, layout.height - y0)
      gatherTurned(image, image.data16, rotation, width, y0, n, turnedPtr)
      for k in 0 ..< n:
        if layout.bytesPerPixel == 2:
          result[y0 + k] = shadow.stageRow(y0 + k, turned[k * width].addr)
        else:
          for x in 0 ..< width:
            expanded[x] = rgb565ToRgbx(turned[k * width + x])
          convertRow(layout, cast[ptr UncheckedArray[ColorRGBX]](expanded[0].addr), 0, dst)
          result[y0 + k] = shadow.stageRow(y0 + k, dst)
  elif layout.bytesPerPixel in [2, 4]:
    # Converted as it is gathered: the turned rows are the panel's bytes.
    let src = image.data
    let shifts = layout.wordShifts
    let rowBytes = layout.rowBytes
    var turned = newSeq[uint32](TurnBlock * width) # a block of either width
    let rows = cast[ptr UncheckedArray[uint8]](turned[0].addr)
    for y0 in countup(0, layout.height - 1, TurnBlock):
      let n = min(TurnBlock, layout.height - y0)
      if layout.bytesPerPixel == 4:
        gatherTurned(image, src, rotation, width, y0, n,
          cast[ptr UncheckedArray[uint32]](rows), (shifts.packWord(it)))
      else:
        gatherTurned(image, src, rotation, width, y0, n,
          cast[ptr UncheckedArray[uint16]](rows), (pack565(it)))
      for k in 0 ..< n:
        result[y0 + k] = shadow.stageRow(y0 + k, rows[k * rowBytes].addr)
  else:
    var turned = newSeq[ColorRGBX](TurnBlock * width)
    let turnedPtr = cast[ptr UncheckedArray[ColorRGBX]](turned[0].addr)
    for y0 in countup(0, layout.height - 1, TurnBlock):
      let n = min(TurnBlock, layout.height - y0)
      gatherTurned(image, image.data, rotation, width, y0, n, turnedPtr)
      for k in 0 ..< n:
        convertRow(layout, turnedPtr, k * width, dst)
        result[y0 + k] = shadow.stageRow(y0 + k, dst)
  shadow.valid = true

proc turnedCopy*(image: Image, rotation: int): Image =
  ## `image` turned by `rotation` degrees into an RGBX image of the driver's
  ## own, for the rare frame that is not the panel's size (it is fitted
  ## after). A 565 image comes out as RGBX, which is what a resize takes.
  let (width, height) = turnedDimensions(image.width, image.height, rotation)
  result = newImage(width, height)
  for y in 0 ..< height:
    for x in 0 ..< width:
      let i = image.sourceIndex(rotation, x, y)
      result.data[result.dataIndex(x, y)] =
        if image.isRgb565: rgb565ToRgbx(image.data16[i]) else: image.data[i]

proc changedRuns*(changed: openArray[bool]): seq[tuple[first, last: int]] =
  ## Consecutive changed rows as inclusive (first, last) runs, top to bottom.
  var start = -1
  for y, isChanged in changed:
    if isChanged:
      if start < 0:
        start = y
    elif start >= 0:
      result.add((start, y - 1))
      start = -1
  if start >= 0:
    result.add((start, changed.len - 1))

{.pop.}
