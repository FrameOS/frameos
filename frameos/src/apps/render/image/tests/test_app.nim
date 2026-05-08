import std/[json, options, unittest]
import pixie

import ../app
import frameos/types

proc makeConfig(width = 6, height = 4): FrameConfig =
  FrameConfig(width: width, height: height, rotate: 0)

proc makeScene(config: FrameConfig): FrameScene =
  FrameScene(
    frameConfig: config,
    logger: Logger(log: proc(payload: JsonNode) = discard)
  )

proc pixel(image: Image, x, y: int): ColorRGBX =
  image.data[image.dataIndex(x, y)]

suite "render/image app":
  test "get falls back to frame dimensions when no input image or context image":
    let source = newImage(1, 1)
    source.data[0] = rgbx(10, 20, 30, 255)
    let config = makeConfig(5, 3)
    let app = App(
      frameConfig: config,
      scene: makeScene(config),
      appConfig: AppConfig(
        inputImage: none(Image),
        image: source,
        placement: "stretch",
        offsetX: 0,
        offsetY: 0,
        blendMode: "normal"
      )
    )

    let output = app.get(ExecutionContext(hasImage: false))
    check output.width == 5
    check output.height == 3
    let sample = pixel(output, 4, 2)
    check sample.r > 0
    check sample.g > 0
    check sample.b > 0

  test "run renders onto context image in place":
    let source = newImage(1, 1)
    source.data[0] = rgbx(200, 100, 50, 255)
    let config = makeConfig(3, 2)
    let app = App(
      frameConfig: config,
      scene: makeScene(config),
      appConfig: AppConfig(
        inputImage: none(Image),
        image: source,
        placement: "stretch",
        offsetX: 0,
        offsetY: 0,
        blendMode: "normal"
      )
    )
    let context = ExecutionContext(image: newImage(3, 2), hasImage: true)

    app.run(context)

    let sample = pixel(context.image, 2, 1)
    check sample.r > 0
    check sample.g > 0
    check sample.b > 0

  test "missing source image is handled by error path without raising":
    let config = makeConfig(4, 3)
    let app = App(
      frameConfig: config,
      scene: makeScene(config),
      appConfig: AppConfig(
        inputImage: none(Image),
        image: nil,
        placement: "cover",
        offsetX: 0,
        offsetY: 0,
        blendMode: "normal"
      )
    )

    let output = app.get(ExecutionContext(hasImage: false))
    check output.width == 4
    check output.height == 3
