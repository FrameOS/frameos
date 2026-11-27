import std/[options, unittest]
import pixie

import ../app
import frameos/types
import frameos/panel_shape

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
    for i in 0 ..< context.image.dataLen:
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

  test "the scene's render scale makes the text larger, with no scene the frame's own pixels":
    let config = makeConfig(2000, 400)
    let plain = makeTextApp(config, "FrameOS").get(ExecutionContext(hasImage: false))
    let app = makeTextApp(config, "FrameOS")
    app.scene = FrameScene(frameConfig: config, renderScaleSetting: 2.0)
    let scaled = app.get(ExecutionContext(hasImage: false))
    check abs(scaled.width - 2 * plain.width) <= 4
    check abs(scaled.height - 2 * plain.height) <= 4
    # The runner's own text (no scene) at a frame scale of 2: as it was.
    let frame = makeConfig(2000, 400)
    frame.renderScale = 2.0
    check makeTextApp(frame, "FrameOS").get(ExecutionContext(hasImage: false)).width == plain.width

suite "render/text on a round panel":
  # Only the circle inside the canvas shows (panel_shape.nim): text drawn on
  # the whole canvas stays inside it, a setup note in the middle as wide as
  # the circle is where it stands, text pinned to a corner in the square
  # inside it. Laid out from the canvas's corner, its first words were under
  # the bezel (the UX bench, 2026-11-27).
  proc inked(image: Image): tuple[minX, minY, maxX, maxY: int] =
    result = (image.width, image.height, -1, -1)
    for y in 0 ..< image.height:
      for x in 0 ..< image.width:
        if image[x, y].a > 0:
          result.minX = min(result.minX, x)
          result.minY = min(result.minY, y)
          result.maxX = max(result.maxX, x)
          result.maxY = max(result.maxY, y)

  proc outsideCircle(image: Image): int =
    for y in 0 ..< image.height:
      for x in 0 ..< image.width:
        if image[x, y].a > 0 and not insideRound(image.width, image.height, x, y):
          inc result

  test "text in a corner is drawn in the square inside the circle":
    let config = FrameConfig(width: 360, height: 360, rotate: 0, assetsPath: "", device: "pimoroni.hyperpixel2r")
    let app = makeTextApp(config, "Friday, November 27\nNo events found")
    app.appConfig.position = "left"
    app.appConfig.vAlign = "top"
    let context = ExecutionContext(image: newImage(360, 360), hasImage: true)
    app.run(context)
    let box = inked(context.image)
    check box.maxX > 0
    check outsideCircle(context.image) == 0
    check box.minX >= 50 and box.minY >= 50

  test "text in the middle uses the circle's width there":
    let config = FrameConfig(width: 360, height: 360, rotate: 0, assetsPath: "", device: "pimoroni.hyperpixel2r")
    let app = makeTextApp(config, "Please provide an OpenAI API key in the settings.")
    let context = ExecutionContext(image: newImage(360, 360), hasImage: true)
    app.run(context)
    check outsideCircle(context.image) == 0
    let box = inked(context.image)
    # Wider than the square inside the circle (237 px of 360).
    check box.maxX - box.minX > 250

  test "a rectangle is drawn from its corner as before":
    let config = FrameConfig(width: 360, height: 360, rotate: 0, assetsPath: "", device: "framebuffer")
    let app = makeTextApp(config, "Friday, November 27")
    app.appConfig.position = "left"
    app.appConfig.vAlign = "top"
    let context = ExecutionContext(image: newImage(360, 360), hasImage: true)
    app.run(context)
    check inked(context.image).minX < 10
