import std/unittest
import pixie

import ../dither

proc setPixel(image: Image, x, y: int, r, g, b: uint8) =
  let idx = image.dataIndex(x, y)
  image.data[idx].r = r
  image.data[idx].g = g
  image.data[idx].b = b
  image.data[idx].a = 255

suite "dither helpers":
  test "closestPalette picks nearest index and color":
    let palette = @[(0, 0, 0), (255, 255, 255), (200, 10, 10)]
    let closest = closestPalette(palette, 210, 0, 0)
    check closest[0] == 2
    check closest[1] == 200
    check closest[2] == 10
    check closest[3] == 10

  test "toGrayscaleFloat applies weighted conversion":
    let image = newImage(2, 1)
    setPixel(image, 0, 0, 255, 0, 0)
    setPixel(image, 1, 0, 0, 255, 0)
    var grayscale = newSeq[float](2)

    toGrayscaleFloat(image, grayscale, multiple = 2.0)
    check abs(grayscale[0] - 0.42) < 0.01
    check abs(grayscale[1] - 1.44) < 0.01

  test "ditherPaletteIndexed packs bytes for 1 2 4 and 8 bit palettes":
    let bwPalette = @[(0, 0, 0), (255, 255, 255)]
    let bwImage = newImage(8, 1)
    for x in 0 ..< 8:
      if x mod 2 == 0:
        setPixel(bwImage, x, 0, 255, 255, 255)
      else:
        setPixel(bwImage, x, 0, 0, 0, 0)
    let packed1 = ditherPaletteIndexed(bwImage, bwPalette)
    check packed1 == @[170'u8]

    let palette2Bit = @[(0, 0, 0), (80, 80, 80), (160, 160, 160), (255, 255, 255)]
    let image2Bit = newImage(4, 1)
    for x in 0 ..< 4:
      let c = uint8(palette2Bit[x][0])
      setPixel(image2Bit, x, 0, c, c, c)
    let packed2 = ditherPaletteIndexed(image2Bit, palette2Bit)
    check packed2 == @[27'u8] # 00 01 10 11

    var palette4Bit: seq[(int, int, int)] = @[]
    for i in 0 .. 15:
      palette4Bit.add((i * 10, i * 10, i * 10))
    let image4Bit = newImage(2, 1)
    setPixel(image4Bit, 0, 0, uint8(palette4Bit[10][0]), uint8(palette4Bit[10][1]), uint8(palette4Bit[10][2]))
    setPixel(image4Bit, 1, 0, uint8(palette4Bit[3][0]), uint8(palette4Bit[3][1]), uint8(palette4Bit[3][2]))
    let packed4 = ditherPaletteIndexed(image4Bit, palette4Bit)
    check packed4 == @[163'u8] # 0xA3

    var palette8Bit: seq[(int, int, int)] = @[]
    for i in 0 .. 16:
      palette8Bit.add((i, i, i))
    let image8Bit = newImage(2, 1)
    setPixel(image8Bit, 0, 0, 0, 0, 0)
    setPixel(image8Bit, 1, 0, 16, 16, 16)
    let packed8 = ditherPaletteIndexed(image8Bit, palette8Bit)
    check packed8 == @[0'u8, 16'u8]
