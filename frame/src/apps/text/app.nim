import pixie, strutils

from frameos/types import FrameOS, FrameConfig, ExecutionContext
from frameos/utils/font import getDefaultTypeface, newFont

type AppConfig* = object
  text*: string
  position*: string
  offsetX*: string
  offsetY*: string
  padding*: string
  fontColor*: string
  fontSize*: string
  borderColor*: string
  borderWidth*: string

type App* = object
  appConfig: AppConfig
  frameConfig: FrameConfig
  typeface: Typeface

proc init*(frameOS: FrameOS, appConfig: AppConfig): App =
  let typeface = getDefaultTypeface()
  result = App(
    frameConfig: frameOS.frameConfig,
    appConfig: appConfig,
    typeface: typeface,
  )

proc render*(self: App, context: ExecutionContext) =
  let size = try: parseFloat(self.appConfig.fontSize) except ValueError: 32.0
  let borderWidth = try: parseInt(self.appConfig.borderWidth) except ValueError: 1
  let color = try: parseHtmlColor(self.appConfig.fontColor) except ValueError: color(
      0, 0, 0, 1)
  let font = newFont(self.typeface, size, color)
  let padding = try: parseFloat(self.appConfig.padding) except ValueError: 10.0
  let offsetX = try: parseFloat(self.appConfig.offsetX) except ValueError: 0.0
  let offsetY = try: parseFloat(self.appConfig.offsetY) except ValueError: 0.0
  let hAlign = case self.appConfig.position:
    of "top-right", "center-right", "bottom-right": RightAlign
    of "top-left", "center-left", "bottom-left": LeftAlign
    else: CenterAlign
  let vAlign = case self.appConfig.position:
    of "top-left", "top-center", "top-right": TopAlign
    of "bottom-left", "bottom-center", "bottom-right": BottomAlign
    else: MiddleAlign

  if borderWidth > 0:
    let color = try: parseHtmlColor(self.appConfig.borderColor) except ValueError: color(
        255, 255, 255, 1)
    let borderFont = newFont(self.typeface, size, color)
    let typeset = typeset(
        spans = [newSpan(self.appConfig.text, borderFont)],
        bounds = vec2(context.image.width.toFloat() - 2 * padding,
            context.image.height.toFloat() - 2 * padding),
        hAlign = hAlign,
        vAlign = vAlign,
    )
    for dx in (-borderWidth)..(borderWidth):
      for dy in (-borderWidth)..(borderWidth):
        context.image.fillText(
          typeset,
          translate(vec2(
            padding + offsetX + dx.toFloat(),
            padding + offsetY + dy.toFloat()))
        )

  context.image.fillText(
    typeset(
        spans = [newSpan(self.appConfig.text, font)],
        bounds = vec2(context.image.width.toFloat() - 2 * padding,
            context.image.height.toFloat() - 2 * padding),
        hAlign = hAlign,
        vAlign = vAlign,
    ),
    translate(vec2(padding + offsetX, padding + offsetY))
  )
