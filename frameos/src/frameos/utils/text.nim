# frameos/src/frameos/utils/text.nim
# --------------------------------
# Shared text layout + rendering helpers for apps.
#
# Key features:
# - Rich text (basic caret syntax) or plain text
# - Auto-fit text into bounds (binary search) or “visible” overflow
# - Horizontal / vertical alignment
# - Optional stroke/border rendering with size that scales with font
#
# Example:
#   let opts = TextRenderOptions(
#     text: "Hello ^(underline)world^(no-underline)!",
#     richTextMode: "basic-caret",
#     position: "center",        # left|center|right or top-left, etc.
#     vAlign: "middle",          # top|middle|bottom (or empty => from position)
#     padding: 10,
#     font: "",                  # "" => default font
#     fontColor: parseHtmlColor("#ffffff"),
#     fontSize: 32,
#     borderColor: parseHtmlColor("#000000"),
#     borderWidth: 2,
#     overflow: "fit-bounds",    # "fit-bounds" | "visible"
#     assetsPath: frameConfig.assetsPath
#   )
#   let layout = typesetIntoBounds(opts, maxWidth, maxHeight)
#   drawText(layout, image, offsetX = 0, offsetY = 0)
#
# Notes:
# - This module has no dependency on App or ExecutionContext.
# - Keep using pixie’s Typeface/Font/Arrangement primitives.

import strutils, unicode, options, math
import pixie
import pixie/blends
import frameos/utils/font
import frameos/utils/memory

type
  TextRenderOptions* = object
    ## High-level rendering inputs (shared across apps)
    text*: string
    richTextMode*: string ## "disabled" | "basic-caret"
    position*: string     ## "left"|"center"|"right" or "top-left" etc.
    vAlign*: string       ## "top"|"middle"|"bottom" or "" to derive from `position`
    padding*: float       ## inner padding in pixels
    font*: string         ## font file name or "" for default
    fontColor*: Color
    fontSize*: float      ## base font size (used for scaling)
    borderColor*: Color
    borderWidth*: int
    overflow*: string     ## "fit-bounds" | "visible"
    assetsPath*: string   ## for loading typefaces
    scale*: float         ## what the sizes above (and rich text's own) are multiplied by, the render scale; 0 = 1

  TextLayoutResult* = ref object
    ## Final, reusable output for drawing
    opts*: TextRenderOptions
    width*: int
    height*: int
    textTypeset*: Arrangement
    borderTypeset*: Option[Arrangement]
    ## Ratio of actual font size used vs. opts.fontSize
    fontScaleRatio*: float

# ---------- Helpers

proc parseHAlign(position: string): HorizontalAlignment =
  case position
  of "top-right", "center-right", "bottom-right", "right": RightAlign
  of "top-left", "center-left", "bottom-left", "left": LeftAlign
  else: CenterAlign

proc parseVAlign(position, vAlign: string): VerticalAlignment =
  let src = if vAlign.len > 0: vAlign else: position
  case src
  of "top-left", "top-center", "top-right", "top": TopAlign
  of "bottom-left", "bottom-center", "bottom-right", "bottom": BottomAlign
  else: MiddleAlign

proc isNumber(x: string): bool =
  try:
    discard parseFloat(x)
    result = true
  except ValueError:
    result = false

# Compute the top-left corner of the layout bounds (pixie gives only bottom-right via layoutBounds)
proc layoutBoundsTopLeft*(arrangement: Arrangement): Vec2 {.raises: [].} =
  result.x = 9.0e9
  result.y = 9.0e9
  if arrangement.runes.len > 0:
    for i in 0 ..< arrangement.runes.len:
      if arrangement.runes[i] != Rune(10): # skip newline
        let rect = arrangement.selectionRects[i]
        result.x = min(result.x, rect.x)
        result.y = min(result.y, rect.y)

const StrokeOffsetDirections = [
  (-1, 0), (1, 0), (0, -1), (0, 1),
  (-1, -1), (1, -1), (-1, 1), (1, 1)
]

proc fillTextStamped(image: Image, arrangement: Arrangement, origin: Vec2, radius: int) =
  ## The outline as `radius * 8` full rasterizations of the text, one per
  ## offset: what a scratch image too big for the memory left comes down to.
  for step in 1 .. radius:
    let amount = step.float32
    for (dx, dy) in StrokeOffsetDirections:
      image.fillText(
        arrangement,
        translate(vec2(
          origin.x + dx.float32 * amount,
          origin.y + dy.float32 * amount
        ))
      )

const ApproxStrokeScratchMaxBytes = 2 * 1024 * 1024

type ApproxStrokeReport* = object
  ## How the last outline was drawn, for the text app's debug log.
  path*: string          ## "dilated", or why it stamped instead
  scratchBytes*: int
  availableBytes*: int

var lastApproxStroke* {.threadvar.}: ApproxStrokeReport

when defined(frameosEmbedded):
  # The two loops below run over every pixel of the text's box, in a firmware
  # built at -Os with every check on; at -O2 with checks off, like the dither
  # packers, they are a few cycles a pixel.
  {.pragma: strokeHotLoop, codegenDecl: "__attribute__((optimize(\"O2\"))) $# $#$#".}
else:
  {.pragma: strokeHotLoop.}

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

proc dilateInPlace(cov: ptr UncheckedArray[uint8], w, h, radius: int,
    rowBuf, ring: ptr UncheckedArray[uint8]) {.strokeHotLoop.} =
  ## A coverage plane (a byte a pixel, rows of `w`) grown by `radius` pixels
  ## in every direction, in place: the maximum over the (2r+1)^2 square
  ## around each pixel, as a row pass and a column pass. `rowBuf` holds one
  ## row, `ring` `radius` rows: the column pass keeps the rows above as they
  ## were before it wrote them, and reads the rows below, not written yet.
  for y in 0 ..< h:
    let row = cast[ptr UncheckedArray[uint8]](cov[y * w].addr)
    copyMem(rowBuf, row, w)
    for x in 0 ..< w:
      var m = 0'u8
      for k in max(0, x - radius) .. min(w - 1, x + radius):
        let a = rowBuf[k]
        if a > m: m = a
      row[x] = m
  for y in 0 ..< h:
    let row = cast[ptr UncheckedArray[uint8]](cov[y * w].addr)
    copyMem(rowBuf, row, w)
    for x in 0 ..< w:
      var m = rowBuf[x]
      for k in 1 .. radius:
        if y - k >= 0:
          let a = ring[((y - k) mod radius) * w + x]
          if a > m: m = a
        if y + k < h:
          let a = cov[(y + k) * w + x]
          if a > m: m = a
      row[x] = m
    copyMem(ring[(y mod radius) * w].addr, rowBuf, w)

proc blendCoverage(image: Image, coverage: ptr UncheckedArray[uint8], w, h, left, top: int, color: ColorRGBX) {.strokeHotLoop.} =
  ## `color` (premultiplied, full coverage at its own alpha) through
  ## `coverage` onto `image` at (left, top), clipped to the image.
  if color.a == 0:
    return
  let rgbx = image.format == pfRgbx
  let pixels = cast[ptr UncheckedArray[ColorRGBX]](image.bufferPointer)
  for y in 0 ..< h:
    let ty = top + y
    if ty < 0 or ty >= image.height: continue
    let rowIndex = image.dataIndex(0, ty)
    for x in 0 ..< w:
      let tx = left + x
      if tx < 0 or tx >= image.width: continue
      let c = coverage[y * w + x].uint32
      if c == 0: continue
      # The coverage is the glyphs' alone (filled in white): the color's own
      # alpha scales it, as filling in the color itself would have.
      let
        sa = (c * color.a.uint32 + 127) div 255
        src = rgbx(
          uint8((color.r.uint32 * sa + color.a.uint32 div 2) div color.a.uint32),
          uint8((color.g.uint32 * sa + color.a.uint32 div 2) div color.a.uint32),
          uint8((color.b.uint32 * sa + color.a.uint32 div 2) div color.a.uint32),
          uint8(sa))
        index = rowIndex + tx
      if rgbx:
        pixels[index] = blendNormal(pixels[index], src)
      else:
        image.setPixel(index, blendNormal(image.getPixel(index), src))

{.pop.}

proc solidArrangementColor(arrangement: Arrangement): (bool, Color) =
  ## The one solid color every span of `arrangement` is filled with — what a
  ## border layout is (toTypeset with `border`: every span in borderColor).
  var found = false
  var color: Color
  for font in arrangement.fonts:
    for paint in font.paints:
      if paint.kind != SolidPaint or paint.opacity != 1.0:
        return (false, color)
      if not found:
        color = paint.color
        found = true
      elif paint.color != color:
        return (false, color)
  (found, color)

proc fillTextApproxStroke*(
  image: Image,
  arrangement: Arrangement,
  origin: Vec2,
  strokeWidth: float
) =
  ## Cheap text outline for embedded targets, where pixie's path strokeText
  ## costs more memory than a board has left: the text in the border color,
  ## grown by `ceil(strokeWidth)` pixels all round, under the fill.
  ##
  ## It used to stamp the text at radius rings of eight whole-pixel offsets:
  ## 16 full rasterizations for the default 2 px border, 2 s of a 480x480
  ## render on an ESP32-S3 at 160 MHz (the SenseCAP Indicator bench,
  ## 2026-10-25, PR #622), and the text app's default border is 2 px. Rasterizing once and
  ## compositing that image 16 times was still 1.3 s (pixie's blend loop runs
  ## at the firmware's -Os, checks on). Now the text is rasterized once into
  ## a scratch image of its ink box, its coverage grown by a square maximum
  ## filter and blended once, both loops at -O2: ~300 ms. The scratch is a
  ## grey image, the text filled in white on black so its luma is the
  ## coverage, grown in place: a byte a pixel and a few rows. It was RGBA
  ## and two planes, 6 bytes a pixel, and a caption across the reTerminal
  ## E1004's 1200 px asked 3.2 MB with 1.1 MB free: every render of
  ## Wikimedia Commons stamped, 24,582 glyphs and 2.4 s (the hardware bench,
  ## 2026-11-21). The same outline, its
  ## corners a little fuller where the rings left gaps, its antialiased rim a
  ## little lighter (a maximum where stacked copies compounded). A scratch the
  ## memory left cannot hold, or a border layout of several colors, stamps.
  if strokeWidth <= 0:
    return
  let radius = max(1, ceil(strokeWidth).int)
  lastApproxStroke = ApproxStrokeReport(path: "", scratchBytes: 0, availableBytes: 0)
  let (solid, borderColor) = solidArrangementColor(arrangement)
  if not solid:
    lastApproxStroke.path = "stamped: not one solid color"
    image.fillTextStamped(arrangement, origin, radius)
    return
  let
    baseX = floor(origin.x)
    baseY = floor(origin.y)
    fracX = origin.x - baseX
    fracY = origin.y - baseY
  var bounds: Rect
  try:
    bounds = arrangement.computeBounds(translate(vec2(fracX, fracY)))
  except PixieError:
    lastApproxStroke.path = "stamped: no bounds"
    image.fillTextStamped(arrangement, origin, radius)
    return
  if bounds.w <= 0 or bounds.h <= 0:
    return
  # A pixel for the antialiased edge, plus room to grow.
  let
    margin = 1 + radius
    x0 = floor(bounds.x).int - margin
    y0 = floor(bounds.y).int - margin
    x1 = ceil(bounds.x + bounds.w).int + margin
    y1 = ceil(bounds.y + bounds.h).int + margin
    w = x1 - x0
    h = y1 - y0
    # The grey scratch (a byte a pixel) and the dilation's rows.
    scratchBytes = w.int64 * h.int64 + w.int64 * (radius + 1)
  # Whatever the renderer could still get for an image (availableRenderBytes:
  # the largest free block, the reserve kept back), less a margin: the
  # scratch lives only for this call.
  let available = availableRenderBytes()
  lastApproxStroke.scratchBytes = scratchBytes.int
  lastApproxStroke.availableBytes = available
  # Nothing available is an answer on an ESP32 (under the reserve, the moment
  # this check is for). Only a host that cannot tell says 0 and means unknown.
  if w <= 0 or h <= 0 or scratchBytes > ApproxStrokeScratchMaxBytes or
      ((available > 0 or runsAsEmbedded()) and scratchBytes + 64 * 1024 > available):
    lastApproxStroke.path = "stamped: no memory for the scratch"
    image.fillTextStamped(arrangement, origin, radius)
    return
  let scratch = newImageGray8(w, h)
  # The glyphs' coverage alone: every span in opaque white for the fill, the
  # arrangement's own paints put back after.
  var saved: seq[seq[Paint]]
  let white = newPaint(SolidPaint)
  white.color = color(1, 1, 1, 1)
  for font in arrangement.fonts:
    saved.add font.paints
    font.paints = @[white]
  try:
    scratch.fillText(arrangement, translate(vec2(fracX - x0.float32, fracY - y0.float32)))
  finally:
    for i, font in arrangement.fonts:
      font.paints = saved[i]
  var rows = newSeq[uint8](w * (radius + 1))
  let
    cov = scratch.data8
    rowBuf = cast[ptr UncheckedArray[uint8]](rows[0].addr)
    ring = cast[ptr UncheckedArray[uint8]](rows[w].addr)
  dilateInPlace(cov, w, h, radius, rowBuf, ring)
  image.blendCoverage(cov, w, h, baseX.int + x0, baseY.int + y0, borderColor.rgbx())
  lastApproxStroke.path = "dilated"

# ---------- Rich text (caret) or plain spans

type FontStyle = object
  typeface: Typeface
  size: float
  color: Color
  underline: bool
  strikethrough: bool

proc toTypeset(
  text: string,
  richTextMode: string,
  fontSize: float,
  baseFontSize: float,
  color: Color,
  typeface: Typeface,
  bounds: Vec2,
  hAlign: HorizontalAlignment,
  vAlign: VerticalAlignment,
  border: bool,
  assetsPath: string
): Arrangement =
  let factor = if baseFontSize == 0: 1.0 else: fontSize / baseFontSize
  var spans: seq[Span] = @[]
  var current = FontStyle(typeface: typeface, size: fontSize, color: color, underline: false, strikethrough: false)

  if richTextMode == "basic-caret":
    var fontStack: seq[FontStyle] = @[]
    var i = 0
    while i < text.len:
      if text[i] == '^':
        inc i
        if i < text.len and text[i] == '(':
          let tagStart = i + 1
          i = text.find(')', tagStart)
          if i != -1:
            let tag = text[tagStart ..< i]
            let parts = tag.split(',')
            for raw in parts:
              let part = strutils.strip(raw)
              if part == "/" and parts.len == 1:
                if fontStack.len > 0: discard fontStack.pop()
                current = if fontStack.len > 0: fontStack[^1] else: current
                break
              elif part.startsWith('#'):
                if not border:
                  current.color = parseHtmlColor(part)
              elif part.isNumber():
                current.size = part.parseFloat() * factor
              elif part == "underline":
                current.underline = true
              elif part == "no-underline":
                current.underline = false
              elif part == "strikethrough":
                current.strikethrough = true
              elif part == "no-strikethrough":
                current.strikethrough = false
              elif part == "reset":
                current.color = color
                current.size = fontSize
                current.underline = false
                current.strikethrough = false
              elif part.endsWith(".ttf"):
                current.typeface = getTypeface(part, assetsPath)
              else:
                # Unknown tag component: ignore silently in util
                discard
            inc i # past ')'
          else:
            # unmatched ')': ignore caret sequence
            discard
        else:
          # lone '^': treat as normal char
          let start = i - 1
          while i < text.len and text[i] != '^': inc i
          let f = newFont(current.typeface, current.size, current.color)
          if current.underline: f.underline = true
          if current.strikethrough: f.strikethrough = true
          spans.add(newSpan(text[start ..< i], f))
          continue
      # gather literal run up to next caret
      let start = i
      while i < text.len and text[i] != '^': inc i
      if i > start:
        let f = newFont(current.typeface, current.size, current.color)
        if current.underline: f.underline = true
        if current.strikethrough: f.strikethrough = true
        spans.add(newSpan(text[start ..< i], f))
  else:
    let f = newFont(typeface, fontSize, color)
    spans.add(newSpan(text, f))

  result = typeset(spans, bounds, hAlign, vAlign)

# ---------- Public API

proc breaksWord*(a: Arrangement): bool =
  ## Whether a word was broken across two lines: pixie wraps at spaces, and a
  ## word wider than its line it breaks where the line ends. A line that ends
  ## in a letter, followed by one that starts with one, with no break of the
  ## text's own between them (a space, a new line, a hyphen).
  for i in 0 ..< a.lines.len - 1:
    let
      last = a.lines[i][1]
      next = a.lines[i + 1][0]
    if last < 0 or next != last + 1 or next >= a.runes.len:
      continue
    let r = a.runes[last]
    if r.isWhiteSpace or a.runes[next].isWhiteSpace or r == Rune('-') or r == Rune(0x2010) or
        r == Rune(0x00AD):
      continue
    return true

proc typesetIntoBounds*(
  opts: TextRenderOptions,
  maxWidth: int,
  maxHeight: int
): TextLayoutResult =
  ## Produce text + optional border arrangements that fit within the content
  ## region (maxWidth x maxHeight) after inner padding, auto-scaling if needed.
  let
    width = maxWidth
    height = maxHeight
    hAlign = parseHAlign(opts.position)
    vAlign = parseVAlign(opts.position, opts.vAlign)
    # The render scale: every length larger by it. Rich text's own sizes
    # follow through toTypeset's factor (the size typeset over `baseSize`).
    scale = if opts.scale > 0: opts.scale else: 1.0
    padding = opts.padding * scale
    innerW = max(0.0, width.float - 2 * padding)
    innerH = max(0.0, height.float - 2 * padding)
    bounds = vec2(innerW, innerH)
    baseSize = if opts.fontSize <= 0: 1.0 else: opts.fontSize
    scaledSize = baseSize * scale
    typeface = getTypeface(opts.font, opts.assetsPath)

  var chosen: Arrangement
  var chosenBorder: Option[Arrangement] = none(Arrangement)
  var scaleRatio = scale
  var fittedSize = scaledSize

  if opts.overflow == "visible":
    chosen = toTypeset(opts.text, opts.richTextMode, scaledSize, baseSize, opts.fontColor, typeface, bounds, hAlign,
        vAlign, false, opts.assetsPath)
    if opts.borderWidth > 0:
      chosenBorder = some(toTypeset(opts.text, opts.richTextMode, scaledSize, baseSize, opts.borderColor, typeface,
          bounds, hAlign, vAlign, true, opts.assetsPath))
  else:
    # Binary search font size that fits: its height, and every word whole on
    # a line (a word wider than the box was broken mid-word, "banan/as" in a
    # narrow split panel, the UX bench 2026-11-27). Words are kept whole only
    # where they can be at 40 % of the size: a text with a token wider than
    # that (a URL, compact JSON) breaks at the box as before, rather than
    # shrink out of sight and break anyway.
    var tooBig = 0.0
    var tooSmall = 0.0
    var fontSize = scaledSize
    var iter = 0
    let wholeWords = not toTypeset(opts.text, opts.richTextMode, scaledSize * 0.4, baseSize, opts.fontColor,
        typeface, bounds, hAlign, vAlign, false, opts.assetsPath).breaksWord()
    while iter < 100:
      inc iter
      let layout = toTypeset(opts.text, opts.richTextMode, fontSize, baseSize, opts.fontColor, typeface, bounds, hAlign,
          vAlign, false, opts.assetsPath)
      let lh = layoutBounds(layout).y
      if lh > innerH or wholeWords and layout.breaksWord():
        if fontSize < 2: break
        tooBig = fontSize
        if tooSmall > 0: fontSize = (tooBig + tooSmall) / 2 else: fontSize = tooBig / 2
        continue
      elif tooBig == 0.0:
        # fits and was never too big -> accept
        chosen = layout
        fittedSize = fontSize
        break
      else:
        # fits and was too big before, tighten upward
        if innerH - lh < 1:
          chosen = layout
          fittedSize = fontSize
          break
        tooSmall = fontSize
        if tooBig - tooSmall < 0.5:
          chosen = layout
          fittedSize = fontSize
          break
        fontSize = (tooBig + tooSmall) / 2

    if chosen.runes.len == 0:
      # safety: try last computed
      chosen = toTypeset(opts.text, opts.richTextMode, fontSize, baseSize, opts.fontColor, typeface, bounds, hAlign,
          vAlign, false, opts.assetsPath)
      fittedSize = fontSize

    scaleRatio = if baseSize == 0: 1.0 else: fittedSize / baseSize
    if opts.borderWidth > 0:
      let borderLayout = toTypeset(opts.text, opts.richTextMode, fittedSize, baseSize, opts.borderColor,
          typeface, bounds, hAlign, vAlign, true, opts.assetsPath)
      chosenBorder = some(borderLayout)

  result = TextLayoutResult(
    opts: opts,
    width: width,
    height: height,
    textTypeset: chosen,
    borderTypeset: chosenBorder,
    fontScaleRatio: scaleRatio
  )
  result.opts.padding = padding # what drawText insets by

proc scaledBorder*(layout: TextLayoutResult): int =
  ## The border's width at the render scale (TextRenderOptions.scale), in
  ## whole pixels: what a tight crop leaves around the text for it.
  let scale = if layout.opts.scale > 0: layout.opts.scale else: 1.0
  int(round(layout.opts.borderWidth.float * scale))

proc drawText*(
  layout: TextLayoutResult,
  image: Image,
  offsetX = 0.0,
  offsetY = 0.0
) =
  ## Draw the prepared layout into `image`, honoring padding and optional border.
  let pad = layout.opts.padding
  let origin = vec2(pad + offsetX, pad + offsetY)
  if layout.opts.borderWidth > 0 and layout.borderTypeset.isSome:
    let strokeWidth = float(layout.opts.borderWidth) * layout.fontScaleRatio
    when defined(frameosEmbedded):
      image.fillTextApproxStroke(layout.borderTypeset.get(), origin, strokeWidth)
    else:
      # The preview running as an ESP32 strokes the way the device does: the
      # path stroke cost the Wikimedia Commons caption 2.5 MB on a 13.3"
      # canvas, more than an 8 MB board has left.
      if runsAsEmbedded():
        image.fillTextApproxStroke(layout.borderTypeset.get(), origin, strokeWidth)
      else:
        image.strokeText(
          layout.borderTypeset.get(),
          translate(origin),
          strokeWidth = strokeWidth
        )
  image.fillText(
    layout.textTypeset,
    translate(origin)
  )

proc measureTightImage*(layout: TextLayoutResult): (int, int) =
  ## For apps that output a tightly-cropped image (without providing input image).
  ## Computes width/height needed to contain the text + border, ignoring padding.
  let br = layoutBounds(layout.textTypeset)
  let tl = layoutBoundsTopLeft(layout.textTypeset)
  let bw = layout.scaledBorder()
  let w = max(1, (br.x - tl.x).int + bw)
  let h = max(1, (br.y - tl.y).int + bw)
  (w, h)
