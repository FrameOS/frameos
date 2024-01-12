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

  # The 7.5" waveshare frame displays weird artifacts without this. Whilte colors bleed from top to bottom if neither of these is blanked.
  # TODO: turn this into an option you can toggle
  for y in 0..<width:
    image[y] = 1
    image[y + width * (height - 1)] = 1
