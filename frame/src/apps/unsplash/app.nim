import pixie
import std/strformat
import times
from frameos/image_utils import downloadImage
from frameos/types import Config

type AppConfig* = object
  keyword*: string
  cache_seconds*: string
  scaling_mode*: string

type App* = object
  appConfig: AppConfig
  config: Config

proc init*(config: Config, appConfig: AppConfig): App =
  result = App(config: config, appConfig: appConfig)
  if result.appConfig.keyword == "":
    result.appConfig.keyword = "random"

proc render*(self: App, image: Image) =
  let url = &"https://source.unsplash.com/random/{image.width}x{image.height}/?{self.appConfig.keyword}"

  let downloadTimer = epochTime()
  let background = downloadImage(url)
  echo "Time taken to downlooad: ", (epochTime() - downloadTimer) * 1000, " ms"

  let drawTimer = epochTime()
  image.draw(background)
  echo "Time taken to draw background: ", (epochTime() - drawTimer) * 1000, " ms"
