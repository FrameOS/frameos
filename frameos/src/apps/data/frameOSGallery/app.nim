import pixie, options, json, strformat
import frameos/utils/image
import frameos/types

const BASE_URL = "https://gallery.frameos.net/image"

type
  AppConfig* = object
    category*: string
    categoryOther*: string

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

    cacheExpiry: float
    cachedImage: Option[Image]
    cachedUrl: string

  AppOutput* = object
    image*: Image

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )

proc run*(self: App, context: ExecutionContext): AppOutput =
  let category = if self.appConfig.category == "other": self.appConfig.categoryOther else: self.appConfig.category
  self.scene.logger.log(%*{"event": "legacy/frameOSGallery", "category": category})
  let url = &"{BASE_URL}?category={category}"
  result = AppOutput(image: downloadImage(url))
