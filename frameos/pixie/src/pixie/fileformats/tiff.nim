import chroma, flatty/binny, ../common, ../images, ../internal,
    zippy, zippy/inflate

const
  tiffSignatures* = [
    [0x4d.uint8, 0x4d, 0x00, 0x2a],
    [0x49.uint8, 0x49, 0x2a, 0x00]
  ]

  ImageWidthTag = 0x0100.uint16
  ImageLengthTag = 0x0101.uint16
  BitsPerSampleTag = 0x0102.uint16
  CompressionTag = 0x0103.uint16
  PhotometricInterpretationTag = 0x0106.uint16
  StripOffsetsTag = 0x0111.uint16
  RowsPerStripTag = 0x0116.uint16
  StripByteCountsTag = 0x0117.uint16
  PredictorTag = 0x013d.uint16
  ColorMapTag = 0x0140.uint16
  TileWidthTag = 0x0142.uint16
  TileLengthTag = 0x0143.uint16
  TileOffsetsTag = 0x0144.uint16
  TileByteCountsTag = 0x0145.uint16
  SampleFormatTag = 0x0153.uint16

  knownTags = [
    ImageWidthTag,
    ImageLengthTag,
    BitsPerSampleTag,
    CompressionTag,
    PhotometricInterpretationTag,
    StripOffsetsTag,
    RowsPerStripTag,
    StripByteCountsTag,
    PredictorTag,
    ColorMapTag,
    TileWidthTag,
    TileLengthTag,
    TileOffsetsTag,
    TileByteCountsTag,
    SampleFormatTag
  ]

type
  TiffDataFormat* = enum
    tiffRgba
    tiffGray16
    tiffGrayInt16
    tiffFloat32

  Tiff* = ref object
    width*, height*: int
    dataFormat*: TiffDataFormat
    data*: seq[ColorRGBA]
    dataFloat32*: seq[float32]
    dataGray16*: seq[uint16]
    dataGrayInt16*: seq[int16]

template failInvalid(reason = "") =
  let msg =
    if reason.len > 0:
      "Invalid TIFF buffer, unable to load: " & reason
    else:
      "Invalid TIFF buffer, unable to load"
  raise newException(PixieError, msg)

proc decodeTiffDimensions*(data: string): ImageDimensions =
  ## Decodes a TIFF's dimensions from memory without decoding the image data.
  if data.len < 8:
    failInvalid()

  var
    pos: int
    isBigEndian: bool

  let signature = cast[array[4, uint8]](data.readUint32(0))
  if signature == tiffSignatures[0]:
    isBigEndian = true
  elif signature == tiffSignatures[1]:
    discard
  else:
    failInvalid()

  pos = 4

  let ifdOffset = data.readUint32(pos).maybeSwap(isBigEndian).int
  pos = ifdOffset # Move to the first IFD offset.

  if pos + 2 > data.len:
    failInvalid()

  let numEntries = data.readUint16(pos).maybeSwap(isBigEndian).int
  pos += 2

  for _ in 0 ..< numEntries:
    if pos + 12 > data.len:
      failInvalid()

    let
      tag = data.readUint16(pos + 0).maybeSwap(isBigEndian)
      fieldType = data.readUint16(pos + 2).maybeSwap(isBigEndian)
      numValues = data.readUint32(pos + 4).maybeSwap(isBigEndian).int
      valueOrOffset = pos + 8

    pos += 12

    if tag notin [ImageWidthTag, ImageLengthTag]:
      continue

    if numValues != 1:
      failInvalid()

    let bytesPerValue =
      case fieldType:
      of 1:
        1
      of 3:
        2
      of 4:
        4
      else:
        raise newException(PixieError, "Unsupported field type " & $fieldType)

    let valueOffset =
      if numValues * bytesPerValue <= 4:
        valueOrOffset
      else:
        data.readUint32(valueOrOffset).maybeSwap(isBigEndian).int

    let value =
      case fieldType:
      of 1:
        if valueOffset + 1 > data.len:
          failInvalid()
        data.readUint8(valueOffset).int
      of 3:
        if valueOffset + 2 > data.len:
          failInvalid()
        data.readUint16(valueOffset).maybeSwap(isBigEndian).int
      of 4:
        if valueOffset + 4 > data.len:
          failInvalid()
        data.readUint32(valueOffset).maybeSwap(isBigEndian).int
      else:
        raise newException(PixieError, "Unsupported field type " & $fieldType)

    case tag:
    of ImageWidthTag:
      result.width = value
    of ImageLengthTag:
      result.height = value
    else:
      discard

    if result.width > 0 and result.height > 0:
      return

  failInvalid()

proc readTiffDimensions*(filePath: string): ImageDimensions =
  ## Decodes a TIFF's dimensions from a file without decoding the image data.
  try:
    decodeTiffDimensions(readFile(filePath))
  except IOError as e:
    raise newException(PixieError, e.msg, e)

proc decodeTiff*(data: string): Tiff =
  if data.len < 8:
    failInvalid()

  result = Tiff()

  var
    pos: int
    isBigEndian: bool
    bitsPerSample: seq[int]
    sampleFormat = 1 # TIFF defaults to unsigned integer samples.
    compression: int
    photometricInterpretation: int
    stripOffsets, stripByteCounts: seq[int]
    rowsPerStrip: int
    tileOffsets, tileByteCounts: seq[int]
    tileWidth, tileLength: int
    predictor = 1
    colorMap: seq[ColorRGBA]

  let signature = cast[array[4, uint8]](data.readUint32(0))
  if signature == tiffSignatures[0]:
    isBigEndian = true
  elif signature == tiffSignatures[1]:
    discard
  else:
    failInvalid()

  pos = 4

  let ifdOffset = data.readUint32(pos).maybeSwap(isBigEndian).int
  pos = ifdOffset # Move to the first IFD offset.

  if pos + 2 > data.len:
    failInvalid()

  let numEntries = data.readUint16(pos).maybeSwap(isBigEndian).int
  pos += 2

  for _ in 0 ..< numEntries:
    if pos + 12 > data.len:
      failInvalid()

    let
      tag = data.readUint16(pos + 0).maybeSwap(isBigEndian)
      fieldType = data.readUint16(pos + 2).maybeSwap(isBigEndian)
      numValues = data.readUint32(pos + 4).maybeSwap(isBigEndian).int
      valueOrOffset = pos + 8

    pos += 12

    if tag notin knownTags:
      continue

    let bytesPerValue =
      case fieldType:
      of 1:
        1
      of 2:
        1
      of 3:
        2
      of 4:
        4
      else:
        raise newException(PixieError, "Unsupported field type " & $fieldType)

    var valueOffset =
      if numValues * bytesPerValue <= 4:
        valueOrOffset
      else:
        data.readUint32(valueOrOffset).maybeSwap(isBigEndian).int

    proc readValue(offset: int): int =
      case fieldType:
      of 1:
        if offset + 1 > data.len:
          failInvalid()
        data.readUint8(offset).int
      of 3:
        if offset + 2 > data.len:
          failInvalid()
        data.readUint16(offset).maybeSwap(isBigEndian).int
      of 4:
        if offset + 4 > data.len:
          failInvalid()
        data.readUint32(offset).maybeSwap(isBigEndian).int
      else:
        raise newException(PixieError, "Unsupported field type " & $fieldType)

    case tag:
    of ImageWidthTag:
      if numValues != 1:
        failInvalid()
      result.width = readValue(valueOffset)
    of ImageLengthTag:
      if numValues != 1:
        failInvalid()
      result.height = readValue(valueOffset)
    of BitsPerSampleTag:
      for _ in 0 ..< numValues:
        bitsPerSample.add(readValue(valueOffset))
        valueOffset += bytesPerValue
    of CompressionTag:
      if numValues != 1:
        failInvalid()
      compression = readValue(valueOffset)
    of PhotometricInterpretationTag:
      if numValues != 1:
        failInvalid()
      photometricInterpretation = readValue(valueOffset)
    of StripOffsetsTag:
      for _ in 0 ..< numValues:
        stripOffsets.add(readValue(valueOffset))
        valueOffset += bytesPerValue
    of RowsPerStripTag:
      if numValues != 1:
        failInvalid()
      rowsPerStrip = readValue(valueOffset)
    of StripByteCountsTag:
      for _ in 0 ..< numValues:
        stripByteCounts.add(readValue(valueOffset))
        valueOffset += bytesPerValue
    of PredictorTag:
      if numValues != 1:
        failInvalid("unsupported predictor count")
      predictor = readValue(valueOffset)
    of ColorMapTag:
      if fieldType != 3:
        failInvalid()
      var values: seq[int]
      for _ in 0 ..< numValues:
        values.add(readValue(valueOffset))
        valueOffset += bytesPerValue
      colorMap.setLen(numValues div 3)
      for i in 0 ..< colorMap.len:
        colorMap[i] = rgba(
          ((values[i].float32 / 65535) * 255).uint8,
          ((values[i + colorMap.len].float32 / 65535) * 255).uint8,
          ((values[i + 2 * colorMap.len].float32 / 65535) * 255).uint8,
          255
        )
    of TileWidthTag:
      if numValues != 1:
        failInvalid("unsupported tile width count")
      tileWidth = readValue(valueOffset)
    of TileLengthTag:
      if numValues != 1:
        failInvalid("unsupported tile length count")
      tileLength = readValue(valueOffset)
    of TileOffsetsTag:
      for _ in 0 ..< numValues:
        tileOffsets.add(readValue(valueOffset))
        valueOffset += bytesPerValue
    of TileByteCountsTag:
      for _ in 0 ..< numValues:
        tileByteCounts.add(readValue(valueOffset))
        valueOffset += bytesPerValue
    of SampleFormatTag:
      if fieldType != 3:
        failInvalid()
      sampleFormat = readValue(valueOffset)
    else:
      discard

  if result.width == 0 or result.height == 0:
    failInvalid("missing width/height")

  if stripOffsets.len != stripByteCounts.len:
    failInvalid("stripOffsets and stripByteCounts length mismatch")
  if tileOffsets.len != tileByteCounts.len:
    failInvalid("tileOffsets and tileByteCounts length mismatch")
  if stripOffsets.len == 0 and tileOffsets.len == 0:
    failInvalid("no strip or tile offsets found")

  if bitsPerSample.len == 0:
    failInvalid("missing bitsPerSample")

  for bits in bitsPerSample:
    if bits notin {8, 16, 32}:
      raise newException(
        PixieError,
        "TIFF bits per sample of " & $bits & " not supported yet"
      )

  # Check the bits per sample are all equal.
  for i in 0 ..< bitsPerSample.len:
    for j in 0 ..< bitsPerSample.len:
      if bitsPerSample[i] != bitsPerSample[j]:
        failInvalid("mixed bitsPerSample values not supported")

  let
    imageWidth = result.width
    imageHeight = result.height
    sampleBytes = bitsPerSample[0] div 8
    samplesPerPixel = bitsPerSample.len
    bytesPerPixel = sampleBytes * samplesPerPixel

  const maxDecodedTiffBytes = 1024 * 1024 * 1024

  proc checkedProduct(a, b: int, label: string): int =
    if a < 0 or b < 0 or (a != 0 and b > high(int) div a):
      failInvalid(label & " overflow")
    result = a * b

  let
    pixelCount = checkedProduct(imageWidth, imageHeight, "image size")
    decodedLen = checkedProduct(pixelCount, bytesPerPixel, "decoded size")

  if decodedLen > maxDecodedTiffBytes:
    failInvalid("decoded image too large")

  var decompressed: string

  proc expectedRowsForStrip(stripIndex: int): int =
    if rowsPerStrip <= 0:
      return imageHeight
    let rowsRemaining = imageHeight - stripIndex * rowsPerStrip
    max(0, min(rowsPerStrip, rowsRemaining))

  proc inflateData(offset, byteCount: int): string =
    if offset + byteCount > data.len:
      failInvalid("compressed data out of bounds")

    try:
      if compression == 8:
        result = uncompress(
          cast[pointer](data[offset].unsafeAddr),
          byteCount,
          dfZlib
        )
      else:
        inflate(
          result,
          cast[ptr UncheckedArray[uint8]](data[offset].unsafeAddr),
          byteCount,
          0
        )
    except CatchableError as e:
      raise newException(
        PixieError,
        "Invalid TIFF buffer, unable to load: " & e.msg,
        e
      )

  proc applyPredictor(buffer: var string, rowWidth, rows: int) =
    if predictor == 1:
      return

    let bytesPerPixelLocal = sampleBytes * samplesPerPixel
    case predictor
    of 2:
      for row in 0 ..< rows:
        let rowStart = row * rowWidth * bytesPerPixelLocal
        for x in 1 ..< rowWidth:
          let pixelStart = rowStart + x * bytesPerPixelLocal
          let prevPixelStart = pixelStart - bytesPerPixelLocal
          for b in 0 ..< bytesPerPixelLocal:
            let reconstructed = (
              cast[uint8](buffer[pixelStart + b]) +
              cast[uint8](buffer[prevPixelStart + b])
            ).uint8
            buffer[pixelStart + b] = cast[char](reconstructed)
    of 3:
      let rowBytes = rowWidth * bytesPerPixelLocal
      var restored = newString(rowBytes)
      for row in 0 ..< rows:
        let rowStart = row * rowBytes
        var cp = rowStart
        var count = rowBytes
        if samplesPerPixel == 1:
          while count > 1:
            let reconstructed = (
              cast[uint8](buffer[cp + 1]) +
              cast[uint8](buffer[cp])
            ).uint8
            buffer[cp + 1] = cast[char](reconstructed)
            inc cp
            dec count
        else:
          while count > samplesPerPixel:
            for _ in 0 ..< samplesPerPixel:
              let reconstructed = (
                cast[uint8](buffer[cp + samplesPerPixel]) +
                cast[uint8](buffer[cp])
              ).uint8
              buffer[cp + samplesPerPixel] = cast[char](reconstructed)
              inc cp
            dec count, samplesPerPixel
        for x in 0 ..< rowWidth:
          for plane in 0 ..< bytesPerPixelLocal:
            let
              sampleIndex = plane div sampleBytes
              byteIndex = plane mod sampleBytes
              mappedByteIndex =
                if isBigEndian:
                  byteIndex
                else:
                  sampleBytes - 1 - byteIndex
              mappedPlane = sampleIndex * sampleBytes + mappedByteIndex
            restored[x * bytesPerPixelLocal + plane] =
              buffer[rowStart + mappedPlane * rowWidth + x]
        if rowBytes > 0:
          copyMem(buffer[rowStart].addr, restored[0].addr, rowBytes)
    else:
      failInvalid("unsupported TIFF predictor " & $predictor)

  proc readStrips() =
    decompressed.setLen(decodedLen)
    var dstOffset = 0
    for i, offset in stripOffsets:
      let
        byteCount = stripByteCounts[i]
        rows = expectedRowsForStrip(i)
        expectedLen = imageWidth * rows * bytesPerPixel

      if offset + byteCount > data.len:
        failInvalid("strip " & $i & " offset+byteCount out of bounds")

      var stripData =
        if compression == 1:
          data.substr(offset, offset + byteCount - 1)
        else:
          inflateData(offset, byteCount)

      if stripData.len < expectedLen:
        failInvalid(
          "strip " & $i & " decompressed too short, expected " &
          $expectedLen & " got " & $stripData.len
        )

      applyPredictor(stripData, imageWidth, rows)

      if dstOffset + expectedLen > decompressed.len:
        failInvalid("strip " & $i & " dstOffset overflow")

      if expectedLen > 0:
        copyMem(decompressed[dstOffset].addr, stripData[0].addr, expectedLen)
      dstOffset += expectedLen

    if dstOffset != decompressed.len:
      failInvalid(
        "inflated byte count mismatch, expected " & $decompressed.len &
        " got " & $dstOffset
      )

  proc readTiles() =
    if tileWidth <= 0 or tileLength <= 0:
      failInvalid("missing tile dimensions")

    decompressed.setLen(decodedLen)
    let tilesAcross = (imageWidth + tileWidth - 1) div tileWidth
    for i, offset in tileOffsets:
      let
        byteCount = tileByteCounts[i]
        tileX = i mod tilesAcross
        tileY = i div tilesAcross
        copyWidth = min(tileWidth, imageWidth - tileX * tileWidth)
        copyHeight = min(tileLength, imageHeight - tileY * tileLength)
        expectedLen = tileWidth * tileLength * bytesPerPixel

      if offset + byteCount > data.len:
        failInvalid("tile " & $i & " offset+byteCount out of bounds")

      var tileData =
        if compression == 1:
          data.substr(offset, offset + byteCount - 1)
        else:
          inflateData(offset, byteCount)

      if tileData.len < expectedLen:
        failInvalid(
          "tile " & $i & " decompressed too short, expected " &
          $expectedLen & " got " & $tileData.len
        )

      applyPredictor(tileData, tileWidth, tileLength)

      for row in 0 ..< copyHeight:
        let
          srcOffset = row * tileWidth * bytesPerPixel
          dstOffset = (
            (tileY * tileLength + row) * imageWidth + tileX * tileWidth
          ) * bytesPerPixel
        copyMem(
          decompressed[dstOffset].addr,
          tileData[srcOffset].addr,
          copyWidth * bytesPerPixel
        )

  case compression:
  of 1: # No compression
    if tileOffsets.len > 0:
      readTiles()
    else:
      readStrips()
  of 5: # LZW
    raise newException(PixieError, "LZW TIFF not supported yet")
  of 8, 32946: # Adobe Deflate / Deflate
    if tileOffsets.len > 0:
      readTiles()
    else:
      readStrips()
  else:
    raise newException(
      PixieError,
      "TIFF compression " & $compression & " not supported yet"
    )

  proc readSample8(offset: int): uint8 =
    decompressed[offset].uint8

  proc readSample16(offset: int): uint16 =
    decompressed.readUint16(offset).maybeSwap(isBigEndian)

  proc downsample16(value: uint16): uint8 =
    (value div 257).uint8

  result.data.setLen(pixelCount)

  case photometricInterpretation:
  of 1: # BlackIsZero. For bilevel and grayscale images: 0 is imaged as black.
    if bitsPerSample == @[8]:
      result.dataFormat = tiffRgba
      if decompressed.len != result.data.len:
        failInvalid("grayscale decompressed length mismatch")
      for i in 0 ..< result.data.len:
        let gray = readSample8(i)
        result.data[i] = rgba(gray, gray, gray, 255)

    elif bitsPerSample == @[16]:
      result.data.setLen(0)
      if sampleFormat == 1:
        result.dataFormat = tiffGray16
        result.dataGray16.setLen(pixelCount)
        for i in 0 ..< result.dataGray16.len:
          result.dataGray16[i] = readSample16(i * 2)
      elif sampleFormat == 2:
        result.dataFormat = tiffGrayInt16
        result.dataGrayInt16.setLen(pixelCount)
        for i in 0 ..< result.dataGrayInt16.len:
          result.dataGrayInt16[i] = cast[int16](readSample16(i * 2))
      else:
        raise newException(
          PixieError,
          "TIFF sample format " & $sampleFormat & " not supported yet"
        )

    elif bitsPerSample == @[32]:
      if sampleFormat != 3:
        raise newException(
          PixieError,
          "TIFF sample format " & $sampleFormat & " not supported yet"
        )
      result.dataFormat = tiffFloat32
      result.data.setLen(0)
      result.dataFloat32.setLen(pixelCount)
      for i in 0 ..< result.dataFloat32.len:
        let bits = decompressed.readUint32(i * 4).maybeSwap(isBigEndian)
        result.dataFloat32[i] = cast[float32](bits)

    else:
      raise newException(
        PixieError,
        "BlackIsZero TIFF only 8, 16 and 32 bits supported"
      )

  of 2: # RGB
    result.dataFormat = tiffRgba
    if bitsPerSample == @[8, 8, 8]:
      if decompressed.len div 3 != result.data.len:
        failInvalid("RGB decompressed length mismatch")
      for i in 0 ..< result.data.len:
        let decompressedIdx = i * 3
        result.data[i] = rgba(
          readSample8(decompressedIdx + 0),
          readSample8(decompressedIdx + 1),
          readSample8(decompressedIdx + 2),
          255
        )
    elif bitsPerSample == @[8, 8, 8, 8]:
      if decompressed.len div 4 != result.data.len:
        failInvalid("RGBA decompressed length mismatch")
      for i in 0 ..< result.data.len:
        let decompressedIdx = i * 4
        result.data[i] = rgba(
          readSample8(decompressedIdx + 0),
          readSample8(decompressedIdx + 1),
          readSample8(decompressedIdx + 2),
          readSample8(decompressedIdx + 3)
        )
    elif bitsPerSample == @[16, 16, 16]:
      if decompressed.len div 6 != result.data.len:
        failInvalid("16-bit RGB decompressed length mismatch")
      for i in 0 ..< result.data.len:
        let decompressedIdx = i * 6
        result.data[i] = rgba(
          downsample16(readSample16(decompressedIdx + 0)),
          downsample16(readSample16(decompressedIdx + 2)),
          downsample16(readSample16(decompressedIdx + 4)),
          255
        )
    elif bitsPerSample == @[16, 16, 16, 16]:
      if decompressed.len div 8 != result.data.len:
        failInvalid("16-bit RGBA decompressed length mismatch")
      for i in 0 ..< result.data.len:
        let decompressedIdx = i * 8
        result.data[i] = rgba(
          downsample16(readSample16(decompressedIdx + 0)),
          downsample16(readSample16(decompressedIdx + 2)),
          downsample16(readSample16(decompressedIdx + 4)),
          downsample16(readSample16(decompressedIdx + 6))
        )
    else:
      failInvalid("RGB TIFF sample layout not supported")

  of 3: # Color Map
    result.dataFormat = tiffRgba
    if bitsPerSample != @[8]:
      failInvalid("color map TIFF sample layout not supported")
    if decompressed.len != result.data.len:
      failInvalid("color map decompressed length mismatch")
    for i in 0 ..< result.data.len:
      let colorMapIndex = decompressed[i].int
      if colorMapIndex >= colorMap.len:
        failInvalid("color map index out of range")
      result.data[i] = colorMap[colorMapIndex]

  else:
    raise newException(
      PixieError,
      "TIFF photometric interpretation " & $photometricInterpretation &
      " not supported yet"
    )

proc convertToImage*(tiff: Tiff, min = 0.0f, max = 1.0f): Image {.raises: [].} =
  ## Converts a TIFF into an Image by moving the data. This is faster but can
  ## only be done once.
  type Movable = ref object
    width, height: int
    dataFormat: TiffDataFormat
    data: seq[ColorRGBX]

  case tiff.dataFormat
  of tiffRgba:
    result = newImageFromUnchecked(
      tiff.width, tiff.height, move cast[Movable](tiff).data)
    result.toPremultipliedAlpha()
  of tiffGray16:
    result = newImageFromUnchecked(tiff.width, tiff.height,
      newSeq[ColorRGBX](tiff.width * tiff.height))
    for i, gray in tiff.dataGray16:
      let value = (gray div 257).uint8
      result.data[i] = rgbx(value, value, value, 255)
  of tiffGrayInt16:
    result = newImageFromUnchecked(tiff.width, tiff.height,
      newSeq[ColorRGBX](tiff.width * tiff.height))
    for i, gray in tiff.dataGrayInt16:
      let value = ((gray.int32 + 32768) div 257).uint8
      result.data[i] = rgbx(value, value, value, 255)
  of tiffFloat32:
    result = newImageFromUnchecked(tiff.width, tiff.height,
      newSeq[ColorRGBX](tiff.width * tiff.height))
    for i in 0 ..< tiff.dataFloat32.len:
      var gray: float32
      if max > min:
        gray = (tiff.dataFloat32[i] - min) / (max - min)
      if gray < 0:
        gray = 0
      elif gray > 1:
        gray = 1
      let value = (gray * 255 + 0.5).uint8
      result.data[i] = rgbx(value, value, value, 255)

proc newImage*(tiff: Tiff): Image =
  if tiff.dataFormat != tiffRgba:
    return convertToImage(tiff)

  result = newImage(tiff.width, tiff.height)
  if tiff.data.len != result.dataLen:
    failInvalid("image data length mismatch")
  if tiff.data.len > 0:
    copyMem(result.data[0].addr, tiff.data[0].addr, tiff.data.len * 4)
  result.toPremultipliedAlpha()
