import pixie
import times
import options
from frameos/utils/image import downloadImage, scaleAndDrawImage
from frameos/types import FrameScene, FrameConfig, ExecutionContext

type
  AppConfig* = object
    url*: string
    scalingMode*: string
    cacheSeconds*: float

  App* = ref object
    nodeId*: string
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

    cacheExpiry: float
    cachedImage: Option[Image]
    cachedUrl: string

proc init*(nodeId: string, scene: FrameScene, appConfig: AppConfig): App =
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
  let image = context.image
  let url = self.appConfig.url

  var downloadedImage: Option[Image] = none(Image)
  if self.appConfig.cacheSeconds > 0 and self.cachedImage.isSome and
      self.cacheExpiry > epochTime() and self.cachedUrl == url:
    downloadedImage = self.cachedImage
  else:
    downloadedImage = some(downloadImage(url))
    if self.appConfig.cacheSeconds > 0:
      self.cachedImage = downloadedImage
      self.cachedUrl = url
      self.cacheExpiry = epochTime() + self.appConfig.cacheSeconds

  scaleAndDrawImage(image, downloadedImage.get(), self.appConfig.scalingMode)
