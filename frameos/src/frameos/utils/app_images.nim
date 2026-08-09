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

proc scaledDecodeFit*(scalingMode: string): ScaledDecodeFit =
  ## Decode-time fit for a placement string, for decoding straight into a
  ## consumer-sized target on embedded builds.
  case scalingMode
  of "contain": fitContain
  of "stretch": fitStretch
  else: fitCover

proc scaledDecodeFitForFrame*(frameConfig: FrameConfig): ScaledDecodeFit =
  ## The decode-time fit that best matches the frame's scaling mode when an
  ## image is decoded straight into a region-sized target on embedded builds.
  ## Hosts decode downloads at native resolution, so the fit only applies
  ## on embedded targets.
  ##
  ## Only a fallback: when a consumer is going to place the image itself, its
  ## placement decides, through context.decodeTargetScalingMode. The frame's
  ## mode says nothing about what a particular node wants.
  if frameConfig.isNil:
    return fitCover
  scaledDecodeFit(frameConfig.scalingMode)

proc downloadImageForTarget*(url: string, maxBytes: int, target: Image = nil,
    headers: seq[SimpleHttpHeader] = @[], fit = fitCover): Image =
  if not target.isNil:
    return downloadImageInto(url, target, maxBytes = maxBytes, headers = headers, fit = fit)
  downloadImage(url, maxBytes = maxBytes, headers = headers)

proc downloadImageWithDataForContext*(self: AppRoot, context: ExecutionContext, url: string,
    maxBytes = 0, headers: seq[SimpleHttpHeader] = @[], fallbackWidth = 0,
    fallbackHeight = 0): tuple[image: Image, data: string] =
  ## Downloads an image for an app that produces one.
  ##
  ## On embedded this can decode straight into the consumer's canvas, which
  ## keeps peak memory at the decode intermediates — but only when the
  ## interpreter has said so by setting context.decodeTargetImage, because
  ## only the interpreter knows what the consumer will do with the result.
  ##
  ## It used to decode into context.image unconditionally, with the fit taken
  ## from the FRAME's scalingMode. That silently cropped: the XKCD scene asks
  ## render/image for `placement: "contain"`, and got cover, because the frame
  ## default (hardcoded "cover" on ESP32) decided instead of the node. The
  ## image arrived pre-cropped and already canvas-sized, so render/image drew
  ## it 1:1 and its placement did nothing. The same happened to any consumer
  ## that was not a full-frame draw at all. Hosts never had the bug: they skip
  ## decode-into-target entirely and let the consumer place the image.
  ##
  ## With no hint, decode to display bounds instead — aspect preserved, no
  ## crop, and still bounded for a small device.
  let byteLimit =
    if maxBytes > 0: maxBytes
    else: self.maxImageResponseBytes()

  # Consume the hint: it is for this decode only, and must not leak into a
  # sibling producer that runs later under the same context.
  let decodeTarget = context.decodeTargetImage
  let decodeScalingMode = context.decodeTargetScalingMode
  if not decodeTarget.isNil:
    context.decodeTargetImage = nil
    context.decodeTargetScalingMode = ""

  if decodeTarget.isNil:
    return downloadImageWithData(url, maxBytes = byteLimit, headers = headers)

  downloadImageWithDataInto(
    url,
    decodeTarget,
    maxBytes = byteLimit,
    headers = headers,
    fit = scaledDecodeFit(decodeScalingMode)
  )
