import strformat
import strutils
import pixie
import options
import frameos/apps
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    inputImage*: Option[Image]
    image*: Image
    imageData*: string
    placement*: string
    offsetX*: int
    offsetY*: int
    blendMode*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc render*(self: App, context: ExecutionContext, image: Image) =
  try:
    let sourceImage =
      if self.appConfig.imageData.len > 0:
        if self.appConfig.imageData.startsWith("data:"):
          decodeDataUrl(self.appConfig.imageData)
        else:
          decodeImageWithFallback(self.appConfig.imageData)
      else:
        self.appConfig.image
    if sourceImage.isNil:
      raise newException(Exception, "No image provided.")
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
    scaleAndDrawImage(image, sourceImage, self.appConfig.placement, self.appConfig.offsetX,
        self.appConfig.offsetY, blendMode)
  except Exception as e:
    let message = &"Error rendering image: {e.msg}"
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
