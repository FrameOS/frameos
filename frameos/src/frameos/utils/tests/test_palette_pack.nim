import std/unittest
import pixie

import ../dither
import ../palette_pack
from ../panel_damage import panelPoint

# A colour e-paper ESP32 whose canvas is 565 (the 1200x1600 Spectra 6 on an
# 8 MB board, the reTerminal E1004) packs its picture into the canvas's own
# bytes and keeps no panel buffer of its own (palette_pack.nim). These pin that
# the picture packed in place is the picture packed into a buffer of its own,
# and that both are what the packer gave before it stopped clearing its buffer.

proc paint(image: Image, seed: uint32) =
  ## Noise, a gradient and flat runs, so the dither clips and carries error.
  var s = seed
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      s = s * 1664525'u32 + 1013904223'u32
      let
        noise = (s shr 24).int
        grad = (x * 255) div max(1, image.width - 1)
        r = if y < image.height div 2: grad else: noise
        g = if x < image.width div 3: 255 - grad else: (noise * 3) mod 256
        b = if y mod 7 == 0: 255 else: (grad + noise) mod 256
      image[x, y] = rgba(r.uint8, g.uint8, b.uint8, 255)

proc referencePack(image: Image; palette: seq[(int, int, int)];
    panelWidth, panelHeight, rotate: int): seq[uint8] =
  ## The packer as it was: clear the buffer, OR every pixel in.
  let
    bits = paletteBits(palette.len)
    pixelsPerByte = 8 div bits
    rowBytes = paletteRowBytes(panelWidth, palette.len)
  result = newSeq[uint8](rowBytes * panelHeight)
  image.forEachPaletteDithered(palette, x, y, index):
    let
      (px, py) = panelPoint(x, y, image.width, image.height, rotate)
      outputIndex = py * rowBytes + px div pixelsPerByte
    case bits
    of 8: result[outputIndex] = index.uint8
    of 4: result[outputIndex] = result[outputIndex] or (index shl ((1 - (px mod 2)) * 4)).uint8
    of 2: result[outputIndex] = result[outputIndex] or (index shl ((3 - (px mod 4)) * 2)).uint8
    else: discard

proc canvasOver(format: PixelFormat, width, height: int, memory: var seq[uint8]): Image =
  let bytes =
    case format
    of pfRgb565: width * height * 2
    of pfRgbx: width * height * 4
    of pfGray8: width * height
    of pfGray4: ((width + 1) div 2) * height
  memory = newSeq[uint8](bytes)
  case format
  of pfRgb565: newImage565Over(width, height, memory[0].addr)
  of pfRgbx: newImageOver(width, height, memory[0].addr)
  of pfGray8: newImageGray8Over(width, height, memory[0].addr)
  of pfGray4: newImageGray4Over(width, height, memory[0].addr)

let palettes = @[
  ("Spectra 6", spectra6ColorPalette),
  ("seven colours", saturated7ColorPalette),
  ("four colours", saturated4ColorPalette),
]

suite "a colour picture packed into its own canvas":
  test "in place is the same bytes as into a buffer of its own":
    for (name, palette) in palettes:
      for format in [pfRgb565, pfRgbx, pfGray8]:
        for (width, height) in [(40, 30), (37, 23), (1, 5), (64, 1), (121, 17)]:
          for amp in [0, DitherJitterDefaultAmp]:
            ditherJitterAmp = amp
            var memory: seq[uint8]
            let canvas = canvasOver(format, width, height, memory)
            canvas.paint(uint32(width * 7919 + height + amp))
            let expected = referencePack(canvas, palette, width, height, 0)
            var own = newSeq[uint8](expected.len)
            check packPalette(canvas, cast[ptr UncheckedArray[uint8]](own[0].addr), own.len,
              palette, width, height, 0)
            check own == expected
            check packsInPlace(canvas, palette.len, width, height, 0)
            check packPalette(canvas, cast[ptr UncheckedArray[uint8]](memory[0].addr), expected.len,
              palette, width, height, 0)
            if memory[0 ..< expected.len] != expected:
              checkpoint name & " " & $format & " " & $width & "x" & $height & " amp " & $amp
              fail()
    ditherJitterAmp = DitherJitterDefaultAmp

  test "a buffer holding an old picture is written whole, not ORed into":
    var memory: seq[uint8]
    let canvas = canvasOver(pfRgb565, 33, 9, memory)
    canvas.paint(42)
    let expected = referencePack(canvas, spectra6ColorPalette, 33, 9, 0)
    var own = newSeq[uint8](expected.len)
    for i in 0 ..< own.len: own[i] = 0xff
    check packPalette(canvas, cast[ptr UncheckedArray[uint8]](own[0].addr), own.len,
      spectra6ColorPalette, 33, 9, 0)
    check own == expected

  test "turned, the pack goes into a buffer of its own as before":
    for rotate in [90, 180, 270]:
      let (canvasW, canvasH) = if rotate == 180: (24, 18) else: (18, 24)
      var memory: seq[uint8]
      let canvas = canvasOver(pfRgb565, canvasW, canvasH, memory)
      canvas.paint(uint32(rotate))
      let expected = referencePack(canvas, spectra6ColorPalette, 24, 18, rotate)
      var own = newSeq[uint8](expected.len)
      for i in 0 ..< own.len: own[i] = 0xa5
      check packPalette(canvas, cast[ptr UncheckedArray[uint8]](own[0].addr), own.len,
        spectra6ColorPalette, 24, 18, rotate)
      check own == expected
      # Never into its own bytes: the last canvas row lands in the first
      # packed bytes.
      check not packsInPlace(canvas, spectra6ColorPalette.len, 24, 18, rotate)
      let before = memory
      check not packPalette(canvas, cast[ptr UncheckedArray[uint8]](memory[0].addr), expected.len,
        spectra6ColorPalette, 24, 18, rotate)
      check memory == before

  test "what cannot hold its picture is refused, untouched":
    var memory: seq[uint8]
    let canvas = canvasOver(pfRgb565, 16, 16, memory)
    canvas.paint(7)
    let before = memory
    # A view of the canvas, another size, the wrong length.
    check not packsInPlace(canvas.view(0, 0, 8, 8), 7, 8, 8, 0)
    check not packsInPlace(canvas, 7, 32, 8, 0)
    check not packPalette(canvas, cast[ptr UncheckedArray[uint8]](memory[0].addr), 100,
      spectra6ColorPalette, 16, 16, 0)
    check memory == before
    # A 4-bit canvas has half a byte a pixel: room for a 4-bit picture, not
    # for an 8-bit one.
    var greyMemory: seq[uint8]
    let grey = canvasOver(pfGray4, 16, 16, greyMemory)
    check packsInPlace(grey, 7, 16, 16, 0)
    check not packsInPlace(grey, 17, 16, 16, 0)
