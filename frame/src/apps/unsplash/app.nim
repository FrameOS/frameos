import pixie
import std/strformat
import times
import strutils
import options
from frameos/imageUtils import downloadImage
from frameos/types import FrameConfig, ExecutionContext

type AppConfig* = object
  keyword*: string
  cacheSeconds*: string

type App* = ref object
  appConfig: AppConfig
  frameConfig: FrameConfig

  cacheExpiry: float
  cacheSeconds: float
  cachedImage: Option[Image]
  cachedUrl: string

proc init*(frameConfig: FrameConfig, appConfig: AppConfig): App =
  result = App(
    frameConfig: frameConfig,
    appConfig: appConfig,
    cachedImage: none(Image),
    cacheExpiry: 0.0,
    cacheSeconds: if appConfig.cacheSeconds ==
        "": 0.0 else: appConfig.cacheSeconds.parseFloat(),
    cachedUrl: "",
  )
  if result.appConfig.keyword == "":
    result.appConfig.keyword = "random"

proc render*(self: App, context: ExecutionContext) =
  let image = context.image
  let url = &"https://source.unsplash.com/random/{image.width}x{image.height}/?{self.appConfig.keyword}"

  var unsplashImage: Option[Image] = none(Image)
  if self.cacheSeconds > 0 and self.cachedImage.isSome and self.cacheExpiry >
      epochTime() and self.cachedUrl == url:
    unsplashImage = self.cachedImage
  else:
    unsplashImage = some(downloadImage(url))
    if self.cacheSeconds > 0:
      self.cachedImage = unsplashImage
      self.cachedUrl = url
      self.cacheExpiry = epochTime() + self.cacheSeconds

  let drawTimer = epochTime()
  image.draw(unsplashImage.get())
  echo "Time taken to draw background: ", (epochTime() - drawTimer) * 1000, " ms"
