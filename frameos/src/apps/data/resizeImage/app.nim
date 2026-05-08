import pixie
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    image*: Image
    width*: int
    height*: int
    scalingMode*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  let image = newImage(self.appConfig.width, self.appConfig.height)
  var scalingMode = self.appConfig.scalingMode
  if scalingMode == "contain" and
      self.appConfig.image.width <= self.appConfig.width and
      self.appConfig.image.height <= self.appConfig.height:
    scalingMode = "center"
  image.scaleAndDrawImage(self.appConfig.image, scalingMode)
  return image
