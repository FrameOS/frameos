import std/[options, unittest]
import pixie

import ../app
import frameos/types

proc makeConfig(width = 64, height = 32): FrameConfig =
  FrameConfig(width: width, height: height, rotate: 0, assetsPath: "")

proc makeTextApp(config: FrameConfig; text: string; inputImage = none(Image)): App =
  App(
    frameConfig: config,
    appConfig: AppConfig(
      inputImage: inputImage,
      text: text,
      richText: "disabled",
      position: "center",
      vAlign: "middle",
      offsetX: 0,
      offsetY: 0,
      padding: 0,
      font: "",
      fontColor: parseHtmlColor("#ffffff"),
      fontSize: 18,
      borderColor: parseHtmlColor("#000000"),
      borderWidth: 0,
      overflow: "fit-bounds"
    )
  )

suite "render/text app":
  test "run is a no-op when text is empty":
    let config = makeConfig(3, 2)
    let app = makeTextApp(config, "")
    let context = ExecutionContext(image: newImage(3, 2), hasImage: true)
    for i in 0 ..< context.image.data.len:
      context.image.data[i] = rgbx(15, 25, 35, 255)
    let before = context.image.data

    app.run(context)

    check context.image.data == before

  test "get draws on provided input image dimensions and builds cache":
    let config = makeConfig(50, 20)
    let input = newImage(40, 18)
    let app = makeTextApp(config, "Hi", some(input))

    let output = app.get(ExecutionContext(hasImage: false))

    check output.width == 40
    check output.height == 18
    check app.layout.isSome
    check app.cacheKey.isSome

  test "get without input/context returns a bounded non-empty tight image":
    let config = makeConfig(70, 24)
    let app = makeTextApp(config, "FrameOS")

    let output = app.get(ExecutionContext(hasImage: false))

    check output.width > 0
    check output.height > 0
    check output.width <= 70
    check output.height <= 24
