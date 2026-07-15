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

proc renderErrorForContext*(self: AppRoot, context: ExecutionContext, message: string): Image =
  ## Error frame for image producers. On embedded the producer's success path
  ## decodes straight into the context canvas, so the error path must reuse
  ## that canvas too — a second full-frame allocation next to the live canvas
  ## is exactly what OOMs a 16MB module.
  when defined(frameosEmbedded):
    let target = context.contextImage()
    if not target.isNil:
      renderErrorInto(target, target.width, target.height, message)
      return target
  renderError(self.contextImageWidth(context), self.contextImageHeight(context), message)

proc scaledDecodeFitForFrame*(frameConfig: FrameConfig): ScaledDecodeFit =
  ## The decode-time fit that best matches the frame's scaling mode when an
  ## image is decoded straight into a region-sized target on embedded builds.
  ## Hosts decode downloads at native resolution, so the fit only applies
  ## on embedded targets.
  if frameConfig.isNil:
    return fitCover
  case frameConfig.scalingMode
  of "contain": fitContain
  of "stretch": fitStretch
  else: fitCover

proc downloadImageForTarget*(url: string, maxBytes: int, target: Image = nil,
    headers: seq[SimpleHttpHeader] = @[], fit = fitCover): Image =
  if not target.isNil:
    return downloadImageInto(url, target, maxBytes = maxBytes, headers = headers, fit = fit)
  downloadImage(url, maxBytes = maxBytes, headers = headers)

proc downloadImageWithDataForContext*(self: AppRoot, context: ExecutionContext, url: string,
    maxBytes = 0, headers: seq[SimpleHttpHeader] = @[], fallbackWidth = 0,
    fallbackHeight = 0): tuple[image: Image, data: string] =
  let byteLimit =
    if maxBytes > 0: maxBytes
    else: self.maxImageResponseBytes()
  downloadImageWithDataInto(
    url,
    self.contextImageTarget(context, fallbackWidth, fallbackHeight),
    maxBytes = byteLimit,
    headers = headers,
    fit = scaledDecodeFitForFrame(self.frameConfig)
  )
