import
  std/base64,
  chroma, pixie, pixie/fileformats/png

block:
  let image = newImage(2, 1)
  image[0, 0] = rgba(255, 0, 0, 255)
  image[1, 0] = rgba(0, 0, 255, 128)

  let encoded = image.encodeBase64()
  doAssert encoded == base64.encode(image.encodePng())

  let decoded = decodeBase64(encoded)
  doAssert decoded.width == image.width
  doAssert decoded.height == image.height
  doAssert decoded.pixelsEqual(image)

block:
  let image = newImage(1, 1)
  image[0, 0] = rgba(0, 255, 0, 255)

  let
    encoded = image.encodeBase64()
    decoded = decodeBase64("data:image/png;base64," & encoded)

  doAssert decoded.width == image.width
  doAssert decoded.height == image.height
  doAssert decoded.pixelsEqual(image)

block:
  try:
    discard decodeBase64("nope")
    doAssert false
  except PixieError:
    discard
