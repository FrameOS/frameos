import std/[base64, unittest, uri]
import pixie
import pixie/fileformats/png

import ../image

proc pixel(image: Image, x, y: int): ColorRGBX =
  image.data[image.dataIndex(x, y)]

suite "image helpers":
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

  test "rotateDegrees keeps dimensions and remaps pixels for right angles":
    let src = newImage(2, 3)
    for y in 0 ..< src.height:
      for x in 0 ..< src.width:
        let idx = src.dataIndex(x, y)
        src.data[idx].r = uint8(10 + x + y * src.width)
        src.data[idx].a = 255

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
