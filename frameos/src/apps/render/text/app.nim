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
    font*: string
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
    font*: string
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
    renderResult*: Option[RenderResult]

proc `==`(obj1, obj2: RenderData): bool =
  obj1.text == obj2.text and obj1.vAlign == obj2.vAlign and obj1.position == obj2.position and
      obj1.width == obj2.width and obj1.height == obj2.height and
      obj1.padding == obj2.padding and obj1.font == obj2.font and
      obj1.fontColor == obj2.fontColor and obj1.fontSize == obj2.fontSize and
      obj1.borderColor == obj2.borderColor and obj1.borderWidth == obj2.borderWidth

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
  var fontStyles: seq[FontStyle] = @[]
  var currentFontStyle = FontStyle(typeface: typeface, name: "", size: fontSize, color: color, underline: false,
      strikethrough: false, borderWidth: 0)

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
              if part == "/" and parts.len == 1:
                discard pop(fontStyles)
                break
              elif part.startsWith('#'):
                if not border:
                  currentFontStyle.color = parseHtmlColor(part)
              elif part.isNumber():
                currentFontStyle.size = part.parseFloat() * factor
              elif part == "underline":
                currentFontStyle.underline = true
              elif part == "strikethrough":
                currentFontStyle.strikethrough = true
              elif part == "no-underline":
                currentFontStyle.underline = false
              elif part == "no-strikethrough":
                currentFontStyle.strikethrough = false
              elif part == "reset":
                currentFontStyle.color = color
                currentFontStyle.size = fontSize
                currentFontStyle.underline = false
                currentFontStyle.strikethrough = false
              elif part.endsWith(".ttf"):
                currentFontStyle.typeface = getTypeface(part, self.frameConfig.assetsPath)
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
        let font = newFont(currentFontStyle.typeface, currentFontStyle.size, currentFontStyle.color)
        if currentFontStyle.underline:
          font.underline = true
        if currentFontStyle.strikethrough:
          font.strikethrough = true
        spans.add(newSpan(text[start ..< i], font))
  else:
    spans.add(newSpan(text, newFont(currentFontStyle.typeface, currentFontStyle.size, currentFontStyle.color)))

  return typeset(spans, bounds, hAlign, vAlign)


proc generateTypeset(self: App, renderData: RenderData, border: bool): Arrangement =
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
    typeface = getTypeface(renderData.font, self.frameConfig.assetsPath)

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
    font: self.appConfig.font,
    fontColor: self.appConfig.fontColor,
    fontSize: self.appConfig.fontSize,
    borderColor: self.appConfig.borderColor,
    borderWidth: self.appConfig.borderWidth,
  )

  let cacheMatch = self.renderResult.isSome and self.renderResult.get().renderData == renderData
  if not cacheMatch:
    let textTypeset = self.generateTypeset(renderData, false)
    let borderTypeset =
      if renderData.borderWidth > 0: some(self.generateTypeset(renderData, true))
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
