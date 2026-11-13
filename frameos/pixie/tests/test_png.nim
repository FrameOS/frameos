import pixie, pixie/fileformats/png, pixie/decodebudget, pixie/inflatestream, pngsuite, strformat, strutils, crunchy, flatty/binny

when defined(writeImages):
  import write_images

when defined(writeImages):
  resetOutputDir(pngSuiteOutputDir)
  echo &"Writing decoded PNGSuite images to {pngSuiteOutputDir}"

for file in pngSuiteFiles:
  let
    original = readFile(&"tests/fileformats/png/pngsuite/{file}.png")
    decoded = decodePng(original)
    encoded = encodePng(decoded)
  when defined(writeImages):
    newImage(decoded).writeOutputImage(pngSuiteOutputDir, file)

block:
  let
    png8 = decodePng(readFile("tests/fileformats/png/pngsuite/basn2c08.png"))
    png16 = decodePng(readFile("tests/fileformats/png/pngsuite/basn2c16.png"))
    image16 = png16.convertToImage()
  doAssert png8.bitDepth == 8
  doAssert png8.data.len == png8.width * png8.height
  doAssert png8.data16.len == 0
  doAssert png16.bitDepth == 16
  doAssert png16.data.len == 0
  doAssert png16.data16.len == png16.width * png16.height
  doAssert image16.width == png16.width
  doAssert image16.height == png16.height

block:
  let source = newImage(16, 8)
  let encoded = source.encodePng()

  var scaledData = encoded
  let scaled = decodePngScaled(scaledData, 4, 2)
  doAssert scaled.width == 4
  doAssert scaled.height == 2
  doAssert scaledData.len == 0

  var genericData = encoded
  let generic = decodeImageScaled(genericData, 5, 3)
  doAssert generic.width == 5
  doAssert generic.height == 3
  doAssert genericData.len == 0

  var targetData = encoded
  let target = newImage(3, 2)
  doAssert decodeImageScaledInto(targetData, target) == target
  doAssert target.width == 3
  doAssert target.height == 2
  doAssert targetData.len == 0

block:
  for channels in 1 .. 4:
    var data: seq[uint8]
    for x in 0 ..< 16:
      for y in 0 ..< 16:
        var components = newSeq[uint8](channels)
        for i in 0 ..< channels:
          components[i] = (x * 16).uint8
        data.add(components)
    let encoded = encodePng(16, 16, channels, data[0].addr, data.len)

  for file in pngSuiteCorruptedFiles:
    try:
      discard decodePng(readFile(&"tests/fileformats/png/pngsuite/{file}.png"))
      doAssert false
    except PixieError:
      discard

block:
  discard readImage("tests/fileformats/png/trailing_data.png")

block:
  let dimensions =
    decodeImageDimensions(readFile("tests/fileformats/png/mandrill.png"))
  doAssert dimensions.width == 512
  doAssert dimensions.height == 512

block: # streamed scanlines keep canvas-sized decodes within tight budgets
  let source = newImage(480, 800)
  for y in 0 ..< source.height:
    for x in 0 ..< source.width:
      source.unsafe[x, y] = rgbx(uint8(x mod 256), uint8(y mod 256), uint8((x + y) mod 256), 255)
  let encoded = encodePng(source.width, source.height, 4, source.data[0].addr, source.dataLen * 4)

  # Full decode plan is pixels + fixed streaming overhead (~1.6MB);
  # a 2MB budget must accept it
  setDecodeBudgetBytes(2 * 1024 * 1024)
  let decoded = decodePng(encoded).convertToImage()
  doAssert decoded.width == 480
  doAssert decoded.height == 800
  doAssert decoded[123, 456] == source[123, 456]

  # A 1MB budget cannot hold the pixels themselves and must reject
  setDecodeBudgetBytes(1024 * 1024)
  try:
    discard decodePng(encoded)
    doAssert false
  except PixieError as e:
    doAssert "memory budget" in e.msg

  # Scaled decode into a small target never allocates the full pixel
  # buffer: a 256KB budget suffices for a 480x800 source
  setDecodeBudgetBytes(256 * 1024)
  let target = newImage(96, 60)
  decodePngScaledInto(encoded, target, fitStretch)
  # The box sampler's answer for (48, 30): the rounded average of that
  # pixel's exact source footprint (columns 240..<245, rows 400..<414).
  block:
    var r, g, b: uint64
    var n: uint64
    for sy in 0 ..< source.height:
      if (sy * 60) div source.height != 30: continue
      for sx in 0 ..< source.width:
        if (sx * 96) div source.width != 48: continue
        let px = source[sx, sy]
        r += px.r
        g += px.g
        b += px.b
        inc n
    doAssert target[48, 30] == rgbx(
      uint8((r + n div 2) div n),
      uint8((g + n div 2) div n),
      uint8((b + n div 2) div n),
      255)
  setDecodeBudgetBytes(0)

block: # streamed scaled decodes match the buffered fillImage path
  let source = newImage(123, 77)
  for y in 0 ..< source.height:
    for x in 0 ..< source.width:
      source.unsafe[x, y] = rgbx(uint8((x * 7) mod 256), uint8((y * 5) mod 256), uint8((x + y) mod 256), 255)
  let encoded = encodePng(source.width, source.height, 4, source.data[0].addr, source.dataLen * 4)
  for fit in ScaledDecodeFit:
    for (w, h) in [(50, 40), (123, 77), (300, 90), (33, 200)]:
      let streamed = decodePngScaled(encoded, w, h, fit)
      let buffered = decodePng(encoded).convertToImage(w, h, fit)
      doAssert streamed.width == buffered.width
      doAssert streamed.height == buffered.height
      for i in 0 ..< streamed.dataLen:
        doAssert streamed.data[i] == buffered.data[i],
          "pixel mismatch at " & $i & " fit " & $fit & " " & $w & "x" & $h

proc rechunkIdat(encoded: string, chunkSize: int): string =
  ## Rewrites a PNG so its IDAT payload is split into chunkSize-byte IDATs.
  var idatData = ""
  result = encoded[0 ..< 8] # signature
  var pos = 8
  while pos < encoded.len:
    let
      chunkLen = int(encoded.readUint32(pos).swap())
      chunkType = encoded[pos + 4 ..< pos + 8]
  # collect IDAT payloads, copy everything else verbatim (before IEND)
    if chunkType == "IDAT":
      idatData.add(encoded[pos + 8 ..< pos + 8 + chunkLen])
    elif chunkType == "IEND":
      break
    else:
      result.add(encoded[pos ..< pos + 12 + chunkLen])
    pos += 12 + chunkLen

  var off = 0
  while off < idatData.len:
    let n = min(chunkSize, idatData.len - off)
    var chunk = ""
    chunk.addUint32(n.uint32.swap())
    chunk.add("IDAT")
    chunk.add(idatData[off ..< off + n])
    chunk.addUint32(crc32(chunk[chunk.len - n - 4].addr, n + 4).swap())
    result.add(chunk)
    off += n

  var iend = ""
  iend.addUint32(0.uint32.swap())
  iend.add("IEND")
  iend.addUint32(crc32(iend[iend.len - 4].addr, 4).swap())
  result.add(iend)


block: # multi-IDAT PNGs decode without concatenating the compressed stream
  # Real-world encoders split compressed data across hundreds of IDAT
  # chunks (libpng defaults to 8K). The inflater consumes them as segments;
  # re-chunk a PNG's IDAT at awkward sizes — including 1-byte chunks that
  # split the zlib header — and require identical output.
  let source = newImage(101, 53)
  for y in 0 ..< source.height:
    for x in 0 ..< source.width:
      source.unsafe[x, y] = rgbx(uint8((x * 3) mod 256), uint8((y * 11) mod 256), uint8((x * y) mod 256), 255)
  let encoded = encodePng(source.width, source.height, 4, source.data[0].addr, source.dataLen * 4)
  let reference = decodePng(encoded).convertToImage()

  for chunkSize in [1, 2, 3, 7, 64, 8192, 1 shl 30]:
    let rechunked = rechunkIdat(encoded, chunkSize)
    let decoded = decodePng(rechunked).convertToImage()
    doAssert decoded.width == reference.width and decoded.height == reference.height
    for i in 0 ..< decoded.dataLen:
      doAssert decoded.data[i] == reference.data[i],
        "pixel mismatch at " & $i & " with IDAT chunk size " & $chunkSize

    let target = newImage(48, 20)
    decodePngScaledInto(rechunked, target, fitStretch)
    let expected = decodePng(encoded).convertToImage(48, 20, fitStretch)
    for i in 0 ..< target.dataLen:
      doAssert target.data[i] == expected.data[i],
        "scaled pixel mismatch at " & $i & " with IDAT chunk size " & $chunkSize

block: # segmented sources decode identically to contiguous ones
  # A PNG downloaded in fixed-size chunks never gets assembled into one
  # contiguous buffer; decodePngScaledInto(segments) must parse chunk CRCs
  # across boundaries and stream IDATs spanning multiple segments.
  proc segmentsOf(data: string, sizes: seq[int]): seq[InflateSegment] =
    var pos = 0
    var i = 0
    while pos < data.len:
      let n = min(sizes[i mod sizes.len], data.len - pos)
      result.add(InflateSegment(
        data: cast[ptr UncheckedArray[uint8]](data[pos].unsafeAddr), len: n
      ))
      pos += n
      inc i

  let source = newImage(97, 61)
  for y in 0 ..< source.height:
    for x in 0 ..< source.width:
      source.unsafe[x, y] = rgbx(uint8((x * 13) mod 256), uint8((y * 3) mod 256), uint8((x xor y) mod 256), 255)
  let encoded = encodePng(source.width, source.height, 4, source.data[0].addr, source.dataLen * 4)

  for idatChunkSize in [1, 3, 61, 8192]:
    let rechunked = rechunkIdat(encoded, idatChunkSize)
    let expected = newImage(40, 25)
    decodePngScaledInto(rechunked, expected, fitStretch)
    for segSizes in [@[1], @[2, 3, 5], @[7], @[100], @[64 * 1024]]:
      let target = newImage(40, 25)
      decodePngScaledInto(segmentsOf(rechunked, segSizes), target, fitStretch)
      for i in 0 ..< target.dataLen:
        doAssert target.data[i] == expected.data[i],
          "segmented mismatch at " & $i & " idat=" & $idatChunkSize & " segs=" & $segSizes

  # Palette + transparency PNGs exercise PLTE/tRNS chunk handling
  for file in ["basn3p08", "tbbn3p08", "basn6a08"]:
    let original = readFile(&"tests/fileformats/png/pngsuite/{file}.png")
    let expected = newImage(24, 24)
    decodePngScaledInto(original, expected, fitStretch)
    let target = newImage(24, 24)
    decodePngScaledInto(segmentsOf(original, @[5, 11]), target, fitStretch)
    for i in 0 ..< target.dataLen:
      doAssert target.data[i] == expected.data[i], file

  # Corrupted files must still fail cleanly through the segmented parser
  for file in pngSuiteCorruptedFiles:
    let original = readFile(&"tests/fileformats/png/pngsuite/{file}.png")
    try:
      let target = newImage(8, 8)
      decodePngScaledInto(segmentsOf(original, @[9]), target, fitStretch)
      doAssert false
    except PixieError:
      discard

block: # pull sources (file-backed) decode identically to buffered ones
  # A download spilled to disk decodes through a sequential read callback;
  # the whole compressed file is never in memory. Exercise awkward read
  # granularities so chunk headers, CRCs and IDAT payloads all straddle
  # read boundaries.
  proc sourceOf(data: string, readSize: int): PngSourceProc =
    var pos = 0
    result = proc (dst: pointer, maxBytes: int): int =
      let n = min(min(readSize, maxBytes), data.len - pos)
      if n <= 0:
        return 0
      copyMem(dst, data[pos].unsafeAddr, n)
      pos += n
      n

  let source = newImage(89, 47)
  for y in 0 ..< source.height:
    for x in 0 ..< source.width:
      source.unsafe[x, y] = rgbx(uint8((x * 5) mod 256), uint8((y * 9) mod 256), uint8((x + 2 * y) mod 256), 255)
  let encoded = encodePng(source.width, source.height, 4, source.data[0].addr, source.dataLen * 4)

  for idatChunkSize in [1, 3, 61, 8192, 1 shl 30]:
    let rechunked = rechunkIdat(encoded, idatChunkSize)
    for fit in ScaledDecodeFit:
      let expected = newImage(40, 25)
      decodePngScaledInto(rechunked, expected, fit)
      for readSize in [1, 7, 1000, 1 shl 20]:
        let target = newImage(40, 25)
        decodePngStreamScaledInto(sourceOf(rechunked, readSize), rechunked.len, target, fit)
        for i in 0 ..< target.dataLen:
          doAssert target.data[i] == expected.data[i],
            "pull mismatch at " & $i & " idat=" & $idatChunkSize &
            " read=" & $readSize & " fit=" & $fit

  # Palette + transparency PNGs exercise PLTE/tRNS chunk handling
  for file in ["basn3p08", "tbbn3p08", "basn6a08"]:
    let original = readFile(&"tests/fileformats/png/pngsuite/{file}.png")
    let expected = newImage(24, 24)
    decodePngScaledInto(original, expected, fitStretch)
    let target = newImage(24, 24)
    decodePngStreamScaledInto(sourceOf(original, 11), original.len, target, fitStretch)
    for i in 0 ..< target.dataLen:
      doAssert target.data[i] == expected.data[i], file

  # Interlaced and 16-bit PNGs cannot stream and must fail cleanly
  for file in ["basi2c08", "basn2c16"]:
    let original = readFile(&"tests/fileformats/png/pngsuite/{file}.png")
    try:
      let target = newImage(8, 8)
      decodePngStreamScaledInto(sourceOf(original, 100), original.len, target, fitStretch)
      doAssert false
    except PixieError as e:
      doAssert "non-interlaced" in e.msg

  # Truncated input fails instead of hanging on the exhausted source
  block:
    let truncated = encoded[0 ..< encoded.len div 2]
    try:
      let target = newImage(8, 8)
      decodePngStreamScaledInto(sourceOf(truncated, 100), truncated.len, target, fitStretch)
      doAssert false
    except PixieError:
      discard

  # Corrupted files must still fail cleanly through the pull parser
  for file in pngSuiteCorruptedFiles:
    let original = readFile(&"tests/fileformats/png/pngsuite/{file}.png")
    try:
      let target = newImage(8, 8)
      decodePngStreamScaledInto(sourceOf(original, 9), original.len, target, fitStretch)
      doAssert false
    except PixieError:
      discard
