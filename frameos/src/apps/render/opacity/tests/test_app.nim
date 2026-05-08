import std/[options, unittest]
import pixie

import ../app
import frameos/types

proc makeConfig(width = 3, height = 2): FrameConfig =
  FrameConfig(width: width, height: height, rotate: 0)

proc alphaAt(image: Image, x, y: int): uint8 =
  image.data[image.dataIndex(x, y)].a

suite "render/opacity app":
  test "get applies partial opacity to a copy of configured image":
    let source = newImage(2, 1)
    for i in 0 ..< source.data.len:
      source.data[i] = rgbx(120, 60, 30, 255)
    let app = App(
      frameConfig: makeConfig(),
      appConfig: AppConfig(image: some(source), opacity: 0.5)
    )
    check app.appConfig.opacity == 0.5

    let output = app.get(ExecutionContext(hasImage: false))
    let originalAlpha = alphaAt(source, 0, 0)
    check originalAlpha > 0
    check alphaAt(output, 0, 0) < originalAlpha
    check alphaAt(source, 0, 0) == originalAlpha

  test "run applies partial opacity to context image":
    let context = ExecutionContext(image: newImage(2, 2), hasImage: true)
    for i in 0 ..< context.image.data.len:
      context.image.data[i] = rgbx(200, 100, 50, 255)
    let app = App(frameConfig: makeConfig(), appConfig: AppConfig(opacity: 0.25))
    check app.appConfig.opacity == 0.25

    app.run(context)

    check alphaAt(context.image, 1, 1) < 255

  test "full and zero opacity branches behave deterministically":
    let base = newImage(1, 1)
    base.data[0] = rgbx(100, 100, 100, 255)

    let fullApp = App(frameConfig: makeConfig(), appConfig: AppConfig(image: some(base), opacity: 1.0))
    let fullOut = fullApp.get(ExecutionContext(hasImage: false))
    check alphaAt(fullOut, 0, 0) == 255

    let zeroApp = App(frameConfig: makeConfig(), appConfig: AppConfig(image: some(base), opacity: 0.0))
    let zeroOut = zeroApp.get(ExecutionContext(hasImage: false))
    check alphaAt(zeroOut, 0, 0) == 0
