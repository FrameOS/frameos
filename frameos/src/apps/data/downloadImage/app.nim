import json
import pixie
import options
import frameos/apps
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    url*: string
    metadataStateKey*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc error*(self: App, context: ExecutionContext, message: string): Image =
  self.logError(message)
  result = renderError(
    if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
    if context.hasImage: context.image.height else: self.frameConfig.renderHeight(),
    message,
  )

proc get*(self: App, context: ExecutionContext): Image =
  try:
    let url = self.appConfig.url
    if self.appConfig.metadataStateKey == "":
      return downloadImage(url)

    let (image, imageData) = downloadImageWithData(url)
    var metadata = %*{
      "url": url,
      "width": image.width,
      "height": image.height
    }
    let exifMetadata = getExifMetadataFromData(imageData)
    if exifMetadata.isSome():
      metadata["exif"] = exifMetadata.get()
    self.scene.state[self.appConfig.metadataStateKey] = metadata
    return image
  except CatchableError as e:
    return self.error(context, "An error occurred while downloading the image: " & e.msg)
