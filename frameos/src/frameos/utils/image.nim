import pixie
import httpclient

import frameos/utils/font

proc downloadImage*(url: string): Image =
  let client = newHttpClient(timeout = 30000)
  try:
    let content = client.getContent(url)
    result = decodeImage(content)
  finally:
    client.close()

proc rotateDegrees*(image: Image, degrees: int): Image {.raises: [PixieError].} =
  case (degrees + 1080) mod 360: # TODO: yuck
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

proc writeError*(image: Image, width, height: int, message: string) =
  let typeface = getDefaultTypeface()
  let font = newFont(typeface, 32, parseHtmlColor("#000000"))
  let borderFont = newFont(typeface, 32, parseHtmlColor("#ffffff"))
  let padding = 10.0
  let types = typeset(
      spans = [newSpan(message, font)],
      bounds = vec2(width.toFloat() - 2 * padding,
      height.toFloat() - 2 * padding),
      hAlign = CenterAlign,
      vAlign = MiddleAlign,
    )
  let borderTypes = typeset(
      spans = [newSpan(message, borderFont)],
      bounds = vec2(width.toFloat() - 2 * padding,
      height.toFloat() - 2 * padding),
      hAlign = CenterAlign,
      vAlign = MiddleAlign,
    )
  image.strokeText(borderTypes, translate(vec2(padding, padding)), strokeWidth = 2)
  image.fillText(types, translate(vec2(padding, padding)))

proc renderError*(width, height: int, message: string): Image =
  result = newImage(width, height)
  result.fill(parseHtmlColor("#ffffff"))
  writeError(result, width, height, message)

proc scaleAndDrawImage*(targetImage: Image, srcImage: Image, scalingMode: string, offsetX: int = 0,
    offsetY: int = 0, blendMode: BlendMode = OverwriteBlend) {.raises: [PixieError].} =
  if srcImage.width == targetImage.width and srcImage.height ==
      targetImage.height:
    if offsetX != 0 or offsetY != 0:
      targetImage.draw(srcImage, translate(vec2(offsetX.float32, offsetY.float32)), blendMode)
    else:
      targetImage.draw(srcImage, blendMode = blendMode)
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
        translate(vec2(-xOffset + offsetX.float32, -yOffset + offsetY.float32)) * scale(vec2(scaleRatio,
            scaleRatio)),
        blendMode
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
        scale(vec2(scaleRatio, scaleRatio)) * translate(vec2(xOffset + offsetX.float32, yOffset + offsetY.float32)),
        blendMode
      )

    of "stretch":
      targetImage.draw(
        srcImage,
        scale(vec2(
          targetImage.width.float32 / srcImage.width.float32,
          targetImage.height.float32 / srcImage.height.float32
        )) * translate(vec2(offsetX.float32, offsetY.float32)),
        blendMode
      )

    of "tiled":
      targetImage.drawTiled(srcImage, translate(vec2(offsetX.float32, offsetY.float32)))

    of "top-left":
      targetImage.draw(srcImage, translate(vec2(offsetX.float32, offsetY.float32)))

    of "top-center":
      let xOffset = (targetImage.width - srcImage.width) div 2
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, offsetY.float32)))

    of "top-right":
      let xOffset = targetImage.width - srcImage.width
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, offsetY.float32)))

    of "center-left":
      let yOffset = (targetImage.height - srcImage.height) div 2
      targetImage.draw(srcImage, translate(vec2(offsetX.float32, yOffset.float32 + offsetY.float32)))

    of "center-right":
      let yOffset = (targetImage.height - srcImage.height) div 2
      let xOffset = targetImage.width - srcImage.width
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, yOffset.float32 + offsetY.float32)))

    of "bottom-left":
      let yOffset = targetImage.height - srcImage.height
      targetImage.draw(srcImage, translate(vec2(offsetX.float32, yOffset.float32 + offsetY.float32)))

    of "bottom-center":
      let xOffset = (targetImage.width - srcImage.width) div 2
      let yOffset = targetImage.height - srcImage.height
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, yOffset.float32 + offsetY.float32)))

    of "bottom-right":
      let xOffset = targetImage.width - srcImage.width
      let yOffset = targetImage.height - srcImage.height
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, yOffset.float32 + offsetY.float32)))

    else: # "center"
      let xOffset = (targetImage.width - srcImage.width) div 2
      let yOffset = (targetImage.height - srcImage.height) div 2
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, yOffset.float32 + offsetY.float32)))
