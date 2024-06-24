import pixie
import frameos/utils/image
import frameos/types

type
  AppConfig* = object
    url*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  try:
    let url = self.appConfig.url
    return downloadImage(url)
  except:
    self.logError "An error occurred while downloading the image."
    return renderError(if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
        if context.hasImage: context.image.height else: self.frameConfig.renderHeight(), "An error occurred while downloading the image.")
