import pixie, std/strutils

from frameos/types import FrameOS, FrameConfig, ExecutionContext
from frameos/utils/font import getDefaultTypeface, newFont

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

proc init*(frameOS: FrameOS, appConfig: AppConfig): App =
  let typeface = getDefaultTypeface()
  let font = newFont(
    typeface,
    try: parseFloat(appConfig.font_size) except ValueError: 32.0,
    color(0.78125, 0.78125, 0.78125, 1)
  )
  result = App(
    frameConfig: frameOS.frameConfig,
    appConfig: appConfig,
    typeface: typeface,
    font: font,
    span: newSpan(appConfig.text, font)
  )

proc render*(self: App, context: ExecutionContext) =
  let padding = 10.0
  let hAlign = case self.appConfig.position:
    of "top-right", "center-right", "bottom-right": RightAlign
    of "top-left", "center-left", "bottom-left": LeftAlign
    else: CenterAlign
  let vAlign = case self.appConfig.position:
    of "top-left", "top-center", "top-right": TopAlign
    of "bottom-left", "bottom-center", "bottom-right": BottomAlign
    else: MiddleAlign

  context.image.fillText(
    typeset(
        spans = [self.span],
        bounds = vec2(context.image.width.toFloat() - 2 * padding,
            context.image.height.toFloat() - 2 * padding),
        hAlign = hAlign,
        vAlign = vAlign,
    ),
    translate(vec2(padding, padding))
  )
