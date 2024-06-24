import json
import pixie
import times
import options
import frameos/utils/image
import frameos/types

type
  AppConfig* = object
    url*: string
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

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "legacy/downloadImage:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "legacy/downloadImage:error", "error": message})

proc run*(self: App, context: ExecutionContext) =
  try:
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

    if context.image.width > 0 and context.image.height > 0:
      scaleAndDrawImage(context.image, downloadedImage.get(), self.appConfig.scalingMode)
  except:
    self.error "An error occurred while downloading the image."
