import std/unittest
import pixie

import ../app
import frameos/types

proc pixel(image: Image, x, y: int): ColorRGBX =
  image.data[image.dataIndex(x, y)]

proc makeFrameConfig(width = 10, height = 8, rotate = 0): FrameConfig =
  FrameConfig(width: width, height: height, rotate: rotate)

suite "data/newImage app":
  test "uses explicit width and height when provided":
    let app = App(
      frameConfig: makeFrameConfig(10, 8),
      appConfig: AppConfig(
        color: parseHtmlColor("#224466"),
        width: 3,
        height: 2,
        opacity: 1.0,
        renderNext: 0.NodeId
      )
    )

    let outputImage = app.get(ExecutionContext(hasImage: false))
    check outputImage.width == 3
    check outputImage.height == 2
    check pixel(outputImage, 0, 0).r == 0x22
    check pixel(outputImage, 0, 0).g == 0x44
    check pixel(outputImage, 0, 0).b == 0x66

  test "falls back to input image dimensions when width and height are zero":
    let app = App(
      frameConfig: makeFrameConfig(10, 8),
      appConfig: AppConfig(
        color: parseHtmlColor("#abcdef"),
        width: 0,
        height: 0,
        opacity: 1.0,
        renderNext: 0.NodeId
      )
    )
    let context = ExecutionContext(image: newImage(6, 5), hasImage: true)

    let outputImage = app.get(context)
    check outputImage.width == 6
    check outputImage.height == 5

  test "falls back to rotated frame render dimensions when no input image":
    let app = App(
      frameConfig: makeFrameConfig(width = 7, height = 4, rotate = 90),
      appConfig: AppConfig(
        color: parseHtmlColor("#ffffff"),
        width: 0,
        height: 0,
        opacity: 1.0,
        renderNext: 0.NodeId
      )
    )

    let outputImage = app.get(ExecutionContext(hasImage: false))
    check outputImage.width == 4
    check outputImage.height == 7

  test "applies opacity for partial and zero alpha":
    let appPartial = App(
      frameConfig: makeFrameConfig(),
      appConfig: AppConfig(
        color: parseHtmlColor("#ff0000"),
        width: 2,
        height: 2,
        opacity: 0.5,
        renderNext: 0.NodeId
      )
    )
    let partialImage = appPartial.get(ExecutionContext())
    check pixel(partialImage, 1, 1).r in 127'u8..128'u8
    check pixel(partialImage, 1, 1).a in 127'u8..128'u8

    let appZero = App(
      frameConfig: makeFrameConfig(),
      appConfig: AppConfig(
        color: parseHtmlColor("#00ff00"),
        width: 2,
        height: 2,
        opacity: 0.0,
        renderNext: 0.NodeId
      )
    )
    let zeroImage = appZero.get(ExecutionContext())
    check pixel(zeroImage, 0, 0).a == 0

  test "executes renderNext and propagates nextSleep":
    var called = false
    var calledNodeId = 0.NodeId
    var sawParentContext = false

    let frameScene = FrameScene(
      execNode: proc(nodeId: NodeId, context: ExecutionContext) =
        called = true
        calledNodeId = nodeId
        sawParentContext = context.parent != nil
        context.nextSleep = 42.5
    )

    let app = App(
      scene: frameScene,
      frameConfig: makeFrameConfig(),
      appConfig: AppConfig(
        color: parseHtmlColor("#123456"),
        width: 3,
        height: 3,
        opacity: 1.0,
        renderNext: 11.NodeId
      )
    )
    let context = ExecutionContext(scene: frameScene, hasImage: false, nextSleep: 2.0)

    discard app.get(context)

    check called
    check calledNodeId == 11.NodeId
    check sawParentContext
    check context.nextSleep == 42.5
