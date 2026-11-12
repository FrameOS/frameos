import
  std/base64 as stdbase64,
  std/strutils,
  flatty/binny,
  common,
  fileformats/[bmp, gif, jpeg, png, qoi, svg]

when not defined(pixieNoPpm):
  import fileformats/ppm

proc decodeImageData(data: string): Image {.raises: [PixieError].} =
  ## Decodes supported image bytes into an image.
  if data.len > 8 and data.readUint64(0) == cast[uint64](pngSignature):
    decodePng(data).convertToImage()
  elif data.len > 2 and data.readUint16(0) == cast[uint16](jpegStartOfImage):
    decodeJpeg(data)
  elif data.len > 2 and data.readStr(0, 2) == bmpSignature:
    decodeBmp(data)
  elif data.len > 5 and (
    data.readStr(0, 5) == xmlSignature or
    data.readStr(0, 4) == svgSignature
  ):
    newImage(parseSvg(data))
  elif data.len > 6 and data.readStr(0, 6) in gifSignatures:
    newImage(decodeGif(data))
  elif data.len > (14 + 8) and data.readStr(0, 4) == qoiSignature:
    decodeQoi(data).convertToImage()
  else:
    # PPM last: its two-byte signature cannot collide with the formats above.
    when not defined(pixieNoPpm):
      if data.len > 9 and data.readStr(0, 2) in ppmSignatures:
        return decodePpm(data)
    raise newException(PixieError, "Unsupported image file format")

proc getPayload(data: string): string {.raises: [PixieError].} =
  ## Gets the base64 payload from plain base64 data or a data URL.
  if data.startsWith("data:"):
    let comma = data.find(',')
    if comma == -1:
      raise newException(PixieError, "Invalid data URL")
    if comma + 1 < data.len:
      data[comma + 1 .. ^1]
    else:
      ""
  else:
    data

proc encodeBase64*(image: Image): string {.raises: [PixieError].} =
  ## Encodes an image into PNG format and returns it as base64.
  stdbase64.encode(image.encodePng())

proc decodeBase64*(data: string): Image {.raises: [PixieError].} =
  ## Decodes a base64 image string into an image.
  try:
    decodeImageData(stdbase64.decode(data.getPayload()))
  except ValueError as e:
    raise newException(PixieError, e.msg, e)
