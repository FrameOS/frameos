import pixie, strutils

from frameos/types import FrameOS, FrameConfig, ExecutionContext
from frameos/utils/font import getDefaultTypeface, newFont

type AppConfig* = object
  text*: string
  position*: string
  offsetX*: float
  offsetY*: float
  padding*: float
  fontColor*: Color
  fontSize*: float
  borderColor*: Color
  borderWidth*: int

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
  let size = self.appConfig.fontSize
  let borderWidth = self.appConfig.borderWidth
  let color = self.appConfig.fontColor
  let font = newFont(self.typeface, size, color)
  let padding = self.appConfig.padding
  let offsetX = self.appConfig.offsetX
  let offsetY = self.appConfig.offsetY
  let hAlign = case self.appConfig.position:
    of "top-right", "center-right", "bottom-right": RightAlign
    of "top-left", "center-left", "bottom-left": LeftAlign
    else: CenterAlign
  let vAlign = case self.appConfig.position:
    of "top-left", "top-center", "top-right": TopAlign
    of "bottom-left", "bottom-center", "bottom-right": BottomAlign
    else: MiddleAlign

  if borderWidth > 0:
    let borderColor = self.appConfig.borderColor
    let borderFont = newFont(self.typeface, size, borderColor)
    let typeset = typeset(
        spans = [newSpan(self.appConfig.text, borderFont)],
        bounds = vec2(context.image.width.toFloat() - 2 * padding,
            context.image.height.toFloat() - 2 * padding),
        hAlign = hAlign,
        vAlign = vAlign,
    )
    # TODO: This is ridiculously inefficient
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
