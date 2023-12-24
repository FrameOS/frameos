import pixie
import times

from frameos/types import FrameConfig, ExecutionContext
from frameos/fontUtils import getDefaultTypeface, newFont

type AppConfig* = object
  text*: string
  position*: string
  offset_x*: string
  offset_y*: string
  font_color*: string
  font_size*: string
  border_color*: string
  border_width*: string

type App* = object
  appConfig: AppConfig
  frameConfig: FrameConfig
  typeface: Typeface
  font: Font
  span: Span

proc init*(frameConfig: FrameConfig, appConfig: AppConfig): App =
  var typeface = getDefaultTypeface()
  let makeFontTimer = epochTime()
  var font = newFont(typeface, 32, color(0.78125, 0.78125, 0.78125, 1))
  echo "Time taken to make new font: ", (epochTime() - makeFontTimer) * 1000, " ms"
  result = App(
    frameConfig: frameConfig,
    appConfig: appConfig,
    typeface: typeface,
    font: font,
    span: newSpan(appConfig.text, font)
  )


proc render*(self: App, context: ExecutionContext) =
  let image = context.image

  let drawFontTimer = epochTime()
  # let spans = @[
  #   newSpan("verb [with object] ",
  #     newFont(self.typeface, 12, color(0.78125, 0.78125, 0.78125, 1))),
  #   newSpan("unladen strallow\n", newFont(self.typeface, 36, color(0, 0, 0, 1))),
  #   newSpan("\nstral·low\n", newFont(self.typeface, 13, color(0, 0.5, 0.953125, 1))),
  #   newSpan("\n1. free (something) from restrictive restrictions \"the regulations are intended to strallow changes in public policy\" ",
  #       newFont(self.typeface, 14, color(0.3125, 0.3125, 0.3125, 1)))
  # ]

  image.fillText(typeset([self.span], vec2(180, 180)), translate(vec2(10, 10)))
  echo "Time taken to draw text: ", (epochTime() - drawFontTimer) * 1000, " ms"
