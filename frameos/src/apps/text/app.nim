import pixie, options

import frameos/types
import frameos/utils/font

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
    overflow*: string

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
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig
    typeface*: Typeface
    cachedRender*: Option[CachedRender]

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  let typeface = getDefaultTypeface()
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
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

proc generateTypeset(self: App, typeface: Typeface, renderData: RenderData,
    border: bool): Arrangement =
  let
    hAlign = case renderData.position:
      of "top-right", "center-right", "bottom-right": RightAlign
      of "top-left", "center-left", "bottom-left": LeftAlign
      else: CenterAlign
    vAlign = case renderData.position:
      of "top-left", "top-center", "top-right": TopAlign
      of "bottom-left", "bottom-center", "bottom-right": BottomAlign
      else: MiddleAlign
    color = if border: renderData.borderColor else: renderData.fontColor
    width = renderData.width.toFloat() - 2 * renderData.padding
    height = renderData.height.toFloat() - 2 * renderData.padding
    bounds = vec2(width, height)
    font = newFont(typeface, renderData.fontSize, color)

  if self.appConfig.overflow == "visible":
    return typeset([newSpan(renderData.text, font)], bounds, hAlign, vAlign)

  else: # "fit-bounds"
    var tooBigFontSize = 0.0
    var tooSmallFontSize = 0.0
    var loopIndex = 0
    while loopIndex < 100:
      loopIndex += 1
      result = typeset([newSpan(renderData.text, font)], bounds, hAlign, vAlign)
      let bounds = layoutBounds(result)

      # if the text is too big, shrink the font size
      if bounds.y > height:
        if font.size < 2:
          break

        # try to get closer based on the ratio
        tooBigFontSize = font.size
        if tooSmallFontSize > 0.0:
          font.size = (tooBigFontSize + tooSmallFontSize) / 2
        else:
          font.size = tooBigFontSize / 2
        continue

      # we're in bounds, and on the first run (text was never too big), so return
      elif tooBigFontSize == 0.0:
        break

      # the text is too small, and was once too big
      else:
        if height - bounds.y < 1:
          break
        tooSmallFontSize = font.size
        if tooBigFontSize - tooSmallFontSize < 0.5:
          break
        font.size = (tooBigFontSize + tooSmallFontSize) / 2
        continue

proc run*(self: App, context: ExecutionContext) =
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
    else: self.generateTypeset(self.typeface, renderData, false)
  let borderTypeset = if renderData.borderWidth > 0:
      if cacheMatch:
        self.cachedRender.get().borderTypeset
      else: some(self.generateTypeset(self.typeface, renderData, true))
      else: none(Arrangement)

  if not cacheMatch:
    self.cachedRender = some(CachedRender(
      renderData: renderData,
      typeset: textTypeset,
      borderTypeset: borderTypeset,
    ))

  context.image.fillText(
    textTypeset,
    translate(vec2(renderData.padding + self.appConfig.offsetX,
        renderData.padding + self.appConfig.offsetY))
  )
  if renderData.borderWidth > 0 and borderTypeset.isSome:
    context.image.strokeText(
      borderTypeset.get(),
      translate(vec2(renderData.padding + self.appConfig.offsetX,
          renderData.padding + self.appConfig.offsetY)),
      strokeWidth = float(renderData.borderWidth)
    )
