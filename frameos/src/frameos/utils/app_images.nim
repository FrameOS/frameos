import pixie

import frameos/apps
import frameos/types
import frameos/utils/http_client
import frameos/utils/image

proc contextImage*(context: ExecutionContext): Image {.inline.} =
  if context != nil and context.hasImage and not context.image.isNil:
    return context.image
  nil

proc contextImageWidth*(self: AppRoot, context: ExecutionContext): int {.inline.} =
  let image = context.contextImage()
  if not image.isNil:
    return image.width
  self.frameConfig.renderWidth()

proc contextImageHeight*(self: AppRoot, context: ExecutionContext): int {.inline.} =
  let image = context.contextImage()
  if not image.isNil:
    return image.height
  self.frameConfig.renderHeight()

proc contextImageTarget*(self: AppRoot, context: ExecutionContext,
    fallbackWidth = 0, fallbackHeight = 0): Image =
  let image = context.contextImage()
  if not image.isNil:
    return image
  let width =
    if fallbackWidth > 0: fallbackWidth
    else: self.frameConfig.renderWidth()
  let height =
    if fallbackHeight > 0: fallbackHeight
    else: self.frameConfig.renderHeight()
  newImage(width, height)

proc downloadImageForTarget*(url: string, maxBytes: int, target: Image = nil,
    headers: seq[SimpleHttpHeader] = @[]): Image =
  when defined(frameosEmbedded):
    if not target.isNil:
      return downloadImageInto(url, target, maxBytes = maxBytes, headers = headers)
  downloadImage(url, maxBytes = maxBytes, headers = headers)

proc downloadImageWithDataForContext*(self: AppRoot, context: ExecutionContext, url: string,
    maxBytes = 0, headers: seq[SimpleHttpHeader] = @[], fallbackWidth = 0,
    fallbackHeight = 0): tuple[image: Image, data: string] =
  let byteLimit =
    if maxBytes > 0: maxBytes
    else: self.maxImageResponseBytes()
  when defined(frameosEmbedded):
    downloadImageWithDataInto(
      url,
      self.contextImageTarget(context, fallbackWidth, fallbackHeight),
      maxBytes = byteLimit,
      headers = headers
    )
  else:
    downloadImageWithData(url, maxBytes = byteLimit, headers = headers)
