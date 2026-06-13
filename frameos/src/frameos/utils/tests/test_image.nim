import std/[base64, options, unittest, uri]
import pixie
import pixie/fileformats/png

import ../image

when defined(frameosEmbedded):
  import std/os

proc pixel(image: Image, x, y: int): ColorRGBX =
  image.data[image.dataIndex(x, y)]

proc testImage(width = 2, height = 2): Image =
  result = newImage(width, height)
  for y in 0 ..< result.height:
    for x in 0 ..< result.width:
      let idx = result.dataIndex(x, y)
      result.data[idx].r = uint8(10 + x + y * result.width)
      result.data[idx].a = 255

suite "image helpers":
  test "effective runtime image engine resolves blank default to pixie":
    setRuntimeImageEngine("")
    check getRuntimeImageEngine() == ""
    check getEffectiveRuntimeImageEngine() == "pixie"

    setRuntimeImageEngine("imagemagick")
    check getRuntimeImageEngine() == "imagemagick"
    check getEffectiveRuntimeImageEngine() == "imagemagick"

    setRuntimeImageEngine("")

  test "decodeDataUrl supports base64 and plain payloads and rejects invalid urls":
    let source = newImage(1, 1)
    source.fill(rgba(255, 0, 0, 255))
    let pngData = encodePng(source.width, source.height, 4, source.data[0].addr, source.data.len * 4)
    let pngBase64 = encode(pngData)
    let base64Image = decodeDataUrl("data:image/png;base64," & pngBase64)
    check base64Image.width == 1
    check base64Image.height == 1

    let ppm = "P3\n1 1\n255\n0 255 0\n"
    let plainImage = decodeDataUrl("data:image/x-portable-pixmap," & encodeUrl(ppm))
    check plainImage.width == 1
    check plainImage.height == 1

    expect(ValueError):
      discard decodeDataUrl("http://example.com/not-a-data-url")
    expect(ValueError):
      discard decodeDataUrl("data:image/png;base64")

  when defined(frameosEmbedded):
    test "embedded pointer decoder accepts guarded small JPEGs":
      let fixture = "../../pixie/tests/fileformats/jpeg/masters/8x8.jpg"
      if fileExists(fixture):
        let data = readFile(fixture)
        let image = decodeImageWithFallback(data.cstring, data.len)
        check image.width == 8
        check image.height == 8

  test "decodeSvgWithFallback defaults to pixie and honors target dimensions":
    let image = decodeSvgWithFallback(
      """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>""",
      4,
      3,
    )
    check image.isSome
    check image.get().width == 4
    check image.get().height == 3

  test "rotateDegrees keeps dimensions and remaps pixels for right angles":
    let src = testImage(2, 3)

    let rot90 = rotateDegrees(src, 90)
    check rot90.width == 3
    check rot90.height == 2
    check pixel(rot90, 0, 0).r == pixel(src, 0, 2).r
    check pixel(rot90, 2, 1).r == pixel(src, 1, 0).r

    let rot180 = rotateDegrees(src, 180)
    check rot180.width == 2
    check rot180.height == 3
    check pixel(rot180, 0, 0).r == pixel(src, 1, 2).r
    check pixel(rot180, 1, 2).r == pixel(src, 0, 0).r

    let rot270 = rotateDegrees(src, 270)
    check rot270.width == 3
    check rot270.height == 2
    check pixel(rot270, 0, 0).r == pixel(src, 1, 0).r
    check pixel(rot270, 2, 1).r == pixel(src, 0, 2).r

  test "previewTransform restores driver images for preview":
    let original = testImage()

    var horizontal = testImage()
    horizontal.flipHorizontal()
    let restoredHorizontal = horizontal.previewTransform(0, "horizontal")
    check pixel(restoredHorizontal, 0, 0).r == pixel(original, 0, 0).r
    check pixel(restoredHorizontal, 1, 1).r == pixel(original, 1, 1).r

    var vertical = testImage()
    vertical.flipVertical()
    let restoredVertical = vertical.previewTransform(0, "vertical")
    check pixel(restoredVertical, 0, 0).r == pixel(original, 0, 0).r
    check pixel(restoredVertical, 1, 1).r == pixel(original, 1, 1).r

    var both = testImage()
    both.flipHorizontal()
    both.flipVertical()
    let restoredBoth = both.previewTransform(0, "both")
    check pixel(restoredBoth, 0, 0).r == pixel(original, 0, 0).r
    check pixel(restoredBoth, 1, 1).r == pixel(original, 1, 1).r

    var unchanged = testImage()
    check unchanged.previewTransform(0, "unknown").data == original.data

  test "previewTransform handles inverse rotation before preview flip":
    let original = testImage(2, 3)
    var deviceInput = testImage(2, 3)
    deviceInput.flipHorizontal()
    var deviceImage = deviceInput.rotateDegrees(90)
    let preview = deviceImage.previewTransform(270, "horizontal")

    check preview.width == original.width
    check preview.height == original.height
    check preview.data == original.data

  test "previewSourceIndex matches previewTransform coordinates":
    for width in [2, 3]:
      for height in [2, 3]:
        let source = testImage(width, height)
        for rotate in [0, 90, 180, 270]:
          for flip in ["", "horizontal", "vertical", "both"]:
            var transformed = source.copy()
            let preview = transformed.previewTransform(rotate, flip)
            let dimensions = previewDimensions(width, height, rotate)
            check preview.width == dimensions.width
            check preview.height == dimensions.height
            for y in 0 ..< dimensions.height:
              for x in 0 ..< dimensions.width:
                let sourceIndex = previewSourceIndex(x, y, width, height, rotate, flip)
                check preview.data[preview.dataIndex(x, y)] == source.data[sourceIndex]

  test "scaleAndDrawImage places content for contain cover stretch center and corner anchors":
    let red = rgba(255, 0, 0, 255)

    var srcContain = newImage(2, 1)
    srcContain.fill(red)
    var containTarget = newImage(4, 4)
    containTarget.scaleAndDrawImage(srcContain, "contain")
    check pixel(containTarget, 0, 0).a == 0
    check pixel(containTarget, 1, 2).a > 0
    check pixel(containTarget, 0, 3).a == 0

    var coverTarget = newImage(4, 4)
    coverTarget.scaleAndDrawImage(srcContain, "cover")
    check pixel(coverTarget, 0, 0).a > 0
    check pixel(coverTarget, 3, 3).a > 0

    var stretchTarget = newImage(4, 4)
    stretchTarget.scaleAndDrawImage(srcContain, "stretch")
    check pixel(stretchTarget, 0, 0).a > 0
    check pixel(stretchTarget, 3, 3).a > 0

    let anchorSrc = newImage(1, 1)
    anchorSrc.fill(red)

    var centerTarget = newImage(3, 3)
    centerTarget.scaleAndDrawImage(anchorSrc, "center")
    check pixel(centerTarget, 1, 1).r == 255

    var topLeftTarget = newImage(3, 3)
    topLeftTarget.scaleAndDrawImage(anchorSrc, "top-left")
    check pixel(topLeftTarget, 0, 0).r == 255

    var bottomRightTarget = newImage(3, 3)
    bottomRightTarget.scaleAndDrawImage(anchorSrc, "bottom-right")
    check pixel(bottomRightTarget, 2, 2).r == 255
