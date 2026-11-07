import
  std/[os, strutils],
  bumpy, chroma, flatty/binny, vmath,
  pixie/[common, contexts, fonts, imagebase64, images, internal, paints, paths],
  pixie/fileformats/[bmp, gif, jpeg, png, qoi, svg, webp]

when not defined(pixieNoPpm):
  # Netpbm (P3/P6) is a rarity next to the other formats, and on a
  # flash-constrained target (FrameOS' ESP32 firmware) its decoder is dead
  # weight. `-d:pixieNoPpm` drops the module: `PpmFormat` stays in the enum so
  # the API does not change shape, but decoding a P3/P6 file and encoding to
  # PPM both raise "Unsupported file format".
  import pixie/fileformats/ppm

export bumpy, chroma, common, contexts, fonts, imagebase64, images, paints,
    paths, vmath

type
  FileFormat* = enum
    PngFormat, BmpFormat, JpegFormat, GifFormat, QoiFormat, PpmFormat,
    WebpFormat

converter autoStraightAlpha*(c: ColorRGBX): ColorRGBA {.inline, raises: [].} =
  ## Convert a premultiplied alpha RGBA to a straight alpha RGBA.
  c.rgba()

converter autoPremultipliedAlpha*(c: ColorRGBA): ColorRGBX {.inline, raises: [].} =
  ## Convert a straight alpha RGBA to a premultiplied alpha RGBA.
  c.rgbx()

proc decodeImageDimensions*(
  data: pointer, len: int
): ImageDimensions {.raises: [PixieError].} =
  ## Decodes an image's dimensions from memory.
  if len > 8 and equalMem(data, pngSignature[0].unsafeAddr, 8):
    decodePngDimensions(data, len)
  elif len > 2 and equalMem(data, jpegStartOfImage[0].unsafeAddr, 2):
    decodeJpegDimensions(data, len)
  elif len > 2 and equalMem(data, bmpSignature.cstring, 2):
    decodeBmpDimensions(data, len)
  elif len > 6 and (
    equalMem(data, gifSignatures[0].cstring, 6) or
    equalMem(data, gifSignatures[1].cstring, 6)
  ):
    decodeGifDimensions(data, len)
  elif len > (14 + 8) and equalMem(data, qoiSignature.cstring, 4):
    decodeQoiDimensions(data, len)
  elif len > 12 and
      equalMem(data, WebpRiffSignature.cstring, 4) and
      equalMem(cast[pointer](cast[uint](data) + 8), WebpSignature.cstring, 4):
    decodeWebpDimensions(data, len)
  else:
    # PPM last: its two-byte signature cannot collide with the formats above.
    when not defined(pixieNoPpm):
      if len > 9 and (
        equalMem(data, ppmSignatures[0].cstring, 2) or
        equalMem(data, ppmSignatures[1].cstring, 2)
      ):
        return decodePpmDimensions(data, len)
    raise newException(PixieError, "Unsupported image file format")

proc decodeImageDimensions*(
  data: string
): ImageDimensions {.raises: [PixieError].} =
  ## Decodes an image's dimensions from memory.
  decodeImageDimensions(data.cstring, data.len)

proc decodeImage*(data: string): Image {.raises: [PixieError].} =
  ## Loads an image from memory.
  if data.len > 8 and data.readUint64(0) == cast[uint64](pngSignature):
    decodePng(data).convertToImage()
  elif data.len > 2 and data.readUint16(0) == cast[uint16](jpegStartOfImage):
    decodeJpeg(data)
  elif data.len > 2 and data.readStr(0, 2) == bmpSignature:
    decodeBmp(data)
  elif data.len > 5 and
    (data.readStr(0, 5) == xmlSignature or data.readStr(0, 4) == svgSignature):
    newImage(parseSvg(data))
  elif data.len > 6 and data.readStr(0, 6) in gifSignatures:
    newImage(decodeGif(data))
  elif data.len > (14+8) and data.readStr(0, 4) == qoiSignature:
    decodeQoi(data).convertToImage()
  elif data.len > 12 and data.readStr(0, 4) == WebpRiffSignature and
      data.readStr(8, 4) == WebpSignature:
    decodeWebp(data)
  else:
    # PPM last: its two-byte signature cannot collide with the formats above.
    when not defined(pixieNoPpm):
      if data.len > 9 and data.readStr(0, 2) in ppmSignatures:
        return decodePpm(data)
    raise newException(PixieError, "Unsupported image file format")

proc validateScaledImageTarget(width, height: int) {.raises: [PixieError].} =
  if width <= 0 or width > int32.high.int:
    raise newException(PixieError, "Invalid target width")
  if height <= 0 or height > int32.high.int:
    raise newException(PixieError, "Invalid target height")

proc validateScaledImageTarget(target: Image) {.raises: [PixieError].} =
  if target.isNil:
    raise newException(PixieError, "Invalid target Image")
  validateScaledImageTarget(target.width, target.height)

proc copyIntoTarget(target, source: Image) {.raises: [PixieError].} =
  if target.width != source.width or target.height != source.height:
    raise newException(PixieError, "Image dimensions do not match target")
  # Row at a time: either side may be a view, whose rows are `stride` apart
  # rather than adjacent.
  if target.format != source.format:
    # A decoded RGBX picture landing in a 565 canvas (or the reverse) goes
    # through the accessors; the same-format case stays a row memcpy.
    for y in 0 ..< target.height:
      var
        ti = target.dataIndex(0, y)
        si = source.dataIndex(0, y)
      for x in 0 ..< target.width:
        target.setPixel(ti, source.getPixel(si))
        inc ti
        inc si
    return
  let rowBytes = target.width * target.bytesPerPixel
  for y in 0 ..< target.height:
    copyMem(
      target.pixelAddr(target.dataIndex(0, y)),
      source.pixelAddr(source.dataIndex(0, y)),
      rowBytes
    )

template isWebpData(data: string): bool =
  data.len > 12 and data.readStr(0, 4) == WebpRiffSignature and
    data.readStr(8, 4) == WebpSignature

proc decodeImageScaled*(
  data: string, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].}

proc decodeImageScaled*(
  data: var string, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].}

proc decodeImageScaledInto*(
  data: var string, target: Image, fit = fitStretch
): Image {.raises: [PixieError].}

proc decodeImageScaled*(
  data: pointer, len, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Loads an image from memory scaled to the requested dimensions.
  validateScaledImageTarget(width, height)
  if len > 8 and equalMem(data, pngSignature[0].unsafeAddr, 8):
    decodePngScaled(data, len, width, height, fit)
  elif len > 2 and equalMem(data, jpegStartOfImage[0].unsafeAddr, 2):
    decodeJpegScaled(data, len, width, height, fit)
  elif len > 2 and equalMem(data, bmpSignature.cstring, 2):
    decodeBmpScaled(data, len, width, height, fit)
  else:
    var copy = newString(len)
    if len > 0:
      copyMem(addr copy[0], data, len)
    decodeImageScaled(copy, width, height, fit)

proc decodeImageScaled*(
  data: string, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Loads an image from memory scaled to the requested dimensions.
  validateScaledImageTarget(width, height)
  if data.len > 8 and data.readUint64(0) == cast[uint64](pngSignature):
    decodePngScaled(data, width, height, fit)
  elif data.len > 2 and data.readUint16(0) == cast[uint16](jpegStartOfImage):
    decodeJpegScaled(data, width, height, fit)
  elif data.len > 2 and data.readStr(0, 2) == bmpSignature:
    decodeBmpScaled(data, width, height, fit)
  elif data.isWebpData:
    decodeWebpScaled(data, width, height, fit)
  else:
    let image = decodeImage(data)
    if image.width == width and image.height == height:
      image
    else:
      image.resize(width, height)

proc decodeImageScaled*(
  data: var string, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Loads an image from memory scaled to the requested dimensions. JPEG
  ## releases the source buffer before allocating the destination; PNG releases
  ## it after parsing because the PNG stream must be inflated first.
  validateScaledImageTarget(width, height)
  if data.len > 8 and data.readUint64(0) == cast[uint64](pngSignature):
    decodePngScaled(data, width, height, fit)
  elif data.len > 2 and data.readUint16(0) == cast[uint16](jpegStartOfImage):
    decodeJpegScaled(data, width, height, fit)
  elif data.len > 2 and data.readStr(0, 2) == bmpSignature:
    decodeBmpScaled(data, width, height, fit)
  elif data.isWebpData:
    decodeWebpScaled(data, width, height, fit)
  else:
    let image = decodeImage(data)
    data = ""
    try:
      GC_fullCollect()
    except Exception:
      discard
    if image.width == width and image.height == height:
      image
    else:
      image.resize(width, height)

proc decodeImageScaledInto*(
  data: pointer, len: int, target: Image, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Loads an image from memory scaled into an existing target Image.
  validateScaledImageTarget(target)
  if len > 8 and equalMem(data, pngSignature[0].unsafeAddr, 8):
    decodePngScaledInto(data, len, target, fit)
  elif len > 2 and equalMem(data, jpegStartOfImage[0].unsafeAddr, 2):
    decodeJpegScaledInto(data, len, target, fit)
  elif len > 2 and equalMem(data, bmpSignature.cstring, 2):
    decodeBmpScaledInto(data, len, target, fit)
  else:
    var copy = newString(len)
    if len > 0:
      copyMem(addr copy[0], data, len)
    discard decodeImageScaledInto(copy, target, fit)
  target

proc decodeImageScaledInto*(
  data: string, target: Image, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Loads an image from memory scaled into an existing target Image.
  validateScaledImageTarget(target)
  if data.len > 8 and data.readUint64(0) == cast[uint64](pngSignature):
    decodePngScaledInto(data, target, fit)
  elif data.len > 2 and data.readUint16(0) == cast[uint16](jpegStartOfImage):
    decodeJpegScaledInto(data, target, fit)
  elif data.len > 2 and data.readStr(0, 2) == bmpSignature:
    decodeBmpScaledInto(data, target, fit)
  elif data.isWebpData:
    discard decodeWebpScaledInto(data, target, fit)
  else:
    target.copyIntoTarget(decodeImageScaled(data, target.width, target.height))
  target

proc decodeImageScaledInto*(
  data: var string, target: Image, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Loads an image from memory scaled into an existing target Image.
  validateScaledImageTarget(target)
  if data.len > 8 and data.readUint64(0) == cast[uint64](pngSignature):
    decodePngScaledInto(data, target, fit)
  elif data.len > 2 and data.readUint16(0) == cast[uint16](jpegStartOfImage):
    decodeJpegScaledInto(data, target, fit)
  elif data.len > 2 and data.readStr(0, 2) == bmpSignature:
    decodeBmpScaledInto(data, target, fit)
  elif data.isWebpData:
    discard decodeWebpScaledInto(data, target, fit)
  else:
    target.copyIntoTarget(decodeImageScaled(data, target.width, target.height))
  target

proc readImageDimensions*(
  filePath: string
): ImageDimensions {.inline, raises: [PixieError].} =
  ## Decodes an image's dimensions from a file.
  try:
    decodeImageDimensions(readFile(filePath))
  except IOError as e:
    raise newException(PixieError, e.msg, e)

proc readImage*(filePath: string): Image {.inline, raises: [PixieError].} =
  ## Loads an image from a file.
  try:
    decodeImage(readFile(filePath))
  except IOError as e:
    raise newException(PixieError, e.msg, e)

proc readImageScaled*(
  filePath: string, width, height: int, fit = fitStretch
): Image {.inline, raises: [PixieError].} =
  ## Loads an image from a file scaled to the requested dimensions.
  try:
    var data = readFile(filePath)
    decodeImageScaled(data, width, height, fit)
  except IOError as e:
    raise newException(PixieError, e.msg, e)

proc encodeImage*(
  image: Image, fileFormat: FileFormat
): string {.raises: [PixieError].} =
  ## Encodes an image into memory.
  case fileFormat:
  of PngFormat:
    image.encodePng()
  of JpegFormat:
    raise newException(PixieError, "Unsupported file format")
  of BmpFormat:
    image.encodeBmp()
  of QoiFormat:
    image.encodeQoi()
  of GifFormat:
    raise newException(PixieError, "Unsupported file format")
  of PpmFormat:
    when defined(pixieNoPpm):
      raise newException(PixieError, "Unsupported file format")
    else:
      image.encodePpm()
  of WebpFormat:
    raise newException(PixieError, "Unsupported file format")

proc writeFile*(image: Image, filePath: string) {.raises: [PixieError].} =
  ## Writes an image to a file.
  let fileFormat = case splitFile(filePath).ext.toLowerAscii():
    of ".png": PngFormat
    of ".bmp": BmpFormat
    of ".jpg", ".jpeg": JpegFormat
    of ".qoi": QoiFormat
    of ".ppm": PpmFormat
    of ".webp": WebpFormat
    else:
      raise newException(PixieError, "Unsupported file extension")

  try:
    writeFile(filePath, image.encodeImage(fileFormat))
  except IOError as e:
    raise newException(PixieError, e.msg, e)

proc fill*(image: Image, paint: Paint) {.raises: [PixieError].} =
  ## Fills the image with the paint.
  case paint.kind:
  of SolidPaint:
    image.forEachSpan:
      fillUnsafe(image.data, paint.color, spanStart, spanLen)
  of ImagePaint, TiledImagePaint:
    image.forEachSpan:
      fillUnsafe(image.data, rgbx(0, 0, 0, 0), spanStart, spanLen)
    let path = newPath()
    path.rect(0, 0, image.width.float32, image.height.float32)
    image.fillPath(path, paint)
  of LinearGradientPaint, RadialGradientPaint, AngularGradientPaint:
    image.fillGradient(paint)
