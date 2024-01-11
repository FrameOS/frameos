import math, pixie

proc grayscaleFloat*(image: Image): seq[float] =
  let
    width = image.width
    height = image.height
  var res = newSeq[float](width * height)
  for y in 0..<height:
    for x in 0..<width:
      let index = y * width + x
      res[index] = (image.data[index].r.float * 0.21 + image.data[index].g.float * 0.72 + image.data[index].b.float *
          0.07) / 255.0
  return res

proc floydSteinberg*(image: var seq[float], width, height: int) =
  let
    distribution = [7.0 / 16.0, 3.0 / 16.0, 5.0 / 16.0, 1.0 / 16.0]
    u = [0, 1, 1, 1]  # + y
    v = [1, -1, 0, 1] # + x

  for y in 0..<height:
    for x in 0..<width:
      let index = y * width + x
      let value = round(image[index])
      let error = image[index] - value
      image[index] = value

      for i in 0..<4:
        if (x + v[i] >= 0) and (x + v[i] < width) and (y + u[i] < height):
          image[(y + u[i]) * width + (x + v[i])] += error * distribution[i]

# TODO: add more dithering algorithms
# Inspired by https://github.com/SolitudeSF/imageman/blob/master/src/imageman/dither.nim

# func twoDist*(i: var Image, x, y: int, r, g, b: float32) =
#   i.addErrors x, y, r, g, b, 4.0, [
#     1, 0, 2,
#     0, 1, 1,
#     1, 1, 1
#   ]

# func floydsteinDist*(i: var Image, x, y: int, r, g, b: float32) =
#   i.addErrors x, y, r, g, b, 16.0, [
#     1, 0, 7,
#     -1, 1, 3,
#     0, 1, 5,
#     1, 1, 1
#   ]

# func atkinsonDist*(i: var Image, x, y: int, r, g, b: float32) =
#   i.addErrors x, y, r, g, b, 8.0, [
#     1, 0, 1,
#     2, 0, 1,
#     -1, 1, 1,
#     0, 1, 1,
#     1, 1, 1,
#     0, 2, 1
#   ]

# func burkeDist*(i: var Image, x, y: int, r, g, b: float32) =
#   i.addErrors x, y, r, g, b, 42.0, [
#     1, 0, 8,
#     2, 0, 4,
#     -2, 1, 2,
#     -1, 1, 4,
#     0, 1, 8,
#     1, 1, 4,
#     2, 1, 2
#   ]

# func sierraDist*(i: var Image, x, y: int, r, g, b: float32) =
#   i.addErrors x, y, r, g, b, 32.0, [
#     1, 0, 5,
#     2, 0, 3,
#     -2, 1, 2,
#     -1, 1, 3,
#     0, 1, 5,
#     1, 1, 4,
#     2, 1, 2,
#     -1, 2, 2,
#     0, 2, 3,
#     1, 2, 2
#   ]

# func sierra2Dist*(i: var Image, x, y: int, r, g, b: float32) =
#   i.addErrors x, y, r, g, b, 16.0, [
#     1, 0, 4,
#     2, 0, 3,
#     -2, 1, 1,
#     -1, 1, 2,
#     0, 1, 3,
#     1, 1, 2,
#     2, 1, 1
#   ]

# func sierraLiteDist*(i: var Image, x, y: int, r, g, b: float32) =
#   i.addErrors x, y, r, g, b, 4.0, [
#     1, 0, 2,
#     -1, 1, 1,
#     0, 1, 1
#   ]

# func jarvisDist*(i: var Image, x, y: int, r, g, b: float32) =
#   i.addErrors x, y, r, g, b, 48.0, [
#     1, 0, 7,
#     2, 0, 5,
#     -2, 1, 3,
#     -1, 1, 5,
#     0, 1, 7,
#     1, 1, 5,
#     2, 1, 3,
#     -2, 2, 1,
#     -1, 2, 3,
#     0, 2, 5,
#     1, 2, 3,
#     2, 2, 1
#   ]

# func stuckiDist*(i: var Image, x, y: int, r, g, b: float32) =
#   i.addErrors x, y, r, g, b, 42.0, [
#     1, 0, 8,
#     2, 0, 4,
#     -2, 1, 2,
#     -1, 1, 4,
#     0, 1, 8,
#     1, 1, 4,
#     2, 1, 2,
#     -2, 2, 1,
#     -1, 2, 2,
#     0, 2, 4,
#     1, 2, 2,
#     2, 2, 1
#   ]

