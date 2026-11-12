import math, pixie, pixie/fileformats/qoi

const tests = ["testcard", "testcard_rgba"]

proc srgbToLinear(value: uint8): uint8 =
  let c = value.float32 / 255
  let linear =
    if c <= 0.04045:
      c / 12.92
    else:
      pow((c + 0.055) / 1.055, 2.4)
  round(linear * 255).uint8

proc addBe32(data: var string, value: int) =
  data.add(char((value shr 24) and 0xff))
  data.add(char((value shr 16) and 0xff))
  data.add(char((value shr 8) and 0xff))
  data.add(char(value and 0xff))

for name in tests:
  let
    path = "tests/fileformats/qoi/" & name & ".qoi"
    input = readImage(path)
    dimensions = decodeQoiDimensions(readFile(path))
  doAssert input.width == dimensions.width
  doAssert input.height == dimensions.height
  discard encodeQoi(input)

for name in tests:
  let
    path = "tests/fileformats/qoi/" & name & ".qoi"
    input = decodeQoi(readFile(path))
    output = decodeQoi(encodeQoi(input))
  doAssert output.data.len == input.data.len
  doAssert output.colorspace == Linear
  if input.colorspace == Linear:
    doAssert output.data == input.data
  else:
    for i, px in input.data:
      doAssert output.data[i] == rgba(
        px.r.srgbToLinear(),
        px.g.srgbToLinear(),
        px.b.srgbToLinear(),
        px.a
      )

block:
  var data = ""
  data.add(qoiSignature)
  data.addBe32(1)
  data.addBe32(1)
  data.add(char(4)) # RGBA
  data.add(char(sRBG.uint8))
  data.add(char(0xff)) # QOI_OP_RGBA
  data.add(char(128))
  data.add(char(64))
  data.add(char(255))
  data.add(char(255))
  for _ in 0 .. 6:
    data.add(char(0))
  data.add(char(1))

  let
    qoi = decodeQoi(data)
    image = convertToImage(decodeQoi(data))
    encoded = decodeQoi(encodeQoi(qoi))

  doAssert qoi.colorspace == sRBG
  doAssert qoi.data[0] == rgba(128, 64, 255, 255)
  doAssert image.data[0] == rgbx(
    128.uint8.srgbToLinear(),
    64.uint8.srgbToLinear(),
    255.uint8.srgbToLinear(),
    255
  )
  doAssert encoded.colorspace == Linear
  doAssert encoded.data[0] == rgba(
    128.uint8.srgbToLinear(),
    64.uint8.srgbToLinear(),
    255.uint8.srgbToLinear(),
    255
  )
