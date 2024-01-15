import math, pixie

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
