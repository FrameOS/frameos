import strformat
import pixie
import options
import frameos/apps
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    inputImage*: Option[Image]
    image*: Image
    placement*: string
    offsetX*: int
    offsetY*: int

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc render*(self: App, context: ExecutionContext, image: Image) =
  try:
    if self.appConfig.image == nil:
      raise newException(Exception, "No image provided.")
    scaleAndDrawImage(image, self.appConfig.image, self.appConfig.placement, self.appConfig.offsetX,
        self.appConfig.offsetY)
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

