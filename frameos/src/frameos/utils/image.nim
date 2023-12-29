
import pixie
import httpclient

import frameos/utils/font

proc downloadImage*(url: string): Image =
  let client = newHttpClient()
  try:
    let content = client.getContent(url)
    result = decodeImage(content)
  finally:
    client.close()


proc rotateDegrees*(image: Image, degrees: int): Image {.raises: [PixieError].} =
  case degrees:
  of 90:
    result = newImage(image.height, image.width)
    for y in 0 ..< result.height:
      for x in 0 ..< result.width:
        result.data[result.dataIndex(x, y)] =
          image.data[image.dataIndex(y, image.height - x - 1)]
  of 180:
    result = newImage(image.width, image.height)
    for y in 0 ..< result.height:
      for x in 0 ..< result.width:
        result.data[result.dataIndex(x, y)] =
          image.data[image.dataIndex(image.width - x - 1, image.height - y - 1)]
  of 270:
    result = newImage(image.height, image.width)
    for y in 0 ..< result.height:
      for x in 0 ..< result.width:
        result.data[result.dataIndex(x, y)] =
          image.data[image.dataIndex(image.width - y - 1, x)]
  else:
    result = image

proc renderError*(width, height: int, message: string): Image =
  let typeface = getDefaultTypeface()
  let font = newFont(typeface, 32, parseHtmlColor("#ffffff"))
  let padding = 10.0
  result = newImage(width, height)
  result.fill(parseHtmlColor("#000000"))
  result.fillText(
    typeset(
      spans = [newSpan(message, font)],
      bounds = vec2(width.toFloat() - 2 * padding,
      height.toFloat() - 2 * padding),
      hAlign = CenterAlign,
      vAlign = MiddleAlign,
    ),
    translate(vec2(padding, padding))
  )

proc scaleAndDrawImage*(targetImage: Image, srcImage: Image,
    scalingMode: string) {.raises: [PixieError].} =
  if srcImage.width == targetImage.width and srcImage.height ==
      targetImage.height:
    targetImage.draw(srcImage)
  else:
    case scalingMode:
    of "cover":
      let scaleRatio = max(
        targetImage.width.float32 / srcImage.width.float32,
        targetImage.height.float32 / srcImage.height.float32
      )
      let scaledWidth = srcImage.width.float32 * scaleRatio
      let scaledHeight = srcImage.height.float32 * scaleRatio
      let xOffset = (scaledWidth - targetImage.width.float32) / 2
      let yOffset = (scaledHeight - targetImage.height.float32) / 2
      targetImage.draw(
        srcImage,
        scale(vec2(scaleRatio, scaleRatio)) * translate(vec2(-xOffset,
            -yOffset)),
        OverwriteBlend
      )

    of "contain":
      let scaleRatio = min(
        targetImage.width.float32 / srcImage.width.float32,
        targetImage.height.float32 / srcImage.height.float32
      )
      let scaledWidth = srcImage.width.float32 * scaleRatio
      let scaledHeight = srcImage.height.float32 * scaleRatio
      let xOffset = (targetImage.width.float32 - scaledWidth) / 2
      let yOffset = (targetImage.height.float32 - scaledHeight) / 2
      targetImage.draw(
        srcImage,
        scale(vec2(scaleRatio, scaleRatio)) * translate(vec2(xOffset, yOffset)),
        OverwriteBlend
      )

    of "stretch":
      targetImage.draw(
        srcImage,
        scale(vec2(
          targetImage.width.float32 / srcImage.width.float32,
          targetImage.height.float32 / srcImage.height.float32
        )),
        OverwriteBlend
      )

    else:
      let xOffset = (targetImage.width - srcImage.width) div 2
      let yOffset = (targetImage.height - srcImage.height) div 2
      targetImage.draw(srcImage, translate(vec2(xOffset.float, yOffset.float)))
