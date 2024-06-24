import pixie
import frameos/types

type
  AppConfig* = object
    color*: Color
    width*: int
    height*: int

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  let width = if self.appConfig.width != 0:
                self.appConfig.width
              elif context.hasImage:
                context.image.width
              else:
                self.frameConfig.renderWidth()
  let height = if self.appConfig.height != 0:
                 self.appConfig.height
                elif context.hasImage:
                  context.image.height
                else:
                  self.frameConfig.renderHeight()
  let image = newImage(width, height)
  image.fill(self.appConfig.color)
  return image
