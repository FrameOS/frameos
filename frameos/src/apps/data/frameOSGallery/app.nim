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

  AppOutput* = object
    image: Image

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )

proc run*(self: App, context: ExecutionContext): AppOutput =
  self.scene.logger.log(%*{"event": "legacy/frameOSGallery", "category": self.appConfig.category})
  let url = &"{BASE_URL}?category={self.appConfig.category}"
  result = AppOutput(image: downloadImage(url))
