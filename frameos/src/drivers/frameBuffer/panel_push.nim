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

proc convertRow(layout: PanelLayout, pixels: ptr UncheckedArray[ColorRGBX], row: int,
    dst: ptr UncheckedArray[uint8]) =
  ## The old full-frame conversion, one row at a time.
  if layout.bytesPerPixel == 2:
    var j = 0
    for x in 0 ..< layout.width:
      let color = pixels[row + x]
      let pixel = ((uint16(color.r) shr 3) shl 11) or ((uint16(color.g) shr 2) shl 5) or
        (uint16(color.b) shr 3)
      dst[j] = uint8(pixel and 0xff)
      dst[j + 1] = uint8(pixel shr 8)
      j += 2
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
    let fillByte = 6 - redByte - greenByte - blueByte # the one offset no colour took
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

proc stageImage*(shadow: var PanelShadow, image: Image, scratch: var seq[uint8]): seq[bool] =
  ## Stages a frame of the layout's size into the shadow and returns, per
  ## row, whether it changed. A `pfRgb565` image on a 2-byte layout is taken
  ## as the panel's own bytes; an RGBX one is converted. `image` is only read
  ## through raw pointers: the driver may be a library with its own runtime
  ## (frameBuffer.nim, the note on `render`), so it never owns the host's ref.
  let layout = shadow.layout
  result = newSeq[bool](layout.height)
  if image.isRgb565 and layout.bytesPerPixel == 2:
    for y in 0 ..< layout.height:
      result[y] = shadow.stageRow(y, image.data16[image.dataIndex(0, y)].addr)
  elif image.isRgb565:
    # A 565 canvas on a panel that changed mode under it: expand, then convert.
    if scratch.len < layout.rowBytes:
      scratch.setLen(layout.rowBytes)
    var expanded = newSeq[ColorRGBX](layout.width)
    let pixels = cast[ptr UncheckedArray[ColorRGBX]](expanded[0].addr)
    let dst = cast[ptr UncheckedArray[uint8]](scratch[0].addr)
    for y in 0 ..< layout.height:
      let src = image.dataIndex(0, y)
      for x in 0 ..< layout.width:
        expanded[x] = rgb565ToRgbx(image.data16[src + x])
      convertRow(layout, pixels, 0, dst)
      result[y] = shadow.stageRow(y, dst)
  else:
    if scratch.len < layout.rowBytes:
      scratch.setLen(layout.rowBytes)
    let pixels = cast[ptr UncheckedArray[ColorRGBX]](image.data[image.dataIndex(0, 0)].addr)
    let dst = cast[ptr UncheckedArray[uint8]](scratch[0].addr)
    for y in 0 ..< layout.height:
      convertRow(layout, pixels, y * image.stride, dst)
      result[y] = shadow.stageRow(y, dst)
  shadow.valid = true

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
