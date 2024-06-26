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
  image.scaleAndDrawImage(self.appConfig.image, self.appConfig.scalingMode)
  return image
