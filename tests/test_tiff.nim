import pixie/common, pixie/fileformats/tiff

let
  data = readFile("tests/fileformats/tiff/pc260001.tif")
  dimensions = decodeTiffDimensions(data)
  t = decodeTiff(data)
  image = newImage(t)

doAssert dimensions.width == t.width
doAssert dimensions.height == t.height
doAssert t.dataFormat == tiffRgba
doAssert t.data.len == t.width * t.height
doAssert t.dataFloat32.len == 0
doAssert t.dataGray16.len == 0
doAssert t.dataGrayInt16.len == 0
doAssert image.width == t.width
doAssert image.height == t.height

let
  gray16Tiff = Tiff(
    width: 1,
    height: 1,
    dataFormat: tiffGray16,
    dataGray16: @[32768.uint16]
  )
  gray16Image = convertToImage(gray16Tiff)
  grayInt16Tiff = Tiff(
    width: 3,
    height: 1,
    dataFormat: tiffGrayInt16,
    dataGrayInt16: @[-32768.int16, 0.int16, 32767.int16]
  )
  grayInt16Image = convertToImage(grayInt16Tiff)
  floatTiff = Tiff(
    width: 1,
    height: 1,
    dataFormat: tiffFloat32,
    dataFloat32: @[0.5'f32]
  )
  floatImage = convertToImage(floatTiff)

doAssert gray16Image.width == 1
doAssert gray16Image.height == 1
doAssert gray16Image.data[0].r == 127
doAssert grayInt16Image.width == 3
doAssert grayInt16Image.height == 1
doAssert grayInt16Image.data[0].r == 0
doAssert grayInt16Image.data[1].r == 127
doAssert grayInt16Image.data[2].r == 255
doAssert floatImage.width == 1
doAssert floatImage.height == 1
doAssert floatImage.data[0].r == 128

block:
  proc addLe16(data: var string, value: int) =
    data.add(char(value and 0xff))
    data.add(char((value shr 8) and 0xff))

  proc addLe32(data: var string, value: int) =
    data.add(char(value and 0xff))
    data.add(char((value shr 8) and 0xff))
    data.add(char((value shr 16) and 0xff))
    data.add(char((value shr 24) and 0xff))

  proc addIfdEntry(
    data: var string,
    tag, fieldType, numValues, valueOrOffset: int
  ) =
    data.addLe16(tag)
    data.addLe16(fieldType)
    data.addLe32(numValues)
    data.addLe32(valueOrOffset)

  const
    ifdOffset = 8
    entryCount = 9
    colorMapOffset = ifdOffset + 2 + entryCount * 12 + 4
    pixelDataOffset = colorMapOffset + 6

  var payload = ""
  payload.add("II")
  payload.addLe16(42)
  payload.addLe32(ifdOffset)
  payload.addLe16(entryCount)
  payload.addIfdEntry(0x0100, 4, 1, 1) # ImageWidth
  payload.addIfdEntry(0x0101, 4, 1, 1) # ImageLength
  payload.addIfdEntry(0x0102, 3, 1, 8) # BitsPerSample
  payload.addIfdEntry(0x0103, 3, 1, 1) # Compression = none
  payload.addIfdEntry(0x0106, 3, 1, 3) # PhotometricInterpretation = palette
  payload.addIfdEntry(0x0111, 4, 1, pixelDataOffset)
  payload.addIfdEntry(0x0116, 4, 1, 1) # RowsPerStrip
  payload.addIfdEntry(0x0117, 4, 1, 1) # StripByteCounts
  payload.addIfdEntry(0x0140, 3, 3, colorMapOffset)
  payload.addLe32(0)
  payload.addLe16(0)
  payload.addLe16(0)
  payload.addLe16(0)
  payload.add(char(0x01))

  doAssertRaises PixieError:
    discard decodeTiff(payload)
