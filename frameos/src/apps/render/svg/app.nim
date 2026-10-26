import base64
import options
import pixie
import sequtils
import strformat
import strutils
import uri

import frameos/apps
import frameos/types
import frameos/utils/image
import frameos/utils/app_images
import frameos/utils/svg_frames

type
  AppConfig* = object
    inputImage*: Option[Image]
    svg*: string
    placement*: string
    offsetX*: int
    offsetY*: int
    blendMode*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc decodeSvgInput(svgInput: string): string =
  if svgInput.startsWith("data:"):
    let commaIndex = svgInput.find(',')
    if commaIndex == -1:
      raise newException(ValueError, "Invalid data URL.")
    let header = svgInput[5 ..< commaIndex]
    let dataBody = svgInput[commaIndex + 1 .. ^1]
    let headerParts = if header.len > 0: header.split(';') else: @[""]
    let isBase64 = headerParts.anyIt(it == "base64")
    if isBase64:
      return dataBody.decode
    return decodeUrl(dataBody)
  return svgInput

proc render*(self: App, context: ExecutionContext, image: Image) =
  try:
    if self.appConfig.svg.len == 0:
      raise newException(Exception, "No SVG provided.")
    let svgMarkup = decodeSvgInput(self.appConfig.svg)
    let blendMode = case self.appConfig.blendMode:
      of "normal": NormalBlend
      of "overwrite": OverwriteBlend
      of "darken": DarkenBlend
      of "multiply": MultiplyBlend
      of "color-burn": ColorBurnBlend
      of "lighten": LightenBlend
      of "screen": ScreenBlend
      of "color-dodge": ColorDodgeBlend
      of "overlay": OverlayBlend
      of "soft-light": SoftLightBlend
      of "hard-light": HardLightBlend
      of "difference": DifferenceBlend
      of "exclusion": ExclusionBlend
      of "hue": HueBlend
      of "saturation": SaturationBlend
      of "color": ColorBlend
      of "luminosity": LuminosityBlend
      of "mask": MaskBlend
      of "inverse-mask": SubtractMaskBlend
      of "exclude-mask": ExcludeMaskBlend
      else: NormalBlend
    # The SVG is drawn at the image's own size, so every placement lands it
    # 1:1, and with no offset and a normal blend it can be painted straight
    # onto the image. A standalone raster beside it was a second image the
    # size of the canvas: 7.7 MB at 1200x1600, which an 8 MB ESP32 (the
    # E1004) does not have, so the render aborted out of memory.
    #
    # The scene background this canvas still owes is the app's to settle
    # (the interpreter leaves it, FlowAppsSettlingBackground): an SVG whose
    # first paint covers the canvas waives it, any other pays it first. And
    # on an LCD, when the SVG is the whole frame, only what changed since
    # the SVG this buffer last held is repainted (utils/svg_frames.nim): the
    # Touch test moved one dot and rewrote one line of text per touch, and
    # drew all 230,400 pixels twice (the background, then the SVG's own)
    # for it on the SenseCAP Indicator (2026-10-26).
    if blendMode == NormalBlend and self.appConfig.offsetX == 0 and self.appConfig.offsetY == 0:
      var owed = takeOwedBackground(context, image)
      var rendered = renderSvgFrame(svgMarkup, image, owed, context.wholeFrame)
      if not rendered:
        rendered = renderSvgIntoTargetWithDegrade(svgMarkup, image, owed)
      if owed.isSome:
        payBackground(image, owed.get())
      if not rendered:
        let reason = svgDecodeError(svgMarkup, image.width, image.height)
        raise newException(Exception, if reason.len > 0: reason else: "Failed to render SVG.")
      return
    paintPendingBackground(context)
    let svgImageOption = decodeSvgWithFallback(svgMarkup, image.width, image.height)
    if svgImageOption.isNone:
      raise newException(Exception, "Failed to render SVG.")
    let svgImage = svgImageOption.get()
    scaleAndDrawImage(image, svgImage, self.appConfig.placement, self.appConfig.offsetX,
      self.appConfig.offsetY, blendMode)
  except Exception as e:
    paintPendingBackground(context)
    let message = &"Error rendering SVG: {e.msg}"
    self.logError(message)
    when defined(frameosEmbedded):
      renderErrorInto(image, image.width, image.height, message)
    else:
      let errorImage = renderError(image.width, image.height, message)
      scaleAndDrawImage(image, errorImage, self.appConfig.placement)

proc run*(self: App, context: ExecutionContext) =
  render(self, context, context.image)

proc get*(self: App, context: ExecutionContext): Image =
  result = if self.appConfig.inputImage.isSome:
    self.appConfig.inputImage.get()
  elif context.hasImage:
    newImage(context.image.width, context.image.height)
  else:
    newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
  render(self, context, result)
