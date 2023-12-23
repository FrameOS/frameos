import pixie
import assets/fonts as fontAssets
import times

from frameos/config import Config
import apps/unsplash/frame as unsplashApp

type Scene = object
  config: Config
  image: Image
  app_1: unsplashApp.App
  typeface: Typeface

proc init*(config: Config): Scene =
  result = Scene()
  result.config = config
  result.image = newImage(config.width, config.height)
  result.app_1 = unsplashApp.init(config, unsplashApp.AppConfig(
      keyword: "random"))
  let parseTtfTimer = epochTime()
  result.typeface = parseTtf(fontAssets.getAsset("assets/fonts/Ubuntu-Regular_1.ttf"))
  echo "Time taken to parse ttf: ", (epochTime() - parseTtfTimer) * 1000, " ms"

proc render*(self: Scene): Image =
  echo "---- Creating image ----"
  let image = newImage(self.image.width, self.image.height)

  self.app_1.render(image)

  proc newFont(typeface: Typeface, size: float32, color: Color): Font =
    result = newFont(typeface)
    result.size = size
    result.paint.color = color

  let drawFontTimer = epochTime()
  let spans = @[
    newSpan("verb [with object] ",
      newFont(self.typeface, 12, color(0.78125, 0.78125, 0.78125, 1))),
    newSpan("unladen strallow\n", newFont(self.typeface, 36, color(0, 0, 0, 1))),
    newSpan("\nstral·low\n", newFont(self.typeface, 13, color(0, 0.5, 0.953125, 1))),
    newSpan("\n1. free (something) from restrictive restrictions \"the regulations are intended to strallow changes in public policy\" ",
        newFont(self.typeface, 14, color(0.3125, 0.3125, 0.3125, 1)))
  ]

  image.fillText(typeset(spans, vec2(180, 180)), translate(vec2(10, 10)))
  echo "Time taken to draw text: ", (epochTime() - drawFontTimer) * 1000, " ms"
  return image
