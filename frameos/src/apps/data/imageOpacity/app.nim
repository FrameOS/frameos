import pixie
import frameos/types

type
  AppConfig* = object
    image*: Image
    opacity*: float

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  let image = self.appConfig.image.copy()
  applyOpacity(image, self.appConfig.opacity)
  return image
