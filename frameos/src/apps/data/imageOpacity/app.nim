import pixie
import frameos/types

type
  AppConfig* = object
    image*: Image
    opacity*: float

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  applyOpacity(self.appConfig.image, self.appConfig.opacity)
  return self.appConfig.image
