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
    when defined(frameosEmbedded):
      discard self.refreshEmbeddedServiceSettings()
    let url = self.appConfig.url
    let (image, imageData) =
      when defined(frameosEmbedded):
        let target =
          if context.hasImage and not context.image.isNil:
            context.image
          else:
            newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
        downloadImageWithDataInto(
          url,
          target,
          maxBytes = self.maxImageResponseBytes(),
          proxyBaseUrl = self.embeddedMediaProxyBaseUrl()
        )
      else:
        downloadImageWithData(
          url,
          maxBytes = self.maxImageResponseBytes(),
          proxyBaseUrl = self.embeddedMediaProxyBaseUrl()
        )
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
  except CatchableError as e:
    let detail = if e.msg.len > 0: e.msg else: "unknown error"
    self.logError "An error occurred while downloading the image: " & detail
    return renderError(if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
        if context.hasImage: context.image.height else: self.frameConfig.renderHeight(),
        "An error occurred while downloading the image.\n" & detail)
