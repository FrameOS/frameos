import pixie, options

from frameos/types import FrameOS, FrameConfig, ExecutionContext
from frameos/utils/font import getDefaultTypeface, newFont

type
  AppConfig* = object
    text*: string
    position*: string
    offsetX*: float
    offsetY*: float
    padding*: float
    fontColor*: Color
    fontSize*: float
    borderColor*: Color
    borderWidth*: int

  RenderData* = object
    text*: string
    position*: string
    width*: int
    height*: int
    padding*: float
    fontColor*: Color
    fontSize*: float
    borderColor*: Color
    borderWidth*: int

  CachedRender* = ref object
    renderData*: RenderData
    typeset*: Arrangement
    borderTypeset*: Option[Arrangement]

  App* = ref object
    appConfig*: AppConfig
    frameConfig*: FrameConfig
    typeface*: Typeface
    cachedRender*: Option[CachedRender]

proc init*(frameOS: FrameOS, appConfig: AppConfig): App =
  let typeface = getDefaultTypeface()
  result = App(
    frameConfig: frameOS.frameConfig,
    appConfig: appConfig,
    typeface: typeface,
    cachedRender: none(CachedRender),
  )

proc `==`(obj1, obj2: RenderData): bool =
  obj1.text == obj2.text and obj1.position == obj2.position and
      obj1.width == obj2.width and obj1.height == obj2.height and
      obj1.padding == obj2.padding and obj1.fontColor == obj2.fontColor and
      obj1.fontSize == obj2.fontSize and obj1.borderColor ==
          obj2.borderColor and obj1.borderWidth == obj2.borderWidth

proc generateTypeset(typeface: Typeface, renderData: RenderData,
    border: bool): Arrangement =

  let font = if border:
    newFont(typeface, renderData.fontSize, renderData.borderColor)
  else:
    newFont(typeface, renderData.fontSize, renderData.fontColor)

  let hAlign = case renderData.position:
    of "top-right", "center-right", "bottom-right": RightAlign
    of "top-left", "center-left", "bottom-left": LeftAlign
    else: CenterAlign
  let vAlign = case renderData.position:
    of "top-left", "top-center", "top-right": TopAlign
    of "bottom-left", "bottom-center", "bottom-right": BottomAlign
    else: MiddleAlign

  result = typeset(
      spans = [newSpan(renderData.text, font)],
      bounds = vec2(renderData.width.toFloat() - 2 * renderData.padding,
          renderData.height.toFloat() - 2 * renderData.padding),
      hAlign = hAlign,
      vAlign = vAlign,
  )

proc render*(self: App, context: ExecutionContext) =
  let renderData = RenderData(
    text: self.appConfig.text,
    position: self.appConfig.position,
    width: context.image.width,
    height: context.image.height,
    padding: self.appConfig.padding,
    fontColor: self.appConfig.fontColor,
    fontSize: self.appConfig.fontSize,
    borderColor: self.appConfig.borderColor,
    borderWidth: self.appConfig.borderWidth,
  )

  let cacheMatch = self.cachedRender.isSome and self.cachedRender.get().renderData == renderData
  let textTypeset = if cacheMatch: self.cachedRender.get().typeset
    else: generateTypeset(self.typeface, renderData, false)
  let borderTypeset = if renderData.borderWidth > 0:
      if cacheMatch:
        self.cachedRender.get().borderTypeset
      else: some(generateTypeset(self.typeface, renderData, true))
      else: none(Arrangement)

  if not cacheMatch:
    self.cachedRender = some(CachedRender(
      renderData: renderData,
      typeset: textTypeset,
      borderTypeset: borderTypeset,
    ))

  if renderData.borderWidth > 0 and borderTypeset.isSome:
    for dx in (-renderData.borderWidth)..(renderData.borderWidth):
      for dy in (-renderData.borderWidth)..(renderData.borderWidth):
        context.image.fillText(
          borderTypeset.get(),
          translate(vec2(
            renderData.padding + self.appConfig.offsetX + dx.toFloat(),
            renderData.padding + self.appConfig.offsetY + dy.toFloat()))
        )

  context.image.fillText(
    textTypeset,
    translate(vec2(renderData.padding + self.appConfig.offsetX,
        renderData.padding + self.appConfig.offsetY))
  )
