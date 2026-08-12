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

proc decodeTargetIsOwned*(context: ExecutionContext): bool =
  ## Whether the pending target is one the chain allocated (and so is
  ## transparent), rather than the live render canvas.
  not context.isNil and context.decodeTargetOwned

proc offeredDecodeTargetSize*(self: AppRoot, context: ExecutionContext):
    tuple[width, height: int] =
  ## The size of the target currently addressed to this node, without taking
  ## it — (0, 0) when there is none. For producers that can only claim a
  ## target of one specific size (the JS runtime's natural-size branches):
  ## taking first and checking after would consume the offer — and, on the
  ## owned tier, allocate a canvas-sized image — only to throw both away on a
  ## mismatch.
  if context.isNil:
    return (0, 0)
  if context.decodeTargetNodeId != 0.NodeId and
      (self.isNil or self.nodeId != context.decodeTargetNodeId):
    return (0, 0)
  if not context.decodeTargetImage.isNil:
    (context.decodeTargetImage.width, context.decodeTargetImage.height)
  elif context.decodeTargetWidth > 0 and context.decodeTargetHeight > 0:
    (context.decodeTargetWidth, context.decodeTargetHeight)
  else:
    (0, 0)

proc takeDecodeTarget*(self: AppRoot, context: ExecutionContext):
    tuple[image: Image, scalingMode: string] =
  ## The producer's half of the `intoTarget` handshake: consumes the target the
  ## planner addressed to this node, in either form — the live canvas
  ## (`decodeTargetImage`), or a size the producer allocates for itself
  ## (`decodeTargetWidth`/`Height`, used when the producer's own node cache
  ## would otherwise end up owning the canvas). Returns (nil, "") when there is
  ## no target for this node.
  ##
  ## Two things keep it from being a free-for-all. It is addressed: a target
  ## planned for one edge is not handed to whichever producer happens to run
  ## first under the same context. And it is one-shot: taken targets are
  ## cleared, so a sibling producer later in the same render cannot inherit it.
  if context.isNil:
    return (nil, "")
  if context.decodeTargetNodeId != 0.NodeId and
      (self.isNil or self.nodeId != context.decodeTargetNodeId):
    return (nil, "")
  let scalingMode = context.decodeTargetScalingMode
  if not context.decodeTargetImage.isNil:
    result = (context.decodeTargetImage, scalingMode)
  elif context.decodeTargetWidth > 0 and context.decodeTargetHeight > 0:
    result = (newImage(context.decodeTargetWidth, context.decodeTargetHeight), scalingMode)
  else:
    return (nil, "")
  context.decodeTargetImage = nil
  context.decodeTargetScalingMode = ""
  context.decodeTargetWidth = 0
  context.decodeTargetHeight = 0
  context.decodeTargetNodeId = 0.NodeId
  context.decodeTargetOwned = false

proc mayMutateImageInPlace*(self: AppRoot, context: ExecutionContext): bool =
  ## The `forwardsTarget` half of the handshake: may this app mutate the image
  ## it was handed and return that very image, instead of copying it?
  ##
  ## True only when the planner put this node on a forwarding chain AND the
  ## target has actually been taken by the producer upstream. A hint still in
  ## flight means the chain did not fuse after all — the producer bailed, or it
  ## served a cached value — and the image we hold may be shared with a node
  ## cache or with the canvas. Mutating that would corrupt a later render.
  if self.isNil or context.isNil or context.inPlaceImageNodes.len == 0:
    return false
  if not context.decodeTargetImage.isNil or context.decodeTargetWidth > 0:
    return false
  self.nodeId in context.inPlaceImageNodes

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

when defined(testing):
  ## Test seam for the download-based image producers (downloadImage,
  ## unsplash, immich, googlePhotos, openaiImage, wikicommons). data/frameOS-
  ## Gallery exposes its own `galleryDownloadHook`; everything else funnels
  ## through downloadImageWithDataForContext below, and without a seam here a
  ## test cannot observe what the interpreter handed them — which is exactly
  ## the invariant worth pinning, since an unhinted producer decodes at native
  ## resolution on embedded. Compiled out of real builds.
  type ContextDownloadHook* = proc(url: string, maxBytes: int, target: Image,
    fit: ScaledDecodeFit): tuple[image: Image, data: string]
  var contextDownloadHook*: ContextDownloadHook = nil

proc downloadImageWithDataForContext*(self: AppRoot, context: ExecutionContext, url: string,
    maxBytes = 0, headers: seq[SimpleHttpHeader] = @[], fallbackWidth = 0,
    fallbackHeight = 0): tuple[image: Image, data: string] =
  ## Downloads an image for an app that produces one.
  ##
  ## On embedded this can decode straight into a consumer-sized target, which
  ## keeps peak memory at the decode intermediates — but only when the
  ## interpreter has said so by setting a decode-target hint, because only the
  ## interpreter knows what the consumer will do with the result.
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
  ## With no hint at all the download decodes at its native resolution — on
  ## embedded that is unbounded, so the interpreter is expected to hint every
  ## producer it routes into a canvas, cached or not.
  let byteLimit =
    if maxBytes > 0: maxBytes
    else: self.maxImageResponseBytes()

  let (decodeTarget, decodeScalingMode) = self.takeDecodeTarget(context)

  when defined(testing):
    if contextDownloadHook != nil:
      return contextDownloadHook(url, byteLimit, decodeTarget,
        scaledDecodeFit(decodeScalingMode))

  if decodeTarget.isNil:
    return downloadImageWithData(url, maxBytes = byteLimit, headers = headers)

  downloadImageWithDataInto(
    url,
    decodeTarget,
    maxBytes = byteLimit,
    headers = headers,
    fit = scaledDecodeFit(decodeScalingMode)
  )
