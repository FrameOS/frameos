import std/[math, unittest]
import pixie

import ../app
import frameos/types

proc expectedDims(w, h: int, degree: float): (int, int) =
  let angle = degToRad(degree).float32
  let cosA = abs(cos(angle))
  let sinA = abs(sin(angle))
  (
    int(ceil(w.float32 * cosA + h.float32 * sinA)),
    int(ceil(w.float32 * sinA + h.float32 * cosA))
  )

suite "data/rotateImage app":
  test "output dimensions match canonical and arbitrary angles":
    let src = newImage(10, 4)
    let degrees = @[0.0, 90.0, 180.0, 270.0, 45.0]

    for degree in degrees:
      let app = App(appConfig: AppConfig(image: src, rotationDegree: degree, scalingMode: ""))
      let outputImage = app.get(ExecutionContext())
      let (expectedW, expectedH) = expectedDims(10, 4, degree)
      check outputImage.width == expectedW
      check outputImage.height == expectedH
