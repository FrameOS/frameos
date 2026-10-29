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

import std/[math, strutils, unicode]
import pixie
import pixie/fileformats/svg
import frameos/ui/tailwind
import frameos/ui/keyboard

export keyboard.KeyboardPage

type
  UiKind = enum
    ukBox, ukText, ukImage, ukSvg

  UiEvent* = enum
    ## The handlers an element can have, by the event that runs them; a
    ## field's change and keys (onChange, onKeyDown) come from its edits.
    ueClick = "tap", ueDoubleClick = "doubleTap", ueLongPress = "longPress",
    uePointerDown = "pointerDown", uePointerUp = "pointerUp", uePointerMove = "pointerMove",
    ueSwipe = "swipe", ueChange = "change", ueKeyDown = "keyDown"

  UiRegion* = object
    ## An element the pointer can do something to, where the layout put it:
    ## one with a handler, or with `hover:` / `active:` classes, or a `group`,
    ## a field, or a box that scrolls.
    x*, y*, w*, h*: float32
    visible*: array[4, float32]      ## the part of it no scrolling box cut off: x0, y0, x1, y1
    key*: int                        ## its place in the tree, the same next render
    handlers*: array[UiEvent, int]   ## a handler's number + 1, 0 for none
    hover*, active*, group*: bool
    field*: uint8                    ## 1 an <input>, 2 a <textarea>, 3 a number input
    scrollX*, scrollY*: float32      ## how far a box can scroll each way; 0: not that way
    # Plain values only: regions are copied by the dozen on every layout
    # and every event (a field's text is `fieldText`).

  UiInput* = object
    ## What the pointer was doing when this layout was asked for: the keys of
    ## the elements it is over and of those it is pressing. And the keyboard:
    ## the field it types into, where, and the on-screen keyboard's keys;
    ## how far each box is scrolled.
    hovered*, pressed*: seq[int]
    focus*: int          ## the focused field's key + 1; 0 for none
    caret*: int          ## where in its text the next character goes, in bytes
    text*: string        ## its text as the last layout found it, with the edits since
    place*: bool         ## a tap focused it: the caret goes to placeX, placeY ...
    placeX*, placeY*: float32 ## ... from the field's corner
    keyboard*: bool      ## the on-screen keyboard is up (the frame has none of its own)
    page*: KeyboardPage  ## which keys it shows ...
    shift*: int          ## ... letters in capitals: 1 the next one, 2 all of them
    reveal*: bool        ## scroll the focused field into view at the next layout
    paper*: bool         ## e-paper: the keyboard shows no press
    scrolls*: seq[(int, float32, float32)] ## how far each box that scrolled is, by key

  TextMemo = object
    key: string          ## the runs, their styles, the width and alignment
    arrangement: Arrangement
    bold: seq[Font]      ## its fonts drawn with a stroke (UiNode.bold)
    drawnAt: array[3, float32] ## x, y, opacity `drawn` was emitted for
    drawn: seq[SvgNode]  ## its outlines as emitted there, paths shared

  UiMemo* = ref object
    ## What the last layout of a UI set in type, for the next one (one per
    ## UI, ui/events.nim's target). Text whose runs, style and box did not
    ## change is neither typeset nor outlined again, and it comes back as
    ## the same nodes and paths: pixie compares those by identity, keeps
    ## their bounds and their flattened shapes (paths.share), so an
    ## unchanged label costs a repaint nothing.
    last, kept: seq[TextMemo]
    gen: int             ## this layout's number: a node's `memo` holds for it only
    root: UiNode         ## the last layout's tree, taken back where it did not change
    rootW, rootH: float32
    keyboard: UiNode     ## the on-screen keyboard's, likewise

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
    # The layout before that (a flex item is measured, then placed: two
    # calls, both the same the next time an unchanged item is laid out), and
    # the call the node was asked for last, which its children are placed
    # for before it is emitted (`placed`).
    prevW, prevH: float32
    prevFix: int
    prevSize: Vec2
    asked: (int, float32, float32)
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
    memo: int             ## its arrangement's entry in the memo's `kept` ...
    memoGen: int          ## ... of the layout with this number
    # What it was built from, for the next layout to take it back unbuilt:
    # its element, the style it inherited, whether it was in a hovered
    # group, and its pointer states (`pointer`: it or one below has hover:,
    # active: or group classes, so the pointer can change it).
    inherited: Text
    inGroup, pointer: bool
    states: set[UiState]
    # What it emitted last, and for which place, size, opacity, layout call
    # and first gradient number: the same again is the same nodes again.
    emitted: seq[SvgNode]
    emittedRegions: seq[UiRegion]
    emittedAt: array[7, float32]
    emittedFor: (int, float32, float32)
    emittedGradients: (int, int)
    # What the pointer can do to it (UiRegion).
    key: int
    handlers: array[UiEvent, int]
    hover, active, group: bool
    field: uint8          # an <input> or a <textarea> (UiRegion.field) ...
    value: string         # ... and its text
    keep: bool            # ukText: a field's text, its spaces kept as typed
    maxX, maxY: float32   # a box that clips: how much of it is out of sight ...
    scrollAt: (float32, float32) # ... and how far it was scrolled when built, then emitted

const
  # The attributes the JSX walker turns onClick, onLongPress, ... into.
  handlerAttrs: array[UiEvent, string] = ["on-click", "on-double-click",
    "on-long-press", "on-pointer-down", "on-pointer-up", "on-pointer-move", "on-swipe",
    "on-change", "on-key-down"]
  KeyboardKey = 1 shl 21 ## the on-screen keyboard's root, far from the UI's keys
  Unbounded = 1e9'f32
  MaxDepth = 64

{.push boundChecks: off, overflowChecks: off, rangeChecks: off, raises: [].}

proc scrolled*(input: UiInput, key: int): (float32, float32) =
  ## How far the box at `key` is scrolled: (0, 0) until something scrolls it.
  for (k, x, y) in input.scrolls:
    if k == key:
      return (x, y)

proc scrollTo*(input: var UiInput, key: int, x, y: float32) =
  ## The box at `key` scrolled to (x, y); the next layout keeps it in range.
  for i in 0 ..< input.scrolls.len:
    if input.scrolls[i][0] == key:
      input.scrolls[i] = (key, x, y)
      return
  if x != 0 or y != 0:
    input.scrolls.add((key, x, y))


proc isText(n: SvgNode): bool {.inline.} =
  n.tag.len == 0 or n.tag == "&"

proc isBlank(n: SvgNode): bool =
  ## A text child of white space alone (an entity such as `&nbsp;` is not).
  if n.tag.len != 0:
    return false
  for c in n.text:
    if c notin Whitespace:
      return false
  true

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

proc pointerClasses(classes: string): bool {.inline.} =
  ## Classes the pointer can change: hover:, active:, group and group-hover:;
  ## and focus:, which a tap on a field changes.
  classes.contains("hover:") or classes.contains("active:") or classes.contains("group") or
    classes.contains("focus:")

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
  let classes = n.attr("class")
  if classes.pointerClasses:
    into.pointer = true
  box.applyClasses(text, classes, rootW, rootH, states)
  if box.display != diNone:
    for child in n.children:
      child.addRuns(text, into, rootW, rootH, depth + 1, states)

proc newUiNode(kind: UiKind, text: Text): UiNode =
  UiNode(kind: kind, box: initBox(), text: text, lastFix: -1, prevFix: -1, emittedFor: (-1, 0'f32, 0'f32))

proc sameTree(a, b: SvgNode): bool =
  ## Whether two element trees say the same: the very nodes (a walk that
  ## kept them), or the same tags, text, attributes, pictures and children.
  if a == b:
    return true
  if a.isNil or b.isNil or a.tag != b.tag or a.text != b.text or a.image != b.image or
      a.path != b.path or a.children.len != b.children.len or a.attrs != b.attrs:
    return false
  for i in 0 ..< a.children.len:
    if not sameTree(a.children[i], b.children[i]):
      return false
  true

proc statesOf(n: UiNode, input: UiInput, groupHover: bool): set[UiState] =
  if groupHover: result.incl usGroupHover
  if n.hover and n.key in input.hovered: result.incl usHover
  if n.active and n.key in input.pressed: result.incl usActive
  if n.key == input.focus - 1: result.incl usFocus

proc samePointer(n: UiNode, input: UiInput, groupHover: bool): bool =
  ## Whether the pointer leaves `n` and what is in it as they were built:
  ## the focused field never (its text and caret), and a box that clips
  ## when it scrolled since.
  if not n.pointer:
    return true
  if n.field > 0 and n.key == input.focus - 1:
    return false
  if (n.box.overflowX != ovVisible or n.box.overflowY != ovVisible) and
      input.scrolled(n.key) != n.scrollAt:
    return false
  if n.inGroup != groupHover or (n.kind != ukText and n.statesOf(input, groupHover) != n.states):
    return false
  let childGroup = groupHover or (n.group and n.key in input.hovered)
  for c in n.children:
    if not c.samePointer(input, childGroup):
      return false
  true

proc buildField(result: UiNode, n: SvgNode, text: Text, classes: string, rootW, rootH: float32,
    input: UiInput) =
  ## An <input> or a <textarea>: a box that clips the one run of text it
  ## holds, its `value` (the edits since the last layout while it has the
  ## keyboard and no `value` of its own), dots for a password, else the
  ## placeholder in its `placeholder:` style (half its color without one).
  ## Its spaces are kept as typed, and an empty field is a line tall.
  let kind = n.attr("type")
  result.pointer = true
  result.field = if n.tag == "textarea": 2 elif kind == "number": 3 else: 1
  result.box.overflowX = max(result.box.overflowX, ovHidden)
  result.box.overflowY = max(result.box.overflowY, ovHidden)
  result.scrollAt = input.scrolled(result.key)
  result.value = n.attr("value")
  var controlled = false
  for attr in n.attrs:
    if attr[0] == "value":
      controlled = true
  if result.key == input.focus - 1 and not controlled:
    result.value = input.text
  var
    style = result.text
    shown = result.value
  if kind == "password":
    shown.setLen(0)
    for _ in 0 ..< result.value.runeLen:
      shown.add "\u2022"
  if shown.len == 0:
    shown = n.attr("placeholder")
    var scratch = initBox()
    style = text
    scratch.applyClasses(style, classes, rootW, rootH, result.states + {usPlaceholder})
    if style.color == result.text.color:
      style.color.a = style.color.a div 2
  if shown.len == 0 or shown[^1] == '\n':
    shown.add ' ' # a line to measure, and to put the caret on
  if result.field != 2:
    # One line, centered in the field's height as a browser centers it.
    style.nowrap = true
    result.box.display = diFlex
    result.box.items = alCenter
  let run = newUiNode(ukText, style)
  run.box.grow = 1
  run.keep = true
  run.runs.add SvgNode(tag: "&", text: shown)
  run.styles.add style
  result.children.add run

proc build(n: SvgNode, inherited: Text, rootW, rootH: float32, depth: int,
    key: int, input: UiInput, groupHover: bool, prev: UiNode): UiNode =
  ## `n` as a node to lay out. `prev`, the node the last layout built at this
  ## place, is taken back as it is, laid out and emitted, when nothing it was
  ## built from changed: React's diff, without its API.
  # The focused field is built again every time: its text can be the edits
  # since, and its caret moves.
  if not prev.isNil and prev.kind != ukText and prev.key == key and prev.inherited == inherited and
      sameTree(prev.src, n) and prev.samePointer(input, groupHover) and
      (prev.field == 0 or key != input.focus - 1):
    return prev
  var text = inherited
  tagStyle(n.tag, text)
  result = newUiNode(ukBox, text)
  let classes = n.attr("class")
  result.src = n
  result.inherited = inherited
  result.inGroup = groupHover
  result.pointer = classes.pointerClasses
  result.key = key
  result.hover = classes.variant("hover")
  result.active = classes.variant("active")
  result.group = classes.hasClass("group")
  for event in UiEvent:
    var id: float32
    # onInput is a field's onChange by another name, as in React.
    let value = n.attr(if event == ueChange and n.attr("on-input").len > 0: "on-input" else: handlerAttrs[event])
    if value.len > 0 and number(value, 0, value.len, id):
      result.handlers[event] = int(id) + 1
  var states: set[UiState]
  if groupHover: states.incl usGroupHover
  if result.hover and key in input.hovered: states.incl usHover
  if result.active and key in input.pressed: states.incl usActive
  if key == input.focus - 1: states.incl usFocus
  result.states = states
  result.box.applyClasses(result.text, classes, rootW, rootH, states)
  if result.box.overflowX != ovVisible or result.box.overflowY != ovVisible:
    result.pointer = true # a scroll builds it again (samePointer)
    result.scrollAt = input.scrolled(key)
  # A hovered `group` lights its descendants' group-hover: classes.
  let childGroup = groupHover or (result.group and key in input.hovered)
  if n.tag == "img" or n.tag == "svg":
    result.kind = if n.tag == "img": ukImage else: ukSvg
    return
  if n.tag == "input" or n.tag == "textarea":
    result.buildField(n, text, classes, rootW, rootH, input)
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
      # White space that starts no text, as between two items (`<A/> <B/>`
      # on one line) or before a block, is nothing: CSS makes no flex or
      # grid item of it and no line.
      if run.isNil and child.isBlank:
        continue
      if run.isNil:
        run = newUiNode(ukText, result.text)
        run.inGroup = childGroup
        result.children.add run
      child.addRuns(result.text, run, rootW, rootH, depth + 1, inlineStates)
      if run.pointer:
        result.pointer = true
    else:
      run = nil
      let childKey = key * 31 + i + 1
      var before: UiNode
      if not prev.isNil:
        for c in prev.children:
          if c.kind != ukText and c.key == childKey:
            before = c
            break
      let built = child.build(result.text, rootW, rootH, depth + 1, childKey, input, childGroup, before)
      if built.pointer:
        result.pointer = true
      result.children.add built

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
  if n.spans.len > 0 and n.spans[^1].text.endsWith(' ') and not n.keep:
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

var
  memo {.threadvar.}: UiMemo ## the layout's, while layoutUi runs
  ui {.threadvar.}: ptr UiInput ## and the input it was asked for
  focusSeen {.threadvar.}: bool ## the focused field was laid out

template scrollOf(key: int): (float32, float32) = ui[].scrolled(key)
template setScroll(key: int, x, y: float32) = ui[].scrollTo(key, x, y)

proc textKey(n: UiNode, width: float32, align: HorizontalAlignment): string =
  template addBytes(v: untyped) =
    let at = result.len
    result.setLen(at + sizeof(v))
    copyMem(addr result[at], unsafeAddr v, sizeof(v))
  for i in 0 ..< n.runs.len:
    result.add n.runs[i].tag
    result.add '\0'
    result.add n.runs[i].text
    result.add '\0'
    addBytes(n.styles[i])
  addBytes(width)
  addBytes(align)

proc recall(key: string): int =
  ## The memo entry for `key`, moved to the entries this layout keeps; -1.
  for i in 0 ..< memo.kept.len:
    if memo.kept[i].key == key:
      return i
  for i in 0 ..< memo.last.len:
    if memo.last[i].key == key:
      memo.kept.add move(memo.last[i])
      memo.last.del(i)
      return memo.kept.high
  -1

proc arrange(n: UiNode, width: float32, align: HorizontalAlignment): Arrangement =
  ## The text set into `width`, wrapped unless `whitespace-nowrap`, and cut
  ## with an ellipsis after `lines` lines (truncate, line-clamp-N).
  if not n.arrangement.isNil and n.arrangedW == width and n.arrangedAlign == align:
    return n.arrangement
  var key: string
  n.memo = -1
  if not memo.isNil:
    key = n.textKey(width, align)
    n.memo = recall(key)
    n.memoGen = memo.gen
    if n.memo >= 0:
      n.arrangement = memo.kept[n.memo].arrangement
      n.bold = memo.kept[n.memo].bold
      n.arrangedW = width
      n.arrangedAlign = align
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
  if not memo.isNil:
    memo.kept.add TextMemo(key: move(key), arrangement: result, bold: n.bold, drawnAt: [-1'f32, 0, 0])
    n.memo = memo.kept.high
    n.memoGen = memo.gen

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

proc layout(n: UiNode, w, h: float32, fixW, fixH: bool, force = false): Vec2 {.raises: [].}

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

proc layout(n: UiNode, w, h: float32, fixW, fixH: bool, force = false): Vec2 =
  ## `n`'s border-box size: `w` x `h` where fixed, else the room it may take
  ## at most, sized to its content. Lays its children out on the way.
  let key = int(fixW) or (int(fixH) shl 1)
  n.asked = (key, w, h)
  if not force:
    if n.lastFix == key and n.lastW == w and n.lastH == h:
      return n.lastSize
    if n.prevFix == key and n.prevW == w and n.prevH == h:
      return n.prevSize # its children are placed for it before it is emitted
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
    # A box that scrolls lays its children out at their own heights, however
    # tall (nothing shrinks to fit it), and is no taller than it may be.
    let
      clipsY = b.overflowY == ovScroll
      innerW = max(w - px, 0)
      innerH = if h >= Unbounded or clipsY: Unbounded else: max(h - py, 0)
    content = n.layoutFlex(innerW, innerH, fixW, fixH and not clipsY)
    if clipsY and not fixH and h < Unbounded:
      content.y = min(content.y, max(h - py, 0))
  result.x = if fixW: w else: min(content.x + px, max(w, 0))
  result.y = if fixH: h else: content.y + py
  if n.kind == ukBox and b.aspect > 0 and fixW != fixH:
    if fixW: result.y = result.x / b.aspect
    else: result.x = result.y * b.aspect
  if n.kind == ukBox:
    n.layoutAbsolute(result)
    if b.overflowX != ovVisible or b.overflowY != ovVisible:
      # How much of what it holds is out of sight, its padding included.
      var right, bottom = 0'f32
      for c in n.children:
        if c.box.display != diNone:
          right = max(right, c.x + c.size.x)
          bottom = max(bottom, c.y + c.size.y)
      n.maxX = max(right + b.pad[1] + b.border[1] - result.x, 0)
      n.maxY = max(bottom + b.pad[2] + b.border[2] - result.y, 0)
  n.prevW = n.lastW
  n.prevH = n.lastH
  n.prevFix = n.lastFix
  n.prevSize = n.lastSize
  n.lastW = w
  n.lastH = h
  n.lastFix = key
  n.lastSize = result

proc placed(n: UiNode) =
  ## The children placed for the call `n` was asked for last: a call the
  ## layout before the last answered (`prev`) left them where the last put
  ## them.
  if n.kind == ukBox and n.asked != (n.lastFix, n.lastW, n.lastH):
    let (key, w, h) = n.asked
    discard n.layout(w, h, (key and 1) != 0, (key and 2) != 0, force = true)

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

proc nums(values: openArray[float32]): string =
  ## Numbers for an attribute that lists them (a viewBox, a translate):
  ## one append each, not a string made and copied per `&`.
  for i, v in values:
    if i > 0:
      result.add ' '
    result.add num(v)

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

proc recolored(n: SvgNode, color: string): SvgNode =
  ## `currentColor` in an icon as the text color, as in a browser: `n`
  ## itself when nothing in it says currentColor, else a copy. The app's
  ## nodes are never changed: a later layout may take them back.
  result = n
  for i in 0 ..< n.attrs.len:
    if n.attrs[i][1] == "currentColor":
      if result == n:
        result = SvgNode(tag: n.tag, text: n.text, attrs: n.attrs, children: n.children,
          image: n.image, path: n.path)
      result.attrs[i][1] = color
  for i in 0 ..< n.children.len:
    let child = n.children[i].recolored(color)
    if child != n.children[i]:
      if result == n:
        result = SvgNode(tag: n.tag, text: n.text, attrs: n.attrs, children: n.children,
          image: n.image, path: n.path)
      result.children[i] = child

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
  var transform = "translate("
  transform.add nums([tx, ty])
  transform.add ") scale("
  transform.add nums([sx, sy])
  transform.add ')'
  group.attrs.add(("transform", transform))
  if opacity < 1:
    group.attrs.add(("opacity", num(opacity)))
  group.children = n.src.children
  drawn.add group.recolored(n.text.color.hex)

proc emitText(n: UiNode, x, y, w, opacity: float32, drawn: var seq[SvgNode]) =
  let arrangement = n.arrange(w, n.text.align)
  if arrangement.runes.len == 0:
    return
  let
    at = [x, y, opacity]
    remembered = not memo.isNil and n.memo >= 0 and n.memoGen == memo.gen
  if remembered and memo.kept[n.memo].drawnAt == at:
    for node in memo.kept[n.memo].drawn:
      drawn.add node
    return
  let first = drawn.len
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
  if remembered:
    template entry: untyped = memo.kept[n.memo]
    entry.drawnAt = at
    entry.drawn = drawn[first .. ^1]
    for node in entry.drawn:
      node.path.share() # never changed again: its bounds and shapes are kept

proc caretAt(arrangement: Arrangement, x, y: float32): int =
  ## The rune a tap at (x, y) in the text puts the caret before: the nearest
  ## edge of a glyph on the line under it.
  var best = Unbounded
  for i in 0 .. arrangement.runes.len:
    let r =
      if i < arrangement.runes.len: arrangement.selectionRects[i]
      else: arrangement.selectionRects[^1]
    let
      edge = if i < arrangement.runes.len: r.x else: r.x + r.w
      off = if y < r.y: r.y - y elif y > r.y + r.h: y - r.y - r.h else: 0
      d = abs(x - edge) + off * 1000
    if d < best:
      best = d
      result = i

proc runeOffset(text: string, rune: int): int =
  ## The byte where rune number `rune` starts (the length past the last).
  var n = 0
  while result < text.len and n < rune:
    inc result
    while result < text.len and (ord(text[result]) and 0xC0) == 0x80:
      inc result
    inc n

proc emitField(n: UiNode, x, y, w, h: float32, sx, sy: var float32): array[4, float32] =
  ## The focused field's caret, where it is in the text: placed where a tap
  ## landed, and the field scrolled so it shows. Its box, unscrolled.
  template b: untyped = n.box
  let t = n.children[0] # the field's one run of text
  let
    tx = round(x + t.x)
    ty = round(y + t.y)
    arrangement = t.arrange(round(x + t.x + t.size.x) - tx, t.text.align)
  if arrangement.runes.len == 0:
    return
  if ui.place:
    ui.place = false
    ui.caret = n.value.runeOffset(arrangement.caretAt(ui.placeX - (tx - x) + sx, ui.placeY - (ty - y) + sy))
  ui.caret = clamp(ui.caret, 0, n.value.len)
  let
    i = min(n.value.toOpenArray(0, ui.caret - 1).runeLen, arrangement.runes.len)
    r = arrangement.selectionRects[min(i, arrangement.runes.high)]
    cw = max(1'f32, round(t.text.size / 16))
  result = [tx + (if i < arrangement.runes.len: r.x else: r.x + r.w), ty + r.y, cw, r.h]
  # In sight: inside the content box, the caret's width to spare.
  let
    left = x + b.border[3] + b.pad[3]
    right = x + w - b.border[1] - b.pad[1] - cw
    top = y + b.border[0] + b.pad[0]
    bottom = y + h - b.border[2] - b.pad[2]
  if result[0] - sx > right: sx = result[0] - right
  if result[0] - sx < left: sx = max(result[0] - left, 0)
  if result[1] + r.h - sy > bottom: sy = result[1] + r.h - bottom
  if result[1] - sy < top: sy = max(result[1] - top, 0)

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
    clips = n.kind == ukBox and (b.overflowX != ovVisible or b.overflowY != ovVisible)
  n.placed()
  # How far a box that clips is scrolled; a focused field, so its caret shows.
  var
    (sx, sy) = scrollOf(n.key)
    caret: array[4, float32]
  if clips:
    sx = clamp(sx, 0, n.maxX)
    sy = clamp(sy, 0, n.maxY)
    if n.field > 0 and n.key == ui.focus - 1 and n.children.len > 0:
      focusSeen = true
      caret = n.emitField(x, y, w, h, sx, sy)
    elif n.field > 0:
      # A field that lets go of the keyboard shows its text from the start.
      sx = 0
      sy = 0
    setScroll(n.key, sx, sy)
    n.scrollAt = (sx, sy)
  let
    at = [x, y, w, h, op, sx, sy]
    call = (n.lastFix, n.lastW, n.lastH)
  if n.kind == ukBox and n.emittedAt == at and n.emittedFor == call and n.emittedGradients[0] == gradients:
    # Taken back unchanged (build), laid out by the same call and placed
    # where it was: what it emitted then, the same nodes for pixie to keep.
    for node in n.emitted:
      drawn.add node
    for region in n.emittedRegions:
      regions.add region
    gradients += n.emittedGradients[1]
    return
  let
    first = drawn.len
    firstRegion = regions.len
    firstGradient = gradients
    scrolls = b.overflowX == ovScroll and n.maxX > 0 or b.overflowY == ovScroll and n.maxY > 0
  n.emitPaint(x, y, w, h, op, drawn, gradients)
  if n.hover or n.active or n.group or n.handlers != default(array[UiEvent, int]) or
      n.field > 0 or scrolls:
    # In paint order: whatever comes later is on top.
    regions.add UiRegion(x: x, y: y, w: w, h: h, visible: [x, y, x + w, y + h], key: n.key,
      handlers: n.handlers, hover: n.hover, active: n.active, group: n.group, field: n.field,
      scrollX: (if b.overflowX == ovScroll: n.maxX else: 0),
      scrollY: (if b.overflowY == ovScroll: n.maxY else: 0))
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
    # In-flow children, then the absolute ones on top, as CSS paints them;
    # in a box that clips, inside a viewport of its padding box that its
    # scroll moves them in (pixie's nested <svg>).
    let
      vx = x + b.border[3]
      vy = y + b.border[0]
      vw = w - b.border[1] - b.border[3]
      vh = h - b.border[0] - b.border[2]
      kids = regions.len
    var view: SvgNode
    if clips:
      if vw <= 0 or vh <= 0:
        return
      view = SvgNode(tag: "svg", attrs: @[("x", num(vx)), ("y", num(vy)), ("width", num(vw)),
        ("height", num(vh)), ("viewBox", nums([vx + sx, vy + sy, vw, vh]))])
    for pass in [false, true]:
      for c in n.children:
        if c.box.absolute == pass:
          if clips: c.emit(x, y, op, view.children, gradients, regions)
          else: c.emit(x, y, op, drawn, gradients, regions)
    if clips:
      if caret[2] > 0:
        let bar = SvgNode(tag: "rect", attrs: @[("x", num(caret[0])), ("y", num(caret[1])),
          ("width", num(caret[2])), ("height", num(caret[3]))])
        bar.paint(n.text.color, op)
        view.children.add bar
      drawn.add view
      # What is inside answers the pointer where it shows, scrolled.
      var k = kids
      for i in kids ..< regions.len:
        var r = regions[i]
        r.x -= sx
        r.y -= sy
        r.visible = [max(r.visible[0] - sx, vx), max(r.visible[1] - sy, vy),
          min(r.visible[2] - sx, vx + vw), min(r.visible[3] - sy, vy + vh)]
        if r.visible[2] > r.visible[0] and r.visible[3] > r.visible[1]:
          regions[k] = r
          inc k
      regions.setLen(k)
      if b.overflowY == ovScroll and n.maxY > 0:
        # Where in what it holds it shows: a thin bar at its right edge.
        let
          barH = max(vh * vh / (vh + n.maxY), min(vh, 16))
          bar = SvgNode(tag: "path", path: newPath())
        bar.path.roundedRect(vx + vw - 5, vy + (vh - barH) * sy / n.maxY, 3, barH, 1.5, 1.5, 1.5, 1.5)
        bar.paint(n.text.color, op * 0.35)
        drawn.add bar
    n.emitted = drawn[first .. ^1]
    n.emittedRegions = regions[firstRegion .. ^1]
    n.emittedAt = at
    n.emittedFor = call
    n.emittedGradients = (firstGradient, gradients - firstGradient)

proc reveal(n: UiNode, key: int, r: var array[4, float32]): bool =
  ## Whether the field at `key` is in `n`: then `r` is its box from n's
  ## corner as n shows it, every box on the way that scrolls scrolled so it
  ## is in sight, a little room around it.
  if n.key == key and n.field > 0:
    r = [0'f32, 0, n.size.x, n.size.y]
    return true
  if n.kind != ukBox:
    return false
  for c in n.children:
    if c.reveal(key, r):
      template b: untyped = n.box
      r[0] += c.x
      r[1] += c.y
      if b.overflowX == ovScroll or b.overflowY == ovScroll:
        var (sx, sy) = scrollOf(n.key)
        const room = 8'f32
        if b.overflowY == ovScroll:
          if r[1] + r[3] - sy > n.size.y - b.border[2]: sy = r[1] + r[3] - n.size.y + b.border[2] + room
          if r[1] - sy < b.border[0]: sy = r[1] - b.border[0] - room
          sy = clamp(sy, 0, n.maxY)
        if b.overflowX == ovScroll:
          if r[0] + r[2] - sx > n.size.x - b.border[1]: sx = r[0] + r[2] - n.size.x + b.border[1] + room
          if r[0] - sx < b.border[3]: sx = r[0] - b.border[3] - room
          sx = clamp(sx, 0, n.maxX)
        setScroll(n.key, sx, sy)
        r[0] -= sx
        r[1] -= sy
      return true
  false

proc fieldIn(n: UiNode, key: int): UiNode =
  if n.isNil or n.key == key:
    return n
  for c in n.children:
    result = c.fieldIn(key)
    if not result.isNil:
      return

proc fieldText*(memo: UiMemo, key: int): string =
  ## The text the last layout gave the field at `key` ("" for none).
  if not memo.isNil:
    let n = memo.root.fieldIn(key)
    if not n.isNil:
      result = n.value

proc layoutUi*(root: SvgNode, width, height: int, input: var UiInput,
    regions: var seq[UiRegion], textMemo: UiMemo = nil): SvgNode =
  ## A UI tree laid out into a `width` x `height` image, as the SVG that
  ## draws it there. The outermost element fills the image unless its own
  ## classes size it. `input` is what the pointer is doing; `regions` gets
  ## the elements it can do something to, for the next event. With the
  ## on-screen keyboard up (`input.keyboard`), the UI is laid out above it,
  ## its focused field scrolled into sight, and the keyboard drawn below.
  memo = textMemo
  ui = addr input
  focusSeen = false
  let
    kb = if input.keyboard and input.focus > 0: keyboardHeight(height) else: 0
    w = width.float32
    h = float32(height - kb)
  var before: UiNode
  if not memo.isNil:
    inc memo.gen
    if memo.rootW == w and memo.rootH == h:
      before = memo.root
  let top = root.build(initText(), w, h, 0, 0, input, false, before)
  var
    rw = top.box.w.resolve(w)
    rh = top.box.h.resolve(h)
  if rw < 0: rw = w
  if rh < 0: rh = h
  top.size = top.layout(rw, rh, true, true)
  top.x = max(top.box.margin[3].resolve(w), 0)
  top.y = max(top.box.margin[0].resolve(h), 0)
  if input.reveal and input.focus > 0:
    var r: array[4, float32]
    discard top.reveal(input.focus - 1, r)
  input.reveal = false
  result = SvgNode(tag: "svg", attrs: @[("width", $width), ("height", $height)])
  if kb > 0 and top.box.bg.a == 255 and top.box.gradient == 0:
    # The UI's page under the keyboard too: an opaque first paint over the
    # whole image, so a key repaints only what it changed.
    let page = SvgNode(tag: "rect", attrs: @[("width", $width), ("height", $height)])
    page.paint(top.box.bg, 1)
    result.children.add page
  var gradients = 0
  top.emit(0, 0, 1, result.children, gradients, regions)
  if kb > 0:
    let keys = keyboardTree(width, kb, input.page, input.shift, input.paper).build(initText(),
      w, kb.float32, 0, KeyboardKey, input, false, if memo.isNil: nil else: memo.keyboard)
    keys.size = keys.layout(w, kb.float32, true, true)
    keys.y = h
    keys.emit(0, 0, 1, result.children, gradients, regions)
    if not memo.isNil:
      memo.keyboard = keys
  if input.focus > 0 and not focusSeen:
    # The field is gone: nothing has the keyboard.
    input.focus = 0
    input.keyboard = false
  if not memo.isNil:
    memo.last = move(memo.kept) # what this layout did not use is let go
    memo.root = top
    memo.rootW = w
    memo.rootH = h
    memo = nil
  ui = nil

proc layoutUi*(root: SvgNode, width, height: int): SvgNode =
  var
    regions: seq[UiRegion]
    input: UiInput
  layoutUi(root, width, height, input, regions)

{.pop.}
