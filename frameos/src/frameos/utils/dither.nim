import math, pixie

const desaturated4ColorPalette* = @[
  (0, 0, 0),
  (255, 255, 255),
  (255, 255, 0),
  (255, 0, 0),
]

const saturated4ColorPalette* = @[
  (57, 48, 57),
  (255, 255, 255),
  (208, 190, 71),
  (156, 72, 75),
]

const desaturated7ColorPalette* = @[
  (0, 0, 0),
  (255, 255, 255),
  (0, 255, 0),
  (0, 0, 255),
  (255, 0, 0),
  (255, 255, 0),
  (255, 140, 0)
]

const saturated7ColorPalette* = @[
  (57, 48, 57),
  (255, 255, 255),
  (58, 91, 70),
  (61, 59, 94),
  (156, 72, 75),
  (208, 190, 71),
  (177, 106, 73),
]

proc clip8(value: int): uint8 {.inline.} =
  if value < 0: return 0
  elif value > 255: return 255
  else: return value.uint8

proc nextPowerOfTwo(bits: int): int =
  var n = bits - 1
  n = n or n shr 1
  n = n or n shr 2
  n = n or n shr 4
  n = n or n shr 8
  n = n or n shr 16
  n += 1
  return n

proc toGrayscaleFloat*(image: Image, grayscale: var seq[float], multiple: float = 1.0) =
  let
    width = image.width
    height = image.height
  for y in 0..<height:
    for x in 0..<width:
      let index = y * width + x
      grayscale[index] = multiple * (image.data[index].r.float * 0.21 + image.data[index].g.float * 0.72 + image.data[
          index].b.float * 0.07) / 255.0

proc floydSteinberg*(pixels: var seq[float], width, height: int) =
  let
    distribution = [7.0 / 16.0, 3.0 / 16.0, 5.0 / 16.0, 1.0 / 16.0]
    dy = [0, 1, 1, 1]
    dx = [1, -1, 0, 1]

  for y in 0..<height:
    for x in 0..<width:
      let index = y * width + x
      let value = round(pixels[index])
      let error = pixels[index] - value
      pixels[index] = value

      for i in 0..<4:
        if (x + dx[i] >= 0) and (x + dx[i] < width) and (y + dy[i] < height):
          pixels[(y + dy[i]) * width + (x + dx[i])] += error * distribution[i]

proc closestPalette*(palette: seq[(int, int, int)], r, g, b: int): (int, int, int, int) =
  # TODO: optimize with a lookup table
  var index: int = 0
  var min = 99999999999
  for i in 0..<palette.len:
    let distance = abs(r - palette[i][0]) + abs(g - palette[i][1]) + abs(b - palette[i][2])
    if distance < min:
      min = distance
      index = i
  return (index, palette[index][0], palette[index][1], palette[index][2])


proc ditherPaletteIndexed*(image: Image, palette: seq[(int, int, int)]): seq[uint8] =
  let
    img = image.copy
    width = img.width
    height = img.height
    distribution = [7, 3, 5, 1]
    dy = [0, 1, 1, 1]
    dx = [1, -1, 0, 1]
    bits = nextPowerOfTwo(palette.len)

  let rowWidth = ceil(width.float / bits.float).int
  var output = newSeq[uint8](height * rowWidth)

  for y in 0..<height:
    for x in 0..<width:
      let dataIndex = y * width + x

      let imageR = img.data[dataIndex].r.int
      let imageG = img.data[dataIndex].g.int
      let imageB = img.data[dataIndex].b.int

      let (index, palR, palG, palB) = closestPalette(palette, imageR, imageG, imageB)

      let errorR = imageR - palR
      let errorG = imageG - palG
      let errorB = imageB - palB

      case bits:
        of 8: output[dataIndex] = index.uint8
        of 4:
          output[dataIndex div 2] = output[dataIndex div 2] or (index shl (5 - (dataIndex mod 2) * 4)).uint8
        of 2:
          output[dataIndex div 4] = output[dataIndex div 4] or (index shl (6 - (dataIndex mod 4) * 2)).uint8
        of 1:
          output[dataIndex div 8] = output[dataIndex div 8] or (index shl (7 - (dataIndex mod 8))).uint8
        else: discard

      for i in 0..<4:
        if (x + dx[i] >= 0) and (x + dx[i] < width) and (y + dy[i] < height):
          let errorIndex = (y + dy[i]) * width + (x + dx[i])
          img.data[errorIndex].r = clip8(img.data[errorIndex].r.int + (errorR * distribution[i] div 16))
          img.data[errorIndex].g = clip8(img.data[errorIndex].g.int + (errorG * distribution[i] div 16))
          img.data[errorIndex].b = clip8(img.data[errorIndex].b.int + (errorB * distribution[i] div 16))

  return output
