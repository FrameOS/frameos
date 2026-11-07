## Load SVG files.

import bumpy, chroma, ../common, ../fonts, ../images, ../internal, ../paints,
    ../paths, parsexml, strtabs, strutils, tables, unicode, vmath, xmlparser, xmltree

const
  xmlSignature* = "<?xml"
  svgSignature* = "<svg"

type
  Svg* = ref object
    width*, height*: int
    elements: seq[SvgElement]
    gradients: Table[string, SvgGradient]
    viewBoxWidth, viewBoxHeight: float32 # what percentage lengths refer to

  SvgNode* {.acyclic.} = ref object
    ## What `parseSvg` reads: an element (`tag`, `attrs`, `children`), a run
    ## of text inside one (an empty `tag`), or the text of an entity, which
    ## keeps its spaces (`tag` "&"). Markup becomes a tree of these
    ## (`parseSvgNodes`); a caller that holds a drawing in some other form
    ## builds the tree itself and skips the markup — the larger half of an
    ## animated document's parse. Such a caller can also hand over what markup
    ## has no words for: the picture an `<image>` draws (`image`) and the
    ## outline of a `<path>` (`path`, in place of its `d`).
    tag*: string
    text*: string
    attrs*: seq[(string, string)]
    children*: seq[SvgNode]
    image*: Image
    path*: Path
    # What parseSvg made of this node as a child of the document, and under
    # which inherited properties: a caller that hands the same node over
    # again (a UI's unchanged card) gets the same elements back unparsed.
    # A node is not changed once parsed, as a shared path is not. The
    # properties are the document's, one object for every node parsed
    # with them, not a copy in each.
    parsed: seq[SvgElement]
    parsedUnder: ref SvgProperties # nil: not parsed

  SvgElement = ref object
    ## One thing an SVG draws. Never changed once made, so the parses that
    ## bring a node's elements back (`SvgNode.parsed`) and every frame a
    ## caller keeps for its damage share it: a pointer per element, not a
    ## copy of its properties each. The same element in two parses is one
    ## object, which is how damageRects knows it without comparing.
    path: Path
    props: SvgProperties
    bounds: Rect # paintBounds, once measured (w < 0: not yet)

  SvgTextAnchor = enum
    StartAnchor, MiddleAnchor, EndAnchor

  SvgBaseline = enum
    AlphabeticBaseline, MiddleBaseline, HangingBaseline, IdeographicBaseline

  SvgProperties = object
    display: bool
    fillRule: WindingRule
    fill: string
    stroke: ColorRGBX
    strokeWidth: float32
    strokeLineCap: LineCap
    strokeLineJoin: LineJoin
    strokeMiterLimit: float32
    strokeDashArray: seq[float32]
    transform: Mat3
    opacity, fillOpacity, strokeOpacity: float32
    fontFamily: string
    fontSize: float32
    fontWeight: int
    fontItalic: bool
    textAnchor: SvgTextAnchor
    baseline: SvgBaseline
    # A square-cornered `<rect>` element's own box, before `transform`
    # (`coversOpaque`). Never inherited: parseSvgProperties clears it.
    isRect: bool
    rectX, rectY, rectW, rectH: float32
    # An `<image>`: the picture, the box it is drawn stretched into, and
    # whether it is clipped to the element's own box (rectX.., `slice`).
    # Never inherited either.
    image: Image
    imageBox: Rect
    imageClip: bool
    # The viewport of a nested `<svg>` it is inside (and of every one around
    # that), in the parsed image's pixels: nothing is drawn outside it. An
    # axis-aligned box; w < 0: none. Inherited.
    clip: Rect

  SvgGradient = object
    kind: PaintKind         # LinearGradientPaint or RadialGradientPaint
    x1, y1, x2, y2: float32 # linear: the gradient vector, user space
    cx, cy, r: float32      # radial: centre and radius, user space
    transform: Mat3         # gradientTransform
    stops: seq[ColorStop]

  SvgTypefaceResolver* = proc(
    family: string, weight: int, italic: bool
  ): Typeface {.gcsafe, raises: [].}
    ## Turns a CSS font-family name into a typeface for `<text>`. Called once
    ## per candidate in a `font-family` list, most-preferred first; return nil
    ## to decline and let the next candidate try. Called a final time with an
    ## empty family for the default face, so returning nil there means the text
    ## is skipped rather than the SVG failing.

template failInvalid() =
  raise newException(PixieError, "Invalid SVG data")

proc newSvgElement(path: Path, props: SvgProperties): SvgElement =
  SvgElement(path: path, props: props, bounds: rect(0, 0, -1, -1))

proc newSvgElement(element: (Path, SvgProperties)): SvgElement =
  newSvgElement(element[0], element[1])

var svgTypefaceResolverImpl: SvgTypefaceResolver

proc setSvgTypefaceResolver*(resolver: SvgTypefaceResolver) {.raises: [].} =
  ## Installs the hook `<text>` uses to find typefaces. Pixie ships no fonts, so
  ## without one `<text>` elements are skipped: an application that wants text
  ## rendered supplies its own font lookup here (see `readTypeface`).
  svgTypefaceResolverImpl = resolver

proc svgTypefaceResolver*(): SvgTypefaceResolver {.raises: [].} =
  ## The currently installed typeface resolver, or nil.
  {.cast(gcsafe).}:
    result = svgTypefaceResolverImpl

proc attr*(node: SvgNode, name: string): string =
  ## The value of attribute `name`, or "" when the element has none. A
  ## handful of attributes per element: a scan beats a hash table, and costs
  ## no table.
  for i in 0 ..< node.attrs.len:
    if node.attrs[i][0] == name:
      return node.attrs[i][1]

proc setAttr*(node: SvgNode, name, value: string) =
  for i in 0 ..< node.attrs.len:
    if node.attrs[i][0] == name:
      node.attrs[i][1] = value
      return
  node.attrs.add((name, value))

proc isText(node: SvgNode): bool {.inline.} =
  node.tag.len == 0 or node.tag == "&"

proc attrOrDefault(node: SvgNode, name, default: string): string =
  result = node.attr(name)
  if result.len == 0:
    result = default

proc initSvgProperties(): SvgProperties =
  result.display = true
  result.fill = "black"
  result.strokeWidth = 1
  result.transform = mat3()
  result.strokeMiterLimit = defaultMiterLimit
  result.opacity = 1
  result.fillOpacity = 1
  result.strokeOpacity = 1
  result.fontSize = 16 # CSS initial value
  result.fontWeight = 400
  result.clip = rect(0, 0, -1, -1)

proc parseSvgFontSize(value: string, inherited: float32): float32 =
  ## font-size in CSS units, resolved to pixels. An unparseable size inherits
  ## rather than failing: a broken font-size must not lose the whole drawing.
  var v = value.strip()
  if v.len == 0:
    return inherited
  case v
  of "xx-small": return 9
  of "x-small": return 10
  of "small": return 13
  of "medium": return 16
  of "large": return 18
  of "x-large": return 24
  of "xx-large": return 32
  of "larger": return inherited * 1.2
  of "smaller": return inherited / 1.2
  of "inherit": return inherited
  else: discard

  var scale: float32 = 1
  template cut(suffix: string, factor: float32) =
    v.setLen(v.len - suffix.len)
    scale = factor
  if v.endsWith("px"): cut("px", 1)
  elif v.endsWith("rem"): cut("rem", inherited)
  elif v.endsWith("em"): cut("em", inherited)
  elif v.endsWith("pt"): cut("pt", 96 / 72)
  elif v.endsWith("pc"): cut("pc", 16)
  elif v.endsWith("in"): cut("in", 96)
  elif v.endsWith("cm"): cut("cm", 96 / 2.54)
  elif v.endsWith("mm"): cut("mm", 96 / 25.4)
  elif v.endsWith("%"): cut("%", inherited / 100)

  try:
    result = parseFloat(v.strip()) * scale
  except ValueError:
    result = inherited
  if result <= 0:
    result = 0

proc parseSvgFontWeight(value: string, inherited: int): int =
  case value.strip():
  of "": inherited
  of "normal", "book", "regular": 400
  of "bold": 700
  of "bolder": min(inherited + 300, 900)
  of "lighter": max(inherited - 300, 100)
  of "inherit": inherited
  else:
    try:
      clamp(parseInt(value.strip()), 1, 1000)
    except ValueError:
      inherited

proc splitArgs(s: string): seq[string] =
  # Handles (1,1) or (1 1) or (1, 1) or (1,1 2,2) etc
  let tmp = s.replace(',', ' ').split(' ')
  for entry in tmp:
    if entry.len > 0:
      result.add(entry)

proc parseSvgTransform(transform: string): Mat3 =
  ## A `transform` (or `gradientTransform`) attribute: a list of matrix,
  ## translate, rotate and scale functions, composed left to right.
  template failInvalidTransform(transform: string) =
    raise newException(
        PixieError, "Unsupported SVG transform: " & transform
      )

  result = mat3()
  var remaining = transform
  while remaining.len > 0:
    let index = remaining.find(")")
    if index == -1:
      failInvalidTransform(transform)
    let f = remaining[0 .. index].strip()
    remaining = remaining[index + 1 .. ^1]

    if f.startsWith("matrix("):
      let arr = splitArgs(f[7 .. ^2])
      if arr.len != 6:
        failInvalidTransform(transform)
      var m = mat3()
      m[0, 0] = parseFloat(arr[0])
      m[0, 1] = parseFloat(arr[1])
      m[1, 0] = parseFloat(arr[2])
      m[1, 1] = parseFloat(arr[3])
      m[2, 0] = parseFloat(arr[4])
      m[2, 1] = parseFloat(arr[5])
      result = result * m
    elif f.startsWith("translate("):
      let
        components = splitArgs(f[10 .. ^2])
        tx = parseFloat(components[0])
        ty =
          if components.len == 1:
            0.0
          else:
            parseFloat(components[1])
      result = result * translate(vec2(tx, ty))
    elif f.startsWith("rotate("):
      let
        values = splitArgs(f[7 .. ^2])
        angle: float32 = parseFloat(values[0]) * PI / 180
      var cx, cy: float32
      if values.len > 1:
        cx = parseFloat(values[1])
      if values.len > 2:
        cy = parseFloat(values[2])
      let center = vec2(cx, cy)
      result = result * translate(center) * rotate(angle) * translate(-center)
    elif f.startsWith("scale("):
      let
        values = splitArgs(f[6 .. ^2])
        sx: float32 = parseFloat(values[0])
        sy: float32 =
          if values.len > 1:
            parseFloat(values[1])
          else:
            sx
      result = result * scale(vec2(sx, sy))
    else:
      failInvalidTransform(transform)

const
  PathCacheEntries = 32
  PathCacheMaxChars = 64 * 1024 ## all cached path data together

var
  pathCache {.threadvar.}: seq[(string, Path)]
  pathCacheChars {.threadvar.}: int

proc parsePathCached(d: string): Path {.raises: [PixieError].} =
  ## `<path d>` parsed once and shared by every SVG that holds the same data.
  ## An animation renders the same shapes under a new transform every frame,
  ## and parsing their data was a third of the parse on an ESP32; sharing one
  ## path also makes "this element did not change" a pointer comparison
  ## (`damage`). Paths parsed here are only ever read — rendered and measured
  ## — never changed, so sharing them is safe. Per thread, bounded by count
  ## and by total characters; data too long for the bound is parsed each time.
  if d.len * 4 > PathCacheMaxChars:
    return parsePath(d)
  for i in countdown(pathCache.high, 0):
    if pathCache[i][0] == d:
      result = pathCache[i][1]
      if i != pathCache.high:
        let entry = pathCache[i]
        pathCache.delete(i)
        pathCache.add(entry)
      return
  result = parsePath(d)
  result.share() # fills keep what it flattens to (paths.share)
  pathCache.add((d, result))
  pathCacheChars += d.len
  while pathCache.len > PathCacheEntries or pathCacheChars > PathCacheMaxChars:
    pathCacheChars -= pathCache[0][0].len
    pathCache.delete(0)

proc parseSvgProperties(node: SvgNode, inherited: SvgProperties): SvgProperties =
  result = inherited
  result.isRect = false
  result.image = nil
  result.imageClip = false

  var
    fillRule = node.attr("fill-rule")
    fill = node.attr("fill")
    stroke = node.attr("stroke")
    strokeWidth = node.attr("stroke-width")
    strokeLineCap = node.attr("stroke-linecap")
    strokeLineJoin = node.attr("stroke-linejoin")
    strokeMiterLimit = node.attr("stroke-miterlimit")
    strokeDashArray = node.attr("stroke-dasharray")
    transform = node.attr("transform")
    style = node.attr("style")
    display = node.attr("display")
    opacity = node.attr("opacity")
    fillOpacity = node.attr("fill-opacity")
    strokeOpacity = node.attr("stroke-opacity")
    fontFamily = node.attr("font-family")
    fontSize = node.attr("font-size")
    fontWeight = node.attr("font-weight")
    fontStyle = node.attr("font-style")
    textAnchor = node.attr("text-anchor")
    baseline = node.attrOrDefault(
      "dominant-baseline", node.attr("alignment-baseline")
    )

  when defined(pixieDebugSvg):
    proc maybeLogPair(k, v: string) =
      if k notin [
          "fill-rule", "fill", "stroke", "stroke-width", "stroke-linecap",
          "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
          "transform", "style", "version", "viewBox", "width", "height",
          "xmlns", "x", "y", "x1", "x2", "y1", "y2", "id", "d", "cx", "cy",
          "r", "points", "rx", "ry", "enable-background", "xml:space",
          "xmlns:xlink", "data-name", "role", "class", "opacity",
          "fill-opacity", "stroke-opacity", "font-family", "font-size",
          "font-weight", "font-style", "text-anchor", "dominant-baseline",
          "alignment-baseline", "dx", "dy"
        ]:
          echo k, ": ", v

    for (k, v) in node.attrs:
      maybeLogPair(k, v)

  # Most elements have no style: splitting "" still allocates a seq.
  let pairs = if style.len > 0: style.split(';') else: @[]
  for pair in pairs:
    let parts = pair.split(':')
    if parts.len == 2:
      # Do not override element properties
      case parts[0].strip():
      of "fill-rule":
        if fillRule.len == 0:
          fillRule = parts[1].strip()
      of "fill":
        if fill.len == 0:
          fill = parts[1].strip()
      of "stroke":
        if stroke.len == 0:
          stroke = parts[1].strip()
      of "stroke-linecap":
        if strokeLineCap.len == 0:
          strokeLineCap = parts[1].strip()
      of "stroke-linejoin":
        if strokeLineJoin.len == 0:
          strokeLineJoin = parts[1].strip()
      of "stroke-width":
        if strokeWidth.len == 0:
          strokeWidth = parts[1].strip()
      of "stroke-miterlimit":
        if strokeMiterLimit.len == 0:
          strokeMiterLimit = parts[1].strip()
      of "stroke-dasharray":
        if strokeDashArray.len == 0:
          strokeDashArray = parts[1].strip()
      of "display":
        if display.len == 0:
          display = parts[1].strip()
      of "opacity":
        if opacity.len == 0:
          opacity = parts[1].strip()
      of "fillOpacity":
        if fillOpacity.len == 0:
          fillOpacity = parts[1].strip()
      of "strokeOpacity":
        if strokeOpacity.len == 0:
          strokeOpacity = parts[1].strip()
      of "font-family":
        if fontFamily.len == 0:
          fontFamily = parts[1].strip()
      of "font-size":
        if fontSize.len == 0:
          fontSize = parts[1].strip()
      of "font-weight":
        if fontWeight.len == 0:
          fontWeight = parts[1].strip()
      of "font-style":
        if fontStyle.len == 0:
          fontStyle = parts[1].strip()
      of "text-anchor":
        if textAnchor.len == 0:
          textAnchor = parts[1].strip()
      of "dominant-baseline", "alignment-baseline":
        if baseline.len == 0:
          baseline = parts[1].strip()
      else:
        when defined(pixieDebugSvg):
          maybeLogPair(parts[0], parts[1])
    elif pair.len > 0:
      when defined(pixieDebugSvg):
        echo "Invalid style pair: ", pair

  if display.len > 0:
    result.display = display.strip() != "none"

  if opacity.len > 0:
    result.opacity = clamp(parseFloat(opacity), 0, 1)

  if fillRule == "":
    discard # Inherit
  elif fillRule == "nonzero":
    result.fillRule = NonZero
  elif fillRule == "evenodd":
    result.fillRule = EvenOdd
  else:
    raise newException(
      PixieError, "Invalid fill-rule value " & fillRule
    )

  if fill == "" or fill == "currentColor":
    result.fill = inherited.fill
  else:
    result.fill = fill

  if stroke == "":
    discard # Inherit
  elif stroke == "currentColor":
    if result.stroke == rgbx(0, 0, 0, 0):
      result.stroke = rgbx(0, 0, 0, 255)
  elif stroke == "none":
    result.stroke = ColorRGBX()
  else:
    result.stroke = parseHtmlColor(stroke).rgbx

  if fillOpacity.len > 0:
    result.fillOpacity = parseFloat(fillOpacity).clamp(0, 1)

  if strokeOpacity.len > 0:
    result.strokeOpacity = parseFloat(strokeOpacity).clamp(0, 1)

  if strokeWidth == "":
    discard # Inherit
  else:
    if strokeWidth.endsWith("px"):
      strokeWidth = strokeWidth[0 .. ^3]
    result.strokeWidth = parseFloat(strokeWidth)
    if result.stroke == rgbx(0, 0, 0, 0):
      result.stroke = rgbx(0, 0, 0, 255)

  if strokeLineCap == "":
    discard # Inherit
  else:
    case strokeLineCap:
    of "butt":
      result.strokeLineCap = ButtCap
    of "round":
      result.strokeLineCap = RoundCap
    of "square":
      result.strokeLineCap = SquareCap
    of "inherit":
      discard
    else:
      raise newException(
        PixieError, "Invalid stroke-linecap value " & strokeLineCap
      )

  if strokeLineJoin == "":
    discard # Inherit
  else:
    case strokeLineJoin:
    of "miter":
      result.strokeLineJoin = MiterJoin
    of "round":
      result.strokeLineJoin = RoundJoin
    of "bevel":
      result.strokeLineJoin = BevelJoin
    of "inherit":
      discard
    else:
      raise newException(
        PixieError, "Invalid stroke-linejoin value " & strokeLineJoin
      )

  if strokeMiterLimit == "":
    discard
  else:
    result.strokeMiterLimit = parseFloat(strokeMiterLimit)

  if fontFamily.len > 0 and fontFamily != "inherit":
    result.fontFamily = fontFamily

  result.fontSize = parseSvgFontSize(fontSize, inherited.fontSize)
  result.fontWeight = parseSvgFontWeight(fontWeight, inherited.fontWeight)

  case fontStyle.strip():
  of "": discard # Inherit
  of "italic", "oblique": result.fontItalic = true
  of "normal": result.fontItalic = false
  else: discard # Unknown font-style: keep inheriting rather than fail

  case textAnchor.strip():
  of "": discard # Inherit
  of "middle": result.textAnchor = MiddleAnchor
  of "end": result.textAnchor = EndAnchor
  of "start": result.textAnchor = StartAnchor
  else: discard

  case baseline.strip():
  of "": discard # Inherit
  of "middle", "central": result.baseline = MiddleBaseline
  of "hanging", "text-before-edge", "top": result.baseline = HangingBaseline
  of "text-after-edge", "ideographic", "bottom":
    result.baseline = IdeographicBaseline
  of "auto", "alphabetic", "baseline", "mathematical":
    result.baseline = AlphabeticBaseline
  else: discard

  if strokeDashArray == "":
    discard
  else:
    var values = splitArgs(strokeDashArray)
    for value in values:
      result.strokeDashArray.add(parseFloat(value))

  if transform == "":
    discard # Inherit
  else:
    result.transform = result.transform * parseSvgTransform(transform)

type
  SvgTextPosition = object
    hasX, hasY: bool
    x, y, dx, dy: float32

  SvgTextRun = object
    text: string
    props: SvgProperties
    pos: SvgTextPosition

proc svgEntityText(name: string): string =
  ## `parsexml` resolves numeric entities and the five predefined ones itself,
  ## so what reaches an entity node is a named entity. These are the ones that
  ## turn up in hand-written and generated SVG; anything else contributes
  ## nothing rather than failing the drawing.
  case name
  of "nbsp": " " # A normal space: fonts often lack U+00A0 and would draw tofu
  of "ndash": "–"
  of "mdash": "—"
  of "hellip": "…"
  of "lsquo": "‘"
  of "rsquo": "’"
  of "ldquo": "“"
  of "rdquo": "”"
  of "bull": "•"
  of "middot": "·"
  of "times": "×"
  of "deg": "°"
  of "copy": "©"
  of "reg": "®"
  of "trade": "™"
  of "euro": "€"
  of "pound": "£"
  of "yen": "¥"
  else: ""

proc collapseSvgWhitespace(text: string, lastWasSpace: var bool): string =
  ## XML whitespace inside `<text>` is layout, not content: newlines and the
  ## indentation around a `<tspan>` collapse to a single space. `lastWasSpace`
  ## carries across runs so `<text> a <tspan>b</tspan> </text>` does not gain
  ## spaces at the seams, and starts true so leading indentation disappears.
  for c in text:
    if c in Whitespace:
      if not lastWasSpace:
        result.add ' '
        lastWasSpace = true
    else:
      result.add c
      lastWasSpace = false

proc parseSvgCoordinate(value: string, default: float32 = 0): float32 =
  ## The first number of an SVG coordinate attribute. `x="10 20 30"` positions
  ## glyphs individually; v1 takes the first and advances the rest normally.
  var s = value.strip()
  let sep = s.find({' ', ',', '\t', '\n', '\r'})
  if sep > 0:
    s.setLen(sep)
  # SVG2 allows units on geometry attributes; treat them as user units.
  while s.len > 0 and s[^1] in {'a' .. 'z', 'A' .. 'Z', '%'}:
    s.setLen(s.len - 1)
  try:
    parseFloat(s)
  except ValueError:
    default

proc resolveSvgTypeface(props: SvgProperties): Typeface =
  ## Walks the font-family list, most-preferred first, and asks the resolver for
  ## each. An unknown family falls through to the resolver's default rather than
  ## failing: text in the wrong face still says what it says.
  let resolver = svgTypefaceResolver()
  if resolver == nil:
    return nil
  for candidate in props.fontFamily.split(','):
    let family = candidate.strip().strip(chars = {'"', '\'', ' '})
    if family.len == 0:
      continue
    let typeface = resolver(family, props.fontWeight, props.fontItalic)
    if typeface != nil:
      return typeface
  resolver("", props.fontWeight, props.fontItalic)

proc walkSvgText(
  node: SvgNode,
  inherited: SvgProperties,
  runs: var seq[SvgTextRun],
  lastWasSpace: var bool,
  pending: var SvgTextPosition
) =
  ## Flattens a `<text>` element (and any nested `<tspan>`s) into runs of text,
  ## each carrying the properties and the pending position adjustment that apply
  ## to its first character.
  let props = node.parseSvgProperties(inherited)

  let
    x = node.attr("x")
    y = node.attr("y")
    dx = node.attr("dx")
    dy = node.attr("dy")
  if x.len > 0:
    pending.hasX = true
    pending.x = parseSvgCoordinate(x)
  if y.len > 0:
    pending.hasY = true
    pending.y = parseSvgCoordinate(y)
  if dx.len > 0:
    pending.dx += parseSvgCoordinate(dx)
  if dy.len > 0:
    pending.dy += parseSvgCoordinate(dy)

  for child in node.children:
    case child.tag
    of "":
      let text = collapseSvgWhitespace(child.text, lastWasSpace)
      if text.len > 0:
        runs.add SvgTextRun(text: text, props: props, pos: pending)
        pending = SvgTextPosition()
    of "&":
      if child.text.len > 0:
        lastWasSpace = false
        runs.add SvgTextRun(text: child.text, props: props, pos: pending)
        pending = SvgTextPosition()
    of "tspan", "text", "a":
      child.walkSvgText(props, runs, lastWasSpace, pending)
    else:
      # <textPath>, <title>, <desc>, <tref>: no v1 support, and dropping the
      # element is better than losing the document it sits in.
      discard

proc parseSvgText(
  node: SvgNode, props: SvgProperties
): seq[(Path, SvgProperties)] =
  ## Turns a `<text>` element into glyph outlines. They are ordinary paths from
  ## there on: fill, stroke, gradients, opacity and transforms all apply exactly
  ## as they do to a `<path>`.
  if svgTypefaceResolver() == nil:
    # No font source installed. Skipping the text keeps the rest of the
    # drawing, which is what a missing font should cost.
    return

  var
    runs: seq[SvgTextRun]
    lastWasSpace = true
    pending = SvgTextPosition(hasX: true, hasY: true) # x=0 y=0 unless given
  node.walkSvgText(props, runs, lastWasSpace, pending)
  if runs.len == 0:
    return

  if runs[^1].text.endsWith(" "):
    # Renders nothing, but would widen the chunk that text-anchor centers.
    runs[^1].text.setLen(runs[^1].text.len - 1)

  var
    arrangements = newSeq[Arrangement](runs.len)
    fonts = newSeq[Font](runs.len)
    origins = newSeq[Vec2](runs.len)
    widths = newSeq[float32](runs.len)
    chunkStarts: seq[int]
    pen: Vec2

  for i, run in runs:
    if run.pos.hasX:
      pen.x = run.pos.x
      chunkStarts.add i
    if run.pos.hasY:
      pen.y = run.pos.y
    pen.x += run.pos.dx
    pen.y += run.pos.dy
    origins[i] = pen

    if run.props.fontSize <= 0:
      continue
    let typeface = resolveSvgTypeface(run.props)
    if typeface == nil:
      continue
    let font = newFont(typeface)
    font.size = run.props.fontSize
    fonts[i] = font
    # No bounds, no wrapping: SVG text is one line unless the author breaks it
    # into positioned tspans.
    arrangements[i] = font.typeset(run.text, wrap = false)
    widths[i] = arrangements[i].layoutBounds().x
    pen.x += widths[i]

  for c, start in chunkStarts:
    let
      stop = if c + 1 < chunkStarts.len: chunkStarts[c + 1] - 1 else: runs.high
      anchor = runs[start].props.textAnchor
    if anchor == StartAnchor:
      continue
    let
      width = origins[stop].x + widths[stop] - origins[start].x
      shift = if anchor == MiddleAnchor: -width / 2 else: -width
    for i in start .. stop:
      origins[i].x += shift

  for i, run in runs:
    if fonts[i] == nil or run.text.strip().len == 0:
      continue
    let
      font = fonts[i]
      typeface = font.typeface
      scale = font.scale
      baselineShift =
        case run.props.baseline
        of AlphabeticBaseline: 0.float32
        of MiddleBaseline: (typeface.ascent + typeface.descent) / 2 * scale
        of HangingBaseline: typeface.ascent * scale
        of IdeographicBaseline: typeface.descent * scale
      path = arrangements[i].computePath()
    # `typeset` puts the first baseline at `baselineOffset` below the top of the
    # block; SVG gives us the baseline itself, so shift the block up by that.
    path.transform(translate(vec2(
      origins[i].x,
      origins[i].y + baselineShift - font.baselineOffset
    )))
    result.add (path, run.props)

proc parseSvgLength(value: string, reference: float32): float32 =
  ## A gradient coordinate: a user-space number, or a percentage of
  ## `reference` (the viewport's width, height or normalised diagonal).
  let v = value.strip()
  if v.endsWith("%"):
    parseFloat(v[0 .. ^2]).float32 / 100 * reference
  else:
    parseFloat(v)

proc parseSvgGradientStops(node: SvgNode): seq[ColorStop] =
  for child in node.children:
    if child.isText:
      # Whitespace between the stops, reported for documents with text in
      # them (see parseSvgNodes).
      continue
    if child.tag == "stop":
      var
        color = child.attr("stop-color")
        opacity = child.attr("stop-opacity")

      let
        style = child.attr("style")
        pairs = style.split(';')
      for pair in pairs:
        let parts = pair.split(':')
        if parts.len == 2:
          # Do not override element properties
          case parts[0].strip():
          of "stop-color":
            if color == "":
              color = parts[1].strip()
          of "stop-opacity":
            if opacity == "":
              opacity = parts[1].strip()
          else:
            when defined(pixieDebugSvg):
              echo parts[0], ": ", parts[1]
        elif pair.len > 0:
          when defined(pixieDebugSvg):
            echo "Invalid style pair: ", pair

      if color == "":
        raise newException(
          PixieError, "Invalid SVG gradient, missing stop-color"
        )

      var stop = ColorStop(
        color: color.parseHtmlColor(),
        position: parseSvgLength(child.attr("offset"), 1)
      )
      if opacity != "":
        stop.color.a *= parseFloat(opacity).clamp(0, 1)
      result.add stop
    else:
      raise newException(PixieError, "Unexpected SVG tag: " & child.tag)

proc parseSvgGradient(node: SvgNode, svg: Svg) =
  ## `<linearGradient>` and `<radialGradient>`, registered by id for fills to
  ## reference as `url(#id)`. Coordinates are user space (`gradientUnits=
  ## "userSpaceOnUse"`, the only supported units), numbers or percentages of
  ## the viewport, with the SVG defaults when absent; `gradientTransform`
  ## applies on top. A radial gradient's focal point (fx, fy) and
  ## `spreadMethod` are read as their defaults: the ramp is centred and pads.
  let
    id = node.attr("id")
    gradientUnits = node.attr("gradientUnits")
    gradientTransform = node.attr("gradientTransform")

  if gradientUnits != "userSpaceOnUse":
    raise newException(
      PixieError, "Unsupported gradient units: " & gradientUnits
    )

  var gradient: SvgGradient
  gradient.transform =
    if gradientTransform == "": mat3()
    else: parseSvgTransform(gradientTransform)

  let
    w = svg.viewBoxWidth
    h = svg.viewBoxHeight
  if node.tag == "linearGradient":
    gradient.kind = LinearGradientPaint
    gradient.x1 = parseSvgLength(node.attrOrDefault("x1", "0%"), w)
    gradient.y1 = parseSvgLength(node.attrOrDefault("y1", "0%"), h)
    gradient.x2 = parseSvgLength(node.attrOrDefault("x2", "100%"), w)
    gradient.y2 = parseSvgLength(node.attrOrDefault("y2", "0%"), h)
  else:
    gradient.kind = RadialGradientPaint
    gradient.cx = parseSvgLength(node.attrOrDefault("cx", "50%"), w)
    gradient.cy = parseSvgLength(node.attrOrDefault("cy", "50%"), h)
    gradient.r = parseSvgLength(
      node.attrOrDefault("r", "50%"), sqrt((w * w + h * h) / 2)
    )

  gradient.stops = node.parseSvgGradientStops()
  svg.gradients[id] = gradient

proc parseSvgImage(node: SvgNode, props: SvgProperties): (Path, SvgProperties) =
  ## An `<image>` whose picture the caller decoded (`SvgNode.image`): drawn
  ## into its x/y/width/height box (the picture's own size when absent), fitted
  ## the way `preserveAspectRatio` says — `none` stretches, `meet` (the
  ## default) fits inside and `slice` covers, clipped to the box, both aligned
  ## by xMin/xMid/xMax and YMin/YMid/YMax.
  let image = node.image
  if image.isNil or image.width <= 0 or image.height <= 0:
    raise newException(PixieError, "Unsupported SVG tag: image")
  let
    x = parseSvgCoordinate(node.attr("x"))
    y = parseSvgCoordinate(node.attr("y"))
    w = parseSvgCoordinate(node.attr("width"), image.width.float32)
    h = parseSvgCoordinate(node.attr("height"), image.height.float32)
    aspect = node.attr("preserveAspectRatio")
  if w <= 0 or h <= 0:
    return
  var box = rect(x, y, w, h)
  result[1] = props
  if aspect != "none":
    let
      slice = aspect.endsWith("slice")
      sx = w / image.width.float32
      sy = h / image.height.float32
      s = if slice: max(sx, sy) else: min(sx, sy)
      fw = image.width.float32 * s
      fh = image.height.float32 * s
      ax = if "xMin" in aspect: 0f32 elif "xMax" in aspect: 1f32 else: 0.5f32
      ay = if "YMin" in aspect: 0f32 elif "YMax" in aspect: 1f32 else: 0.5f32
    box = rect(x + (w - fw) * ax, y + (h - fh) * ay, fw, fh)
    result[1].imageClip = slice
  result[1].image = image
  result[1].imageBox = box
  result[1].rectX = x
  result[1].rectY = y
  result[1].rectW = w
  result[1].rectH = h
  # The element's box, for its bounds (damage); never filled.
  result[0] = newPath()
  result[0].rect(x, y, w, h)

proc parseSvgViewBox(
  root: SvgNode, width, height: int
): tuple[minX, minY, width, height: float32] =
  ## The user coordinate box the document is drawn in. `viewBox` when there is
  ## one (four numbers, whitespace and/or commas between them, decimals
  ## allowed). Otherwise the root's own width/height: an SVG without a viewBox
  ## maps user units 1:1 onto that viewport, so those ARE its box — a document
  ## a JS app hand-builds as `<svg width="600" height="480">` used to fail here
  ## with `invalid integer` the moment it was rasterized at any other size.
  ## Otherwise the size the caller asked for, so a bare document still renders
  ## unscaled at that size. Only a document with none of the three is refused,
  ## and by name.
  let viewBox = root.attr("viewBox").strip()
  if viewBox.len > 0:
    let box = strutils.splitWhitespace(viewBox.replace(",", " "))
    if box.len != 4:
      raise newException(PixieError, "Invalid SVG viewBox: " & viewBox)
    result = (
      parseFloat(box[0]).float32, parseFloat(box[1]).float32,
      parseFloat(box[2]).float32, parseFloat(box[3]).float32
    )
    if result.width <= 0 or result.height <= 0:
      raise newException(PixieError, "Invalid SVG viewBox: " & viewBox)
    return
  # A percentage has nothing to be a percentage of without a viewBox.
  let
    rootWidth = root.attr("width").strip()
    rootHeight = root.attr("height").strip()
    w = if rootWidth.endsWith("%"): -1f32 else: parseSvgCoordinate(rootWidth, -1)
    h = if rootHeight.endsWith("%"): -1f32 else: parseSvgCoordinate(rootHeight, -1)
  if w > 0 and h > 0:
    return (0f32, 0f32, w, h)
  if width > 0 and height > 0:
    return (0f32, 0f32, width.float32, height.float32)
  raise newException(PixieError, "SVG has no viewBox and no width/height")

proc intersect(a, b: Rect): Rect =
  ## The part of `a` inside `b`, or an empty box (w = 0) where they miss.
  let
    x = max(a.x, b.x)
    y = max(a.y, b.y)
  rect(x, y, max(min(a.x + a.w, b.x + b.w) - x, 0), max(min(a.y + a.h, b.y + b.h) - y, 0))

proc parseSvgElement(
  node: SvgNode, svg: Svg, propertiesStack: var seq[SvgProperties],
  elements: var seq[SvgElement]
) =
  if node.isText:
    return

  case node.tag:
  of "title", "desc":
    discard

  of "defs":
    # Where documents keep their gradients. Anything else defined here
    # (patterns, clip paths, symbols) is not drawn, as before.
    for child in node.children:
      if child.tag in ["linearGradient", "radialGradient"]:
        child.parseSvgGradient(svg)

  of "g", "svg":
    var props = node.parseSvgProperties(propertiesStack[^1])
    if node.tag == "svg":
      # A nested viewport: its content drawn from (x, y), its viewBox (when
      # it has one) fitted to width x height, and nothing of it outside that
      # box, whose corners an axis-aligned transform keeps a rectangle of
      # the image (a UI's scrolled list, its clipped picture). A size of 0
      # draws nothing, as in SVG.
      let
        x = parseSvgCoordinate(node.attr("x"))
        y = parseSvgCoordinate(node.attr("y"))
        w = parseSvgCoordinate(node.attr("width"))
        h = parseSvgCoordinate(node.attr("height"))
        m = props.transform
      if w <= 0 or h <= 0:
        return
      let
        a = m * vec2(x, y)
        b = m * vec2(x + w, y + h)
        box = rect(min(a.x, b.x), min(a.y, b.y), abs(b.x - a.x), abs(b.y - a.y))
      props.clip = if props.clip.w < 0: box else: box.intersect(props.clip)
      # Its user box, read as the document's is (the viewBox, else its
      # size), onto (x, y, w, h): m times a scale and a move, written out
      # (nine products where three 3x3 ones were 81).
      let
        view = parseSvgViewBox(node, 0, 0)
        sx = w / view.width
        sy = h / view.height
        tx = x - view.minX * sx
        ty = y - view.minY * sy
      for r in 0 .. 2:
        props.transform[0, r] = m[0, r] * sx
        props.transform[1, r] = m[1, r] * sy
        props.transform[2, r] = m[0, r] * tx + m[1, r] * ty + m[2, r]
    propertiesStack.add(props)
    for child in node.children:
      child.parseSvgElement(svg, propertiesStack, elements)
    discard propertiesStack.pop()

  of "text":
    for element in node.parseSvgText(propertiesStack[^1]):
      elements.add newSvgElement(element)

  of "image":
    let element = node.parseSvgImage(node.parseSvgProperties(propertiesStack[^1]))
    if not element[0].isNil:
      elements.add newSvgElement(element)

  of "path":
    let
      d = node.attr("d")
      props = node.parseSvgProperties(propertiesStack[^1])
      path = if node.path.isNil: parsePathCached(d) else: node.path

    elements.add newSvgElement(path, props)

  of "line":
    let
      props = node.parseSvgProperties(propertiesStack[^1])
      x1 = parseFloat(node.attrOrDefault("x1", "0"))
      y1 = parseFloat(node.attrOrDefault("y1", "0"))
      x2 = parseFloat(node.attrOrDefault("x2", "0"))
      y2 = parseFloat(node.attrOrDefault("y2", "0"))

    let path = newPath()
    path.moveTo(x1, y1)
    path.lineTo(x2, y2)

    elements.add newSvgElement(path, props)

  of "polyline", "polygon":
    let
      props = node.parseSvgProperties(propertiesStack[^1])
      points = node.attr("points")

    var vecs: seq[Vec2]
    if points.contains(","):
      for pair in points.split(" "):
        let parts = pair.split(",")
        if parts.len != 2:
          failInvalid()
        vecs.add(vec2(parseFloat(parts[0]), parseFloat(parts[1])))
    else:
      let points = points.split(" ")
      if points.len mod 2 != 0:
        failInvalid()
      for i in 0 ..< points.len div 2:
        vecs.add(vec2(parseFloat(points[i * 2]), parseFloat(points[i * 2 + 1])))

    if vecs.len == 0:
      failInvalid()

    let path = newPath()
    path.moveTo(vecs[0])
    for i in 1 ..< vecs.len:
      path.lineTo(vecs[i])

    # The difference between polyline and polygon is whether we close the path
    # and fill or not
    if node.tag == "polygon":
      path.closePath()

    elements.add newSvgElement(path, props)

  of "rect":
    let
      props = node.parseSvgProperties(propertiesStack[^1])
      x = parseFloat(node.attrOrDefault("x", "0"))
      y = parseFloat(node.attrOrDefault("y", "0"))
      width = parseFloat(node.attrOrDefault("width", "0"))
      height = parseFloat(node.attrOrDefault("height", "0"))

    if width == 0 or height == 0:
      return

    var
      rx = max(parseFloat(node.attrOrDefault("rx", "0")), 0)
      ry = max(parseFloat(node.attrOrDefault("ry", "0")), 0)

    let path = newPath()
    var rectProps = props
    if rx > 0 or ry > 0:
      if rx == 0:
        rx = ry
      elif ry == 0:
        ry = rx
      rx = min(rx, width / 2)
      ry = min(ry, height / 2)

      path.moveTo(x + rx, y)
      path.lineTo(x + width - rx, y)
      path.ellipticalArcTo(rx, ry, 0, false, true, x + width, y + ry)
      path.lineTo(x + width, y + height - ry)
      path.ellipticalArcTo(rx, ry, 0, false, true, x + width - rx, y + height)
      path.lineTo(x + rx, y + height)
      path.ellipticalArcTo(rx, ry, 0, false, true, x, y + height - ry)
      path.lineTo(x, y + ry)
      path.ellipticalArcTo(rx, ry, 0, false, true, x + rx, y)
    else:
      path.rect(x, y, width, height)
      rectProps.isRect = true
      rectProps.rectX = x
      rectProps.rectY = y
      rectProps.rectW = width
      rectProps.rectH = height

    elements.add newSvgElement(path, rectProps)

  of "circle", "ellipse":
    let
      props = node.parseSvgProperties(propertiesStack[^1])
      cx = parseFloat(node.attrOrDefault("cx", "0"))
      cy = parseFloat(node.attrOrDefault("cy", "0"))

    var rx, ry: float32
    if node.tag == "circle":
      rx = parseFloat(node.attr("r"))
      ry = rx
    else:
      rx = parseFloat(node.attrOrDefault("rx", "0"))
      ry = parseFloat(node.attrOrDefault("ry", "0"))

    let path = newPath()
    path.ellipse(cx, cy, rx, ry)

    elements.add newSvgElement(path, props)

  of "linearGradient", "radialGradient":
    node.parseSvgGradient(svg)

  else:
    raise newException(PixieError, "Unsupported SVG tag: " & node.tag)

proc parseSvg*(
  root: SvgNode, width = 0, height = 0, reuse = false
): Svg {.raises: [PixieError].} =
  ## Parse an SVG node tree. Defaults to the SVG's view box size.
  ##
  ## `reuse`: the caller hands over nodes it handed over before (a UI's
  ## layout keeps what did not change): a child of the root parsed under the
  ## same inherited properties brings its elements back without a parse,
  ## and damageRects knows them for the same elements without comparing
  ## them. Each child keeps what it made for that.
  try:
    if root.tag != "svg":
      failInvalid()

    let box = parseSvgViewBox(root, width, height)

    var rootProps = initSvgProperties()
    rootProps = root.parseSvgProperties(rootProps)

    if box.minX != 0 or box.minY != 0:
      let viewBoxMin = vec2(-box.minX, -box.minY)
      rootProps.transform = rootProps.transform * translate(viewBoxMin)

    result = Svg(
      viewBoxWidth: box.width,
      viewBoxHeight: box.height
    )

    if width == 0 and height == 0: # Default to the view box size
      result.width = round(box.width).int
      result.height = round(box.height).int
    else:
      result.width = width
      result.height = height

      let
        scaleX = width.float32 / box.width
        scaleY = height.float32 / box.height
      rootProps.transform = rootProps.transform * scale(vec2(scaleX, scaleY))

    var
      propertiesStack = @[rootProps]
      under: ref SvgProperties # rootProps, for the nodes parsed here
    for node in root.children:
      if not reuse:
        node.parseSvgElement(result, propertiesStack, result.elements)
        continue
      if not node.parsedUnder.isNil and
          (node.parsedUnder == under or node.parsedUnder[] == rootProps):
        under = node.parsedUnder
        result.elements.add node.parsed
        continue
      let
        first = result.elements.len
        gradients = result.gradients.len
      node.parseSvgElement(result, propertiesStack, result.elements)
      # Kept unless it defined gradients (the document's, not the node's).
      if result.gradients.len == gradients:
        if under.isNil:
          under = new(SvgProperties)
          under[] = rootProps
        node.parsed = result.elements[first .. ^1]
        node.parsedUnder = under
      else:
        node.parsed = @[]
        node.parsedUnder = nil
  except PixieError as e:
    raise e
  except:
    raise currentExceptionAsPixieError()

proc addSvgNode(siblings: var seq[SvgNode], node: XmlNode) =
  ## `node` as what parseSvg reads, appended to `siblings`: comments and
  ## processing instructions go, an entity becomes the text it stands for.
  case node.kind
  of xnElement:
    let element = SvgNode(tag: node.tag)
    if node.attrs != nil:
      for key, value in node.attrs:
        element.attrs.add((key, value))
    for child in node:
      element.children.addSvgNode(child)
    siblings.add element
  of xnText, xnCData, xnVerbatimText:
    siblings.add SvgNode(text: node.text)
  of xnEntity:
    siblings.add SvgNode(tag: "&", text: svgEntityText(node.text))
  else:
    discard

proc toSvgNode*(root: XmlNode): SvgNode {.raises: [].} =
  ## An XML tree as the node tree parseSvg reads.
  var nodes: seq[SvgNode]
  try:
    nodes.addSvgNode(root)
  except KeyError:
    discard # attrs iteration: not raised for a table it is walking
  if nodes.len > 0: nodes[0] else: SvgNode(tag: "svg")

proc parseSvg*(
  root: XmlNode, width = 0, height = 0
): Svg {.raises: [PixieError].} =
  ## Parse SVG XML. Defaults to the SVG's view box size.
  root.toSvgNode().parseSvg(width, height)

proc holdsText(data: string): bool =
  ## Whether the markup has a `<text` or `<tspan` tag: one pass from `<` to
  ## `<` (memchr), where two substring searches walked the whole document
  ## twice.
  var i = data.find('<')
  while i >= 0 and i + 1 < data.len:
    if data[i + 1] == 't' and
        (data.continuesWith("text", i + 1) or data.continuesWith("tspan", i + 1)):
      return true
    i = data.find('<', i + 1)
  false

const
  xmlNameStart = {'A'..'Z', 'a'..'z', '_', ':', '\128'..'\255'}
  xmlNameChar = {'A'..'Z', 'a'..'z', '0'..'9', '.', '-', '_', ':', '\128'..'\255'}
  xmlSpace = {' ', '\t', '\c', '\L'}

proc xmlAttrValue(data: string, start, stop: int): string =
  ## An attribute's value the way std/parsexml reads it: every run of
  ## whitespace is one space, and a run at the end is dropped.
  var clean = true
  for i in start ..< stop:
    let c = data[i]
    if c in {'\t', '\c', '\L'} or (c == ' ' and (i + 1 == stop or data[i + 1] == ' ')):
      clean = false
      break
  if clean:
    return data[start ..< stop]
  result = newStringOfCap(stop - start)
  var pendingSpace = false
  for i in start ..< stop:
    let c = data[i]
    if c in xmlSpace:
      pendingSpace = true
    else:
      if pendingSpace:
        result.add ' '
        pendingSpace = false
      result.add c

proc parseSvgNodesFast*(data: string): SvgNode {.raises: [].} =
  ## The elements std/xmlparser reads (with `reportComments`, without
  ## `reportWhitespace`) for markup made of elements, attributes, comments
  ## and text, cut out of `data` a value at a time: Nim's parser appends
  ## every character to its token one by one, which was half the parse of
  ## an animated logo on an ESP32. For a document without `<text>`, where
  ## nothing reads text or comments, so neither is kept. nil for anything
  ## else — an entity, a CR, a NUL, CDATA, a declaration, unquoted or empty
  ## attributes, a tag that does not close — which the full parser then
  ## reads, and reports.
  for c in data:
    if c in {'&', '\c', '\0'}:
      return nil
  let n = data.len
  var
    pos = 0
    stack: seq[SvgNode]

  template skipSpace() =
    while pos < n and data[pos] in xmlSpace:
      inc pos

  template skipName() =
    if pos < n and data[pos] in xmlNameStart:
      inc pos
      while pos < n and data[pos] in xmlNameChar:
        inc pos

  while pos < n:
    let c = data[pos]
    if c in xmlSpace:
      skipSpace()
      continue
    if c != '<':
      if stack.len == 0:
        return nil # text outside the root element: an error to std
      pos = data.find('<', pos)
      if pos < 0:
        pos = n
      continue
    if pos + 1 >= n:
      return nil
    case data[pos + 1]
    of '/':
      pos += 2
      let start = pos
      skipName()
      let name = data[start ..< pos]
      skipSpace()
      if pos >= n or data[pos] != '>' or stack.len == 0 or stack[^1].tag != name:
        return nil
      inc pos
      let closed = stack.pop()
      if stack.len == 0:
        return closed # std reads no further than the root element
    of '!':
      if not data.continuesWith("<!--", pos):
        return nil # CDATA or a declaration
      let stop = data.find("-->", pos + 4)
      if stop < 0:
        return nil
      pos = stop + 3
    of '?':
      let stop = data.find("?>", pos + 2)
      if stop < 0:
        return nil
      pos = stop + 2 # a processing instruction: std ignores it
    else:
      inc pos
      let start = pos
      skipName()
      if pos == start:
        return nil
      let element = SvgNode(tag: data[start ..< pos])
      skipSpace()
      while pos < n and data[pos] in xmlNameStart:
        let keyStart = pos
        skipName()
        let key = data[keyStart ..< pos]
        skipSpace()
        if pos >= n or data[pos] != '=':
          return nil
        inc pos
        skipSpace()
        if pos >= n or data[pos] notin {'"', '\''}:
          return nil
        let quote = data[pos]
        inc pos
        let stop = data.find(quote, pos)
        if stop < 0:
          return nil
        # std keeps the last of a repeated attribute
        element.setAttr(key, xmlAttrValue(data, pos, stop))
        pos = stop + 1
        skipSpace()
      var empty = false
      if pos < n and data[pos] == '/':
        empty = true
        inc pos
      if pos >= n or data[pos] != '>':
        return nil
      inc pos
      if stack.len > 0:
        stack[^1].children.add element
      if empty:
        if stack.len == 0:
          return element
      else:
        stack.add element
  nil # the root element never closed

proc parseSvgXml*(data: string): XmlNode {.raises: [PixieError].} =
  ## Parses SVG markup into XML the way `parseSvg` reads it: with the
  ## whitespace that follows a closing tag when the document has text (Nim's
  ## parser drops it otherwise, and inside `<text>` the space in
  ## `…</tspan> tail` is content). parseSvgNodes is the faster way to the
  ## same drawing.
  try:
    var options = {reportComments}
    if data.holdsText():
      options.incl reportWhitespace
    result = parseXml(data, options)
  except PixieError as e:
    raise e
  except:
    raise currentExceptionAsPixieError()

proc parseSvgNodes*(data: string): SvgNode {.raises: [PixieError].} =
  ## Parses SVG markup into the node tree parseSvg reads. Markup without
  ## text, entities or declarations — what an app writes — is read straight
  ## into nodes (parseSvgNodesFast); anything else goes through std/xmlparser
  ## (parseSvgXml), whose errors are the ones reported.
  if not data.holdsText():
    result = parseSvgNodesFast(data)
    if result != nil:
      return
  result = parseSvgXml(data).toSvgNode()

proc parseSvg*(data: string, width = 0, height = 0): Svg {.raises: [PixieError].} =
  ## Parse SVG data. Defaults to the SVG's view box size.
  parseSvgNodes(data).parseSvg(width, height)

proc drawSvgImage(target: Image, props: SvgProperties) {.raises: [PixieError].} =
  ## An `<image>` element: its picture stretched into `imageBox`, and with
  ## `imageClip` only where it falls inside the element's box, which an axis
  ## aligned transform keeps a rectangle of the target.
  var image = props.image
  let
    box = props.imageBox
    m = props.transform
    opacity = props.opacity * props.fillOpacity
  if opacity < 1:
    image = image.copy()
    image.applyOpacity(opacity)
  let transform = m * translate(vec2(box.x, box.y)) *
    scale(vec2(box.w / image.width.float32, box.h / image.height.float32))
  if not props.imageClip or m[0, 1] != 0 or m[1, 0] != 0:
    target.draw(image, transform)
    return
  let
    a = m * vec2(props.rectX, props.rectY)
    b = m * vec2(props.rectX + props.rectW, props.rectY + props.rectH)
    x0 = clamp(round(min(a.x, b.x)).int, 0, target.width)
    y0 = clamp(round(min(a.y, b.y)).int, 0, target.height)
    x1 = clamp(round(max(a.x, b.x)).int, 0, target.width)
    y1 = clamp(round(max(a.y, b.y)).int, 0, target.height)
  if x1 > x0 and y1 > y0:
    target.view(x0, y0, x1 - x0, y1 - y0).draw(
      image, translate(vec2(-x0.float32, -y0.float32)) * transform)

proc sameElement(a: Svg, i: int, b: Svg, j: int): bool =
  ## Element i of `a` and j of `b` draw the same: one element, handed over
  ## twice (the same node's parse), or two equal ones.
  let
    x = a.elements[i]
    y = b.elements[j]
  x == y or (sameCommands(x.path, y.path) and x.props == y.props)

proc transformedBounds(bounds: Rect, m: Mat3): Rect =
  ## The box around a box's four corners under `m`: it holds whatever the box
  ## held, for any affine transform.
  let corners = [
    m * vec2(bounds.x, bounds.y), m * vec2(bounds.x + bounds.w, bounds.y),
    m * vec2(bounds.x, bounds.y + bounds.h), m * vec2(bounds.x + bounds.w, bounds.y + bounds.h)
  ]
  var
    minX = corners[0].x
    minY = corners[0].y
    maxX = minX
    maxY = minY
  for corner in corners:
    minX = min(minX, corner.x)
    minY = min(minY, corner.y)
    maxX = max(maxX, corner.x)
    maxY = max(maxY, corner.y)
  rect(minX, minY, maxX - minX, maxY - minY)

proc paintBounds(path: Path, props: SvgProperties): Rect {.raises: [PixieError].} =
  ## The pixels an element can touch: the path's bounds, grown by its stroke
  ## and a pixel of antialiasing on each side. Measured untransformed (once,
  ## for a shared path) and mapped through the transform, which can only
  ## grow the box; flattening at the untransformed scale can put a curve a
  ## fraction of a unit inside its true extent, so that fraction, scaled,
  ## goes into the margin too.
  let
    m = props.transform
    scale = sqrt(max(m[0, 0] * m[0, 0] + m[0, 1] * m[0, 1],
      m[1, 0] * m[1, 0] + m[1, 1] * m[1, 1]))
  result = transformedBounds(localBounds(path), m)
  var margin = 1.0'f32 + 0.5'f32 * scale
  if props.stroke.a > 0 and props.strokeWidth > 0:
    # How far the stroke reaches past the path, in half widths: a miter join
    # as far as the miter limit lets it, a square cap to its corners, and
    # round or bevel joins, round or butt caps and a line with no join at
    # all half the width. A finger painting round-capped lines repaints a box
    # around each, not one four widths wider on every side.
    var reach = 1'f32
    if props.strokeLineJoin == MiterJoin and path.hasJoins:
      reach = max(reach, props.strokeMiterLimit)
    if props.strokeLineCap == SquareCap:
      reach = max(reach, sqrt(2'f32))
    margin += props.strokeWidth * scale * reach / 2
  result.x -= margin
  result.y -= margin
  result.w += margin * 2
  result.h += margin * 2

proc paintBounds(element: SvgElement): Rect {.raises: [PixieError].} =
  ## The element's paintBounds, measured once per element, whatever parses
  ## share it: a frame's repaint boxes each look at every element, and
  ## damageRects at the changed ones of the frame before as well.
  if element.bounds.w < 0:
    element.bounds = paintBounds(element.path, element.props)
    if element.props.clip.w >= 0:
      element.bounds = element.bounds.intersect(element.props.clip)
  element.bounds

proc join(a, b: Rect): Rect =
  let
    x = min(a.x, b.x)
    y = min(a.y, b.y)
  rect(x, y, max(a.x + a.w, b.x + b.w) - x, max(a.y + a.h, b.y + b.h) - y)

proc meets(a, b: Rect): bool =
  ## The two share a pixel's edge at least: repainting them as one costs
  ## nothing a second pass over the overlap would not.
  a.x <= b.x + b.w and b.x <= a.x + a.w and a.y <= b.y + b.h and b.y <= a.y + a.h

proc hidesWindow(element: SvgElement, window: Rect): bool =
  ## Whether the element paints every pixel of `window` opaquely, so nothing
  ## drawn before it shows there: a solid square-cornered rect, or a 565
  ## picture (which has no alpha), at full opacity, axis-aligned, around the
  ## whole window. False whenever it cannot be sure.
  let props = element.props
  if not props.display or props.opacity < 1 or props.fillOpacity < 1:
    return false
  let m = props.transform
  if m[0, 1] != 0 or m[1, 0] != 0:
    return false
  if props.clip.w >= 0 and (props.clip.x > window.x or props.clip.y > window.y or
      props.clip.x + props.clip.w < window.x + window.w or
      props.clip.y + props.clip.h < window.y + window.h):
    return false
  var
    lo, hi: Vec2
    edge = 0'f32
  if not props.image.isNil:
    if props.image.format != pfRgb565:
      return false
    let box = props.imageBox
    lo = vec2(box.x, box.y)
    hi = vec2(box.x + box.w, box.y + box.h)
    if props.imageClip:
      lo = vec2(max(lo.x, props.rectX), max(lo.y, props.rectY))
      hi = vec2(min(hi.x, props.rectX + props.rectW), min(hi.y, props.rectY + props.rectH))
    edge = 1 # a scaled picture blends its edge pixels with nothing
  elif props.isRect:
    lo = vec2(props.rectX, props.rectY)
    hi = vec2(props.rectX + props.rectW, props.rectY + props.rectH)
  else:
    return false
  let
    a = m * lo
    b = m * hi
  if min(a.x, b.x) + edge > window.x or min(a.y, b.y) + edge > window.y or
      max(a.x, b.x) - edge < window.x + window.w or
      max(a.y, b.y) - edge < window.y + window.h:
    return false
  if not props.image.isNil:
    return true
  if props.fill.len == 0 or props.fill == "none" or props.fill.startsWith("url("):
    return false
  try:
    parseHtmlColor(props.fill).a >= 1
  except:
    false

proc renderSvg(
  svg: Svg, target: Image, firstBlendMode: BlendMode, offset = mat3(),
  window = rect(0, 0, 0, 0)
) {.raises: [PixieError].} =
  ## `offset` maps the image the SVG was parsed for onto `target`: a
  ## translation when `target` is a window of it (renderInto with an origin).
  ## `window`, when it has an area: that window, in the parsed image. An
  ## element that cannot touch it is skipped, and so is everything under the
  ## topmost one that hides it (a canvas picture over its page), so
  ## repainting a small box costs the elements that show in it, not every
  ## element's flattening and stroke.
  try:
    var
      blendMode = firstBlendMode
      first = 0
    if window.w > 0:
      for i in countdown(svg.elements.high, 0):
        if svg.elements[i].hidesWindow(window):
          first = i
          break
    for i in first ..< svg.elements.len:
      let element = svg.elements[i]
      let path = element.path
      template elementProps: untyped = element.props
      if window.w > 0 and elementProps.display and elementProps.opacity > 0:
        var bounds = window
        try:
          bounds = element.paintBounds()
        except PixieError:
          discard # unmeasured: drawn
        if not bounds.meets(window):
          continue
      var props = elementProps
      props.transform = offset * props.transform
      var target = target
      if props.clip.w >= 0:
        # Inside a nested viewport: drawn into the view of the target that
        # is the viewport, and nothing at all when they miss.
        let
          a = offset * vec2(props.clip.x, props.clip.y)
          x0 = clamp(round(a.x).int, 0, target.width)
          y0 = clamp(round(a.y).int, 0, target.height)
          x1 = clamp(round(a.x + props.clip.w).int, 0, target.width)
          y1 = clamp(round(a.y + props.clip.h).int, 0, target.height)
        if x1 <= x0 or y1 <= y0:
          continue
        target = target.view(x0, y0, x1 - x0, y1 - y0)
        props.transform = translate(vec2(-x0.float32, -y0.float32)) * props.transform
      if not props.image.isNil:
        if props.display and props.opacity > 0:
          target.drawSvgImage(props)
          blendMode = NormalBlend
        continue
      if props.display and props.opacity > 0:
        if props.fill != "none":
          var paint: Paint
          if props.fill.startsWith("url("):
            let closingParen = props.fill.find(")", 5)
            if closingParen == -1:
              raise newException(PixieError, "Malformed fill: " & props.fill)
            let id = props.fill[5 .. closingParen - 1]
            if id in svg.gradients:
              let
                gradient = svg.gradients[id]
                transform = props.transform * gradient.transform
              paint = newPaint(gradient.kind)
              case gradient.kind
              of RadialGradientPaint:
                # pixie's radial paint takes the centre plus a point on the
                # circle along each axis; the transform turns those into the
                # ellipse the SVG asks for.
                paint.gradientHandlePositions = @[
                  transform * vec2(gradient.cx, gradient.cy),
                  transform * vec2(gradient.cx + gradient.r, gradient.cy),
                  transform * vec2(gradient.cx, gradient.cy + gradient.r)
                ]
              else:
                paint.gradientHandlePositions = @[
                  transform * vec2(gradient.x1, gradient.y1),
                  transform * vec2(gradient.x2, gradient.y2)
                ]
              paint.gradientStops = gradient.stops
            else:
              raise newException(PixieError, "Missing SVG resource " & id)
          else:
            paint = parseHtmlColor(props.fill).rgbx

          paint.opacity = props.fillOpacity * props.opacity
          paint.blendMode = blendMode

          target.fillPath(path, paint, props.transform, props.fillRule)

        blendMode = NormalBlend # Switch to normal when compositing multiple paths

        if props.stroke != rgbx(0, 0, 0, 0) and props.strokeWidth > 0:
          let paint = props.stroke.copy()
          paint.color.a *= (props.opacity * props.strokeOpacity)
          target.strokePath(
            path,
            paint,
            props.transform,
            props.strokeWidth,
            props.strokeLineCap,
            props.strokeLineJoin,
            miterLimit = props.strokeMiterLimit,
            dashes = props.strokeDashArray
          )
  except PixieError as e:
    raise e
  except:
    raise currentExceptionAsPixieError()

type SvgPicture* = tuple
  image: Image  ## what an `<image>` element draws
  box: Rect     ## the box it is stretched into, before `transform`
  clip: Rect    ## the element's own box it is clipped to (`slice`); w < 0: none
  transform: Mat3

iterator pictures*(svg: Svg): SvgPicture {.raises: [].} =
  ## The pictures the SVG draws, and where: for a caller that changes a
  ## picture's pixels in place (a canvas an app draws into) and must repaint
  ## them, which damageRects cannot see (the element is the same, and so is
  ## its picture, by identity).
  if not svg.isNil:
    for element in svg.elements:
      let props = element.props
      if not props.image.isNil and props.display and props.opacity > 0:
        yield (props.image, props.imageBox,
          (if props.imageClip: rect(props.rectX, props.rectY, props.rectW, props.rectH)
           else: rect(0, 0, -1, -1)),
          props.transform)

proc coversOpaque*(svg: Svg, width, height: int): bool {.raises: [].} =
  ## Whether the first thing `svg` paints is an opaque, solid, square-cornered
  ## rectangle over all of a `width` x `height` target — a background rect —
  ## so that rendering it overwrites every pixel of the target whatever was
  ## there before. A caller that would clear the target first (FrameOS paints
  ## a scene's background colour before its first node draws) can skip that
  ## pass. Conservative: false whenever it cannot be sure (a gradient, any
  ## opacity, rounded corners, a rotation, an edge short of the target's).
  if svg.isNil or svg.elements.len == 0 or width <= 0 or height <= 0:
    return false
  let props = svg.elements[0].props
  if not props.isRect or not props.display or props.clip.w >= 0:
    return false
  if props.opacity < 1 or props.fillOpacity < 1:
    return false
  if props.fill.len == 0 or props.fill == "none" or props.fill.startsWith("url("):
    return false
  var color: Color
  try:
    color = parseHtmlColor(props.fill)
  except:
    return false
  if color.a < 1:
    return false
  let m = props.transform
  # Scale and translation only: a rotated or skewed box is not axis-aligned.
  if m[0, 1] != 0 or m[1, 0] != 0:
    return false
  let
    a = m * vec2(props.rectX, props.rectY)
    b = m * vec2(props.rectX + props.rectW, props.rectY + props.rectH)
  min(a.x, b.x) <= 0 and min(a.y, b.y) <= 0 and
    max(a.x, b.x) >= width.float32 and max(a.y, b.y) >= height.float32

proc renderInto*(svg: Svg, target: Image) {.raises: [PixieError].} =
  ## Render SVG into an existing image, compositing onto whatever is already
  ## there. Nothing is allocated: for a caller that already owns a correctly
  ## sized buffer — a render canvas, a cell of a larger image — this is the
  ## difference between one image and two.
  ##
  ## Unlike `newImage`, the first path composites rather than overwrites.
  ## `newImage` can start in overwrite because its image is freshly
  ## transparent, where the two are identical; on a target that already has
  ## content they are not, and a semi-transparent first path would replace what
  ## is underneath instead of blending with it.
  svg.renderSvg(target, NormalBlend)

proc renderInto*(
  svg: Svg, target: Image, originX, originY: int
) {.raises: [PixieError].} =
  ## renderInto for a window: `target` is the part of the image the SVG was
  ## parsed for that starts at (originX, originY) — a `view` of it, say — and
  ## what falls inside it is drawn exactly as a whole render would draw it
  ## there. With `damageRects`, an animation or a UI repaints the boxes that
  ## changed instead of the whole canvas; an element that cannot touch the
  ## window is skipped, so a small box costs the elements over it.
  svg.renderSvg(target, NormalBlend,
    translate(vec2(-originX.float32, -originY.float32)),
    rect(originX.float32, originY.float32, target.width.float32, target.height.float32))

proc addBox(boxes: var seq[Rect], box: Rect) =
  ## `box` into `boxes`, joined with every box it meets (and those with the
  ## boxes they then meet).
  var box = box
  var i = 0
  while i < boxes.len:
    if boxes[i].meets(box):
      box = box.join(boxes[i])
      boxes.delete(i)
      i = 0
    else:
      inc i
  boxes.add box

proc damageRects*(
  previous, next: Svg, width, height: int, maxRects = 4
): tuple[full: bool, rects: seq[tuple[x, y, w, h: int]]] {.raises: [].} =
  ## Where rendering `next` changes a `width` x `height` target that holds
  ## exactly what `previous` rendered there (both parsed for that size), as
  ## at most `maxRects` boxes. The two lists of elements are matched in
  ## order, identical with identical, the way a keyed list is reconciled:
  ## an element in one with no match in the other (changed, added, removed)
  ## is damage where it is. Everything outside the boxes is drawn by matched
  ## elements in the same order, so repainting each box (renderInto with an
  ## origin, into a view) leaves the target exactly as a whole render of
  ## `next` would. Two changes far apart (a switch and the count it updates)
  ## are two small boxes, not the canvas between them: boxes that meet are
  ## joined, and past `maxRects` the two whose join adds the least area.
  ##
  ## The match looks `Resync` elements ahead for an element added or
  ## removed; a longer run than that is damage too, if more of it. An
  ## element filled with a gradient whose definition differs between the
  ## two (a progress bar's ramp stretched to its new width) differs however
  ## equal the rest of it is. `full` when bounds cannot be measured. No
  ## boxes when nothing differs.
  if previous.isNil or next.isNil or width <= 0 or height <= 0:
    return (true, @[(0, 0, width, height)])
  const Resync = 8
  template a: untyped = previous.elements
  template b: untyped = next.elements
  var changedGradients: seq[string]
  for id, gradient in previous.gradients:
    if id notin next.gradients or next.gradients.getOrDefault(id) != gradient:
      changedGradients.add id
  for id in next.gradients.keys:
    if id notin previous.gradients:
      changedGradients.add id
  proc paintChanged(element: SvgElement): bool =
    changedGradients.len > 0 and element.props.fill.startsWith("url(#") and
      element.props.fill.find(")") > 5 and
      element.props.fill[5 ..< element.props.fill.find(")")] in changedGradients
  template same(i, j: int): bool =
    sameElement(previous, i, next, j) and not paintChanged(previous.elements[i])
  var boxes: seq[Rect]
  proc add(boxes: var seq[Rect], svg: Svg, i: int) {.raises: [PixieError].} =
    let element = svg.elements[i]
    if element.props.display and element.props.opacity > 0:
      # An element scrolled out of its viewport paints nothing anywhere.
      let bounds = element.paintBounds()
      if bounds.w > 0 and bounds.h > 0:
        boxes.addBox(bounds)
  try:
    var i, j = 0
    while i < a.len or j < b.len:
      if i < a.len and j < b.len and same(i, j):
        inc i
        inc j
        continue
      # The nearest place the two agree again: `added` elements of `next`
      # before a[i] reappears, or `removed` of `previous` before b[j] does.
      var added, removed = 0
      for k in 1 .. Resync:
        if i < a.len and j + k < b.len and same(i, j + k):
          added = k
        elif j < b.len and i + k < a.len and same(i + k, j):
          removed = k
        if added + removed > 0:
          break
      if added > 0:
        for _ in 1 .. added:
          boxes.add(next, j)
          inc j
      elif removed > 0:
        for _ in 1 .. removed:
          boxes.add(previous, i)
          inc i
      else:
        if i < a.len:
          boxes.add(previous, i)
          inc i
        if j < b.len:
          boxes.add(next, j)
          inc j
  except:
    return (true, @[(0, 0, width, height)])
  while boxes.len > max(maxRects, 1):
    var
      best = float32.high
      bi, bj: int
    for i in 0 ..< boxes.len:
      for j in i + 1 ..< boxes.len:
        let
          joined = boxes[i].join(boxes[j])
          added = joined.w * joined.h - boxes[i].w * boxes[i].h - boxes[j].w * boxes[j].h
        if added < best:
          best = added
          bi = i
          bj = j
    let joined = boxes[bi].join(boxes[bj])
    boxes.delete(bj)
    boxes.delete(bi)
    boxes.addBox(joined)
  for box in boxes:
    let
      x0 = clamp(floor(box.x).int, 0, width)
      y0 = clamp(floor(box.y).int, 0, height)
      x1 = clamp(ceil(box.x + box.w).int, 0, width)
      y1 = clamp(ceil(box.y + box.h).int, 0, height)
    if x1 > x0 and y1 > y0:
      result.rects.add((x0, y0, x1 - x0, y1 - y0))

proc damage*(
  previous, next: Svg, width, height: int
): tuple[full: bool, x, y, w, h: int] {.raises: [].} =
  ## damageRects as one box: the box around every element that differs. An
  ## empty box (w = 0) when nothing differs.
  let found = damageRects(previous, next, width, height, 1)
  if found.full:
    return (true, 0, 0, width, height)
  if found.rects.len == 0:
    return (false, 0, 0, 0, 0)
  let r = found.rects[0]
  (false, r.x, r.y, r.w, r.h)

proc newImage*(svg: Svg): Image {.raises: [PixieError].} =
  ## Render SVG and return the image.
  result = newImage(svg.width, svg.height)
  svg.renderSvg(result, OverwriteBlend) # Fresh image: overwrite == normal

