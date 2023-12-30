import pixie, times, options, json, strformat
from frameos/utils/image import downloadImage, scaleAndDrawImage
from frameos/types import FrameScene, FrameConfig, ExecutionContext
from frameos/logger import log

const BASE_URL = "https://gallery.frameos.net/image"

type
  AppConfig* = object
    category*: string
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

  let apiKey = self.frameConfig.settings{"frameOS"}{"apiKey"}.getStr
  if apiKey == "":
    self.scene.logger.log(%*{"event": "frameOSGallery:error",
        "error": "FrameOS API key absent. Sign up at https://gallery.frameos.net/ to support the project."})
    return

  let url = &"{BASE_URL}?api_key={apiKey}&category={self.appConfig.category}"

  self.scene.logger.log(%*{"event": "frameOSGallery",
      "category": self.appConfig.category})

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
