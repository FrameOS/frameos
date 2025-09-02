import pixie, options
import frameos/apps
import frameos/types
import frameos/utils/text

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

  # Internal cache key to avoid re-typesetting when nothing relevant changed.
  CacheKey = object
    text: string
    richText: string
    position: string
    vAlign: string
    width: int
    height: int
    padding: float
    font: string
    fontColor: Color
    fontSize: float
    borderColor: Color
    borderWidth: int
    overflow: string
    assetsPath: string

  App* = ref object of AppRoot
    appConfig*: AppConfig
    layout*: Option[TextLayoutResult]
    cacheKey*: Option[CacheKey]

proc `==`(a, b: CacheKey): bool =
  a.text == b.text and
  a.richText == b.richText and
  a.position == b.position and
  a.vAlign == b.vAlign and
  a.width == b.width and
  a.height == b.height and
  a.padding == b.padding and
  a.font == b.font and
  a.fontColor == b.fontColor and
  a.fontSize == b.fontSize and
  a.borderColor == b.borderColor and
  a.borderWidth == b.borderWidth and
  a.overflow == b.overflow and
  a.assetsPath == b.assetsPath

proc toOptions(self: App, width, height: int): TextRenderOptions =
  TextRenderOptions(
    text: self.appConfig.text,
    richTextMode: self.appConfig.richText,
    position: self.appConfig.position,
    vAlign: self.appConfig.vAlign,
    padding: self.appConfig.padding,
    font: self.appConfig.font,
    fontColor: self.appConfig.fontColor,
    fontSize: self.appConfig.fontSize,
    borderColor: self.appConfig.borderColor,
    borderWidth: self.appConfig.borderWidth,
    overflow: self.appConfig.overflow,
    assetsPath: self.frameConfig.assetsPath
  )

proc buildKey(self: App, width, height: int): CacheKey =
  CacheKey(
    text: self.appConfig.text,
    richText: self.appConfig.richText,
    position: self.appConfig.position,
    vAlign: self.appConfig.vAlign,
    width: width,
    height: height,
    padding: self.appConfig.padding,
    font: self.appConfig.font,
    fontColor: self.appConfig.fontColor,
    fontSize: self.appConfig.fontSize,
    borderColor: self.appConfig.borderColor,
    borderWidth: self.appConfig.borderWidth,
    overflow: self.appConfig.overflow,
    assetsPath: self.frameConfig.assetsPath
  )

proc ensureLayout(self: App, maxWidth, maxHeight: int) =
  let key = self.buildKey(maxWidth, maxHeight)
  let need = if self.cacheKey.isSome: not (self.cacheKey.get == key) else: true
  if need or not self.layout.isSome:
    let opts = self.toOptions(maxWidth, maxHeight)
    let layout = typesetIntoBounds(opts, maxWidth, maxHeight)
    self.layout = some(layout)
    self.cacheKey = some(key)

proc renderText*(self: App, context: ExecutionContext, image: Image, offsetX, offsetY: float): Image =
  let lay = self.layout.get()
  drawText(lay, image, offsetX = offsetX, offsetY = offsetY)
  image

proc run*(self: App, context: ExecutionContext) =
  if self.appConfig.text.len == 0:
    return
  self.ensureLayout(context.image.width, context.image.height)
  discard self.renderText(context, context.image, self.appConfig.offsetX, self.appConfig.offsetY)

proc get*(self: App, context: ExecutionContext): Image =
  if self.appConfig.inputImage.isSome:
    let img = self.appConfig.inputImage.get()
    self.ensureLayout(img.width, img.height)
    return self.renderText(context, img, self.appConfig.offsetX, self.appConfig.offsetY)
  else:
    if context.hasImage:
      self.ensureLayout(context.image.width, context.image.height)
    else:
      self.ensureLayout(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())

    let lay = self.layout.get()
    # Compute a tightly-cropped image size around the laid out text (ignoring padding),
    # same behavior as before but via utils helpers.
    let br = layoutBounds(lay.textTypeset)
    let tl = layoutBoundsTopLeft(lay.textTypeset)
    let border = self.appConfig.borderWidth
    let outW = max(1, (br.x - tl.x).int + border)
    let outH = max(1, (br.y - tl.y).int + border)
    let output = newImage(outW, outH)

    # Offset so that the top-left of the layout sits at ~border/2 inset.
    let ox = ceil(border.float / 2) - tl.x + self.appConfig.offsetX
    let oy = ceil(border.float / 2) - tl.y + self.appConfig.offsetY
    discard self.renderText(context, output, ox, oy)
    return output
