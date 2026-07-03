import std/[base64, unittest]
import pixie
import pixie/fileformats/png

import frameos/types
import ../app_images

proc pngDataUrl(width, height: int): string =
  let source = newImage(width, height)
  source.fill(rgba(255, 0, 0, 255))
  let pngData = encodePng(source.width, source.height, 4, source.data[0].addr, source.data.len * 4)
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
