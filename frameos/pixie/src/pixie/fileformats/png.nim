import chroma, flatty/binny, ../common, ../decodebudget, ../images,
    ../inflatestream, ../internal, ../simd, zippy, crunchy

# See http://www.libpng.org/pub/png/spec/1.2/PNG-Contents.html

let
  pngSignature* = [137.uint8, 80, 78, 71, 13, 10, 26, 10]

type
  ChunkCounts = object
    PLTE, IDAT, tRNS: uint8

  PngHeader = object
    width, height: int
    bitDepth, colorType, compressionMethod, filterMethod, interlaceMethod: uint8

  ColorRGBA16* = object
    r*, g*, b*, a*: uint16

  Png* = ref object
    width*, height*, channels*, bitDepth*: int
    data*: seq[ColorRGBA]
    data16*: seq[ColorRGBA16]

template failInvalid() =
  raise newException(PixieError, "Invalid PNG buffer, unable to load")

template failCRC() =
  raise newException(PixieError, "CRC check failed")

when defined(release):
  {.push checks: off.}

proc decodeHeader(data: pointer): PngHeader =
  let data = cast[ptr UncheckedArray[uint8]](data)
  result.width = data.readUint32(0).swap().int
  result.height = data.readUint32(4).swap().int
  result.bitDepth = data.readUint8(8)
  result.colorType = data.readUint8(9)
  result.compressionMethod = data.readUint8(10)
  result.filterMethod = data.readUint8(11)
  result.interlaceMethod = data.readUint8(12)

  if result.width == 0 or result.width > int32.high.int:
    raise newException(PixieError, "Invalid PNG width")

  if result.height == 0 or result.height > int32.high.int:
    raise newException(PixieError, "Invalid PNG height")

  template failInvalidCombo() =
    raise newException(
      PixieError, "Invalid PNG color type and bit depth combination"
    )

  case result.colorType:
  of 0:
    if result.bitDepth notin [1.uint8, 2, 4, 8, 16]:
      failInvalidCombo()
  of 2:
    if result.bitDepth notin [8.uint8, 16]:
      failInvalidCombo()
  of 3: # PLTE chunk is required, sample depth is always 8 bits
    if result.bitDepth notin [1.uint8, 2, 4, 8]:
      failInvalidCombo()
  of 4:
    if result.bitDepth notin [8.uint8, 16]:
      failInvalidCombo()
  of 6:
    if result.bitDepth notin [8.uint8, 16]:
      failInvalidCombo()
  else:
    failInvalidCombo()

  if result.compressionMethod != 0:
    raise newException(PixieError, "Invalid PNG compression method")

  if result.filterMethod != 0:
    raise newException(PixieError, "Invalid PNG filter method")

  if result.interlaceMethod notin [0.uint8, 1]:
    raise newException(PixieError, "Invalid PNG interlace method")

proc decodePalette(data: pointer, len: int): seq[ColorRGB] =
  if len == 0 or len mod 3 != 0:
    failInvalid()

  result.setLen(len div 3)

  copyMem(result[0].addr, data, len)

proc unfilter(
  uncompressed: pointer, len, height, rowBytes, bpp: int
): seq[uint8] =
  result.setLen(len - height)

  template uncompressedIdx(x, y: int): int =
    x + y * (rowBytes + 1)

  template unfiteredIdx(x, y: int): int =
    x + y * rowBytes

  let uncompressed = cast[ptr UncheckedArray[uint8]](uncompressed)

  # Unfilter the image data
  for y in 0 ..< height:
    let filterType = uncompressed[uncompressedIdx(0, y)]
    case filterType:
    of 0: # None
      copyMem(
        result[unfiteredIdx(0, y)].addr,
        uncompressed[uncompressedIdx(1, y)].unsafeAddr,
        rowBytes
      )
    of 1: # Sub
      let
        uncompressedStartIdx = uncompressedIdx(1, y)
        unfilteredStartIx = unfiteredIdx(0, y)
      for x in 0 ..< rowBytes:
        var value = uncompressed[uncompressedStartIdx + x]
        if x - bpp >= 0:
          value += result[unfilteredStartIx + x - bpp]
        result[unfilteredStartIx + x] = value
    of 2: # Up
      let
        uncompressedStartIdx = uncompressedIdx(1, y)
        unfilteredStartIx = unfiteredIdx(0, y)
      var x: int
      when allowSimd and (defined(amd64) or defined(arm64)):
        if y - 1 >= 0:
          for _ in 0 ..< rowBytes div 16:
            when defined(amd64):
              let
                bytes = mm_loadu_si128(uncompressed[uncompressedStartIdx + x].addr)
                up = mm_loadu_si128(result[unfilteredStartIx + x - rowBytes].addr)
              mm_storeu_si128(
                result[unfilteredStartIx + x].addr,
                mm_add_epi8(bytes, up)
              )
            else: # arm64
              let
                bytes = vld1q_u8(uncompressed[uncompressedStartIdx + x].addr)
                up = vld1q_u8(result[unfilteredStartIx + x - rowBytes].addr)
              vst1q_u8(
                result[unfilteredStartIx + x].addr,
                vaddq_u8(bytes, up)
              )
            x += 16
      for x in x ..< rowBytes:
        var value = uncompressed[uncompressedStartIdx + x]
        if y - 1 >= 0:
          value += result[unfilteredStartIx + x - rowBytes]
        result[unfilteredStartIx + x] = value
    of 3: # Average
      let
        uncompressedStartIdx = uncompressedIdx(1, y)
        unfilteredStartIx = unfiteredIdx(0, y)
      for x in 0 ..< rowBytes:
        var
          value = uncompressed[uncompressedStartIdx + x]
          left, up: uint32
        if x - bpp >= 0:
          left = result[unfilteredStartIx + x - bpp]
        if y - 1 >= 0:
          up = result[unfilteredStartIx + x - rowBytes]
        value += ((left + up) div 2).uint8
        result[unfilteredStartIx + x] = value
    of 4: # Paeth
      let
        uncompressedStartIdx = uncompressedIdx(1, y)
        unfilteredStartIx = unfiteredIdx(0, y)
      for x in 0 ..< rowBytes:
        var
          value = uncompressed[uncompressedStartIdx + x]
          left, up, upLeft: int
        if x - bpp >= 0:
          left = result[unfilteredStartIx + x - bpp].int
        if y - 1 >= 0:
          up = result[unfilteredStartIx + x - rowBytes].int
        if x - bpp >= 0 and y - 1 >= 0:
          upLeft = result[unfilteredStartIx + x - rowBytes - bpp].int
        template paethPredictor(a, b, c: int): int =
          let
            p = a + b - c
            pa = abs(p - a)
            pb = abs(p - b)
            pc = abs(p - c)
          if pa <= pb and pa <= pc:
            a
          elif pb <= pc:
            b
          else:
            c
        value += paethPredictor(up, left, upLeft).uint8
        result[unfilteredStartIx + x] = value
    else:
      raise newException(PixieError, "Invalid PNG row filter")

proc valuesPerPixel(header: PngHeader): int =
  case header.colorType:
  of 0: 1
  of 2: 3
  of 3: 1
  of 4: 2
  of 6: 4
  else: 0 # Not possible, decodeHeader validates

proc scanlineBytes(width: int, header: PngHeader): int =
  let bitsPerPixel = header.valuesPerPixel * header.bitDepth.int
  (width * bitsPerPixel + 7) div 8

proc filterBytesPerPixel(header: PngHeader): int =
  max((header.valuesPerPixel * header.bitDepth.int + 7) div 8, 1)

proc adam7Size(size, start, step: int): int =
  if size <= start:
    0
  else:
    (size - start + step - 1) div step

proc packedSample(
  unfiltered: openArray[uint8], rowStart, x: int, bitDepth: uint8
): uint8 =
  case bitDepth:
  of 1:
    (unfiltered[rowStart + x div 8] shr (7 - (x mod 8))) and 1
  of 2:
    (unfiltered[rowStart + x div 4] shr (6 - (x mod 4) * 2)) and 3
  of 4:
    (unfiltered[rowStart + x div 2] shr (4 - (x mod 2) * 4)) and 15
  of 8:
    unfiltered[rowStart + x]
  else:
    0 # 16 bit is rejected before image data is decoded.

proc expandSample(value, bitDepth: uint8): uint8 =
  case bitDepth:
  of 1: value * 255
  of 2: value * 85
  of 4: value * 17
  else: value

proc readUint16be(data: openArray[uint8], offset: int): uint16 {.inline.} =
  (data[offset].uint16 shl 8) or data[offset + 1].uint16

proc readUint16be(data: string, offset: int): uint16 {.inline.} =
  (data.readUint8(offset).uint16 shl 8) or data.readUint8(offset + 1).uint16

proc rgba16*(r, g, b, a: uint16): ColorRGBA16 {.inline.} =
  ColorRGBA16(r: r, g: g, b: b, a: a)

proc toUint8(value: uint16): uint8 {.inline.} =
  ((value.uint32 * 255 + 32767) div 65535).uint8

proc toRgba(color: ColorRGBA16): ColorRGBA {.inline.} =
  rgba(
    color.r.toUint8,
    color.g.toUint8,
    color.b.toUint8,
    color.a.toUint8
  )

proc writePixels(
  image: var seq[ColorRGBA],
  header: PngHeader,
  palette: seq[ColorRGB],
  transparency: string,
  unfiltered: openArray[uint8],
  passWidth, passHeight, startX, startY, stepX, stepY: int
) =
  let
    rowBytes = scanlineBytes(passWidth, header)
    specialGray = if transparency.len == 2: transparency[1].int else: -1

  var specialRgb: ColorRGBA
  if transparency.len == 6:
    specialRgb = rgba(
      transparency.readUint8(1),
      transparency.readUint8(3),
      transparency.readUint8(5),
      255
    )

  for passY in 0 ..< passHeight:
    let
      rowStart = passY * rowBytes
      y = startY + passY * stepY

    for passX in 0 ..< passWidth:
      let
        x = startX + passX * stepX
        dst = x + y * header.width

      case header.colorType:
      of 0:
        let value = expandSample(
          packedSample(unfiltered, rowStart, passX, header.bitDepth),
          header.bitDepth
        )
        let alpha = if value.int == specialGray: 0.uint8 else: 255.uint8
        image[dst] = rgba(value, value, value, alpha)
      of 2:
        let
          src = rowStart + passX * 3
          color = rgba(
            unfiltered[src + 0],
            unfiltered[src + 1],
            unfiltered[src + 2],
            255
          )
        image[dst] =
          if transparency.len == 6 and color == specialRgb:
            rgba(color.r, color.g, color.b, 0)
          else:
            color
      of 3:
        let value = packedSample(unfiltered, rowStart, passX, header.bitDepth)
        if value.int >= palette.len:
          failInvalid()

        let
          rgb = palette[value]
          alpha =
            if transparency.len > value.int:
              transparency.readUint8(value.int)
            else:
              255
        image[dst] = rgba(rgb.r, rgb.g, rgb.b, alpha)
      of 4:
        let src = rowStart + passX * 2
        image[dst] = rgba(
          unfiltered[src],
          unfiltered[src],
          unfiltered[src],
          unfiltered[src + 1]
        )
      of 6:
        let src = rowStart + passX * 4
        image[dst] = rgba(
          unfiltered[src + 0],
          unfiltered[src + 1],
          unfiltered[src + 2],
          unfiltered[src + 3]
        )
      else:
        discard # Not possible, decodeHeader validates

proc writePixels16(
  image: var seq[ColorRGBA16],
  header: PngHeader,
  transparency: string,
  unfiltered: openArray[uint8],
  passWidth, passHeight, startX, startY, stepX, stepY: int
) =
  let
    rowBytes = scanlineBytes(passWidth, header)
    specialGray =
      if transparency.len == 2: transparency.readUint16be(0) else: 0.uint16

  var specialRgb: ColorRGBA16
  if transparency.len == 6:
    specialRgb = rgba16(
      transparency.readUint16be(0),
      transparency.readUint16be(2),
      transparency.readUint16be(4),
      uint16.high
    )

  for passY in 0 ..< passHeight:
    let
      rowStart = passY * rowBytes
      y = startY + passY * stepY

    for passX in 0 ..< passWidth:
      let
        x = startX + passX * stepX
        dst = x + y * header.width

      case header.colorType:
      of 0:
        let value = unfiltered.readUint16be(rowStart + passX * 2)
        let alpha =
          if transparency.len == 2 and value == specialGray:
            0.uint16
          else:
            uint16.high
        image[dst] = rgba16(value, value, value, alpha)
      of 2:
        let src = rowStart + passX * 6
        var color = rgba16(
          unfiltered.readUint16be(src + 0),
          unfiltered.readUint16be(src + 2),
          unfiltered.readUint16be(src + 4),
          uint16.high
        )
        if transparency.len == 6 and color == specialRgb:
          color.a = 0
        image[dst] = color
      of 4:
        let
          src = rowStart + passX * 4
          value = unfiltered.readUint16be(src + 0)
        image[dst] = rgba16(
          value,
          value,
          value,
          unfiltered.readUint16be(src + 2)
        )
      of 6:
        let src = rowStart + passX * 8
        image[dst] = rgba16(
          unfiltered.readUint16be(src + 0),
          unfiltered.readUint16be(src + 2),
          unfiltered.readUint16be(src + 4),
          unfiltered.readUint16be(src + 6)
        )
      else:
        discard # 16-bit paletted PNG is not a valid color/bit-depth combo.

proc uncompressIdats(
  data: ptr UncheckedArray[uint8], idats: seq[(int, int)]
): string =
  if idats.len > 1:
    var imageData: string
    for (start, len) in idats:
      let op = imageData.len
      imageData.setLen(imageData.len + len)
      copyMem(imageData[op].addr, data[start].addr, len)
    result = try: uncompress(imageData) except ZippyError: failInvalid()
  else:
    let
      (start, len) = idats[0]
      p = data[start].unsafeAddr
    result = try: uncompress(p, len) except ZippyError: failInvalid()

proc unfilterRow(
  cur: var seq[uint8], prev: seq[uint8], filterType: uint8, rowBytes, bpp: int
) {.raises: [PixieError].} =
  ## Unfilters one scanline in place. prev must hold the previous unfiltered
  ## row (all zeroes for the first row, matching the PNG spec).
  template paethPredictor(a, b, c: int): int =
    let
      p = a + b - c
      pa = abs(p - a)
      pb = abs(p - b)
      pc = abs(p - c)
    if pa <= pb and pa <= pc:
      a
    elif pb <= pc:
      b
    else:
      c

  case filterType:
  of 0: # None
    discard
  of 1: # Sub
    for x in bpp ..< rowBytes:
      cur[x] = cur[x] + cur[x - bpp]
  of 2: # Up
    for x in 0 ..< rowBytes:
      cur[x] = cur[x] + prev[x]
  of 3: # Average
    for x in 0 ..< rowBytes:
      let left = if x >= bpp: cur[x - bpp].uint32 else: 0
      cur[x] = cur[x] + ((left + prev[x].uint32) div 2).uint8
  of 4: # Paeth
    for x in 0 ..< rowBytes:
      let
        left = if x >= bpp: cur[x - bpp].int else: 0
        upLeft = if x >= bpp: prev[x - bpp].int else: 0
      cur[x] = cur[x] + paethPredictor(prev[x].int, left, upLeft).uint8
  else:
    raise newException(PixieError, "Invalid PNG row filter")

proc idatSlices(
  data: ptr UncheckedArray[uint8], idats: seq[(int, int)]
): seq[InflateSegment] =
  ## The IDAT chunks of a contiguous PNG as inflater segments — big PNGs
  ## commonly split their compressed data across hundreds of IDATs, and
  ## concatenating them would momentarily double the compressed-body
  ## allocation.
  result = newSeq[InflateSegment](idats.len)
  for i, (start, len) in idats:
    result[i] = InflateSegment(
      data: cast[ptr UncheckedArray[uint8]](data[start].unsafeAddr), len: len
    )

type InflateRunProc = proc (
  onData: InflateOnData
) {.gcsafe, raises: [PixieError].}
  ## Runs one full inflate of a PNG's IDAT stream, emitting the uncompressed
  ## bytes through onData. Abstracts over where the compressed bytes live
  ## (in-memory segments or a pull source).

proc streamRows(
  header: PngHeader,
  onRow: proc (y: int, row: seq[uint8]) {.gcsafe, raises: [PixieError].},
  inflate: InflateRunProc
) =
  ## Inflates the IDAT stream and hands unfiltered scanlines to onRow one at
  ## a time, in order. Peak memory: the fixed ~64KB streaming window plus
  ## two row buffers, regardless of image size. Non-interlaced images only.
  let
    rowBytes = scanlineBytes(header.width, header)
    bpp = header.filterBytesPerPixel
    height = header.height

  var
    prevRow = newSeq[uint8](rowBytes)
    curRow = newSeq[uint8](rowBytes)
    rowFill = -1 # -1 = the next byte is the row's filter type
    filterType: uint8
    y: int

  let onData = proc (chunk: openArray[uint8]) {.gcsafe, raises: [PixieError].} =
    var i = 0
    while i < chunk.len:
      if y >= height:
        raise newException(PixieError, "PNG has too much image data")
      if rowFill < 0:
        filterType = chunk[i]
        inc i
        rowFill = 0
      let take = min(chunk.len - i, rowBytes - rowFill)
      if take > 0:
        copyMem(curRow[rowFill].addr, chunk[i].unsafeAddr, take)
        rowFill += take
        i += take
      if rowFill == rowBytes:
        unfilterRow(curRow, prevRow, filterType, rowBytes, bpp)
        onRow(y, curRow)
        swap(prevRow, curRow)
        inc y
        rowFill = -1

  inflate(onData)

  if y != height or rowFill != -1:
    failInvalid()

proc streamIdatRows(
  idatSegments: seq[InflateSegment],
  header: PngHeader,
  onRow: proc (y: int, row: seq[uint8]) {.gcsafe, raises: [PixieError].}
) =
  ## streamRows over IDAT chunks that are resident in memory.
  if idatSegments.len == 0:
    failInvalid()
  streamRows(header, onRow,
    proc (onData: InflateOnData) {.gcsafe, raises: [PixieError].} =
      uncompressStreamZlib(onData, idatSegments)
  )

proc decodeImageData(
  data: ptr UncheckedArray[uint8],
  header: PngHeader,
  palette: seq[ColorRGB],
  transparency: string,
  idats: seq[(int, int)]
): seq[ColorRGBA] =
  if idats.len == 0:
    failInvalid()

  if header.interlaceMethod == 0:
    # Stream scanlines straight out of the inflate window: peak memory is the
    # pixel seq plus a fixed ~64KB, never a whole-image scanline buffer.
    var image = newSeq[ColorRGBA](header.width * header.height)
    streamIdatRows(
      idatSlices(data, idats), header,
      proc (y: int, row: seq[uint8]) {.gcsafe, raises: [PixieError].} =
        image.writePixels(
          header, palette, transparency, row,
          header.width, 1, 0, y, 1, 1
        )
    )
    return move(image)

  var uncompressed = uncompressIdats(data, idats)

  block:
    result.setLen(header.width * header.height)
    const
      startXs = [0, 4, 0, 2, 0, 1, 0]
      startYs = [0, 0, 4, 0, 2, 0, 1]
      stepXs = [8, 8, 4, 4, 2, 2, 1]
      stepYs = [8, 8, 8, 4, 4, 2, 2]

    var pos: int
    for pass in 0 ..< 7:
      let
        passWidth = adam7Size(header.width, startXs[pass], stepXs[pass])
        passHeight = adam7Size(header.height, startYs[pass], stepYs[pass])

      if passWidth == 0 or passHeight == 0:
        continue

      let
        rowBytes = scanlineBytes(passWidth, header)
        passLen = (rowBytes + 1) * passHeight

      if pos + passLen > uncompressed.len:
        failInvalid()

      let unfiltered = unfilter(
        uncompressed[pos].unsafeAddr,
        passLen,
        passHeight,
        rowBytes,
        header.filterBytesPerPixel
      )
      result.writePixels(
        header, palette, transparency, unfiltered,
        passWidth, passHeight,
        startXs[pass], startYs[pass], stepXs[pass], stepYs[pass]
      )
      inc(pos, passLen)

    if pos != uncompressed.len:
      failInvalid()

proc decodeImageData16(
  data: ptr UncheckedArray[uint8],
  header: PngHeader,
  transparency: string,
  idats: seq[(int, int)]
): seq[ColorRGBA16] =
  if idats.len == 0:
    failInvalid()

  if header.interlaceMethod == 0:
    # Stream scanlines straight out of the inflate window: peak memory is the
    # pixel seq plus a fixed ~64KB, never a whole-image scanline buffer.
    var image = newSeq[ColorRGBA16](header.width * header.height)
    streamIdatRows(
      idatSlices(data, idats), header,
      proc (y: int, row: seq[uint8]) {.gcsafe, raises: [PixieError].} =
        image.writePixels16(
          header, transparency, row,
          header.width, 1, 0, y, 1, 1
        )
    )
    return move(image)

  var uncompressed = uncompressIdats(data, idats)

  block:
    result.setLen(header.width * header.height)
    const
      startXs = [0, 4, 0, 2, 0, 1, 0]
      startYs = [0, 0, 4, 0, 2, 0, 1]
      stepXs = [8, 8, 4, 4, 2, 2, 1]
      stepYs = [8, 8, 8, 4, 4, 2, 2]

    var pos: int
    for pass in 0 ..< 7:
      let
        passWidth = adam7Size(header.width, startXs[pass], stepXs[pass])
        passHeight = adam7Size(header.height, startYs[pass], stepYs[pass])

      if passWidth == 0 or passHeight == 0:
        continue

      let
        rowBytes = scanlineBytes(passWidth, header)
        passLen = (rowBytes + 1) * passHeight

      if pos + passLen > uncompressed.len:
        failInvalid()

      let unfiltered = unfilter(
        uncompressed[pos].unsafeAddr,
        passLen,
        passHeight,
        rowBytes,
        header.filterBytesPerPixel
      )
      result.writePixels16(
        header, transparency, unfiltered,
        passWidth, passHeight,
        startXs[pass], startYs[pass], stepXs[pass], stepYs[pass]
      )
      inc(pos, passLen)

    if pos != uncompressed.len:
      failInvalid()

proc newImage*(png: Png): Image {.raises: [PixieError].} =
  ## Creates a new Image from the PNG.
  result = newImage(png.width, png.height)
  if png.data.len > 0:
    copyMem(result.data[0].addr, png.data[0].addr, png.data.len * 4)
    result.toPremultipliedAlpha()
  else:
    for i, color in png.data16:
      result.data[i] = color.toRgba.rgbx()

proc convertToImage*(png: Png): Image {.raises: [].} =
  ## Converts a PNG into an Image by moving the data. This is faster but can
  ## only be done once.
  type Movable = ref object
    width, height, channels, bitDepth: int
    data: seq[ColorRGBX]
    data16: seq[ColorRGBA16]

  if png.data.len > 0:
    # Adopt the decoder's buffer rather than copying it; that move is the whole
    # point of this entry point.
    result = newImageFromUnchecked(
      png.width, png.height, move cast[Movable](png).data)
    result.toPremultipliedAlpha()
  else:
    var pixels = newSeq[ColorRGBX](png.width * png.height)
    for i, color in png.data16:
      pixels[i] = color.toRgba.rgbx()
    result = newImageFromUnchecked(png.width, png.height, move pixels)

proc validateScaledPngTarget(width, height: int) {.raises: [PixieError].} =
  if width <= 0 or width > int32.high.int:
    raise newException(PixieError, "Invalid PNG target width")
  if height <= 0 or height > int32.high.int:
    raise newException(PixieError, "Invalid PNG target height")

proc validateScaledPngTarget(target: Image) {.raises: [PixieError].} =
  if target.isNil:
    raise newException(PixieError, "Invalid PNG target Image")
  validateScaledPngTarget(target.width, target.height)

proc scaledFitRects(
  png: Png, targetWidth, targetHeight: int, fit: ScaledDecodeFit
): tuple[srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH: int] =
  scaledFitRects(png.width, png.height, targetWidth, targetHeight, fit)

proc fillImage*(
  png: Png, target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Scales a decoded PNG into an existing Image through the shared row box
  ## sampler — the same filtering the streamed decode applies, so an
  ## interlaced or 16-bit source that had to buffer whole does not come out
  ## sampled differently. With fitContain, pixels outside the fitted
  ## rectangle keep their current contents.
  validateScaledPngTarget(target)

  var
    rowRgbx = newSeq[ColorRGBX](png.width)
    sampler = initRowBoxSampler(
      png.width, png.height, target.width, target.height, fit)

  for y in 0 ..< png.height:
    if not sampler.wantsRow(y):
      continue
    if png.data.len > 0:
      for x in 0 ..< png.width:
        rowRgbx[x] = png.data[x + y * png.width].rgbx()
    else:
      for x in 0 ..< png.width:
        rowRgbx[x] = png.data16[x + y * png.width].toRgba.rgbx()
    sampler.feedRow(target, y, rowRgbx)
  sampler.finish(target)

proc convertToImage*(
  png: Png, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Converts a PNG into an Image scaled to the requested dimensions.
  validateScaledPngTarget(width, height)
  result = newImage(width, height)
  png.fillImage(result, fit)

proc decodePngDimensions*(
  data: pointer, len: int
): ImageDimensions {.raises: [PixieError].} =
  ## Decodes the PNG dimensions.
  if len < (8 + (8 + 13 + 4) + 4): # Magic bytes + IHDR + IEND
    failInvalid()

  let data = cast[ptr UncheckedArray[uint8]](data)

  # PNG file signature
  let signature = cast[array[8, uint8]](data.readUint64(0))
  if signature != pngSignature:
    failInvalid()

  # First chunk must be IHDR
  if data.readUint32(8).swap() != 13 or data.readStr(12, 4) != "IHDR":
    failInvalid()

  let header = decodeHeader(data[16].addr)
  result.width = header.width
  result.height = header.height

proc decodePngDimensions*(
  data: string
): ImageDimensions {.inline, raises: [PixieError].} =
  ## Decodes the PNG dimensions.
  decodePngDimensions(data.cstring, data.len)

type PngStructure = object
  header: PngHeader
  palette: seq[ColorRGB]
  transparency: string
  idats: seq[(int, int)]

proc streamingRowOverheadBytes(header: PngHeader): int64 =
  ## Fixed working memory for a streamed non-interlaced decode: zippy's
  ## inflate window plus the previous/current row buffers.
  3 * scanlineBytes(header.width, header).int64 + 66_000

proc checkDecodeBudget(header: PngHeader, planBytes: int64) =
  if overDecodeBudget(planBytes):
    raise newException(PixieError,
      "PNG decode of " & $header.width & "x" & $header.height &
      " needs " & $(planBytes div 1024) &
      "K of decode buffers, over the " &
      $(decodeBudgetBytes() div 1024) & "K memory budget"
    )

proc checkFullDecodeBudget(header: PngHeader) =
  ## Non-interlaced images stream scanlines out of the inflate window, so
  ## the peak is the pixel seq plus a fixed overhead; interlaced images
  ## still inflate and unfilter whole-image scanline buffers.
  let
    pixels = header.width.int64 * header.height.int64
    pixelBytes = pixels * (if header.bitDepth == 16: 8 else: 4)
    planBytes =
      if header.interlaceMethod == 0:
        pixelBytes + header.streamingRowOverheadBytes
      else:
        let scanlines = scanlineBytes(header.width, header).int64 *
          header.height.int64 + header.height.int64
        pixelBytes + 2 * scanlines
  checkDecodeBudget(header, planBytes)

proc parsePngStructure(
  data: ptr UncheckedArray[uint8], len: int
): PngStructure {.raises: [PixieError].} =
  ## Validates the PNG signature and every chunk (including CRCs) and
  ## collects the header, palette, transparency and IDAT locations without
  ## decoding any image data.
  if len < (8 + (8 + 13 + 4) + 4): # Magic bytes + IHDR + IEND
    failInvalid()

  # PNG file signature
  let signature = cast[array[8, uint8]](data.readUint64(0))
  if signature != pngSignature:
    failInvalid()

  var
    pos = 8 # After signature
    counts = ChunkCounts()
    header: PngHeader
    palette: seq[ColorRGB]
    transparency: string
    idats: seq[(int, int)]
    prevChunkType: string

  # First chunk must be IHDR
  if data.readUint32(pos).swap() != 13 or
    data.readStr(pos + 4, 4) != "IHDR":
    failInvalid()
  inc(pos, 8)
  header = decodeHeader(data[pos].addr)
  prevChunkType = "IHDR"
  inc(pos, 13)

  let headerCrc = crc32(data[pos - 17].addr, 17)
  if headerCrc != data.readUint32(pos).swap():
    failCRC()
  inc(pos, 4) # CRC

  while true:
    if pos + 8 > len:
      failInvalid()

    let
      chunkLen = data.readUint32(pos).swap().int
      chunkType = data.readStr(pos + 4, 4)
    inc(pos, 8)

    if chunkLen > high(int32).int:
      failInvalid()

    if pos + chunkLen + 4 > len:
      failInvalid()

    case chunkType:
    of "IHDR":
      failInvalid()
    of "PLTE":
      inc counts.PLTE
      if counts.PLTE > 1 or counts.IDAT > 0 or counts.tRNS > 0:
        failInvalid()
      palette = decodePalette(data[pos].addr, chunkLen)
    of "tRNS":
      inc counts.tRNS
      if counts.tRNS > 1 or counts.IDAT > 0:
        failInvalid()
      transparency = data.readStr(pos, chunkLen)
      case header.colorType:
      of 0:
        if transparency.len != 2:
          failInvalid()
      of 2:
        if transparency.len != 6:
          failInvalid()
      of 3:
        if transparency.len > palette.len:
          failInvalid()
      else:
        failInvalid()
    of "IDAT":
      inc counts.IDAT
      if counts.IDAT > 1 and prevChunkType != "IDAT":
        failInvalid()
      if header.colorType == 3 and counts.PLTE == 0:
        failInvalid()
      idats.add((pos, chunkLen))
    of "IEND":
      if chunkLen != 0:
        failInvalid()
    else:
      if (chunkType.readUint8(0) and 0b00100000) == 0:
        raise newException(
          PixieError, "Unrecognized PNG critical chunk " & chunkType
        )

    inc(pos, chunkLen)

    let chunkCrc = crc32(data[pos - chunkLen - 4].addr, chunkLen + 4)
    if chunkCrc != data.readUint32(pos).swap():
      failCRC()
    inc(pos, 4) # CRC

    prevChunkType = chunkType

    if pos == len or prevChunkType == "IEND":
      break

  if prevChunkType != "IEND":
    failInvalid()

  PngStructure(
    header: header,
    palette: palette,
    transparency: transparency,
    idats: idats
  )

proc decodeWholePng(
  data: ptr UncheckedArray[uint8], structure: PngStructure
): Png {.raises: [PixieError].} =
  let header = structure.header

  checkFullDecodeBudget(header)

  result = Png()
  result.width = header.width
  result.height = header.height
  result.channels = 4
  result.bitDepth = header.bitDepth.int
  if header.bitDepth == 16:
    result.data16 = decodeImageData16(
      data, header, structure.transparency, structure.idats
    )
  else:
    result.data = decodeImageData(
      data, header, structure.palette, structure.transparency, structure.idats
    )

proc decodePng*(data: pointer, len: int): Png {.raises: [PixieError].} =
  ## Decodes the PNG data.
  let data = cast[ptr UncheckedArray[uint8]](data)
  decodeWholePng(data, parsePngStructure(data, len))

proc decodePng*(data: string): Png {.inline, raises: [PixieError].} =
  ## Decodes the PNG data.
  decodePng(data.cstring, data.len)

proc canStreamScaled(header: PngHeader): bool {.inline.} =
  # Interlaced rows arrive out of order and 16-bit rows would need their own
  # sampling path; both are rare, so they take the buffered fallback.
  header.interlaceMethod == 0 and header.bitDepth != 16

proc decodePngScaledIntoStreaming(
  structure: PngStructure,
  target: Image,
  fit: ScaledDecodeFit,
  inflate: InflateRunProc
) {.raises: [PixieError].} =
  ## Folds scanlines into the target as they stream out of the inflate
  ## window, through the shared row box sampler: downscales are area
  ## filtered (nearest decimation swallowed thin strokes — an XKCD comic's
  ## letter stems vanished into a contain fit), 1:1 and upscale axes are
  ## byte-identical to the nearest pick this replaced. Peak memory: one row
  ## of pixels in two forms plus two target-width accumulator rows — the
  ## full-size pixel buffer is never allocated.
  let header = structure.header

  checkDecodeBudget(header,
    header.streamingRowOverheadBytes + header.width.int64 * 8 +
    target.width.int64 * 4 * 8 * 2)

  var
    rowPixels = newSeq[ColorRGBA](header.width)
    rowRgbx = newSeq[ColorRGBX](header.width)
    sampler = initRowBoxSampler(
      header.width, header.height, target.width, target.height, fit)

  let onRow = proc (y: int, row: seq[uint8]) {.gcsafe, raises: [PixieError].} =
    if not sampler.wantsRow(y):
      return # Outside the fitted crop; skip the pixel conversion too
    rowPixels.writePixels(
      header, structure.palette, structure.transparency, row,
      header.width, 1, 0, 0, 1, 1
    )
    for i in 0 ..< header.width:
      rowRgbx[i] = rowPixels[i].rgbx()
    sampler.feedRow(target, y, rowRgbx)

  streamRows(header, onRow, inflate)
  sampler.finish(target)

proc decodePngScaledIntoStreaming(
  idatSegments: seq[InflateSegment],
  structure: PngStructure,
  target: Image,
  fit: ScaledDecodeFit
) {.raises: [PixieError].} =
  ## The streaming scaled decode over IDAT chunks resident in memory.
  if idatSegments.len == 0:
    failInvalid()
  decodePngScaledIntoStreaming(structure, target, fit,
    proc (onData: InflateOnData) {.gcsafe, raises: [PixieError].} =
      uncompressStreamZlib(onData, idatSegments)
  )

proc decodePngScaled*(
  data: pointer, len, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Decodes the PNG data into an Image scaled to the requested dimensions.
  validateScaledPngTarget(width, height)
  let data = cast[ptr UncheckedArray[uint8]](data)
  let structure = parsePngStructure(data, len)
  if structure.header.canStreamScaled:
    result = newImage(width, height)
    decodePngScaledIntoStreaming(idatSlices(data, structure.idats), structure, result, fit)
  else:
    result = decodeWholePng(data, structure).convertToImage(width, height, fit)

proc decodePngScaledInto*(
  data: pointer, len: int, target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Decodes the PNG data into an existing Image. With fitContain, pixels
  ## outside the fitted rectangle keep their current contents.
  validateScaledPngTarget(target)
  let data = cast[ptr UncheckedArray[uint8]](data)
  let structure = parsePngStructure(data, len)
  if structure.header.canStreamScaled:
    decodePngScaledIntoStreaming(idatSlices(data, structure.idats), structure, target, fit)
  else:
    decodeWholePng(data, structure).fillImage(target, fit)

proc decodePngScaled*(
  data: string, width, height: int, fit = fitStretch
): Image {.inline, raises: [PixieError].} =
  ## Decodes the PNG data into an Image scaled to the requested dimensions.
  decodePngScaled(data.cstring, data.len, width, height, fit)

proc decodePngScaledInto*(
  data: string, target: Image, fit = fitStretch
) {.inline, raises: [PixieError].} =
  ## Decodes the PNG data into an existing Image.
  decodePngScaledInto(data.cstring, data.len, target, fit)

proc decodePngScaled*(
  data: var string, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Decodes the PNG data into a scaled Image and releases the source string
  ## afterwards. The streamed decode never holds a full-size pixel buffer,
  ## so releasing the source early no longer matters; it is freed on return
  ## for callers that rely on it.
  result = decodePngScaled(data.cstring, data.len, width, height, fit)
  data = ""
  try:
    GC_fullCollect()
  except Exception:
    discard

proc decodePngScaledInto*(
  data: var string, target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Decodes the PNG data into an existing Image and releases the source
  ## string afterwards.
  decodePngScaledInto(data.cstring, data.len, target, fit)
  data = ""
  try:
    GC_fullCollect()
  except Exception:
    discard

# ------------------------------------------------------------------------
# Segmented sources: decode a PNG whose bytes are spread across several
# non-contiguous buffers (e.g. an HTTP body downloaded in fixed-size chunks
# on a device whose fragmented heap has no room for one contiguous copy).

const pngCrcTable = block:
  var table: array[256, uint32]
  for i in 0 ..< 256:
    var c = i.uint32
    for _ in 0 ..< 8:
      c = if (c and 1) != 0: 0xEDB88320'u32 xor (c shr 1) else: c shr 1
    table[i] = c
  table

proc pngCrcUpdate(crc: uint32, data: openArray[uint8], len: int): uint32 =
  result = crc
  for i in 0 ..< len:
    result = pngCrcTable[(result xor data[i].uint32) and 0xff] xor (result shr 8)

type PngSegmentReader = object
  segments: seq[InflateSegment]
  seg, offset: int # Current segment and offset within it
  pos: int         # Global position
  total: int

proc initPngSegmentReader(segments: openArray[InflateSegment]): PngSegmentReader =
  result.segments = @segments
  for segment in segments:
    result.total += segment.len

proc readBytesCrc(
  r: var PngSegmentReader, dst: ptr UncheckedArray[uint8], len: int,
  crc: var uint32, updateCrc: bool
) =
  ## Reads len bytes across segments into dst (skips when dst is nil),
  ## optionally folding them into crc.
  var remaining = len
  var written = 0
  while remaining > 0:
    if r.seg >= r.segments.len:
      failInvalid()
    let segment = r.segments[r.seg]
    let available = segment.len - r.offset
    if available <= 0:
      inc r.seg
      r.offset = 0
      continue
    let take = min(remaining, available)
    if updateCrc:
      crc = crc.pngCrcUpdate(
        segment.data.toOpenArray(r.offset, r.offset + take - 1), take)
    if dst != nil:
      copyMem(dst[written].addr, segment.data[r.offset].addr, take)
      written += take
    r.offset += take
    r.pos += take
    remaining -= take

proc readBytes(r: var PngSegmentReader, dst: ptr UncheckedArray[uint8], len: int) =
  var crc: uint32
  r.readBytesCrc(dst, len, crc, false)

proc readU32be(r: var PngSegmentReader): uint32 =
  var bytes: array[4, uint8]
  r.readBytes(cast[ptr UncheckedArray[uint8]](bytes[0].addr), 4)
  (bytes[0].uint32 shl 24) or (bytes[1].uint32 shl 16) or
    (bytes[2].uint32 shl 8) or bytes[3].uint32

proc sliceSegments(
  segments: openArray[InflateSegment], start, len: int
): seq[InflateSegment] =
  ## The [start, start+len) global span of the segments, as segment slices.
  var
    remaining = len
    pos = 0
  for segment in segments:
    if remaining == 0:
      break
    let segStart = pos
    pos += segment.len
    if pos <= start:
      continue
    let offset = max(start - segStart, 0)
    let take = min(segment.len - offset, remaining)
    if take > 0:
      result.add(InflateSegment(
        data: cast[ptr UncheckedArray[uint8]](segment.data[offset].addr),
        len: take
      ))
      remaining -= take
  if remaining != 0:
    failInvalid()

proc parsePngStructure(
  segments: openArray[InflateSegment]
): PngStructure {.raises: [PixieError].} =
  ## Segmented mirror of the contiguous parser: validates the signature and
  ## every chunk CRC, collecting the header, palette, transparency and
  ## global IDAT spans without copying the image data anywhere.
  var r = initPngSegmentReader(segments)
  if r.total < (8 + (8 + 13 + 4) + 4): # Magic bytes + IHDR + IEND
    failInvalid()

  var signature: array[8, uint8]
  r.readBytes(cast[ptr UncheckedArray[uint8]](signature[0].addr), 8)
  if signature != pngSignature:
    failInvalid()

  var
    counts = ChunkCounts()
    header: PngHeader
    palette: seq[ColorRGB]
    transparency: string
    idats: seq[(int, int)]
    prevChunkType: string

  # First chunk must be IHDR
  var chunkType: array[4, uint8]
  var crc = 0xffffffff'u32
  if r.readU32be() != 13:
    failInvalid()
  r.readBytesCrc(cast[ptr UncheckedArray[uint8]](chunkType[0].addr), 4, crc, true)
  if chunkType != [73'u8, 72, 68, 82]: # "IHDR"
    failInvalid()
  var ihdr: array[13, uint8]
  r.readBytesCrc(cast[ptr UncheckedArray[uint8]](ihdr[0].addr), 13, crc, true)
  header = decodeHeader(ihdr[0].addr)
  prevChunkType = "IHDR"
  if (crc xor 0xffffffff'u32) != r.readU32be():
    failCRC()

  while true:
    if r.pos + 8 > r.total:
      failInvalid()

    let chunkLen = r.readU32be().int
    crc = 0xffffffff'u32
    r.readBytesCrc(cast[ptr UncheckedArray[uint8]](chunkType[0].addr), 4, crc, true)
    let chunkTypeStr = block:
      var s = newString(4)
      copyMem(s[0].addr, chunkType[0].addr, 4)
      s

    if chunkLen > high(int32).int:
      failInvalid()

    if r.pos + chunkLen + 4 > r.total:
      failInvalid()

    case chunkTypeStr:
    of "IHDR":
      failInvalid()
    of "PLTE":
      inc counts.PLTE
      if counts.PLTE > 1 or counts.IDAT > 0 or counts.tRNS > 0:
        failInvalid()
      var paletteBytes = newSeq[uint8](chunkLen)
      if chunkLen > 0:
        r.readBytesCrc(
          cast[ptr UncheckedArray[uint8]](paletteBytes[0].addr),
          chunkLen, crc, true)
      palette = decodePalette(
        if chunkLen > 0: paletteBytes[0].addr else: nil, chunkLen)
    of "tRNS":
      inc counts.tRNS
      if counts.tRNS > 1 or counts.IDAT > 0:
        failInvalid()
      transparency = newString(chunkLen)
      if chunkLen > 0:
        r.readBytesCrc(
          cast[ptr UncheckedArray[uint8]](transparency[0].addr),
          chunkLen, crc, true)
      case header.colorType:
      of 0:
        if transparency.len != 2:
          failInvalid()
      of 2:
        if transparency.len != 6:
          failInvalid()
      of 3:
        if transparency.len > palette.len:
          failInvalid()
      else:
        failInvalid()
    of "IDAT":
      inc counts.IDAT
      if counts.IDAT > 1 and prevChunkType != "IDAT":
        failInvalid()
      if header.colorType == 3 and counts.PLTE == 0:
        failInvalid()
      idats.add((r.pos, chunkLen))
      r.readBytesCrc(nil, chunkLen, crc, true)
    of "IEND":
      if chunkLen != 0:
        failInvalid()
    else:
      if (chunkType[0] and 0b00100000) == 0:
        raise newException(
          PixieError, "Unrecognized PNG critical chunk " & chunkTypeStr
        )
      r.readBytesCrc(nil, chunkLen, crc, true)

    if (crc xor 0xffffffff'u32) != r.readU32be():
      failCRC()

    prevChunkType = chunkTypeStr

    if r.pos == r.total or prevChunkType == "IEND":
      break

  if prevChunkType != "IEND":
    failInvalid()

  PngStructure(
    header: header,
    palette: palette,
    transparency: transparency,
    idats: idats
  )

proc coalesceSegments(segments: openArray[InflateSegment]): string =
  var total = 0
  for segment in segments:
    total += segment.len
  result = newString(total)
  var pos = 0
  for segment in segments:
    if segment.len > 0:
      copyMem(result[pos].addr, segment.data[0].addr, segment.len)
      pos += segment.len

proc decodePngScaledInto*(
  segments: openArray[InflateSegment], target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Decodes a PNG spread across non-contiguous buffers into an existing
  ## Image. Non-interlaced ≤8-bit images stream scanlines straight out of
  ## the inflate window without ever assembling a contiguous copy of the
  ## file or a full-size pixel buffer; interlaced/16-bit images fall back
  ## to coalescing and the buffered decode.
  validateScaledPngTarget(target)
  let structure = parsePngStructure(segments)
  if structure.header.canStreamScaled:
    var idatSegments: seq[InflateSegment]
    for (start, len) in structure.idats:
      idatSegments.add(sliceSegments(segments, start, len))
    decodePngScaledIntoStreaming(idatSegments, structure, target, fit)
  else:
    var data = coalesceSegments(segments)
    decodePng(data.cstring, data.len).fillImage(target, fit)

# ------------------------------------------------------------------------
# Pull sources: decode a PNG read sequentially from a callback (e.g. a
# download spilled to disk on a device without the memory to buffer it).
# Peak memory is one small read buffer plus the fixed streaming decode
# overhead; the compressed file is never held in memory.

type PngSourceProc* = ImageSourceProc
  ## Pull callback for streamed decodes: fill `dst` with up to `maxBytes`
  ## sequential input bytes, returning how many were written (<= 0 on EOF
  ## or read error — the decode then fails with a catchable PixieError).

const pngStreamReadBytes = 16384

type PngStreamReader = object
  source: PngSourceProc
  totalLen: int # <= 0 when unknown
  pos: int

proc readExactCrc(
  r: var PngStreamReader, dst: ptr UncheckedArray[uint8], len: int,
  crc: var uint32, updateCrc: bool
) =
  var done = 0
  while done < len:
    let got = r.source(dst[done].addr, len - done)
    if got <= 0:
      failInvalid()
    if updateCrc:
      crc = crc.pngCrcUpdate(dst.toOpenArray(done, done + got - 1), got)
    done += got
    r.pos += got

proc readU32be(r: var PngStreamReader): uint32 =
  var
    bytes: array[4, uint8]
    crc: uint32
  r.readExactCrc(cast[ptr UncheckedArray[uint8]](bytes[0].addr), 4, crc, false)
  (bytes[0].uint32 shl 24) or (bytes[1].uint32 shl 16) or
    (bytes[2].uint32 shl 8) or bytes[3].uint32

proc decodePngStreamScaledInto*(
  source: PngSourceProc, totalLen: int, target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Decodes a PNG pulled sequentially from `source` (e.g. a file on disk)
  ## into an existing Image, sampling scanlines as they stream out of the
  ## inflate window. Peak memory: one small read buffer, one source row of
  ## RGBA pixels and the fixed inflate overhead — neither the compressed
  ## file nor a full-size pixel buffer is ever resident. Non-interlaced
  ## images up to 8 bits per channel only; interlaced/16-bit PNGs raise a
  ## PixieError since they would need the whole-file buffering this decoder
  ## exists to avoid. Chunk CRCs are validated as they stream by; chunks
  ## after the image data are not read. Pass the input size as totalLen for
  ## chunk bounds checks, or <= 0 when unknown.
  validateScaledPngTarget(target)
  if source == nil:
    failInvalid()

  var
    r = PngStreamReader(source: source, totalLen: totalLen)
    scratchCrc: uint32
    signature: array[8, uint8]
  r.readExactCrc(
    cast[ptr UncheckedArray[uint8]](signature[0].addr), 8, scratchCrc, false)
  if signature != pngSignature:
    failInvalid()

  # First chunk must be IHDR
  var
    chunkType: array[4, uint8]
    crc = 0xffffffff'u32
  if r.readU32be() != 13:
    failInvalid()
  r.readExactCrc(
    cast[ptr UncheckedArray[uint8]](chunkType[0].addr), 4, crc, true)
  if chunkType != [73'u8, 72, 68, 82]: # "IHDR"
    failInvalid()
  var ihdr: array[13, uint8]
  r.readExactCrc(cast[ptr UncheckedArray[uint8]](ihdr[0].addr), 13, crc, true)
  let header = decodeHeader(ihdr[0].addr)
  if (crc xor 0xffffffff'u32) != r.readU32be():
    failCRC()

  if not header.canStreamScaled:
    raise newException(PixieError,
      "Streamed PNG decode supports non-interlaced images up to 8 bits per channel"
    )

  var
    counts = ChunkCounts()
    palette: seq[ColorRGB]
    transparency: string
    buffer = newSeq[uint8](pngStreamReadBytes)
    idatRemaining = -1

  # Walk the metadata chunks up to the first IDAT
  while idatRemaining < 0:
    if r.totalLen > 0 and r.pos + 8 > r.totalLen:
      failInvalid()
    let chunkLen = r.readU32be().int
    if chunkLen > high(int32).int:
      failInvalid()
    if r.totalLen > 0 and r.pos + 4 + chunkLen + 4 > r.totalLen:
      failInvalid()
    crc = 0xffffffff'u32
    r.readExactCrc(
      cast[ptr UncheckedArray[uint8]](chunkType[0].addr), 4, crc, true)
    let chunkTypeStr = block:
      var s = newString(4)
      copyMem(s[0].addr, chunkType[0].addr, 4)
      s

    case chunkTypeStr:
    of "IHDR":
      failInvalid()
    of "PLTE":
      inc counts.PLTE
      if counts.PLTE > 1 or counts.tRNS > 0:
        failInvalid()
      if chunkLen == 0 or chunkLen > 768:
        failInvalid()
      var paletteBytes = newSeq[uint8](chunkLen)
      r.readExactCrc(
        cast[ptr UncheckedArray[uint8]](paletteBytes[0].addr),
        chunkLen, crc, true)
      palette = decodePalette(paletteBytes[0].addr, chunkLen)
    of "tRNS":
      inc counts.tRNS
      if counts.tRNS > 1 or chunkLen > 768:
        failInvalid()
      transparency = newString(chunkLen)
      if chunkLen > 0:
        r.readExactCrc(
          cast[ptr UncheckedArray[uint8]](transparency[0].addr),
          chunkLen, crc, true)
      case header.colorType:
      of 0:
        if transparency.len != 2:
          failInvalid()
      of 2:
        if transparency.len != 6:
          failInvalid()
      of 3:
        if transparency.len > palette.len:
          failInvalid()
      else:
        failInvalid()
    of "IDAT":
      if header.colorType == 3 and counts.PLTE == 0:
        failInvalid()
      idatRemaining = chunkLen
    of "IEND":
      failInvalid() # No image data
    else:
      if (chunkType[0] and 0b00100000) == 0:
        raise newException(
          PixieError, "Unrecognized PNG critical chunk " & chunkTypeStr
        )
      # Skip ancillary chunk payloads through the read buffer
      var remaining = chunkLen
      while remaining > 0:
        let take = min(remaining, buffer.len)
        r.readExactCrc(
          cast[ptr UncheckedArray[uint8]](buffer[0].addr), take, crc, true)
        remaining -= take

    if idatRemaining < 0:
      if (crc xor 0xffffffff'u32) != r.readU32be():
        failCRC()

  let structure = PngStructure(
    header: header, palette: palette, transparency: transparency
  )

  # crc currently covers the first IDAT's type bytes; the pull below keeps
  # folding payload bytes into it and verifies at each chunk boundary.
  var idatDone = false
  let pull = proc (): InflateSegment {.gcsafe, raises: [PixieError].} =
    while not idatDone:
      if idatRemaining == 0:
        # IDAT boundary: verify this chunk's CRC, then continue only when
        # the next chunk is another IDAT (they must be consecutive).
        if (crc xor 0xffffffff'u32) != r.readU32be():
          failCRC()
        if r.totalLen > 0 and r.pos + 8 > r.totalLen:
          failInvalid()
        let chunkLen = r.readU32be().int
        if chunkLen > high(int32).int:
          failInvalid()
        crc = 0xffffffff'u32
        r.readExactCrc(
          cast[ptr UncheckedArray[uint8]](chunkType[0].addr), 4, crc, true)
        if chunkType != [73'u8, 68, 65, 84]: # "IDAT"
          idatDone = true
          break
        if r.totalLen > 0 and r.pos + chunkLen + 4 > r.totalLen:
          failInvalid()
        idatRemaining = chunkLen
        continue
      let take = min(buffer.len, idatRemaining)
      let got = r.source(buffer[0].addr, take)
      if got <= 0:
        failInvalid()
      crc = crc.pngCrcUpdate(buffer.toOpenArray(0, got - 1), got)
      r.pos += got
      idatRemaining -= got
      return InflateSegment(
        data: cast[ptr UncheckedArray[uint8]](buffer[0].addr), len: got)
    InflateSegment(data: nil, len: 0)

  decodePngScaledIntoStreaming(structure, target, fit,
    proc (onData: InflateOnData) {.gcsafe, raises: [PixieError].} =
      uncompressStreamZlib(onData, pull)
  )

  # The inflater stops at the zlib stream's end, usually leaving the last
  # IDAT's tail (the adler32 trailer) unread. Drain it and verify that
  # chunk's CRC too, so a corrupted final IDAT still fails the decode.
  if not idatDone:
    while idatRemaining > 0:
      let take = min(buffer.len, idatRemaining)
      r.readExactCrc(
        cast[ptr UncheckedArray[uint8]](buffer[0].addr), take, crc, true)
      idatRemaining -= take
    if (crc xor 0xffffffff'u32) != r.readU32be():
      failCRC()

proc encodePng*(
  width, height, channels: int, data: pointer, len: int
): string {.raises: [PixieError].} =
  ## Encodes the image data into the PNG file format.
  ## If data points to RGBA data, it is assumed to be straight alpha.

  if width <= 0 or width > int32.high.int:
    raise newException(PixieError, "Invalid PNG width")

  if height <= 0 or height > int32.high.int:
    raise newException(PixieError, "Invalid PNG height")

  if len != width * height * channels:
    raise newException(PixieError, "Invalid PNG data size")

  let colorType = case channels:
    of 1: 0.char
    of 2: 4.char
    of 3: 2.char
    of 4: 6.char
    else:
      raise newException(PixieError, "Invalid PNG number of channels")

  let data = cast[ptr UncheckedArray[uint8]](data)

  # Add the PNG file signature
  for c in pngSignature:
    result.add(c.char)

  # Add IHDR
  result.addUint32(13.uint32.swap())
  result.add("IHDR")
  result.addUint32(width.uint32.swap())
  result.addUint32(height.uint32.swap())
  result.add(8.char)
  result.add(colorType)
  result.add(0.char)
  result.add(0.char)
  result.add(0.char)
  result.addUint32(crc32(result[result.len - 17].addr, 17).swap())

  # Add IDAT
  # Add room for 1 byte before each row for the filter type.
  var
    filtered = newString(width * height * channels + height)
    upRow = newSeq[uint8](width * channels)
    subRow = newSeq[uint8](width * channels)
    avgRow = newSeq[uint8](width * channels)
  for y in 0 ..< height:
    let rowStart = y * width * channels
    for x in 0 ..< width * channels:
      # Move through the image data byte-by-byte
      let dataPos = rowStart + x
      var left, up: uint8
      if x - channels >= 0:
        left = data[dataPos - channels]
      if y - 1 >= 0:
        up = data[(y - 1) * width * channels + x]
      upRow[x] = data[dataPos] - up.uint8
      subRow[x] = data[dataPos] - left.uint8
      let avg = ((left.int + up.int) div 2).uint8
      avgRow[x] = data[dataPos] - avg

    var upRowSum, subRowSum, avgRowSum: uint64
    for i in 0 ..< upRow.len:
      upRowSum += upRow[i]
      subRowSum += subRow[i]
      avgRowSum += avgRow[i]

    let minRowSum = min(min(upRowSum, subRowSum), avgRowSum)

    if upRowSum == minRowSum:
      filtered[rowStart + y] = 2.char # Up filter type
      copyMem(
        filtered[rowStart + y + 1].addr,
        upRow[0].addr,
        upRow.len
      )
    elif subRowSum == minRowSum:
      filtered[rowStart + y] = 1.char # Sub filter type
      copyMem(
        filtered[rowStart + y + 1].addr,
        subRow[0].addr,
        subRow.len
      )
    else:
      filtered[rowStart + y] = 3.char # Average filter type
      copyMem(
        filtered[rowStart + y + 1].addr,
        avgRow[0].addr,
        avgRow.len
      )

  let compressed =
    try:
      compress(filtered, DefaultCompression, dfZlib)
    except ZippyError:
      raise newException(
        PixieError, "Unexpected error compressing PNG image data"
      )
  if compressed.len > int32.high.int:
    raise newException(PixieError, "Compressed PNG image data too large")

  result.addUint32(compressed.len.uint32.swap())
  result.add("IDAT")
  result.add(compressed)
  result.addUint32(crc32(
    result[result.len - compressed.len - 4].addr,
    compressed.len + 4
  ).swap())

  # Add IEND
  result.addUint32(0)
  result.add("IEND")
  result.addUint32(crc32(result[result.len - 4].addr, 4).swap())

proc encodePng*(png: Png): string {.raises: [PixieError].} =
  if png.data.len > 0:
    encodePng(png.width, png.height, 4, png.data[0].addr, png.data.len * 4)
  elif png.data16.len > 0:
    var data = newSeq[ColorRGBA](png.data16.len)
    for i, color in png.data16:
      data[i] = color.toRgba()
    encodePng(png.width, png.height, 4, data[0].addr, data.len * 4)
  else:
    raise newException(PixieError, "PNG has no data")

proc encodePng*(image: Image): string {.raises: [PixieError].} =
  ## Encodes the image data into the PNG file format.
  if image.dataLen == 0:
    raise newException(
      PixieError,
      "Image has no data (are height and width 0?)"
    )
  var copy = image.toContiguousSeq()
  copy.toStraightAlpha()
  encodePng(image.width, image.height, 4, copy[0].addr, copy.len * 4)

when defined(release):
  {.pop.}
