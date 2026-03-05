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

suite "render/svg app":
  test "empty svg string routes through error handling without raising":
    let config = makeConfig(5, 3)
    let app = App(
      frameConfig: config,
      scene: makeScene(config),
      appConfig: AppConfig(
        inputImage: none(Image),
        svg: "",
        placement: "cover",
        offsetX: 0,
        offsetY: 0,
        blendMode: "normal"
      )
    )

    let output = app.get(ExecutionContext(hasImage: false))
    check output.width == 5
    check output.height == 3

  test "invalid data url input is caught by render error path":
    let config = makeConfig(4, 2)
    let app = App(
      frameConfig: config,
      scene: makeScene(config),
      appConfig: AppConfig(
        inputImage: none(Image),
        svg: "data:image/svg+xml;base64",
        placement: "stretch",
        offsetX: 0,
        offsetY: 0,
        blendMode: "normal"
      )
    )

    let context = ExecutionContext(image: newImage(4, 2), hasImage: true)
    app.run(context)
    check context.image.width == 4
    check context.image.height == 2
