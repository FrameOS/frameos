import pixie

from frameos/types import Config
import apps/unsplash/app as unsplashApp
import apps/text/app as textApp

type Scene = object
  config: Config
  app_1: unsplashApp.App
  app_2: textApp.App
  typeface: Typeface

proc init*(config: Config): Scene =
  result = Scene(config: config)
  result.app_1 = unsplashApp.init(config, unsplashApp.AppConfig(
      keyword: "random"))
  result.app_2 = textApp.init(config, textApp.AppConfig(
      text: "Hello"))

proc render*(self: Scene): Image =
  var image = newImage(self.config.width, self.config.height)
  var nextNode = 1
  while nextNode != -1:
    case nextNode:
    of 1:
      self.app_1.render(image)
      nextNode = 2
    of 2:
      self.app_2.render(image)
      nextNode = -1
    else:
      nextNode = -1
  return image
