import std/unittest
import pixie

import ../app
import frameos/types
import frameos/utils/app_images

# The 180-degree rotation is the one that preserves dimensions, and therefore
# the one this app's `forwardsTarget` declaration covers: when the planner
# cleared the node to mutate in place, two flips ARE the rotation and no
# bounding-box image is allocated. Every other angle keeps the allocating
# path, and 180 without clearance must keep it too — the input may be a node
# cache's value.

proc pixelAt(image: Image, x, y: int): ColorRGBX =
  image.data[image.dataIndex(x, y)]

proc gradientImage(width, height: int): Image =
  result = newImage(width, height)
  for y in 0 ..< height:
    for x in 0 ..< width:
      result.data[result.dataIndex(x, y)] =
        rgbx(uint8(x * 40), uint8(y * 40), 0, 255)

suite "data/rotateImage app":
  test "cleared 180 rotates the very same image in place":
    let source = gradientImage(3, 2)
    let topLeft = pixelAt(source, 0, 0)
    let app = App(
      nodeId: 7.NodeId,
      frameConfig: FrameConfig(width: 3, height: 2),
      appConfig: AppConfig(rotationDegree: 180.0, image: source)
    )
    let context = ExecutionContext(inPlaceImageNodes: @[7.NodeId])
    let output = app.get(context)
    check output == source # the same image, not a copy
    check pixelAt(output, 2, 1) == topLeft # and it really rotated

  test "180 without clearance still allocates, leaving the input alone":
    let source = gradientImage(3, 2)
    let topLeft = pixelAt(source, 0, 0)
    let app = App(
      nodeId: 7.NodeId,
      frameConfig: FrameConfig(width: 3, height: 2),
      appConfig: AppConfig(rotationDegree: 180.0, image: source)
    )
    let output = app.get(ExecutionContext())
    check output != source
    check pixelAt(source, 0, 0) == topLeft # input untouched
    check pixelAt(output, 2, 1) == topLeft # output rotated

  test "in-place and allocating 180 agree on every pixel":
    let a = gradientImage(4, 3)
    let b = gradientImage(4, 3)
    let inPlace = App(nodeId: 7.NodeId, frameConfig: FrameConfig(width: 4, height: 3),
      appConfig: AppConfig(rotationDegree: 180.0, image: a))
      .get(ExecutionContext(inPlaceImageNodes: @[7.NodeId]))
    let allocated = App(nodeId: 7.NodeId, frameConfig: FrameConfig(width: 4, height: 3),
      appConfig: AppConfig(rotationDegree: 180.0, image: b))
      .get(ExecutionContext())
    check inPlace.width == allocated.width and inPlace.height == allocated.height
    for y in 0 ..< inPlace.height:
      for x in 0 ..< inPlace.width:
        check pixelAt(inPlace, x, y) == pixelAt(allocated, x, y)

  test "90 keeps the allocating path even when cleared":
    let source = gradientImage(3, 2)
    let app = App(
      nodeId: 7.NodeId,
      frameConfig: FrameConfig(width: 3, height: 2),
      appConfig: AppConfig(rotationDegree: 90.0, image: source)
    )
    let output = app.get(ExecutionContext(inPlaceImageNodes: @[7.NodeId]))
    check output != source
    check output.width == 2 and output.height == 3
