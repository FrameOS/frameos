import pixie
import std/strformat
import times
import strutils
import options
from frameos/utils/image import downloadImage
from frameos/types import FrameScene, FrameConfig, ExecutionContext

type
  AppConfig* = object
    keyword*: string
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
  if result.appConfig.keyword == "":
    result.appConfig.keyword = "random"

proc render*(self: App, context: ExecutionContext) =
  let image = context.image
  let url = &"https://source.unsplash.com/random/{image.width}x{image.height}/?{self.appConfig.keyword}"

  var unsplashImage: Option[Image] = none(Image)
  if self.appConfig.cacheSeconds > 0 and self.cachedImage.isSome and
      self.cacheExpiry > epochTime() and self.cachedUrl == url:
    unsplashImage = self.cachedImage
  else:
    unsplashImage = some(downloadImage(url))
    if self.appConfig.cacheSeconds > 0:
      self.cachedImage = unsplashImage
      self.cachedUrl = url
      self.cacheExpiry = epochTime() + self.appConfig.cacheSeconds

  image.draw(unsplashImage.get())
