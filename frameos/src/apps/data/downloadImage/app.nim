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

proc get*(self: App, context: ExecutionContext): Image =
  try:
    let url = self.appConfig.url
    let (image, imageData) = downloadImageWithData(url)
    if self.appConfig.metadataStateKey != "":
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
  except:
    self.logError "An error occurred while downloading the image."
    return renderError(if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
        if context.hasImage: context.image.height else: self.frameConfig.renderHeight(), "An error occurred while downloading the image.")
