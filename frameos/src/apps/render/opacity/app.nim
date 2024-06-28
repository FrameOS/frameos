import pixie
import options
import frameos/apps
import frameos/types

type
  AppConfig* = object
    image*: Option[Image]
    opacity*: float

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  let image = if self.appConfig.image.isSome(): self.appConfig.image.get().copy()
              elif context.hasImage: newImage(context.image.width, context.image.height)
              else: newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
  applyOpacity(image, self.appConfig.opacity)
  return image

proc run*(self: App, context: ExecutionContext) =
  applyOpacity(context.image, self.appConfig.opacity)
