import math, pixie

# 4-color screen colors, as presented by the manufacturer
const desaturated4ColorPalette* = @[
  (0, 0, 0),
  (255, 255, 255),
  (255, 255, 0),
  (255, 0, 0),
]

# 4-color screen colors, as measured on a real display
const saturated4ColorPalette* = @[
  (57, 48, 57),
  (255, 255, 255),
  (208, 190, 71),
  (156, 72, 75),
]

# 6-color Spectra e-ink displays, measured on display and modulated
const spectra6ColorPalette* = @[
  (13, 0, 19),     # 0x0 - black
  (220, 220, 215), # 0x1 - white
  (242, 220, 0),   # 0x2 - yellow
  (130, 0, 0),     # 0x3 - red
  (999, 999, 999), # skips an index!
  (19, 60, 160),   # 0x5 - blue
  (51, 83, 38),    # 0x6 - green
]

# 6-color Spectra e-ink displays, as measured on a real display (Attempt 1)
const spectra6ColorPaletteTry1* = @[
  (50, 44, 52),    # 0x0 - black
  (255, 255, 255), # 0x1 - white
  (255, 248, 0),   # 0x2 - yellow
  (223, 38, 27),   # 0x3 - red
  (999, 999, 999), # skips an index!
  (41, 112, 238),  # 0x5 - blue
  (87, 161, 126),  # 0x6 - green
]

# 6-color Spectra e-ink displays, as presented by the manufacturer. These are not used.
const spectra6ColorPaletteOrig* = @[
  (0, 0, 0),       # 0x0 - black
  (255, 255, 255), # 0x1 - white
  (255, 255, 0),   # 0x2 - yellow
  (255, 0, 0),     # 0x3 - red
  (999, 999, 999), # skips an index!
  (0, 0, 255),     # 0x5 - blue
  (0, 255, 0),     # 0x6 - green
]

# 7-color screen colors, as presented by the manufacturer
# we do not use these colors anywhere. They're presented for reference
const desaturated7ColorPalette* = @[
  (0, 0, 0),
  (255, 255, 255),
  (0, 255, 0),
  (0, 0, 255),
  (255, 0, 0),
  (255, 255, 0),
  (255, 140, 0)
]

# 7-color screen colors, as measured on a real display
# We use these colors for dithering on all waveshare and inky 7-color displays
const saturated7ColorPalette* = @[
  (57, 48, 57),    # dark gray
  (255, 255, 255), # white
  (58, 91, 70),    # khaki green
  (61, 59, 94),    # dark purple
  (156, 72, 75),   # red
  (208, 190, 71),  # yellow
  (177, 106, 73),  # orange-brown
]

proc clip8(value: int): uint8 {.inline.} =
  if value < 0: return 0
  elif value > 255: return 255
  else: return value.uint8

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
    bits = if palette.len <= 2: 1 elif palette.len <= 4: 2 elif palette.len <= 16: 4 else: 8
    divider = if palette.len <= 2: 8 elif palette.len <= 4: 4 elif palette.len <= 16: 2 else: 1

  let rowWidth = ceil(width.float / divider.float).int
  var output = newSeq[uint8](height * rowWidth)

  for y in 0..<height:
    for x in 0..<width:
      let dataIndex = y * width + x
      let outputIndex = y * rowWidth + x div divider

      let imageR = img.data[dataIndex].r.int
      let imageG = img.data[dataIndex].g.int
      let imageB = img.data[dataIndex].b.int

      let (index, palR, palG, palB) = closestPalette(palette, imageR, imageG, imageB)

      let errorR = imageR - palR
      let errorG = imageG - palG
      let errorB = imageB - palB

      case bits:
        of 8: output[outputIndex] = index.uint8
        of 4:
          let bitPosition = (1 - (x mod 2)) * 4
          output[outputIndex] = output[outputIndex] or (index shl bitPosition).uint8
        of 2:
          let bitPosition = (3 - (x mod 4)) * 2
          output[outputIndex] = output[outputIndex] or (index shl bitPosition).uint8
        of 1:
          let bitPosition = (7 - x) mod 8
          output[outputIndex] = output[outputIndex] or (index shl bitPosition).uint8
        else: discard

      for i in 0..<4:
        if (x + dx[i] >= 0) and (x + dx[i] < width) and (y + dy[i] < height):
          let errorIndex = (y + dy[i]) * width + (x + dx[i])
          img.data[errorIndex].r = clip8(img.data[errorIndex].r.int + (errorR * distribution[i] div 16))
          img.data[errorIndex].g = clip8(img.data[errorIndex].g.int + (errorG * distribution[i] div 16))
          img.data[errorIndex].b = clip8(img.data[errorIndex].b.int + (errorB * distribution[i] div 16))

  return output
