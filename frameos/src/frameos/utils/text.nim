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

import strutils, unicode, options
import pixie
import frameos/utils/font

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
    innerW = max(0.0, width.float - 2 * opts.padding)
    innerH = max(0.0, height.float - 2 * opts.padding)
    bounds = vec2(innerW, innerH)
    baseSize = if opts.fontSize <= 0: 1.0 else: opts.fontSize
    typeface = if opts.font.len == 0: getDefaultTypeface() else: getTypeface(opts.font, opts.assetsPath)

  var chosen: Arrangement
  var chosenBorder: Option[Arrangement] = none(Arrangement)
  var scaleRatio = 1.0
  var fittedSize = baseSize

  if opts.overflow == "visible":
    chosen = toTypeset(opts.text, opts.richTextMode, baseSize, baseSize, opts.fontColor, typeface, bounds, hAlign,
        vAlign, false, opts.assetsPath)
    if opts.borderWidth > 0:
      chosenBorder = some(toTypeset(opts.text, opts.richTextMode, baseSize, baseSize, opts.borderColor, typeface,
          bounds, hAlign, vAlign, true, opts.assetsPath))
  else:
    # Binary search font size that fits height
    var tooBig = 0.0
    var tooSmall = 0.0
    var fontSize = baseSize
    var iter = 0
    while iter < 100:
      inc iter
      let layout = toTypeset(opts.text, opts.richTextMode, fontSize, baseSize, opts.fontColor, typeface, bounds, hAlign,
          vAlign, false, opts.assetsPath)
      let lh = layoutBounds(layout).y
      if lh > innerH:
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

proc drawText*(
  layout: TextLayoutResult,
  image: Image,
  offsetX = 0.0,
  offsetY = 0.0
) =
  ## Draw the prepared layout into `image`, honoring padding and optional border.
  let pad = layout.opts.padding
  if layout.opts.borderWidth > 0 and layout.borderTypeset.isSome:
    image.strokeText(
      layout.borderTypeset.get(),
      translate(vec2(pad + offsetX, pad + offsetY)),
      strokeWidth = float(layout.opts.borderWidth) * layout.fontScaleRatio
    )
  image.fillText(
    layout.textTypeset,
    translate(vec2(pad + offsetX, pad + offsetY))
  )

proc measureTightImage*(layout: TextLayoutResult): (int, int) =
  ## For apps that output a tightly-cropped image (without providing input image).
  ## Computes width/height needed to contain the text + border, ignoring padding.
  let br = layoutBounds(layout.textTypeset)
  let tl = layoutBoundsTopLeft(layout.textTypeset)
  let bw = layout.opts.borderWidth
  let w = max(1, (br.x - tl.x).int + bw)
  let h = max(1, (br.y - tl.y).int + bw)
  (w, h)
