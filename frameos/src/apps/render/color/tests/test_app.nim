import std/[options, unittest]
import pixie

import ../app
import frameos/types

proc makeConfig(width = 4, height = 3): FrameConfig =
  FrameConfig(width: width, height: height, rotate: 0)

proc pixel(image: Image, x, y: int): ColorRGBX =
  image.data[image.dataIndex(x, y)]

suite "render/color app":
  test "get fills output image with configured color":
    let app = App(
      frameConfig: makeConfig(),
      appConfig: AppConfig(color: parseHtmlColor("#123456"), inputImage: none(Image))
    )

    let image = app.get(ExecutionContext(hasImage: false))
    check image.width == 4
    check image.height == 3
    check pixel(image, 0, 0).r == 0x12
    check pixel(image, 0, 0).g == 0x34
    check pixel(image, 0, 0).b == 0x56

  test "run updates context image in place":
    let app = App(
      frameConfig: makeConfig(2, 2),
      appConfig: AppConfig(color: parseHtmlColor("#abcdef"), inputImage: none(Image))
    )
    let context = ExecutionContext(image: newImage(2, 2), hasImage: true)

    app.run(context)

    check pixel(context.image, 1, 1).r == 0xAB
    check pixel(context.image, 1, 1).g == 0xCD
    check pixel(context.image, 1, 1).b == 0xEF
