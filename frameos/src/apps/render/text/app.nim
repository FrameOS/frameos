import std/[json, math]
import pixie, options
import frameos/apps
import frameos/types
import frameos/render_scale
import frameos/panel_shape
import frameos/utils/text
import frameos/utils/image

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
    scale: float

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
  a.assetsPath == b.assetsPath and
  a.scale == b.scale

proc scale(self: App): float =
  ## The render scale in effect for the scene (render_scale.nim): the text's
  ## sizes and offsets are larger by it, as a JSX scene's are. The runner's
  ## own text (no scene) sizes itself by apps.panelScale.
  nodeRenderScale(self.scene, self.frameConfig)

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
    assetsPath: self.frameConfig.assetsPath,
    scale: self.scale()
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
    assetsPath: self.frameConfig.assetsPath,
    scale: self.scale()
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
  if self.frameConfig.debug and lay.borderTypeset.isSome and lastApproxStroke.path.len > 0:
    self.log(%*{"event": "text:outline", "path": lastApproxStroke.path,
                "scratchBytes": lastApproxStroke.scratchBytes,
                "availableBytes": lastApproxStroke.availableBytes})
  image

proc offsets(self: App): (float, float) =
  ## The offsets at the render scale, like the sizes.
  let scale = self.layout.get().opts.scale
  let k = if scale > 0: scale else: 1.0
  (self.appConfig.offsetX * k, self.appConfig.offsetY * k)

proc roundBox(self: App, width, height: int): tuple[x, y, w, h: int] =
  ## Where the text goes when it is drawn on a round panel's whole canvas, of
  ## which only the circle shows (panel_shape.nim): text pinned to an edge or
  ## a corner in the square inside the circle, `RoundInset` in from the rim;
  ## text in the middle as wide as the circle is where its block reaches, a
  ## line or two of a setup message across the whole glass. Laid out from the
  ## canvas's corner, a scene's "add your key" note and a corner's clock lost
  ## their first words to the rim (the UX bench, 2026-11-27).
  let r = float(min(width, height)) / 2 - RoundInset.float
  let side = max(8, int(r * sqrt(2.0)))
  result = ((width - side) div 2, (height - side) div 2, side, side)
  if self.appConfig.vAlign notin ["middle", "center"] or self.appConfig.position != "center":
    return
  # The block's height at a width sets the width the circle has there; the
  # wider line may take fewer rows. Three rounds settle it.
  var w = side
  for _ in 0 ..< 3:
    self.ensureLayout(w, side)
    let lay = self.layout.get()
    let blockH = layoutBounds(lay.textTypeset).y - layoutBoundsTopLeft(lay.textTypeset).y +
      2 * lay.opts.padding * (if lay.opts.scale > 0: lay.opts.scale else: 1.0)
    let half = sqrt(max(0.0, r * r - (blockH / 2) * (blockH / 2)))
    let wider = max(side, int(2 * half))
    if wider == w:
      break
    w = wider
  result = ((width - w) div 2, (height - side) div 2, w, side)

proc roundCanvas(self: App, image: Image): bool =
  ## This run draws a round panel's whole canvas: not a window, a split's
  ## panel or a layout's hole, which are rooms of their own (app_runtime's
  ## `context.round`).
  not self.frameConfig.isNil and panelIsRound(self.frameConfig.device) and
    image.width == self.frameConfig.renderWidth() and image.height == self.frameConfig.renderHeight()

proc run*(self: App, context: ExecutionContext) =
  if self.appConfig.text.len == 0:
    return
  if self.roundCanvas(context.image):
    let box = self.roundBox(context.image.width, context.image.height)
    self.ensureLayout(box.w, box.h)
    let (ox, oy) = self.offsets()
    discard self.renderText(context, context.image, ox + box.x.float, oy + box.y.float)
    return
  self.ensureLayout(context.image.width, context.image.height)
  let (ox, oy) = self.offsets()
  discard self.renderText(context, context.image, ox, oy)

proc get*(self: App, context: ExecutionContext): Image =
  if self.appConfig.inputImage.isSome:
    let img = self.appConfig.inputImage.get()
    self.ensureLayout(img.width, img.height)
    let (ox, oy) = self.offsets()
    return self.renderText(context, img, ox, oy)
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
    let border = lay.scaledBorder()
    # Bounded: a huge font size or border is a scene-supplied allocation.
    let (outW, outH) = boundedRequestedDimensions((br.x - tl.x).int + border, (br.y - tl.y).int + border)
    let output = newImage(outW, outH)

    # Offset so that the top-left of the layout sits at ~border/2 inset.
    let (dx, dy) = self.offsets()
    let ox = ceil(border.float / 2) - tl.x + dx
    let oy = ceil(border.float / 2) - tl.y + dy
    discard self.renderText(context, output, ox, oy)
    return output
