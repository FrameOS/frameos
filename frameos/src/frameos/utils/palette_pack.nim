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

import pixie
import dither
from panel_damage import panelPoint

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
  if not scanOrder:
    for i in 0 ..< bufLen:
      buf[i] = 0

  image.forEachPaletteDithered(palette, x, y, index):
    let
      (px, py) = panelPoint(x, y, width, height, rotate)
      outputIndex = py * rowBytes + px div pixelsPerByte
      value =
        case bits
        of 8: index.uint8
        of 4: (index shl ((1 - (px mod 2)) * 4)).uint8
        of 2: (index shl ((3 - (px mod 4)) * 2)).uint8
        else: (index shl ((7 - px) mod 8)).uint8
    if scanOrder and px mod pixelsPerByte == 0:
      buf[outputIndex] = value
    else:
      buf[outputIndex] = buf[outputIndex] or value

  true

{.pop.}
