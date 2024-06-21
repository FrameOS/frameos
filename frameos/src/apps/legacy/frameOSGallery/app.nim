import pixie, times, options, json, strformat
from frameos/utils/image import downloadImage, scaleAndDrawImage
import frameos/types

const BASE_URL = "https://gallery.frameos.net/image"

type
  AppConfig* = object
    category*: string
    scalingMode*: string
    cacheSeconds*: float

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

    cacheExpiry: float
    cachedImage: Option[Image]
    cachedUrl: string

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
    cachedImage: none(Image),
    cacheExpiry: 0.0,
    cachedUrl: "",
  )

proc run*(self: App, context: ExecutionContext) =
  let url = &"{BASE_URL}?category={self.appConfig.category}"

  self.scene.logger.log(%*{"event": "legacy/frameOSGallery", "category": self.appConfig.category})

  var downloadedImage: Option[Image] = none(Image)
  if self.appConfig.cacheSeconds > 0 and self.cachedImage.isSome and self.cacheExpiry > epochTime() and
      self.cachedUrl == url:
    downloadedImage = self.cachedImage
  else:
    downloadedImage = some(downloadImage(url))
    if self.appConfig.cacheSeconds > 0:
      self.cachedImage = downloadedImage
      self.cachedUrl = url
      self.cacheExpiry = epochTime() + self.appConfig.cacheSeconds

  if context.image.width > 0 and context.image.height > 0:
    scaleAndDrawImage(context.image, downloadedImage.get(), self.appConfig.scalingMode)
