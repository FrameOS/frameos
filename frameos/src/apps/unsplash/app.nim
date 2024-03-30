import pixie
import json
import std/strformat
import std/strutils
import times
import options
import frameos/utils/image
import frameos/types

type
  AppConfig* = object
    keyword*: string
    cacheSeconds*: float

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

    cacheExpiry: float
    cachedImage: Option[Image]
    cachedUrl: string

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "unsplash:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "unsplash:error", "error": message})

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
  if result.appConfig.keyword == "":
    result.appConfig.keyword = "random"
  result.appConfig.keyword = result.appConfig.keyword.strip()

proc run*(self: App, context: ExecutionContext) =
  let image = context.image
  let url = &"https://source.unsplash.com/random/{image.width}x{image.height}/?{self.appConfig.keyword}"

  if self.frameConfig.debug:
    self.scene.logger.log(
      %*{
        "event": "unsplash:run",
        "keyword": self.appConfig.keyword,
        "url": url,
        "cacheSeconds": self.appConfig.cacheSeconds,
        "cacheExpiry": self.cacheExpiry,
        "cachedUrl": self.cachedUrl,
      }
    )

  var unsplashImage: Option[Image] = none(Image)
  if self.appConfig.cacheSeconds > 0 and self.cachedImage.isSome and
      self.cacheExpiry > epochTime() and self.cachedUrl == url:
    unsplashImage = self.cachedImage
    if self.frameConfig.debug:
      self.log("Using cached image")
  else:
    if self.frameConfig.debug:
      self.log("Downloading image")
    unsplashImage = some(downloadImage(url))
    if self.frameConfig.debug:
      self.log("Image downloaded")

    if self.appConfig.cacheSeconds > 0:
      self.cachedImage = unsplashImage
      self.cachedUrl = url
      self.cacheExpiry = epochTime() + self.appConfig.cacheSeconds
      if self.frameConfig.debug:
        self.log("Caching image")
    else:
      if self.frameConfig.debug:
        self.log("Not caching image, cacheSeconds is 0")

  image.draw(unsplashImage.get())
