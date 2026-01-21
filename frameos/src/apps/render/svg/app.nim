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
    let svgImageOption = decodeSvgWithImageMagick(svgMarkup, image.width, image.height)
    if svgImageOption.isNone:
      raise newException(Exception, "Failed to render SVG.")
    let svgImage = svgImageOption.get()
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
    scaleAndDrawImage(image, svgImage, self.appConfig.placement, self.appConfig.offsetX,
      self.appConfig.offsetY, blendMode)
  except Exception as e:
    let message = &"Error rendering SVG: {e.msg}"
    self.logError(message)
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
