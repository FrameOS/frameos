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

  test "the firmware's fast linear fill matches pixie's within a color level":
    for (angle, w, h) in [(45.0, 480, 480), (90.0, 300, 200), (0.0, 200, 300), (135.0, 640, 360)]:
      let startColor = parseHtmlColor("#1e3a8a")
      let endColor = parseHtmlColor("#f59e0b")
      let handles = angleToPoints(angle, w.float, h.float)
      let reference = newImage(w, h)
      let paint = newPaint(LinearGradientPaint)
      paint.gradientStops = @[ColorStop(color: startColor, position: 0), ColorStop(color: endColor, position: 1.0)]
      paint.gradientHandlePositions = handles
      reference.fillGradient(paint)
      let fast = newImage(w, h)
      fillLinearFast(fast, startColor, endColor, handles[0], handles[1])
      var worst = 0
      for i in 0 ..< w * h:
        let a = reference.getPixel(i)
        let b = fast.getPixel(i)
        worst = max(worst, max(max(abs(a.r.int - b.r.int), abs(a.g.int - b.g.int)), abs(a.b.int - b.b.int)))
      check worst <= 1
