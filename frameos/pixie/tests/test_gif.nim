import pixie, pixie/fileformats/gif, xrays

block:
  let
    path = "tests/fileformats/gif/3x5.gif"
    image = readImage(path)
    dimensions = decodeGifDimensions(readFile(path))
  image.xray("tests/fileformats/gif/3x5.png")
  doAssert image.width == dimensions.width
  doAssert image.height == dimensions.height

block:
  let
    path = "tests/fileformats/gif/audrey.gif"
    image = readImage(path)
    dimensions = decodeGifDimensions(readFile(path))
  image.xray("tests/fileformats/gif/audrey.png")
  doAssert image.width == dimensions.width
  doAssert image.height == dimensions.height

block:
  let
    path = "tests/fileformats/gif/sunflower.gif"
    image = readImage(path)
    dimensions = decodeGifDimensions(readFile(path))
  image.xray("tests/fileformats/gif/sunflower.png")
  doAssert image.width == dimensions.width
  doAssert image.height == dimensions.height

block:
  let img4 = readImage("tests/fileformats/gif/newtons_cradle.gif")
  img4.xray("tests/fileformats/gif/newtons_cradle.png")

  let animatedGif =
    decodeGif(readFile("tests/fileformats/gif/newtons_cradle.gif"))
  doAssert animatedGif.frames.len == 36
  doAssert animatedGif.intervals.len == animatedGif.frames.len

block:
  var data = readFile("tests/fileformats/gif/3x5.gif")
  data[12] = char(49) # Pixel aspect ratio is advisory and can be ignored.
  discard decodeGif(data)

block:
  proc addLe16(data: var string, value: int) =
    data.add(char(value and 0xff))
    data.add(char((value shr 8) and 0xff))

  var payload = "GIF89a"
  payload.addLe16(1)
  payload.addLe16(1)
  payload.add(char(0x80)) # Global color table present, size = 2 entries.
  payload.add(char(0x02)) # One past the last valid color table index.
  payload.add(char(0x00))
  payload.add("\x00\x00\x00\xff\xff\xff")
  payload.add(char(0x3b))

  doAssertRaises PixieError:
    discard decodeGif(payload)
