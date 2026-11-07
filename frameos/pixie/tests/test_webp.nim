import pixie, pixie/decodebudget, pixie/fileformats/webp, webpsuite

proc checkDimensions(path: string, width, height: int) =
  let
    data = readFile(path)
    info = decodeWebpInfo(data)
    dimensions = decodeWebpDimensions(data)
    pointerDimensions = decodeWebpDimensions(data.cstring, data.len)
    readDimensions = readImageDimensions(path)

  doAssert info.width == width
  doAssert info.height == height
  doAssert dimensions.width == width
  doAssert dimensions.height == height
  doAssert pointerDimensions.width == width
  doAssert pointerDimensions.height == height
  doAssert readDimensions.width == width
  doAssert readDimensions.height == height

block:
  doAssert WebpSuiteFiles.len == 129

  var
    lossyCount, losslessCount, alphaCount, vp8XCount: int

  for path in WebpSuiteFiles:
    let
      data = readFile(path)
      info = decodeWebpInfo(data)
      dimensions = decodeWebpDimensions(data)

    doAssert info.width == dimensions.width
    doAssert info.height == dimensions.height
    doAssert info.fileSize <= data.len
    doAssert info.chunks.len > 0

    case info.compression
    of LossyWebp:
      inc lossyCount
      doAssert info.vp8Offset > 0
      doAssert info.vp8Size > 0
      let image = readImage(path)
      doAssert image.width == info.width
      doAssert image.height == info.height
    of LosslessWebp:
      inc losslessCount
      doAssert info.vp8LOffset > 0
      doAssert info.vp8LSize > 0
      let image = readImage(path)
      doAssert image.width == info.width
      doAssert image.height == info.height
    of UnknownWebpCompression:
      doAssert info.hasAnimation

    if info.hasAlpha:
      inc alphaCount
    if info.hasVp8X:
      inc vp8XCount

  doAssert lossyCount > 0
  doAssert losslessCount > 0
  doAssert alphaCount > 0
  doAssert vp8XCount > 0

checkDimensions("tests/fileformats/webp/small_1x1.webp", 1, 1)
checkDimensions("tests/fileformats/webp/small_1x13.webp", 1, 13)
checkDimensions("tests/fileformats/webp/small_13x1.webp", 13, 1)
checkDimensions("tests/fileformats/webp/small_31x13.webp", 31, 13)
checkDimensions("tests/fileformats/webp/test.webp", 128, 128)
checkDimensions("tests/fileformats/webp/lossy_q0_f100.webp", 128, 128)
checkDimensions("tests/fileformats/webp/lossless1.webp", 1000, 307)
checkDimensions("tests/fileformats/webp/lossy_alpha1.webp", 1000, 307)
checkDimensions("tests/fileformats/webp/alpha_no_compression.webp", 16, 16)
checkDimensions("tests/fileformats/webp/one_color_no_palette.webp", 100, 100)
checkDimensions("tests/fileformats/webp/near_lossless_75.webp", 256, 256)
checkDimensions("tests/fileformats/webp/vp80-00-comprehensive-016.webp", 176, 144)

block:
  let lossless = decodeWebpInfo(readFile("tests/fileformats/webp/lossless1.webp"))
  doAssert lossless.compression == LosslessWebp
  doAssert lossless.losslessAlpha

block:
  let lossyAlpha = decodeWebpInfo(readFile("tests/fileformats/webp/lossy_alpha1.webp"))
  doAssert lossyAlpha.compression == LossyWebp
  doAssert lossyAlpha.hasVp8X
  doAssert lossyAlpha.hasAlpha
  doAssert lossyAlpha.alphaOffset > 0
  doAssert lossyAlpha.alphaInfo.compressionMethod in [0, 1]
  doAssert lossyAlpha.alphaInfo.filterMethod in 0 .. 3

block:
  let rawAlpha = decodeWebpInfo(
    readFile("tests/fileformats/webp/alpha_no_compression.webp")
  )
  doAssert rawAlpha.hasAlpha
  doAssert rawAlpha.alphaInfo.compressionMethod == 0

proc chunkedSource(data: string, chunkSize: int): ImageSourceProc =
  ## A pull source that drips the body in small chunks, like a spilled file
  ## read back from storage.
  var pos = 0
  result = proc(dst: pointer, maxBytes: int): int {.gcsafe, raises: [].} =
    let n = min(min(maxBytes, chunkSize), data.len - pos)
    if n > 0:
      copyMem(dst, data[pos].unsafeAddr, n)
      pos += n
    n

block:
  # The scaled-into family against the buffered decoder, over the whole
  # suite. At native size the sampling is the identity, so the fitted decode
  # must be pixel-identical to decodeWebp — same YUV conversion, same alpha,
  # same premultiplication. The pull-source variant reads the same bytes
  # through a drip-fed callback and must land on the same pixels.
  for path in WebpSuiteFiles:
    let data = readFile(path)
    if decodeWebpInfo(data).compression == UnknownWebpCompression:
      continue
    let
      reference = decodeWebp(data)
      same = newImage(reference.width, reference.height)
    discard decodeWebpScaledInto(data, same, fitStretch)
    doAssert same.pixelsEqual(reference), path

    let streamed = newImage(reference.width, reference.height)
    decodeWebpStreamScaledInto(
      chunkedSource(data, 977), data.len, streamed, fitStretch
    )
    doAssert streamed.pixelsEqual(reference), path

block:
  # Downscale sampling against a hand-rolled box-filter reference over the
  # buffered decode, for every fit. Each target pixel must be the rounded
  # premultiplied average of its exact source footprint — the same area
  # filter a smooth resize applies — computed here independently from the
  # decoded image's pixels.
  for path in [
    "tests/fileformats/webp/test.webp",           # lossy
    "tests/fileformats/webp/lossless1.webp",      # lossless, odd size
    "tests/fileformats/webp/lossy_alpha1.webp",   # lossy + alpha
    "tests/fileformats/webp/small_31x13.webp"     # tiny, odd size
  ]:
    let
      data = readFile(path)
      reference = decodeWebp(data)
    for fit in ScaledDecodeFit:
      let
        targetWidth = max(1, reference.width div 3)
        targetHeight = max(1, reference.height div 2)
        scaled = decodeWebpScaled(data, targetWidth, targetHeight, fit)
        rects = scaledFitRects(
          reference.width, reference.height, targetWidth, targetHeight, fit
        )
      for dstY in rects.dstY ..< rects.dstY + rects.dstH:
        let
          relY = dstY - rects.dstY
          sy0 = min(rects.srcY + (relY * rects.srcH) div rects.dstH,
            reference.height - 1)
          sy1 = max(sy0 + 1, min(
            rects.srcY + ((relY + 1) * rects.srcH) div rects.dstH,
            reference.height))
        for dstX in rects.dstX ..< rects.dstX + rects.dstW:
          let
            relX = dstX - rects.dstX
            sx0 = min(rects.srcX + (relX * rects.srcW) div rects.dstW,
              reference.width - 1)
            sx1 = max(sx0 + 1, min(
              rects.srcX + ((relX + 1) * rects.srcW) div rects.dstW,
              reference.width))
          var sumR, sumG, sumB, sumA: uint32
          for sy in sy0 ..< sy1:
            for sx in sx0 ..< sx1:
              let px = reference.data[reference.dataIndex(sx, sy)]
              sumR += px.r
              sumG += px.g
              sumB += px.b
              sumA += px.a
          let
            area = uint32((sy1 - sy0) * (sx1 - sx0))
            expected = ColorRGBX(
              r: ((sumR + area div 2) div area).uint8,
              g: ((sumG + area div 2) div area).uint8,
              b: ((sumB + area div 2) div area).uint8,
              a: ((sumA + area div 2) div area).uint8)
          doAssert scaled.data[scaled.dataIndex(dstX, dstY)] == expected,
            path & " " & $fit & " at " & $dstX & "," & $dstY

block:
  # A contain fit writes only the fitted rect; the margins belong to the
  # caller (they may be the live canvas of a render in progress).
  let
    data = readFile("tests/fileformats/webp/test.webp") # 128x128
    sentinel = rgbx(1, 2, 3, 255)
    target = newImage(200, 100)
  target.fill(sentinel)
  discard decodeWebpScaledInto(data, target, fitContain)
  # 128x128 into 200x100 contain -> a 100x100 rect centered horizontally.
  doAssert target.data[target.dataIndex(0, 50)] == sentinel
  doAssert target.data[target.dataIndex(199, 50)] == sentinel
  doAssert target.data[target.dataIndex(100, 50)] != sentinel

block:
  # An over-budget decode refuses catchably before allocating, in every
  # entry point, and the stream variant refuses before buffering the body.
  let data = readFile("tests/fileformats/webp/lossless1.webp")
  setDecodeBudgetBytes(1024)
  doAssertRaises(PixieError):
    discard decodeWebp(data)
  doAssertRaises(PixieError):
    discard decodeWebpScaled(data, 10, 10)
  doAssertRaises(PixieError):
    decodeWebpStreamScaledInto(
      chunkedSource(data, 977), data.len, newImage(10, 10)
    )
  setDecodeBudgetBytes(0)
  doAssert decodeWebp(data).width == 1000
