import pixie, options, strutils, unicode
import frameos/apps
import frameos/types
import frameos/utils/font

type
  AppConfig* = object
    inputImage*: Option[Image]
    text*: string
    richText*: string
    position*: string
    vAlign*: string
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
    vAlign*: string
    width*: int
    height*: int
    padding*: float
    fontColor*: Color
    fontSize*: float
    borderColor*: Color
    borderWidth*: int

  RenderResult* = ref object
    renderData*: RenderData
    textTypeset*: Arrangement
    borderTypeset*: Option[Arrangement]

  App* = ref object of AppRoot
    appConfig*: AppConfig
    typeface*: Typeface
    renderResult*: Option[RenderResult]

proc init*(self: App) =
  self.typeface = getDefaultTypeface()

proc `==`(obj1, obj2: RenderData): bool =
  obj1.text == obj2.text and obj1.vAlign == obj2.vAlign and obj1.position == obj2.position and
      obj1.width == obj2.width and obj1.height == obj2.height and
      obj1.padding == obj2.padding and obj1.fontColor == obj2.fontColor and
      obj1.fontSize == obj2.fontSize and obj1.borderColor ==
          obj2.borderColor and obj1.borderWidth == obj2.borderWidth

proc isNumber(x: string): bool =
  try:
    discard parseFloat(x)
    result = true
  except ValueError:
    result = false

proc toTypeset*(self: App, text: string, fontSize: float, baseFontSize: float, color: Color, typeface: Typeface,
                bounds: Vec2, hAlign: HorizontalAlignment, vAlign: VerticalAlignment, border: bool): Arrangement =
  let factor = fontSize / baseFontSize
  var spans: seq[Span] = @[]
  var currentColor = color
  var currentSize = fontSize
  var currentUnderline = false
  var currentStrikethrough = false

  if self.appConfig.richText == "basic-caret":
    var i = 0
    while i < text.len:
      if text[i] == '^':
        # Increment to skip '^'
        i += 1
        if i < text.len and text[i] == '(':
          # Find the closing parenthesis for the tag
          let tagStart = i + 1
          i = text.find(')', tagStart)
          if i != -1:
            let tag = text[tagStart ..< i]
            let parts = tag.split(',')
            for p in parts:
              let part = strutils.strip(p)
              if part.startsWith('#'):
                if not border:
                  currentColor = parseHtmlColor(part)
              elif part.isNumber():
                currentSize = part.parseFloat() * factor
              elif part == "underline":
                currentUnderline = true
              elif part == "strikethrough":
                currentStrikethrough = true
              elif part == "no-underline":
                currentUnderline = false
              elif part == "no-strikethrough":
                currentStrikethrough = false
              elif part == "reset":
                currentColor = color
                currentSize = fontSize
                currentUnderline = false
                currentStrikethrough = false
              else:
                self.logError("Invalid tag component: " & part)
            # Move past the closing ')'
            i += 1
          else:
            self.logError("Unmatched parenthesis in tag.")
        else:
          self.logError("Invalid tag format.")
      # Process the text following the tag until next tag or end of text
      let start = i
      while i < text.len and text[i] != '^':
        i += 1
      if i > start:
        let font = newFont(typeface, currentSize, currentColor)
        if currentUnderline:
          font.underline = true
        if currentStrikethrough:
          font.strikethrough = true
        spans.add(newSpan(text[start ..< i], font))
  else:
    spans.add(newSpan(text, newFont(typeface, currentSize, currentColor)))

  return typeset(spans, bounds, hAlign, vAlign)


proc generateTypeset(self: App, typeface: Typeface, renderData: RenderData, border: bool): Arrangement =
  let
    hAlign = case renderData.position:
      of "top-right", "center-right", "bottom-right", "right": RightAlign
      of "top-left", "center-left", "bottom-left", "left": LeftAlign
      else: CenterAlign
    vAlign = case (if renderData.vAlign != "": renderData.vAlign else: renderData.position):
      of "top-left", "top-center", "top-right", "top": TopAlign
      of "bottom-left", "bottom-center", "bottom-right", "bottom": BottomAlign
      else: MiddleAlign
    color = if border: renderData.borderColor else: renderData.fontColor
    width = renderData.width.toFloat() - 2 * renderData.padding
    height = renderData.height.toFloat() - 2 * renderData.padding
    bounds = vec2(width, height)
    baseFontSize = renderData.fontSize

  if self.appConfig.overflow == "visible":
    return self.toTypeset(renderData.text, renderData.fontSize, baseFontSize, color, typeface, bounds, hAlign, vAlign, border)

  else: # "fit-bounds"
    var tooBigFontSize = 0.0
    var tooSmallFontSize = 0.0
    var loopIndex = 0
    var fontSize = baseFontSize
    while loopIndex < 100:
      loopIndex += 1
      result = self.toTypeset(renderData.text, fontSize, baseFontSize, color, typeface, bounds, hAlign, vAlign, border)
      let bounds = layoutBounds(result)

      # if the text is too big, shrink the font size
      if bounds.y > height:
        if fontSize < 2:
          break

        # try to get closer based on the ratio
        tooBigFontSize = fontSize
        if tooSmallFontSize > 0.0:
          fontSize = (tooBigFontSize + tooSmallFontSize) / 2
        else:
          fontSize = tooBigFontSize / 2
        continue

      # we're in bounds, and on the first run (text was never too big), so return
      elif tooBigFontSize == 0.0:
        break

      # the text is too small, and was once too big
      else:
        if height - bounds.y < 1:
          break
        tooSmallFontSize = fontSize
        if tooBigFontSize - tooSmallFontSize < 0.5:
          break
        fontSize = (tooBigFontSize + tooSmallFontSize) / 2
        continue

proc setRenderResult*(self: App, context: ExecutionContext, maxWidth, maxHeight: int) =
  let renderData = RenderData(
    text: self.appConfig.text,
    position: self.appConfig.position,
    vAlign: self.appConfig.vAlign,
    width: maxWidth,
    height: maxHeight,
    padding: self.appConfig.padding,
    fontColor: self.appConfig.fontColor,
    fontSize: self.appConfig.fontSize,
    borderColor: self.appConfig.borderColor,
    borderWidth: self.appConfig.borderWidth,
  )

  let cacheMatch = self.renderResult.isSome and self.renderResult.get().renderData == renderData
  if not cacheMatch:
    let textTypeset = self.generateTypeset(self.typeface, renderData, false)
    let borderTypeset =
      if renderData.borderWidth > 0: some(self.generateTypeset(self.typeface, renderData, true))
      else: none(Arrangement)
    self.renderResult = some(RenderResult(
      renderData: renderData,
      textTypeset: textTypeset,
      borderTypeset: borderTypeset,
    ))

proc renderText*(self: App, context: ExecutionContext, image: Image, offsetX, offsetY: float): Image =
  let renderData = self.renderResult.get().renderData
  let textTypeset = self.renderResult.get().textTypeset
  let borderTypeset = self.renderResult.get().borderTypeset
  if renderData.borderWidth > 0 and borderTypeset.isSome:
    let ratio = if textTypeset.fonts.len > 0: textTypeset.fonts[0].size / self.appConfig.fontSize else: 1.0
    image.strokeText(
      borderTypeset.get(),
      translate(vec2(renderData.padding + offsetX, renderData.padding + offsetY)),
      strokeWidth = float(renderData.borderWidth) * ratio
    )
  image.fillText(
    textTypeset,
    translate(vec2(renderData.padding + offsetX, renderData.padding + offsetY))
  )
  return image

proc layoutBoundsTopLeft*(arrangement: Arrangement): Vec2 {.raises: [].} =
  result.x = 999999999
  result.y = 999999999
  ## Computes the width and height of the arrangement in pixels.
  if arrangement.runes.len > 0:
    for i in 0 ..< arrangement.runes.len:
      if arrangement.runes[i] != Rune(10):
        # Don't add width of a new line rune.
        let rect = arrangement.selectionRects[i]
        result.x = min(result.x, rect.x)
        result.y = min(result.y, rect.y)

proc run*(self: App, context: ExecutionContext) =
  self.setRenderResult(context, context.image.width, context.image.height)
  discard self.renderText(context, context.image, self.appConfig.offsetX, self.appConfig.offsetY)

proc get*(self: App, context: ExecutionContext): Image =
  if self.appConfig.inputImage.isSome:
    let image = self.appConfig.inputImage.get()
    self.setRenderResult(context, image.width, image.height)
    return self.renderText(context, image, self.appConfig.offsetX, self.appConfig.offsetY)
  else:
    if context.hasImage:
      self.setRenderResult(context, context.image.width, context.image.height)
    else:
      self.setRenderResult(context, self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
    let typeset = self.renderResult.get().textTypeset
    let bottomRight = layoutBounds(typeset)
    let topLeft = layoutBoundsTopLeft(typeset)
    let border = self.appConfig.borderWidth
    let image = newImage((bottomRight.x - topLeft.x).int + border, (bottomRight.y - topLeft.y).int + border)
    return self.renderText(context, image, ceil(border.float/2) - topLeft.x, ceil(border.float/2) - topLeft.y)
