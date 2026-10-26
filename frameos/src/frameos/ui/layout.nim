## UI trees (what a JS app returns as JSX: `<div className="flex p-4">`)
## laid out and turned into the SVG that draws them (`docs/jsx-ui.md`).
##
## The input is the node tree the JSX walker builds (`js_runtime/jsx.nim`),
## the output a tree of SVG nodes pixie draws: so a UI is drawn, damaged,
## repainted and waived as a background exactly like an SVG
## (`utils/svg_frames.nim`), and the engine itself is only the layout.
##
## The layout is a subset of CSS: every element is a border-box; a block
## stacks its children and flows its text; `flex` and `grid` are flexbox
## (grow, shrink, basis, wrap, gap, justify, align, auto margins) and
## equal-column grids; `absolute` places a child against its parent's padding
## box. Text is set with pixie's typesetter and drawn as its outlines.

import std/[math, strutils]
import pixie
import pixie/fileformats/svg
import frameos/ui/tailwind

type
  UiKind = enum
    ukBox, ukText, ukImage, ukSvg

  UiEvent* = enum
    ## The handlers an element can have, by the event that runs them.
    ueClick = "tap", ueDoubleClick = "doubleTap", ueLongPress = "longPress",
    uePointerDown = "pointerDown", uePointerUp = "pointerUp"

  UiRegion* = object
    ## An element the pointer can do something to, where the layout put it:
    ## one with a handler, or with `hover:` / `active:` classes, or a `group`.
    x*, y*, w*, h*: float32
    key*: int                        ## its place in the tree, the same next render
    handlers*: array[UiEvent, int]   ## a handler's number + 1, 0 for none
    hover*, active*, group*: bool

  UiInput* = object
    ## What the pointer was doing when this layout was asked for: the keys of
    ## the elements it is over and of those it is pressing.
    hovered*, pressed*: seq[int]

  UiNode {.acyclic.} = ref object
    kind: UiKind
    box: Box
    text: Text
    children: seq[UiNode]
    src: SvgNode          # ukImage, ukSvg: the element
    runs: seq[SvgNode]    # ukText: its text (and <br>s) ...
    styles: seq[Text]     # ... in the style each was written in
    x, y: float32         # border box, from the parent's border box
    size: Vec2
    # The last layout call: a container asks a child for its size before it
    # places it, often with the same question twice.
    lastW, lastH: float32
    lastFix: int
    lastSize: Vec2
    # An item's margins and sizes while its container lays it out.
    margins: array[4, float32]
    autos: set[0 .. 3]
    fixedMain, fixedCross, main, cross: float32
    # ukText
    spans: seq[Span]
    bold: seq[Font]       # drawn with a stroke: no bold face to use
    arrangement: Arrangement
    arrangedW: float32
    arrangedAlign: HorizontalAlignment
    # What the pointer can do to it (UiRegion).
    key: int
    handlers: array[UiEvent, int]
    hover, active, group: bool

const
  # The attributes the JSX walker turns onClick, onLongPress, ... into.
  handlerAttrs: array[UiEvent, string] = ["on-click", "on-double-click",
    "on-long-press", "on-pointer-down", "on-pointer-up"]
  Unbounded = 1e9'f32
  MaxDepth = 64

{.push boundChecks: off, overflowChecks: off, rangeChecks: off, raises: [].}

proc isText(n: SvgNode): bool {.inline.} =
  n.tag.len == 0 or n.tag == "&"

proc isInline(tag: string): bool =
  tag in ["span", "b", "strong", "i", "em", "u", "s", "small", "br", "a", "code", "label", "mark"]

proc tagStyle(tag: string, text: var Text) =
  ## What an inline tag means before its classes say anything.
  if tag == "b" or tag == "strong": text.weight = 700
  elif tag == "i" or tag == "em": text.italic = true
  elif tag == "u": text.underline = true
  elif tag == "s": text.strike = true

proc variant(classes, name: string): bool =
  ## Whether `classes` has a `name:` variant (hover:, not group-hover:).
  var at = classes.find(name & ":")
  while at >= 0:
    if at == 0 or classes[at - 1] in {' ', '\t', '\n', ':', '!'}:
      return true
    at = classes.find(name & ":", at + 1)

proc hasClass(classes, name: string): bool =
  var at = classes.find(name)
  while at >= 0:
    let stop = at + name.len
    if (at == 0 or classes[at - 1] in Whitespace) and (stop == classes.len or classes[stop] in Whitespace):
      return true
    at = classes.find(name, at + 1)

proc addRuns(n: SvgNode, style: Text, into: UiNode, rootW, rootH: float32, depth: int,
    states: set[UiState]) =
  ## The text of an inline element and everything inside it, each run in the
  ## style it was written in.
  if n.isText or n.tag == "br":
    into.runs.add n
    into.styles.add style
    return
  if depth > MaxDepth:
    return
  var
    text = style
    box = initBox()
  tagStyle(n.tag, text)
  box.applyClasses(text, n.attr("class"), rootW, rootH, states)
  if box.display != diNone:
    for child in n.children:
      child.addRuns(text, into, rootW, rootH, depth + 1, states)

proc newUiNode(kind: UiKind, text: Text): UiNode =
  UiNode(kind: kind, box: initBox(), text: text, lastFix: -1)

proc build(n: SvgNode, inherited: Text, rootW, rootH: float32, depth: int,
    key: int, input: UiInput, groupHover: bool): UiNode =
  var text = inherited
  tagStyle(n.tag, text)
  result = newUiNode(ukBox, text)
  let classes = n.attr("class")
  result.key = key
  result.hover = classes.variant("hover")
  result.active = classes.variant("active")
  result.group = classes.hasClass("group")
  for event in UiEvent:
    var id: float32
    let value = n.attr(handlerAttrs[event])
    if value.len > 0 and number(value, 0, value.len, id):
      result.handlers[event] = int(id) + 1
  var states: set[UiState]
  if groupHover: states.incl usGroupHover
  if result.hover and key in input.hovered: states.incl usHover
  if result.active and key in input.pressed: states.incl usActive
  result.box.applyClasses(result.text, classes, rootW, rootH, states)
  # A hovered `group` lights its descendants' group-hover: classes.
  let childGroup = groupHover or (result.group and key in input.hovered)
  if n.tag == "img" or n.tag == "svg":
    result.kind = if n.tag == "img": ukImage else: ukSvg
    result.src = n
    return
  if depth > MaxDepth:
    return
  # A block flows its text and inline children into lines; in a flex or grid
  # container every child is an item, and a run of text one item.
  let flows = result.box.display == diBlock
  var run: UiNode
  let inlineStates = if childGroup: {usGroupHover} else: {}
  for i, child in n.children:
    if child.isText or (flows and child.tag.isInline):
      if run.isNil:
        run = newUiNode(ukText, result.text)
        result.children.add run
      child.addRuns(result.text, run, rootW, rootH, depth + 1, inlineStates)
    else:
      run = nil
      result.children.add child.build(result.text, rootW, rootH, depth + 1,
        key * 31 + i + 1, input, childGroup)

# -------- Text

proc typefaceFor(text: Text, weight: int): Typeface =
  let resolver = svgTypefaceResolver()
  if resolver.isNil:
    return nil
  # The default face is Ubuntu: a frame whose fonts hold Ubuntu-Bold.ttf
  # draws font-bold in it.
  let family =
    if text.family > 0 and text.family < fontFamilies.len: fontFamilies[text.family]
    elif weight >= 600 or text.italic: "Ubuntu"
    else: ""
  if family.len > 0:
    result = resolver(family, weight, text.italic)
  if result.isNil:
    result = resolver("", weight, text.italic)

proc ensureSpans(n: UiNode) =
  ## The runs as pixie spans, white space collapsed the way HTML collapses it
  ## (a `<br>` stays a line break), and trimmed at both ends.
  if n.spans.len > 0 or n.runs.len == 0:
    return
  var
    lastSpace = true
    faceStyles: seq[Text]
    faceFonts: seq[Font]
  for i in 0 ..< n.runs.len:
    template run: untyped = n.runs[i]
    template style: untyped = n.styles[i]
    var text = newStringOfCap(run.text.len)
    if run.tag == "br":
      text.add '\n'
      lastSpace = true
    else:
      for c in run.text:
        if c in Whitespace and run.tag != "&":
          if not lastSpace:
            text.add ' '
            lastSpace = true
        else:
          text.add c
          lastSpace = false
    if text.len == 0 or style.size <= 0:
      continue
    var font: Font
    let seen = faceStyles.find(style)
    if seen >= 0:
      font = faceFonts[seen]
    else:
      let face = typefaceFor(style, style.weight)
      if face.isNil:
        continue
      font = newFont(face)
      font.size = style.size
      font.lineHeight =
        if style.leading < 0: style.lineHeight
        elif style.leadingPx: style.leading
        else: style.leading * style.size
      font.paint = color(style.color)
      font.underline = style.underline
      font.strikethrough = style.strike
      font.textCase = style.textCase
      faceStyles.add style
      faceFonts.add font
      if style.weight >= 600 and face == typefaceFor(style, 400):
        n.bold.add font
    n.spans.add newSpan(text, font)
  if n.spans.len > 0 and n.spans[^1].text.endsWith(' '):
    n.spans[^1].text.setLen(n.spans[^1].text.len - 1)

proc cutSpans(spans: seq[Span], keep: int): seq[Span] =
  ## The first `keep` characters of `spans`, and an ellipsis.
  var left = keep
  for span in spans:
    if left <= 0:
      break
    var i = 0
    while i < span.text.len and left > 0:
      inc i
      while i < span.text.len and (ord(span.text[i]) and 0xC0) == 0x80:
        inc i
      dec left
    result.add newSpan(span.text[0 ..< i], span.font)
  if result.len > 0:
    result[^1] = newSpan(result[^1].text.strip(leading = false) & "…", result[^1].font)

proc arrange(n: UiNode, width: float32, align: HorizontalAlignment): Arrangement =
  ## The text set into `width`, wrapped unless `whitespace-nowrap`, and cut
  ## with an ellipsis after `lines` lines (truncate, line-clamp-N).
  if not n.arrangement.isNil and n.arrangedW == width and n.arrangedAlign == align:
    return n.arrangement
  n.ensureSpans()
  # A pixel to spare: pixie rounds the bounds it reports, so text measured
  # at its own width could otherwise wrap when set into it.
  let
    wrap = not n.text.nowrap
    bounds = vec2(max(width, 0) + 1, 0)
    lines = n.text.lines
  result = typeset(n.spans, bounds, align, TopAlign, wrap)
  template overflows(a: Arrangement): bool =
    a.lines.len > lines or (not wrap and a.layoutBounds().x > width + 0.5)
  if lines > 0 and result.runes.len > 0 and result.overflows:
    var
      lo = 0
      hi = if result.lines.len > lines: result.lines[lines - 1][1] + 1 else: result.runes.len
    while lo < hi:
      let mid = (lo + hi + 1) div 2
      if typeset(cutSpans(n.spans, mid), bounds, align, TopAlign, wrap).overflows:
        hi = mid - 1
      else:
        lo = mid
    result = typeset(cutSpans(n.spans, lo), bounds, align, TopAlign, wrap)
  n.arrangement = result
  n.arrangedW = width
  n.arrangedAlign = align

# -------- Layout

proc padX(b: Box): float32 {.inline.} = b.pad[1] + b.pad[3] + b.border[1] + b.border[3]
proc padY(b: Box): float32 {.inline.} = b.pad[0] + b.pad[2] + b.border[0] + b.border[2]

template inFlow(c: UiNode): bool =
  not c.box.absolute and c.box.display != diNone

proc clampTo(v: float32, lo, hi: Len, base: float32): float32 =
  result = v
  let most = hi.resolve(base)
  if most >= 0:
    result = min(result, most)
  let least = lo.resolve(base)
  if least >= 0:
    result = max(result, least)

proc fields(s: string, into: var array[4, float32]): int =
  ## Up to four numbers apart by spaces or commas (a viewBox, a width).
  var i = 0
  while i < s.len and result < 4:
    while i < s.len and s[i] in {' ', ',', '\t', '\n'}:
      inc i
    let start = i
    while i < s.len and s[i] notin {' ', ',', '\t', '\n'}:
      inc i
    var stop = i
    if stop - start > 2 and s[stop - 2] == 'p' and s[stop - 1] == 'x':
      stop -= 2
    if i > start:
      if not number(s, start, stop, into[result]):
        return
      inc result

proc viewBox(n: UiNode): array[4, float32] =
  ## An `<svg>`'s viewBox, else 0 0 width height, else a 24 px icon's.
  var w, h: array[4, float32]
  if fields(n.src.attr("viewBox"), result) == 4 and result[2] > 0 and result[3] > 0:
    discard
  elif fields(n.src.attr("width"), w) == 1 and fields(n.src.attr("height"), h) == 1 and
      w[0] > 0 and h[0] > 0:
    result = [0'f32, 0, w[0], h[0]]
  else:
    result = [0'f32, 0, 24, 24]

proc intrinsic(n: UiNode): Vec2 =
  ## An image's own size; an SVG's width/height, else its viewBox's.
  if n.kind == ukImage:
    if n.src.image.isNil:
      return vec2(0, 0)
    return vec2(n.src.image.width.float32, n.src.image.height.float32)
  var w, h: array[4, float32]
  if fields(n.src.attr("width"), w) == 1 and fields(n.src.attr("height"), h) == 1 and
      w[0] > 0 and h[0] > 0:
    return vec2(w[0], h[0])
  let box = n.viewBox()
  vec2(box[2], box[3])

proc layout(n: UiNode, w, h: float32, fixW, fixH: bool): Vec2 {.raises: [].}

proc alignOf(parent, child: Box): Align {.inline.} =
  if child.self != alAuto: child.self else: parent.items

proc stretches(parent: Box, c: UiNode, cs, ce: int): bool {.inline.} =
  alignOf(parent, c.box) == alStretch and c.fixedCross < 0 and
    cs notin c.autos and ce notin c.autos

proc layoutFlex(n: UiNode, innerW, innerH: float32, defW, defH: bool): Vec2 =
  ## A block (a column that stretches its children), a flex container or a
  ## grid: equal columns are a wrapping row whose items are as wide as the
  ## columns they span, each row as tall as its tallest item. Places the
  ## in-flow children and returns the size of their content.
  template b: untyped = n.box
  let
    grid = b.display == diGrid
    cols = max(1, b.cols)
  var colW = (innerW - b.gapX * float32(cols - 1)) / cols.float32
  if grid and not defW:
    # A grid sized to its content: columns as wide as its widest item.
    var widest = 0'f32
    for c in n.children:
      if c.inFlow and c.box.span <= 1:
        let own = c.box.w.resolve(-1)
        widest = max(widest,
          if own >= 0: own else: c.layout(max(colW, 0), Unbounded, false, false).x)
    colW = min(colW, widest)
  let
    row = grid or (b.display == diFlex and not b.col)
    # A block stacks its children at their own heights: nothing grows or
    # shrinks, and a child's height is only definite when it is set.
    flexing = b.display != diBlock
    gapMain = if row: b.gapX else: b.gapY
    gapCross = if row: b.gapY else: b.gapX
    mainAvail = if row: innerW else: innerH
    mainDef = if row: defW else: defH
    crossAvail = if row: innerH else: innerW
    crossDef = if row: defH else: defW
    # The sides along each axis: main start/end, cross start/end.
    (ms, me, cs, ce) = if row: (3, 1, 0, 2) else: (0, 2, 3, 1)
  var lines: seq[(int, int)]
  var used = 0'f32
  var first, column = -1
  # Each item's margins and base size, and where the lines break.
  for i in 0 ..< n.children.len:
    template c: untyped = n.children[i]
    if not c.inFlow:
      continue
    template cb: untyped = c.box
    c.autos = {}
    for side in 0 .. 3:
      # Percentages of the width on every side, as in CSS.
      c.margins[side] = 0
      if cb.margin[side].isAuto: c.autos.incl side
      else: c.margins[side] = cb.margin[side].resolve(innerW)
    let crossMargin = c.margins[cs] + c.margins[ce]
    c.fixedMain = (if row: cb.w else: cb.h).resolve(if mainDef: mainAvail else: -1)
    c.fixedCross = (if row: cb.h else: cb.w).resolve(if crossDef or not row: crossAvail else: -1)
    if c.fixedMain >= 0:
      c.fixedMain = c.fixedMain.clampTo(if row: cb.minW else: cb.minH,
        if row: cb.maxW else: cb.maxH, mainAvail)
    let span = clamp(cb.span, 1, cols)
    if grid:
      c.fixedMain = max(colW * span.float32 + b.gapX * float32(span - 1), 0)
    var basis = if grid: -1'f32 else: cb.basis.resolve(if mainDef: mainAvail else: -1)
    if basis < 0:
      basis = c.fixedMain
    if row:
      if basis < 0:
        let fixC = c.fixedCross >= 0
        basis = c.layout(max(mainAvail - c.margins[ms] - c.margins[me], 0),
          if fixC: c.fixedCross else: crossAvail - crossMargin, false, fixC).x
    else:
      # A column needs an item's width before its height: stretched to the
      # column's when it has one, else its own until the widest is known.
      c.cross =
        if c.fixedCross >= 0: c.fixedCross
        elif crossDef and b.stretches(c, cs, ce): max(crossAvail - crossMargin, 0)
        else: c.layout(max(crossAvail - crossMargin, 0), Unbounded, false, false).x
      if basis < 0:
        basis = c.layout(c.cross, Unbounded, true, false).y
    c.main = basis
    let size = basis + c.margins[ms] + c.margins[me]
    # A grid row ends after its columns; a wrapping line where room ends.
    let breaks =
      if grid: column + span > cols
      else: b.wrap and used + gapMain + size > mainAvail + 0.01
    if first < 0:
      first = i
      used = size
      column = span
    elif breaks:
      lines.add((first, i))
      first = i
      used = size
      column = span
    else:
      used += gapMain + size
      column += span
  if first < 0:
    return vec2(0, 0)
  lines.add((first, n.children.len))
  var lineCross = newSeq[float32](lines.len)
  for li, (s, e) in lines:
    var
      sum = 0'f32
      count = 0
      grow, shrink = 0'f32
    for i in s ..< e:
      template c: untyped = n.children[i]
      if c.inFlow:
        sum += c.main + c.margins[ms] + c.margins[me]
        inc count
        grow += c.box.grow
        if c.fixedMain < 0: shrink += c.box.shrink * c.main
    sum += gapMain * float32(count - 1)
    let free = if mainDef: mainAvail - sum else: min(0'f32, mainAvail - sum)
    var tallest = 0'f32
    for i in s ..< e:
      template c: untyped = n.children[i]
      if not c.inFlow:
        continue
      template cb: untyped = c.box
      if not flexing:
        discard
      elif free > 0 and grow > 0:
        c.main += free * cb.grow / grow
      elif free < 0 and shrink > 0 and c.fixedMain < 0:
        # A set size is also the item's least size (CSS's automatic minimum).
        c.main = max(0, c.main + free * cb.shrink * c.main / shrink)
      c.main = c.main.clampTo(if row: cb.minW else: cb.minH, if row: cb.maxW else: cb.maxH, mainAvail)
      let crossMargin = c.margins[cs] + c.margins[ce]
      if row:
        c.cross =
          if c.fixedCross >= 0: c.fixedCross
          else: c.layout(c.main, max(crossAvail - crossMargin, 0), true, false).y
      tallest = max(tallest, c.cross + crossMargin)
    # The line's cross size: the container's when it has one and this is its
    # only line, else its tallest item's.
    lineCross[li] = if lines.len == 1 and crossDef: crossAvail else: tallest
  if lines.len > 1 and crossDef:
    # Wrapped lines and grid rows share out a set height (align-content's
    # default, stretch).
    var taken = gapCross * float32(lines.len - 1)
    for size in lineCross: taken += size
    if crossAvail > taken:
      for li in 0 ..< lineCross.len:
        lineCross[li] += (crossAvail - taken) / lineCross.len.float32
  # Place the items, from the content box's corner.
  let
    originX = b.border[3] + b.pad[3]
    originY = b.border[0] + b.pad[0]
  var
    crossPos = 0'f32
    mainUsed = 0'f32
  for li, (s, e) in lines:
    var
      used = 0'f32
      count = 0
      autoCount = 0
    for i in s ..< e:
      template c: untyped = n.children[i]
      if c.inFlow:
        used += c.main + c.margins[ms] + c.margins[me]
        inc count
        if ms in c.autos: inc autoCount
        if me in c.autos: inc autoCount
    used += gapMain * float32(count - 1)
    mainUsed = max(mainUsed, used)
    var
      leftover = if mainDef: mainAvail - used else: 0'f32
      pos = 0'f32
      between = gapMain
      autoShare = 0'f32
    if autoCount > 0:
      autoShare = max(leftover, 0) / autoCount.float32
      leftover = 0
    if leftover > 0:
      let items = count.float32
      case b.justify
      of juStart: discard
      of juCenter: pos = leftover / 2
      of juEnd: pos = leftover
      of juBetween:
        if count > 1: between += leftover / (items - 1)
      of juAround:
        between += leftover / items
        pos = leftover / items / 2
      of juEvenly:
        between += leftover / (items + 1)
        pos = leftover / (items + 1)
    elif b.justify == juCenter:
      pos = leftover / 2
    elif b.justify == juEnd:
      pos = leftover
    for i in s ..< e:
      template c: untyped = n.children[i]
      if not c.inFlow:
        continue
      let crossMargin = c.margins[cs] + c.margins[ce]
      if b.stretches(c, cs, ce):
        c.cross = max(lineCross[li] - crossMargin, 0)
      let size =
        if row: c.layout(c.main, c.cross, true, true)
        else: c.layout(c.cross, c.main, true, flexing or c.fixedMain >= 0)
      c.size = size
      pos += c.margins[ms] + (if ms in c.autos: autoShare else: 0)
      let
        room = lineCross[li] - (if row: size.y else: size.x) - crossMargin
        offset =
          if cs in c.autos and ce in c.autos: room / 2
          elif cs in c.autos: room
          elif ce in c.autos: 0'f32
          else:
            case alignOf(b, c.box)
            of alCenter: room / 2
            of alEnd: room
            else: 0'f32
        crossAt = crossPos + c.margins[cs] + offset
      if row:
        c.x = originX + pos
        c.y = originY + crossAt
      else:
        c.x = originX + crossAt
        c.y = originY + pos
      pos += (if row: size.x else: size.y) + c.margins[me] +
        (if me in c.autos: autoShare else: 0) + between
    crossPos += lineCross[li] + gapCross
  let
    mainSize = if mainDef: mainAvail else: mainUsed
    crossSize = crossPos - gapCross
  if row: vec2(mainSize, crossSize) else: vec2(crossSize, mainSize)

proc layoutAbsolute(n: UiNode, size: Vec2) =
  ## `absolute` children, against the padding box.
  template b: untyped = n.box
  let
    pw = size.x - b.border[1] - b.border[3]
    ph = size.y - b.border[0] - b.border[2]
  for c in n.children:
    if not c.box.absolute or c.box.display == diNone:
      continue
    let
      inset = c.box.inset
      left = inset[3].resolve(pw)
      right = inset[1].resolve(pw)
      top = inset[0].resolve(ph)
      bottom = inset[2].resolve(ph)
    var
      w = c.box.w.resolve(pw)
      h = c.box.h.resolve(ph)
    if w < 0 and left >= 0 and right >= 0: w = max(pw - left - right, 0)
    if h < 0 and top >= 0 and bottom >= 0: h = max(ph - top - bottom, 0)
    let s = c.layout(if w >= 0: w else: max(pw, 0), if h >= 0: h else: Unbounded, w >= 0, h >= 0)
    c.size = s
    c.x = b.border[3] + (if left >= 0: left elif right >= 0: pw - right - s.x else: b.pad[3])
    c.y = b.border[0] + (if top >= 0: top elif bottom >= 0: ph - bottom - s.y else: b.pad[0])

proc layout(n: UiNode, w, h: float32, fixW, fixH: bool): Vec2 =
  ## `n`'s border-box size: `w` x `h` where fixed, else the room it may take
  ## at most, sized to its content. Lays its children out on the way.
  let key = int(fixW) or (int(fixH) shl 1)
  if n.lastFix == key and n.lastW == w and n.lastH == h:
    return n.lastSize
  template b: untyped = n.box
  let
    px = b.padX
    py = b.padY
  var content: Vec2
  case n.kind
  of ukText:
    content = n.arrange(max(w - px, 0), LeftAlign).layoutBounds()
  of ukImage, ukSvg:
    let
      own = n.intrinsic()
      aspect = if b.aspect > 0: b.aspect elif own.y > 0: own.x / own.y else: 1
    if fixW and not fixH:
      content = vec2(w - px, (w - px) / aspect)
    elif fixH and not fixW:
      content = vec2((h - py) * aspect, h - py)
    elif not fixW:
      let width = min(own.x, max(w - px, 0))
      content = vec2(width, width / aspect)
  of ukBox:
    let
      innerW = max(w - px, 0)
      innerH = if h >= Unbounded: Unbounded else: max(h - py, 0)
    content = n.layoutFlex(innerW, innerH, fixW, fixH)
  result.x = if fixW: w else: min(content.x + px, max(w, 0))
  result.y = if fixH: h else: content.y + py
  if n.kind == ukBox and b.aspect > 0 and fixW != fixH:
    if fixW: result.y = result.x / b.aspect
    else: result.x = result.y * b.aspect
  if n.kind == ukBox:
    n.layoutAbsolute(result)
  n.lastW = w
  n.lastH = h
  n.lastFix = key
  n.lastSize = result

# -------- SVG out

proc num(v: float32): string =
  ## A number for an SVG attribute, to a ten-thousandth, without the float
  ## formatter (5 KB of an ESP32's flash).
  let scaled = int(min(abs(v), 2e5'f32) * 10000 + 0.5)
  result = if v < 0 and scaled > 0: "-" else: ""
  result.add $(scaled div 10000)
  var
    frac = scaled mod 10000
    digit = 1000
  if frac > 0:
    result.add '.'
    while frac > 0:
      result.add chr(ord('0') + frac div digit)
      frac = frac mod digit
      digit = digit div 10

proc hex(c: ColorRGBA): string =
  const digits = "0123456789abcdef"
  result = "#000000"
  for i, v in [c.r, c.g, c.b]:
    result[1 + i * 2] = digits[int(v) shr 4]
    result[2 + i * 2] = digits[int(v) and 15]

proc paint(node: SvgNode, c: ColorRGBA, opacity: float32, attr = "fill") =
  ## `attr` is fill, stroke or stop-color, with its alpha as fill-opacity,
  ## stroke-opacity or stop-opacity.
  node.attrs.add((attr, c.hex))
  if c.a < 255:
    node.attrs.add((attr.split('-')[0] & "-opacity", num(c.a.float32 / 255)))
  if opacity < 1 and attr == "fill":
    node.attrs.add(("opacity", num(opacity)))

proc emit(n: UiNode, ox, oy, opacity: float32, drawn: var seq[SvgNode], gradients: var int,
    regions: var seq[UiRegion]) {.raises: [].}

proc emitPaint(n: UiNode, x, y, w, h, opacity: float32, drawn: var seq[SvgNode], gradients: var int) =
  ## The box's background and border.
  template b: untyped = n.box
  if w <= 0 or h <= 0:
    return
  var r = b.radius
  for i in 0 .. 3:
    r[i] = min(r[i], min(w, h) / 2)
  var fill = ""
  if b.gradient > 0:
    inc gradients
    fill = "ui" & $gradients
    # The gradient line, from where `bg-gradient-to-*` starts to where it
    # points: t, tr, r, br, b, bl, l, tl.
    const ends = [[1'u8, 2, 1, 0], [0, 2, 2, 0], [0, 1, 2, 1], [0, 0, 2, 2],
      [1, 0, 1, 2], [2, 0, 0, 2], [2, 1, 0, 1], [2, 2, 0, 0]]
    let
      e = ends[b.gradient - 1]
      gradient = SvgNode(tag: "linearGradient", attrs: @[("id", fill),
        ("gradientUnits", "userSpaceOnUse"),
        ("x1", num(x + w * e[0].float32 / 2)), ("y1", num(y + h * e[1].float32 / 2)),
        ("x2", num(x + w * e[2].float32 / 2)), ("y2", num(y + h * e[3].float32 / 2))])
    for (offset, c) in [("0", b.gradFrom), ("0.5", b.gradVia), ("1", b.gradTo)]:
      if offset == "0.5" and not b.hasVia:
        continue
      let stop = SvgNode(tag: "stop", attrs: @[("offset", offset)])
      stop.paint(c, 1, "stop-color")
      gradient.children.add stop
    drawn.add gradient
  let square = r == [0'f32, 0, 0, 0]
  if fill.len > 0 or b.bg.a > 0:
    # A square background is a <rect>: the first one, over the whole image,
    # is what lets pixie waive the scene's background (coversOpaque).
    var node: SvgNode
    if square:
      node = SvgNode(tag: "rect")
      for v in [("x", x), ("y", y), ("width", w), ("height", h)]:
        node.attrs.add((v[0], num(v[1])))
    else:
      node = SvgNode(tag: "path", path: newPath())
      node.path.roundedRect(x, y, w, h, r[0], r[1], r[2], r[3])
    if fill.len > 0:
      node.attrs.add(("fill", "url(#" & fill & ")"))
      if opacity < 1:
        node.attrs.add(("opacity", num(opacity)))
    else:
      node.paint(b.bg, opacity)
    drawn.add node
  let bw = b.border
  if bw != [0'f32, 0, 0, 0] and b.borderColor.a > 0:
    # The ring between the box and its inside, one fill whatever the widths.
    let node = SvgNode(tag: "path", path: newPath(), attrs: @[("fill-rule", "evenodd")])
    node.path.roundedRect(x, y, w, h, r[0], r[1], r[2], r[3])
    let
      iw = w - bw[1] - bw[3]
      ih = h - bw[0] - bw[2]
    if iw > 0 and ih > 0:
      node.path.roundedRect(x + bw[3], y + bw[0], iw, ih,
        max(r[0] - max(bw[3], bw[0]), 0), max(r[1] - max(bw[1], bw[0]), 0),
        max(r[2] - max(bw[1], bw[2]), 0), max(r[3] - max(bw[3], bw[2]), 0),
        clockwise = false)
    node.paint(b.borderColor, opacity)
    drawn.add node

proc recolor(n: SvgNode, color: string) =
  ## `currentColor` in an icon is the text color, as in a browser.
  for i in 0 ..< n.attrs.len:
    if n.attrs[i][1] == "currentColor":
      n.attrs[i][1] = color
  for child in n.children:
    child.recolor(color)

proc emitSvg(n: UiNode, x, y, w, h, opacity: float32, drawn: var seq[SvgNode]) =
  ## An `<svg>` inside a UI: its drawing as a group, its viewBox fitted into
  ## the content box (centered, whole) and its `currentColor` the text color.
  let box = n.viewBox()
  if w <= 0 or h <= 0:
    return
  var
    sx = w / box[2]
    sy = h / box[3]
  if n.src.attr("preserveAspectRatio") != "none":
    sx = min(sx, sy)
    sy = sx
  let
    tx = x + (w - box[2] * sx) / 2 - box[0] * sx
    ty = y + (h - box[3] * sy) / 2 - box[1] * sy
    group = SvgNode(tag: "g")
  for attr in n.src.attrs:
    if attr[0] notin ["width", "height", "viewBox", "xmlns", "class", "preserveAspectRatio", "transform"]:
      group.attrs.add(attr)
  group.attrs.add(("transform", "translate(" & num(tx) & " " & num(ty) & ") scale(" &
    num(sx) & " " & num(sy) & ")"))
  if opacity < 1:
    group.attrs.add(("opacity", num(opacity)))
  group.children = n.src.children
  group.recolor(n.text.color.hex)
  drawn.add group

proc emitText(n: UiNode, x, y, w, opacity: float32, drawn: var seq[SvgNode]) =
  let arrangement = n.arrange(w, n.text.align)
  if arrangement.runes.len == 0:
    return
  var paths: seq[Path]
  try:
    paths = arrangement.computePaths()
  except PixieError:
    return
  # arrange() sets text a pixel wider than its box, to wrap where it was
  # measured: centered or right-aligned lines come back by what it added.
  let shift =
    case n.text.align
    of CenterAlign: -0.5'f32
    of RightAlign: -1
    else: 0
  for i, path in paths:
    let font = arrangement.fonts[i]
    path.transform(translate(vec2(x + shift, y)))
    let node = SvgNode(tag: "path", path: path)
    node.paint(font.paint.color.rgba, opacity)
    if font in n.bold:
      # No bold face to draw it in (an ESP32 has one): the outline, thickened.
      node.paint(font.paint.color.rgba, 1, "stroke")
      node.attrs.add(("stroke-width", num(font.size / 24)))
      node.attrs.add(("stroke-linejoin", "round"))
    drawn.add node

proc emit(n: UiNode, ox, oy, opacity: float32, drawn: var seq[SvgNode], gradients: var int,
    regions: var seq[UiRegion]) =
  template b: untyped = n.box
  let op = opacity * b.opacity
  if b.display == diNone or op <= 0:
    return
  let
    # Whole pixels: boxes that touch share an edge, and fills stay crisp.
    x = round(ox + n.x)
    y = round(oy + n.y)
    w = round(ox + n.x + n.size.x) - x
    h = round(oy + n.y + n.size.y) - y
    cx = x + b.pad[3] + b.border[3]
    cy = y + b.pad[0] + b.border[0]
    cw = w - b.padX
    ch = h - b.padY
  n.emitPaint(x, y, w, h, op, drawn, gradients)
  if n.hover or n.active or n.group or n.handlers != default(array[UiEvent, int]):
    # In paint order: whatever comes later is on top.
    regions.add UiRegion(x: x, y: y, w: w, h: h, key: n.key, handlers: n.handlers,
      hover: n.hover, active: n.active, group: n.group)
  case n.kind
  of ukText:
    n.emitText(cx, cy, cw, op, drawn)
  of ukImage:
    if not n.src.image.isNil and cw > 0 and ch > 0:
      let node = SvgNode(tag: "image", image: n.src.image, attrs: @[("x", num(cx)),
        ("y", num(cy)), ("width", num(cw)), ("height", num(ch)),
        ("preserveAspectRatio", ["none", "xMidYMid meet", "xMidYMid slice"][ord(b.fit)])])
      if op < 1:
        node.attrs.add(("opacity", num(op)))
      drawn.add node
  of ukSvg:
    n.emitSvg(cx, cy, cw, ch, op, drawn)
  of ukBox:
    # In-flow children, then the absolute ones on top, as CSS paints them.
    for pass in [false, true]:
      for c in n.children:
        if c.box.absolute == pass:
          c.emit(x, y, op, drawn, gradients, regions)

proc layoutUi*(root: SvgNode, width, height: int, input: UiInput,
    regions: var seq[UiRegion]): SvgNode =
  ## A UI tree laid out into a `width` x `height` image, as the SVG that
  ## draws it there. The outermost element fills the image unless its own
  ## classes size it. `input` is what the pointer is doing; `regions` gets
  ## the elements it can do something to, for the next event.
  let
    w = width.float32
    h = height.float32
    ui = root.build(initText(), w, h, 0, 0, input, false)
  var
    rw = ui.box.w.resolve(w)
    rh = ui.box.h.resolve(h)
  if rw < 0: rw = w
  if rh < 0: rh = h
  ui.size = ui.layout(rw, rh, true, true)
  ui.x = max(ui.box.margin[3].resolve(w), 0)
  ui.y = max(ui.box.margin[0].resolve(h), 0)
  result = SvgNode(tag: "svg", attrs: @[("width", $width), ("height", $height)])
  var gradients = 0
  ui.emit(0, 0, 1, result.children, gradients, regions)

proc layoutUi*(root: SvgNode, width, height: int): SvgNode =
  var regions: seq[UiRegion]
  layoutUi(root, width, height, UiInput(), regions)

{.pop.}
