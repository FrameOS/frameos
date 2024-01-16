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
    u = [0, 1, 1, 1]  # + y
    v = [1, -1, 0, 1] # + x

  for y in 0..<height:
    for x in 0..<width:
      let index = y * width + x
      let value = round(pixels[index])
      let error = pixels[index] - value
      pixels[index] = value

      for i in 0..<4:
        if (x + v[i] >= 0) and (x + v[i] < width) and (y + u[i] < height):
          pixels[(y + u[i]) * width + (x + v[i])] += error * distribution[i]


let desaturatedPalette* = @[
  parseHtmlColor("#000000"),
  parseHtmlColor("#FFFFFF"),
  parseHtmlColor("#00FF00"),
  parseHtmlColor("#0000FF"),
  parseHtmlColor("#FF0000"),
  parseHtmlColor("#FFFF00"),
  parseHtmlColor("#FF8C00"),
  parseHtmlColor("#FFFFFF"),
]

let saturatedPalette* = @[
  parseHtmlColor("#393039"),
  parseHtmlColor("#FFFFFF"),
  parseHtmlColor("#3A5B46"),
  parseHtmlColor("#3D3B5E"),
  parseHtmlColor("#9C484B"),
  parseHtmlColor("#D0BE47"),
  parseHtmlColor("#B16A49"),
  parseHtmlColor("#FFFFFF"),
]

proc closestPalette*(palette: seq[Color], r, g, b: int): (int, int, int, int) =
  var index: int = 0
  var min = 99999999999
  for i in 0..<palette.len:
    let
      paletteR = (palette[i].r * 255).int
      paletteG = (palette[i].g * 255).int
      paletteB = (palette[i].b * 255).int
      distance = abs(r - paletteR) + abs(g - paletteG) + abs(b - paletteB)

    if distance < min:
      min = distance
      index = i.int

  let
    r = (palette[index].r * 255).int
    g = (palette[index].g * 255).int
    b = (palette[index].b * 255).int

  return (index, r, g, b)

proc clip8*(value: int): uint8 =
  if value < 0: return 0
  elif value > 255: return 255
  else: return value.uint8

proc dither*(image: var Image, palette: seq[Color]) =
  let
    width = image.width
    height = image.height

  let
    distribution = [7, 3, 5, 1]
    u = [0, 1, 1, 1]  # + y
    v = [1, -1, 0, 1] # + x

  for y in 0..<height:
    for x in 0..<width:
      let dataIndex = y * width + x

      let imageR = image.data[dataIndex].r.int
      let imageG = image.data[dataIndex].g.int
      let imageB = image.data[dataIndex].b.int

      let (palIndex, palR, palG, palB) = closestPalette(palette, imageR, imageG, imageB)
      image.data[dataIndex].r = palR.uint8
      image.data[dataIndex].g = palG.uint8
      image.data[dataIndex].b = palB.uint8

      let errorR = imageR - palR
      let errorG = imageG - palG
      let errorB = imageB - palB

      for i in 0..<4:
        if (x + v[i] >= 0) and (x + v[i] < width) and (y + u[i] < height):
          let errorIndex = (y + u[i]) * width + (x + v[i])
          image.data[errorIndex].r = clip8(image.data[errorIndex].r.int + (errorR * distribution[i] div 16))
          image.data[errorIndex].g = clip8(image.data[errorIndex].g.int + (errorG * distribution[i] div 16))
          image.data[errorIndex].b = clip8(image.data[errorIndex].b.int + (errorB * distribution[i] div 16))
