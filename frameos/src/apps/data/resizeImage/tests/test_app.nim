import std/unittest
import pixie

import ../app
import frameos/types

proc pixel(image: Image, x, y: int): ColorRGBX =
  image.data[image.dataIndex(x, y)]

suite "data/resizeImage app":
  test "contain mode centers already-fitting source instead of scaling":
    let src = newImage(1, 1)
    src.fill(rgba(255, 0, 0, 255))
    let app = App(
      appConfig: AppConfig(image: src, width: 3, height: 3, scalingMode: "contain")
    )

    let outputImage = app.get(ExecutionContext())
    check outputImage.width == 3
    check outputImage.height == 3
    check pixel(outputImage, 1, 1).r == 255
    check pixel(outputImage, 0, 0).a == 0
    check pixel(outputImage, 2, 2).a == 0

  test "stretch mode fills full target dimensions":
    let src = newImage(2, 1)
    src.fill(rgba(0, 255, 0, 255))
    let app = App(
      appConfig: AppConfig(image: src, width: 4, height: 3, scalingMode: "stretch")
    )

    let outputImage = app.get(ExecutionContext())
    check outputImage.width == 4
    check outputImage.height == 3
    check pixel(outputImage, 0, 0).a > 0
    check pixel(outputImage, 3, 2).a > 0
