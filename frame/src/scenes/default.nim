import pixie

from frameos/config import Config
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
  self.app_1.render(image)
  self.app_2.render(image)
  return image
