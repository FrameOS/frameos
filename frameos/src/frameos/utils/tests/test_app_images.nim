import std/[base64, unittest]
import pixie
import pixie/fileformats/png

import frameos/types
import ../app_images

proc pngDataUrl(width, height: int): string =
  let source = newImage(width, height)
  source.fill(rgba(255, 0, 0, 255))
  let pngData = encodePng(source.width, source.height, 4, source.data[0].addr, source.dataLen * 4)
  "data:image/png;base64," & encode(pngData)

suite "app image helpers":
  test "downloadImageForTarget keeps native size so placement can crop":
    # A pre-scaled image would break render/image placement (center, cover,
    # contain) and distort the aspect ratio, so outside embedded builds the
    # target must not influence decoding.
    let url = pngDataUrl(12, 34)
    let target = newImage(4, 4)
    let image = downloadImageForTarget(url, maxBytes = 1024 * 1024, target = target)
    when defined(frameosEmbedded):
      check image.width == target.width
      check image.height == target.height
    else:
      check image.width == 12
      check image.height == 34

  test "downloadImageForTarget without target decodes at native size":
    let url = pngDataUrl(5, 7)
    let image = downloadImageForTarget(url, maxBytes = 1024 * 1024)
    check image.width == 5
    check image.height == 7

  test "scaledDecodeFitForFrame maps frame scaling modes to aspect-preserving fits":
    check scaledDecodeFitForFrame(nil) == fitCover
    check scaledDecodeFitForFrame(FrameConfig(scalingMode: "cover")) == fitCover
    check scaledDecodeFitForFrame(FrameConfig(scalingMode: "contain")) == fitContain
    check scaledDecodeFitForFrame(FrameConfig(scalingMode: "stretch")) == fitStretch
    check scaledDecodeFitForFrame(FrameConfig(scalingMode: "center")) == fitCover
    check scaledDecodeFitForFrame(FrameConfig(scalingMode: "")) == fitCover

suite "decode target handshake":
  # The target travels on the shared ExecutionContext, so it has to be
  # addressed. Otherwise any producer that happened to run while one was in
  # flight — a sibling input, a node deeper in an unrelated branch — could take
  # a canvas planned for a different edge and render into the wrong place.

  proc app(nodeId: int): AppRoot = AppRoot(nodeId: nodeId.NodeId)

  test "only the node the planner named may take the target":
    let canvas = newImage(8, 4)
    let context = ExecutionContext(
      image: canvas, hasImage: true,
      decodeTargetImage: canvas, decodeTargetScalingMode: "contain",
      decodeTargetNodeId: 3.NodeId
    )

    let (strangerTarget, _) = app(5).takeDecodeTarget(context)
    check strangerTarget.isNil
    check not context.decodeTargetImage.isNil # still in flight for its owner

    let (ownTarget, fit) = app(3).takeDecodeTarget(context)
    check ownTarget == canvas
    check fit == "contain"
    check context.decodeTargetImage.isNil # one-shot
    check context.decodeTargetNodeId == 0.NodeId

  test "an unaddressed target is taken by whoever asks":
    # Contexts built outside the interpreter (app tests, embedded callers) do
    # not name a node; those keep the old broadcast behaviour.
    let canvas = newImage(8, 4)
    let context = ExecutionContext(
      image: canvas, hasImage: true,
      decodeTargetImage: canvas, decodeTargetScalingMode: "cover"
    )
    let (target, _) = app(9).takeDecodeTarget(context)
    check target == canvas

  test "in-place mutation needs the target to have been taken first":
    let canvas = newImage(8, 4)
    let context = ExecutionContext(
      image: canvas, hasImage: true,
      decodeTargetWidth: 8, decodeTargetHeight: 4,
      decodeTargetScalingMode: "cover", decodeTargetNodeId: 3.NodeId,
      inPlaceImageNodes: @[4.NodeId]
    )
    # Hint still in flight: the producer has not run, so the image a
    # transformer holds is not one the chain owns.
    check not app(4).mayMutateImageInPlace(context)

    discard app(3).takeDecodeTarget(context)
    check app(4).mayMutateImageInPlace(context)
    check not app(5).mayMutateImageInPlace(context)
