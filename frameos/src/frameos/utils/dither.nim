import math, pixie, chroma

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
    dx = [0, 1, 1, 1]
    dy = [1, -1, 0, 1]

  for y in 0..<height:
    for x in 0..<width:
      let index = y * width + x
      let value = round(pixels[index])
      let error = pixels[index] - value
      pixels[index] = value

      for i in 0..<4:
        if (x + dx[i] >= 0) and (x + dx[i] < width) and (y + dy[i] < height):
          pixels[(y + dy[i]) * width + (x + dx[i])] += error * distribution[i]

const desaturatedPalette* = @[
  (0, 0, 0),
  (255, 255, 255),
  (0, 255, 0),
  (0, 0, 255),
  (255, 0, 0),
  (255, 255, 0),
  (255, 140, 0),
  (255, 255, 255)
]

const saturatedPalette* = @[
  (57, 48, 57),
  (255, 255, 255),
  (58, 91, 70),
  (61, 59, 94),
  (156, 72, 75),
  (208, 190, 71),
  (177, 106, 73),
  (255, 255, 255),
]

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

proc clip8(value: int): uint8 {.inline.} =
  if value < 0: return 0
  elif value > 255: return 255
  else: return value.uint8

proc ditherPalette*(image: var Image, palette: seq[(int, int, int)]) =
  let
    width = image.width
    height = image.height
    distribution = [7, 3, 5, 1]
    dy = [0, 1, 1, 1]
    dx = [1, -1, 0, 1]

  for y in 0..<height:
    for x in 0..<width:
      let dataIndex = y * width + x

      let imageR = image.data[dataIndex].r.int
      let imageG = image.data[dataIndex].g.int
      let imageB = image.data[dataIndex].b.int

      let (_, palR, palG, palB) = closestPalette(palette, imageR, imageG, imageB)
      image.data[dataIndex].r = palR.uint8
      image.data[dataIndex].g = palG.uint8
      image.data[dataIndex].b = palB.uint8

      let errorR = imageR - palR
      let errorG = imageG - palG
      let errorB = imageB - palB

      for i in 0..<4:
        if (x + dx[i] >= 0) and (x + dx[i] < width) and (y + dy[i] < height):
          let errorIndex = (y + dy[i]) * width + (x + dx[i])
          image.data[errorIndex].r = clip8(image.data[errorIndex].r.int + (errorR * distribution[i] div 16))
          image.data[errorIndex].g = clip8(image.data[errorIndex].g.int + (errorG * distribution[i] div 16))
          image.data[errorIndex].b = clip8(image.data[errorIndex].b.int + (errorB * distribution[i] div 16))
