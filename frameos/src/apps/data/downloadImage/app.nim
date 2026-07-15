import json
import pixie
import options
import frameos/apps
import frameos/types
import frameos/utils/app_images
import frameos/utils/exif
import frameos/utils/image

type
  AppConfig* = object
    url*: string
    metadataStateKey*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc buildMetadata*(url: string, image: Image, imageData: string): JsonNode =
  result = %*{
    "url": url,
    "width": image.width,
    "height": image.height
  }
  let exifMetadata = getExifMetadataFromData(imageData)
  if exifMetadata.isSome():
    result["exif"] = exifMetadata.get()
  mergeParsedExif(result, imageData)

proc get*(self: App, context: ExecutionContext): Image =
  try:
    let url = self.appConfig.url
    let (image, imageData) = self.downloadImageWithDataForContext(
      context,
      url,
      maxBytes = self.maxImageResponseBytes()
    )
    if self.appConfig.metadataStateKey != "":
      self.scene.state[self.appConfig.metadataStateKey] = buildMetadata(url, image, imageData)
    return image
  except CatchableError as e:
    let detail = if e.msg.len > 0: e.msg else: "unknown error"
    self.logError "An error occurred while downloading the image: " & detail
    return self.renderErrorForContext(context,
        "An error occurred while downloading the image.\n" & detail)
