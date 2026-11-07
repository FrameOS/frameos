import os, strutils, pixie, pixie/decodebudget, pixie/fileformats/bmp

proc addLe16(data: var string, value: int) =
  data.add(char(value and 0xff))
  data.add(char((value shr 8) and 0xff))

proc addLe32(data: var string, value: int) =
  data.add(char(value and 0xff))
  data.add(char((value shr 8) and 0xff))
  data.add(char((value shr 16) and 0xff))
  data.add(char((value shr 24) and 0xff))

proc makeIndexedBmp(bits: int, pixelData: string): string =
  let
    paletteEntries = 1 shl bits
    pixelDataOffset = 14 + 40 + paletteEntries * 4
    fileSize = pixelDataOffset + pixelData.len

  result.add("BM")
  result.addLe32(fileSize)
  result.addLe16(0)
  result.addLe16(0)
  result.addLe32(pixelDataOffset)
  result.addLe32(40) # BITMAPINFOHEADER
  result.addLe32(1) # Width
  result.addLe32(1) # Height
  result.addLe16(1) # Planes
  result.addLe16(bits)
  result.addLe32(0) # BI_RGB
  result.addLe32(pixelData.len)
  result.addLe32(0)
  result.addLe32(0)
  result.addLe32(0) # clrUsed = 0 means use the default palette size.
  result.addLe32(0)

  for i in 0 ..< paletteEntries:
    if i == paletteEntries - 1:
      result.add("\xff\xff\xff\x00")
    else:
      result.add("\x00\x00\x00\x00")

  result.add(pixelData)

# block:
#   var image = newImage(4, 2)

#   image[0, 0] = rgba(0, 0, 255, 255)
#   image[1, 0] = rgba(0, 255, 0, 255)
#   image[2, 0] = rgba(255, 0, 0, 255)
#   image[3, 0] = rgba(255, 255, 255, 255)

#   image[0, 1] = rgba(0, 0, 255, 127)
#   image[1, 1] = rgba(0, 255, 0, 127)
#   image[2, 1] = rgba(255, 0, 0, 127)
#   image[3, 1] = rgba(255, 255, 255, 127)

#   writeFile("tests/fileformats/bmp/test4x2.bmp", encodeBmp(image))

#   var image2 = decodeBmp(encodeBmp(image))
#   doAssert image2.width == image.width
#   doAssert image2.height == image.height
#   doAssert image2.pixelsEqual(image)

# block:
#   var image = newImage(16, 16)
#   image.fill(rgba(255, 0, 0, 127))
#   writeFile("tests/fileformats/bmp/test16x16.bmp", encodeBmp(image))

#   var image2 = decodeBmp(encodeBmp(image))
#   doAssert image2.width == image.width
#   doAssert image2.height == image.height
#   doAssert image2.pixelsEqual(image)

block:
  for bits in [32, 24]:
    let
      path = "tests/fileformats/bmp/knight." & $bits & ".master.bmp"
      image = decodeBmp(readFile(path))
    writeFile("tests/fileformats/bmp/knight." & $bits & ".bmp", encodeBmp(image))

block:
  for fixture in [(1, "\x80\x00\x00\x00"), (4, "\xf0\x00\x00\x00")]:
    let image = decodeBmp(makeIndexedBmp(fixture[0], fixture[1]))
    doAssert image.width == 1
    doAssert image.height == 1
    doAssert image.data[0] == rgbx(255, 255, 255, 255)

block:
  let image = decodeBmp(readFile(
    "tests/fileformats/bmp/rgb.24.master.bmp"
  ))
  writeFile("tests/fileformats/bmp/rgb.24.bmp", encodeBmp(image))

block:
  for file in walkFiles("tests/fileformats/bmp/bmpsuite/*"):
    # echo file
    let
      image = decodeBmp(readFile(file))
      dimensions = decodeBmpDimensions(readFile(file))
    #image.writeFile(file.replace("bmpsuite", "output") & ".png")
    doAssert image.width == dimensions.width
    doAssert image.height == dimensions.height

block:
  let image = newImage(100, 100)
  image.fill(color(1, 0, 0, 1))

  let
    encoded = encodeDib(image)
    decoded = decodeDib(encoded.cstring, encoded.len, true)

  doAssert image.pixelsEqual(decoded)

block: # identity-size scaled decodes match the reference decoder exactly
  var files: seq[string]
  for file in walkFiles("tests/fileformats/bmp/bmpsuite/*"):
    files.add(file)
  files.add("tests/fileformats/bmp/knight.24.master.bmp")
  files.add("tests/fileformats/bmp/knight.32.master.bmp")
  for file in files:
    let
      data = readFile(file)
      expected = decodeBmp(data)
      target = newImage(expected.width, expected.height)
    decodeBmpScaledInto(data, target, fitStretch)
    doAssert target.pixelsEqual(expected), file

block: # streaming sampling matches nearest-neighbour on the full decode
  let
    data = readFile("tests/fileformats/bmp/knight.24.master.bmp")
    full = decodeBmp(data)
    target = newImage(37, 23)
  decodeBmpScaledInto(data, target, fitStretch)
  for y in 0 ..< target.height:
    let srcY = min(y * full.height div target.height, full.height - 1)
    for x in 0 ..< target.width:
      let srcX = min(x * full.width div target.width, full.width - 1)
      doAssert target.unsafe[x, y] == full.unsafe[srcX, srcY]

block: # pull sources decode identically to buffered ones
  # A download spilled to disk decodes through a sequential read callback;
  # the file is never in memory. Exercise awkward read granularities so
  # headers, palettes and row payloads all straddle read boundaries.
  proc sourceOf(data: string, readSize: int): ImageSourceProc =
    var pos = 0
    result = proc (dst: pointer, maxBytes: int): int =
      let n = min(min(readSize, maxBytes), data.len - pos)
      if n <= 0:
        return 0
      copyMem(dst, data[pos].unsafeAddr, n)
      pos += n
      n

  for file in [
    "tests/fileformats/bmp/bmpsuite/24bpp-321x240.bmp", # padded stride
    "tests/fileformats/bmp/bmpsuite/24bpp-topdown-320x240.bmp",
    "tests/fileformats/bmp/bmpsuite/32bpp-topdown-320x240.bmp",
    "tests/fileformats/bmp/bmpsuite/32bpp-101110-320x240.bmp", # bitfields
    "tests/fileformats/bmp/bmpsuite/8bpp-320x240.bmp",
    "tests/fileformats/bmp/bmpsuite/4bpp-327x240.bmp",
    "tests/fileformats/bmp/bmpsuite/1bpp-329x240.bmp",
    "tests/fileformats/bmp/knight.32.master.bmp" # bitfields with alpha
  ]:
    let data = readFile(file)
    for (tw, th) in [(89, 47), (320, 240), (401, 333)]:
      for fit in ScaledDecodeFit:
        let expected = newImage(tw, th)
        decodeBmpScaledInto(data, expected, fit)
        for readSize in [7, 4096, 1 shl 20]:
          let target = newImage(tw, th)
          decodeBmpStreamScaledInto(sourceOf(data, readSize), data.len, target, fit)
          doAssert target.pixelsEqual(expected),
            file & " " & $tw & "x" & $th & " read=" & $readSize & " fit=" & $fit

  # Single-byte reads and unknown totalLen on a small file
  block:
    let data = readFile("tests/fileformats/bmp/bmpsuite/1bpp-1x1.bmp")
    for totalLen in [data.len, 0]:
      let
        expected = newImage(3, 3)
        target = newImage(3, 3)
      decodeBmpScaledInto(data, expected, fitStretch)
      decodeBmpStreamScaledInto(sourceOf(data, 1), totalLen, target, fitStretch)
      doAssert target.pixelsEqual(expected)

  # Truncated input fails instead of hanging on the exhausted source
  block:
    let
      data = readFile("tests/fileformats/bmp/bmpsuite/24bpp-320x240.bmp")
      truncated = data[0 ..< data.len div 2]
    try:
      let target = newImage(8, 8)
      decodeBmpStreamScaledInto(
        sourceOf(truncated, 100), truncated.len, target, fitStretch)
      doAssert false
    except PixieError:
      discard

block: # var string scaled decodes release the source buffer
  var data = readFile("tests/fileformats/bmp/bmpsuite/8bpp-320x240.bmp")
  let expected = decodeBmpScaled(data.cstring, data.len, 64, 48)
  let image = decodeBmpScaled(data, 64, 48)
  doAssert data.len == 0
  doAssert image.pixelsEqual(expected)

block: # the format dispatchers route BMPs to the streaming decoder
  let
    data = readFile("tests/fileformats/bmp/bmpsuite/24bpp-320x240.bmp")
    expected = newImage(64, 48)
  decodeBmpScaledInto(data, expected, fitCover)
  let scaled = decodeImageScaled(data, 64, 48, fitCover)
  doAssert scaled.pixelsEqual(expected)
  let target = newImage(64, 48)
  discard decodeImageScaledInto(data, target, fitCover)
  doAssert target.pixelsEqual(expected)

block: # decode budget: full decodes over budget fail, streaming fits
  setDecodeBudgetBytes(64 * 1024)
  let data = readFile("tests/fileformats/bmp/bmpsuite/24bpp-320x240.bmp")
  try:
    discard decodeBmp(data) # 320x240x4 pixel buffer is over budget
    doAssert false
  except PixieError as e:
    doAssert "memory budget" in e.msg
  # The streaming path only needs row buffers and stays under it
  let target = newImage(64, 48)
  decodeBmpScaledInto(data, target, fitStretch)
  setDecodeBudgetBytes(0)
