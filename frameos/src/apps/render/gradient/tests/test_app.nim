import std/[options, unittest]
import pixie

import ../app
import frameos/types

proc makeConfig(width = 5, height = 5): FrameConfig =
  FrameConfig(width: width, height: height, rotate: 0)

proc pixel(image: Image, x, y: int): ColorRGBX =
  image.data[image.dataIndex(x, y)]

suite "render/gradient app":
  test "gradient respects direction and configured colors":
    let app = App(
      frameConfig: makeConfig(7, 3),
      appConfig: AppConfig(
        inputImage: none(Image),
        startColor: parseHtmlColor("#000000"),
        endColor: parseHtmlColor("#ffffff"),
        angle: 0,
      )
    )

    let horizontal = app.get(ExecutionContext(hasImage: false))
    check pixel(horizontal, 0, 1).r < pixel(horizontal, 6, 1).r

    app.appConfig.angle = 90
    let vertical = app.get(ExecutionContext(hasImage: false))
    check pixel(vertical, 3, 0).r < pixel(vertical, 3, 2).r

  test "run renders into provided context image":
    let app = App(
      frameConfig: makeConfig(4, 4),
      appConfig: AppConfig(
        inputImage: none(Image),
        startColor: parseHtmlColor("#ff0000"),
        endColor: parseHtmlColor("#0000ff"),
        angle: 0,
      )
    )
    let context = ExecutionContext(image: newImage(4, 4), hasImage: true)

    app.run(context)

    check pixel(context.image, 0, 2).r > pixel(context.image, 3, 2).r
