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

import std/[hashes, math, strutils, tables, unicode]
import pixie
import pixie/fileformats/svg
import frameos/events_gen
import frameos/ui/tailwind
import frameos/ui/keyboard
import frameos/ui/tree
import frameos/render_probe
from frameos/utils/memory import waitingTextDrops
import frameos/utils/qr
when not defined(frameosEmbedded):
  import frameos/panel_shape
  from frameos/cursor_shape import csPointer, cursorCode

export keyboard.KeyboardPage

const MaxHoles* = 8
  ## Past this many a `<Scene>` is a picture, as one that cannot be a hole is.

type
  UiKind = enum
    ukBox, ukText, ukImage, ukSvg

  UiEvent* = enum
    ## The handlers an element can have, by the event that runs them; a
    ## field's change and keys (onChange, onKeyDown) come from its edits.
    ueClick = "tap", ueDoubleClick = "doubleTap", ueLongPress = "longPress",
    uePointerDown = "pointerDown", uePointerUp = "pointerUp", uePointerMove = "pointerMove",
    ueSwipe = "swipe", uePinch = "pinch", ueChange = "change", ueKeyDown = "keyDown",
    ueScroll = "scroll"

  UiRegion* = object
    ## An element the pointer can do something to, where the layout put it:
    ## one with a handler, or with `hover:` / `active:` classes, or a `group`,
    ## a field, or a box that scrolls.
    x*, y*, w*, h*: float32
    visible*: array[4, float32]      ## the part of it no scrolling box cut off: x0, y0, x1, y1
    key*: int                        ## its place in the tree, the same next render
    handlers*: array[UiEvent, int]   ## a handler's number + 1, 0 for none
    hover*, active*, group*: bool
    field*: uint8                    ## 1 an <input>, 2 a <textarea>, 3 a number input, 4 a <select>
    scrollX*, scrollY*: float32      ## how far a box can scroll each way; 0: not that way
    scene*: bool
      ## Not an element but a `<Scene>` or `<yield />`, where it is in paint
      ## order: whatever is in a region after it is drawn over the scene and
      ## takes the pointer there (ui/events.uiOverScene).
    when not defined(frameosEmbedded):
      cursor*: uint8       ## its `cursor-*` class (tailwind.nim Box.cursor); 0 for none
      cursorBand*: float32 ## ... `cursor-resize`'s edge, in the UI's pixels
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
    sel*: int            ## the selection's other end (its anchor) + 1: the text between it and
                         ## the caret is selected (`selected`); 0 for none
    anchor*: bool        ## a drag selects: the next layout puts `sel` at anchorX, anchorY ...
    anchorX*, anchorY*: float32 ## ... from the field's corner, as `place` puts the caret
    secret*: bool        ## the focused field is a password's, as the last layout found it: never copied
    word*: bool          ## the caret's next placing selects the word there (a long press, a double tap)
    handles*: bool       ## the selection was made by touch: handles at its ends to drag ...
    menu*: bool          ## ... and its menu over it (Cut, Copy, Paste, Select all)
    text*: string        ## its text as the last layout found it, with the edits since
    place*: bool         ## a tap focused it: the caret goes to placeX, placeY ...
    placeX*, placeY*: float32 ## ... from the field's corner
    keyboard*: bool      ## the on-screen keyboard is up (the frame has none of its own)
    page*: KeyboardPage  ## which keys it shows ...
    shift*: int          ## ... letters in capitals: 1 the next one, 2 all of them
    accents*: int        ## the key whose accents show above it (its byte); 0 for none
    accentX*: float32    ## ... the x of the finger that holds it: the accent nearest lights, < 0 none
    accentFrom*: float32 ## ... and where it held: a letter's row lights by how far it went from there
    accentLit*: int      ## ... which one the last layout lit, -1 for none
    flash*: int          ## a key just typed (its byte), drawn lit for a moment after the press; 0 none
    flashDrawn*: bool    ## ... and a layout has drawn it so
    reveal*: bool        ## scroll the focused field into view at the next layout
    slow*: bool          ## a change costs a refresh (panel_shape.panelIsFast): no press shows
    paper*: bool         ## the panel draws in inks: the keyboard's and a select's look
    round*: bool         ## a round panel's whole canvas: the keyboard stays inside its circle
    scrolls*: seq[(int, float32, float32)] ## how far each box that scrolled is, by key
    lineStep*: int       ## a key moved the caret a line up (-1) or down (1): the next layout knows the lines ...
    goalX*: float32      ## ... and keeps the x it set out from across the lines it walks, while `goal`
    goal*: bool
    open*: int           ## the <select> whose list is up: its key + 1; 0 for none
    fresh*: bool         ## it just opened: the next layout scrolls to what it holds
    link*: string        ## the link whose QR code is up over the UI ("Links"); "" for none

  TextMemo = object
    key: string          ## the runs, their styles, the width and alignment
    arrangement: Arrangement
    bold: seq[Font]      ## its fonts drawn with a stroke (UiNode.bold)
    drawnAt: array[3, float32] ## x, y, opacity `drawn` was emitted for
    drawn: seq[SvgNode]  ## its outlines as emitted there, paths shared

  UiHole* = object
    ## A `<Scene>` or `<yield />` (seekHoles), in the UI's pixels, and in the
    ## canvas's (left to bottom, for whoever knows the scale).
    clean*: bool
    x*, y*, w*, h*: float32
    left*, top*, right*, bottom*: int32

  UiHoles* = object
    count*: int
    firstYield: int ## its place + 1
    items*: array[MaxHoles, UiHole]

  UiMemo* = ref object
    ## What the last layout of a UI set in type, for the next one (one per
    ## UI, ui/events.nim's target). Text whose runs, style and box did not
    ## change is neither typeset nor outlined again, and it comes back as
    ## the same nodes and paths: pixie compares those by identity, keeps
    ## their bounds and their flattened shapes (paths.share), so an
    ## unchanged label costs a repaint nothing.
    last, kept: seq[TextMemo]
    older: seq[TextMemo]
      ## What the layouts before the last used and the last did not, newest
      ## first, TextMemoWaitingBytes at most: a toggle goes back and forth
      ## between two texts ("0 of 2 on", "1 of 2 on"), and each was typeset
      ## again on every tap (~10 ms of a Home sample's tap on an ESP32).
    olderDropped: int    ## the utils/memory waitingTextDrops its `older` last went at
    gen: int             ## this layout's number: a node's `memo` holds for it only
    root: UiNode         ## the last layout's tree, taken back where it did not change
    rootW, rootH: float32
    keyboard: UiNode     ## the on-screen keyboard's, likewise
    popup: UiNode        ## an open <select>'s list, likewise
    accents: UiNode      ## a held key's accents, likewise
    menu: UiNode         ## a selection's menu, likewise

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
    base, least: float32  # its flex base size, and the least its main size may be
    frozen: bool          # ... while the free space is shared out (layoutFlex)
    holds: bool           # it is or holds a <Scene> / <yield />: it takes the room it gets
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
    emittedOver: ColorRGBA  ## the backdrop its emit pre-blended against
    emittedFor: (int, float32, float32)
    emittedGradients: (int, int)
    # What the pointer can do to it (UiRegion).
    key: int
    handlers: array[UiEvent, int]
    hover, active, group: bool
    field: uint8          # an <input>, a <textarea> or a <select> (UiRegion.field) ...
    value: string         # ... and its text
    keep: bool            # ukText: a field's text, its spaces kept as typed
    maxX, maxY: float32   # a box that clips: how much of it is out of sight ...
    scrollAt: (float32, float32) # ... and how far it was scrolled when built, then emitted

const
  OptionBase* = KeyBase + 512
    ## An open <select>'s list: this handler + n for its option number n.
    ## Above every key of the keyboard.
  # The attributes the JSX walker turns onClick, onLongPress, ... into.
  handlerAttrs: array[UiEvent, string] = ["on-click", "on-double-click",
    "on-long-press", "on-pointer-down", "on-pointer-up", "on-pointer-move", "on-swipe",
    "on-pinch", "on-change", "on-key-down", "on-scroll"]
  LinkOpen* = KeyBase div 2
    ## The tap handler of a link (`<a href>`, "Links" in docs/jsx-ui.md): its
    ## QR code goes up over the UI. Past every handler a tree can hold.
  LinkClose* = LinkOpen + 1 ## the QR code's: it goes away
  LinkCloseAttr = $LinkClose
  MaxLink = 1024 ## a longer href is no link: its QR code would be too dense to scan
  KeyboardKey = 1 shl 21 ## the on-screen keyboard's root, far from the UI's keys
  LinkKey = 1 shl 24     ## a link's QR code, likewise
  PopupKey = 1 shl 22    ## an open <select>'s list, likewise
  AccentKey = 1 shl 23   ## a held key's accents, likewise
  EndsKey = 1 shl 25     ## where a selection made by touch starts and ends (+ 1), as its field shows them
  MenuKey = 1 shl 26     ## its menu
  Unbounded = 1e9'f32
  MaxDepth = 64

{.push boundChecks: off, overflowChecks: off, rangeChecks: off, raises: [].}

func scheme(name: string): uint64 =
  for c in name: result = result shl 8 or uint64(ord(c))

proc isLink*(href: string): bool =
  ## Whether an `<a href>` opens: http(s)://, mailto: and tel: only (never
  ## `javascript:`), no control characters, at most MaxLink bytes. The scheme
  ## is read into a number, lowercased, and compared with four: no copy of the
  ## href, no string compares (flash on an ESP32).
  if href.len > MaxLink:
    return false
  var
    name = 0'u64
    colon = -1
  for i, c in href:
    if c < ' ' or c == '\x7f':
      return false
    if colon < 0:
      if c == ':': colon = i
      elif i == 6: return false # longer than any scheme here
      else: name = name shl 8 or uint64(ord(c) or 0x20)
  case name
  of scheme("http"), scheme("https"):
    colon + 2 < href.len and href[colon + 1] == '/' and href[colon + 2] == '/'
  of scheme("mailto"), scheme("tel"):
    true
  else:
    false

proc links(n: SvgNode): bool {.noinline.} =
  ## An `<a>` that opens its href on a tap: one with an onClick of its own
  ## does what that says instead.
  n.tag == "a" and n.attr("on-click").len == 0 and n.attr("href").isLink

const MaxClipboard = when defined(frameosEmbedded): 4096 else: 65536
  ## The most a copy keeps, in bytes (cut at a character).

var clipboard {.threadvar.}: string
  ## What Copy and Cut took, for Paste: the frame's own, every UI's.

when not defined(frameosEmbedded):
  var clipboardChanges {.threadvar.}: int
    ## How many times it was set: a host with a clipboard of its own (the
    ## browser's preview) hands it on when this moves. No such host on an
    ## ESP32: not in the firmware.

  proc uiClipboardChanges*(): int =
    ## Counts every `setUiClipboard`.
    clipboardChanges

proc uiClipboard*(): string =
  ## The frame's clipboard (a host with one of its own, the browser's
  ## preview, mirrors it).
  clipboard

proc setUiClipboard*(text: string) =
  ## Copy and Cut; and a host's own clipboard handed to the frame for Paste.
  clipboard = text
  when not defined(frameosEmbedded):
    inc clipboardChanges
  if clipboard.len > MaxClipboard:
    var cut = MaxClipboard
    while cut > 0 and (ord(clipboard[cut]) and 0xC0) == 0x80:
      dec cut
    clipboard.setLen(cut)

proc selected*(input: UiInput): (int, int) =
  ## The bytes of the focused field's text that are selected, from and to;
  ## the two are the caret for none.
  let caret = clamp(input.caret, 0, input.text.len)
  result = (caret, caret)
  if input.sel > 0:
    let other = clamp(input.sel - 1, 0, input.text.len)
    result = (min(other, caret), max(other, caret))

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

var
  memo {.threadvar.}: UiMemo ## the layout's, while layoutUi runs
  ui {.threadvar.}: ptr UiInput ## and the input it was asked for
  focusSeen {.threadvar.}: bool ## the focused field was laid out
  revealCaret {.threadvar.}: bool ## and is scrolled to show its caret (an edit, a key, a tap)
  revealLine {.threadvar.}: array[2, float32] ## reveal(): the caret's line in the field, y and height
  ends {.threadvar.}: array[2, array[4, float32]] ## a selection made by touch: its start and end
                                                  ## (x, y, -, line height), as emitField found them ...
  endsFound {.threadvar.}: bool                   ## ... when it did

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
  if result.key == input.focus - 1:
    if not controlled:
      result.value = input.text
    elif result.value != input.text and not ui.isNil:
      # What the app made of the edit is what the next edit starts from, as
      # in React: a line emptied on Enter (the Terminal), a length kept. The
      # caret (and a selection) stays on its text when what is before it, or
      # what is after it, is unchanged (lines added above or below, as a code
      # editor's window of lines slides); otherwise it goes to the end.
      template old: untyped = ui.text
      template now: untyped = result.value
      let
        c = clamp(ui.caret, 0, old.len)
        o = if ui.sel > 0: clamp(ui.sel - 1, 0, old.len) else: c
      var same = 0
      while same < max(c, o) and same < now.len and old[same] == now[same]: inc same
      var shift = 0
      if same < max(c, o):
        var tail = 0
        let need = old.len - min(c, o)
        while tail < need and tail < now.len and old[old.len - 1 - tail] == now[now.len - 1 - tail]: inc tail
        shift = if tail == need: now.len - old.len else: int.high
      if shift == int.high:
        ui.caret = now.len
        ui.sel = 0
      else:
        ui.caret = c + shift
        if ui.sel > 0: ui.sel = o + shift + 1
      ui.text = result.value
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
  if shown.startsWith(result.value) and result.value.len > 0 and n.children.len > 0:
    # Its value in colors: the `<span>`s inside it, whose text is the value
    # (a code editor's tokens), each run in the style it was written in. What
    # does not spell the value (an edit the app has not seen yet) is one run.
    for child in n.children:
      child.addRuns(style, run, rootW, rootH, 1, result.states)
    var at = 0
    for i in 0 ..< run.runs.len:
      let t = run.runs[i].text
      if run.runs[i].tag == "br" or not result.value.continuesWith(t, at):
        at = -1
        break
      run.runs[i] = SvgNode(tag: "&", text: t) # its spaces kept as typed
      at += t.len
    if at != result.value.len:
      run.runs.setLen(0)
      run.styles.setLen(0)
    elif shown.len > at:
      run.runs.add SvgNode(tag: "&", text: " ")
      run.styles.add style
  if run.runs.len == 0:
    run.runs.add SvgNode(tag: "&", text: shown)
    run.styles.add style
  result.children.add run

proc heldOption(n: SvgNode): int =
  ## Which of a <select>'s options (any child) has its `value`; -1 for none.
  let value = n.attr("value")
  for i in 0 ..< n.children.len:
    if n.children[i].attr("value") == value:
      return i
  -1

proc selectRow(n: SvgNode): SvgNode =
  ## A <select> closed, as a box to lay out: its attributes, and in it what
  ## the option it holds shows, else its `placeholder` at half strength, cut
  ## to fit, and a chevron (`build` sizes it). The list is another tree
  ## (`popup`).
  let held = n.heldOption
  var c = "grow truncate"
  if held < 0:
    c.add " opacity-50"
  let shown = el("div", move c)
  if held < 0:
    shown.children.add SvgNode(text: n.attr("placeholder"))
  else:
    shown.children = n.children[held].children
  SvgNode(tag: "div", attrs: n.attrs, children: @[shown, icon("M6 9l6 6 6-6", false, 0)])

# What a class string said, for the same string, states, image size and
# inherited text: the box and the text it left. A UI's elements repeat a few
# class strings, and a toggle rebuilt a dozen nodes whose classes were read
# again from the characters each time (~4 ms of a tap on an ESP32).
type
  ClassFlags = object
    ## What build() asks of a class string besides its box: its pointer
    ## classes, hover:, active: and group.
    pointer, hover, active, group: bool
  ClassRead = object
    classes: string
    states: set[UiState]
    w, h: float32
    textIn, textOut: Text
    box: Box
  ClassFlagsRead = object
    classes: string
    flags: ClassFlags

# On the heap, made on first use: a global array is the ESP32's internal
# .bss (--threads:off makes a threadvar a global), and these were 47 KB of
# the 80 KB of internal RAM a frame has.
var
  classReads {.threadvar.}: seq[ClassRead]
  classFlagReads {.threadvar.}: seq[ClassFlagsRead]

proc readClasses(box: var Box, text: var Text, classes: string, w, h: float32, states: set[UiState]) =
  if classReads.len == 0:
    classReads = newSeq[ClassRead](128)
  let slot = (hash(classes) !& hash(cast[uint8](states))).int and classReads.high
  template c: untyped = classReads[slot]
  if c.classes.len > 0 and c.classes == classes and c.states == states and c.w == w and c.h == h and
      c.textIn == text:
    box = c.box
    text = c.textOut
    return
  let textIn = text
  box.applyClasses(text, classes, w, h, states)
  classReads[slot] = ClassRead(classes: classes, states: states, w: w, h: h, textIn: textIn,
    textOut: text, box: box)

proc classFlags(classes: string): ClassFlags =
  if classFlagReads.len == 0:
    classFlagReads = newSeq[ClassFlagsRead](128)
  let slot = hash(classes).int and classFlagReads.high
  if classFlagReads[slot].classes.len > 0 and classFlagReads[slot].classes == classes:
    return classFlagReads[slot].flags
  result = ClassFlags(pointer: classes.pointerClasses, hover: classes.variant("hover"),
    active: classes.variant("active"), group: classes.hasClass("group"))
  classFlagReads[slot] = ClassFlagsRead(classes: classes, flags: result)

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
  if n.tag == "select":
    result = n.selectRow.build(inherited, rootW, rootH, depth, key, input, groupHover, nil)
    result.src = n
    result.field = 4
    result.box.display = diFlex
    result.box.items = alCenter
    result.children[1].box.w = px(result.text.size)
    result.children[1].box.h = result.children[1].box.w
    return
  var text = inherited
  tagStyle(n.tag, text)
  result = newUiNode(ukBox, text)
  let classes = n.attr("class")
  result.src = n
  result.inherited = inherited
  result.inGroup = groupHover
  let flags = classFlags(classes)
  result.pointer = flags.pointer
  result.key = key
  result.hover = flags.hover
  result.active = flags.active
  result.group = flags.group
  for event in UiEvent:
    var id: float32
    # onInput is a field's onChange by another name, as in React.
    let value = n.attr(if event == ueChange and n.attr("on-input").len > 0: "on-input" else: handlerAttrs[event])
    if value.len > 0 and number(value, 0, value.len, id):
      result.handlers[event] = int(id) + 1
  if n.links:
    # A link: a tap puts its QR code up (an onClick of its own replaces that).
    result.handlers[ueClick] = LinkOpen + 1
  var states: set[UiState]
  if groupHover: states.incl usGroupHover
  if result.hover and key in input.hovered: states.incl usHover
  if result.active and key in input.pressed: states.incl usActive
  if key == input.focus - 1: states.incl usFocus
  result.states = states
  result.box.readClasses(result.text, classes, rootW, rootH, states)
  if result.box.overflowX != ovVisible or result.box.overflowY != ovVisible:
    result.pointer = true # a scroll builds it again (samePointer)
    # scrollTop={y}: scrolled there when the app changes it (a code editor
    # opening another file, or where a file was left), else where it was.
    let top = n.attr("scroll-top")
    var y: float32
    if top.len > 0 and not ui.isNil and number(top, 0, top.len, y) and
        (prev.isNil or prev.src.isNil or prev.src.attr("scroll-top") != top):
      ui[].scrollTo(key, ui[].scrolled(key)[0], y)
    result.scrollAt = if ui.isNil: input.scrolled(key) else: ui[].scrolled(key)
  # A hovered `group` lights its descendants' group-hover: classes.
  let childGroup = groupHover or (result.group and key in input.hovered)
  if n.tag == "img" or n.tag == "svg":
    result.kind = if n.tag == "img": ukImage else: ukSvg
    return
  if n.tag == "Scene":
    # A picture whose size comes from the room it gets (flex-1 unless it
    # says): the scene runs once the layout knows it (app_runtime.nim).
    result.kind = ukImage
    result.holds = true
    if result.box.grow == 0 and result.box.w.kind == lkAuto and result.box.h.kind == lkAuto:
      result.box.grow = 1
      result.box.shrink = 1
      result.box.basis = Len(kind: lkPct, v: 0)
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
      if run.src.isNil and child.links:
        # A link in running text: the text it runs in is what a tap opens it
        # from (the first link there), keyed by the link's place in the tree.
        run.src = child
        run.key = (key * 31 + i + 1) and 0x3fff_ffff
        run.handlers[ueClick] = LinkOpen + 1
      child.addRuns(result.text, run, rootW, rootH, depth + 1, inlineStates)
      if run.pointer:
        result.pointer = true
    else:
      run = nil
      # 30 bits: never negative (an open select, the field with the keyboard and
      # a scroll are kept as a key + 1, 0 for none), and the same on a 32-bit
      # build (the browser's wasm, an ESP32, a 32-bit Pi), where `key * 31`
      # wraps after seven levels, as on a 64-bit one.
      let childKey = (key * 31 + i + 1) and 0x3fff_ffff
      var before: UiNode
      if not prev.isNil:
        # The same place first: a list that kept its order is one probe per
        # child, not a scan of every earlier child (quadratic in a long list).
        if i < prev.children.len and prev.children[i].kind != ukText and prev.children[i].key == childKey:
          before = prev.children[i]
        else:
          for c in prev.children:
            if c.kind != ukText and c.key == childKey:
              before = c
              break
      let built = child.build(result.text, rootW, rootH, depth + 1, childKey, input, childGroup, before)
      if not before.isNil and built == before and built.src != child and not built.src.isNil:
        # Taken back from the last layout: the element it was built from
        # takes this one's place in the tree too (they say the same,
        # sameTree), or the app's tree keeps a second copy of what the
        # layout keeps: a map's `<svg>` was a third of a megabyte twice over
        # from its second render on.
        n.children[i] = built.src
      if built.pointer:
        result.pointer = true
      result.holds = result.holds or built.holds
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
  n.bold.setLen(0) # the fonts of these spans only
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

const TextMemoWaitingBytes = when defined(frameosEmbedded): 24 * 1024 else: 256 * 1024
  ## What the texts may hold that wait longer than the one layout every text
  ## always waited (the estimate below): on an ESP32 a few labels' worth,
  ## enough for a switch's two states, some sixty glyphs; one long text (a
  ## code editor's file, a store's grid of titles) waits no longer.

proc waitingBytes(entry: TextMemo): int =
  ## A kept text's memory, roughly: its key, its typeset runes (rune,
  ## position, selection box) and its drawn glyphs (a node and its parse:
  ## measured on a 64-bit host, about 730 bytes a glyph, so 90 pointers).
  entry.key.len + 64 + (if entry.arrangement.isNil: 0 else: entry.arrangement.runes.len * 28) +
    entry.drawn.len * 90 * sizeof(pointer)

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
  for i in 0 ..< memo.older.len:
    if memo.older[i].key == key:
      memo.kept.add move(memo.older[i])
      memo.older.del(i)
      return memo.kept.high
  -1

proc arrangeUncached(n: UiNode, width: float32, align: HorizontalAlignment): Arrangement

proc arrange(n: UiNode, width: float32, align: HorizontalAlignment): Arrangement =
  ## The text set into `width`, wrapped unless `whitespace-nowrap`, and cut
  ## with an ellipsis after `lines` lines (truncate, line-clamp-N).
  if not n.arrangement.isNil and n.arrangedW == width and n.arrangedAlign == align:
    return n.arrangement
  probe(phText):
    result = n.arrangeUncached(width, align)

proc arrangeUncached(n: UiNode, width: float32, align: HorizontalAlignment): Arrangement =
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
      # The bold fonts are the recalled arrangement's now: spans set here
      # before would be typeset with fonts `bold` does not hold, and the next
      # text set from them drew its bold glyphs once (the Gallery sample's
      # label, after a few taps).
      n.spans.setLen(0)
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

template clips(n: UiNode): bool =
  ## overflow-hidden, a scroller, or text cut to its lines (truncate,
  ## line-clamp-N, which are overflow: hidden in Tailwind too).
  n.box.overflowX != ovVisible or n.box.overflowY != ovVisible or n.text.lines > 0

proc minContentW(n: UiNode): float32 =
  ## CSS's min-content width: the narrowest `n` is with nothing sticking out
  ## of it, text at its longest word (all of it, `whitespace-nowrap`). What
  ## clips counts for nothing: a `truncate` name in a row item cuts as it
  ## did, where a browser would want `min-w-0` on the item.
  template b: untyped = n.box
  let own = b.w.resolve(-1)
  if own >= 0:
    return own
  if n.clips or n.kind != ukBox and n.kind != ukText:
    return 0
  if n.kind == ukText:
    let a = if n.arrangement.isNil: n.arrange(Unbounded, LeftAlign) else: n.arrangement
    if n.text.nowrap:
      return a.layoutBounds().x + b.padX
    var start, line = -1'f32
    for i in 0 ..< a.runes.len:
      let r = a.selectionRects[i]
      if a.runes[i].isWhiteSpace:
        start = -1
      else:
        if start < 0 or r.y != line:
          start = r.x
          line = r.y
        result = max(result, r.x + r.w - start)
  else:
    let row = b.display == diFlex and not b.col
    var count = 0
    for c in n.children:
      if c.inFlow:
        let w = c.minContentW() + max(c.box.margin[1].resolve(-1), 0) + max(c.box.margin[3].resolve(-1), 0)
        result = if row: result + w else: max(result, w)
        inc count
    if row and count > 1:
      result += b.gapX * float32(count - 1)
  result = result + b.padX

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
    var measured = false
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
        measured = true
    c.main = basis
    # The least it may be: its `min-*`, else CSS's automatic minimum, its
    # content (the longest word in a row) unless it clips. A picture scales,
    # and a box holding a <Scene> takes the room it gets, so they have none;
    # one with a set size keeps it unless a `min-*` says how far it may
    # shrink (frozen below).
    let least = if row: cb.minW else: cb.minH
    c.least = max(least.resolve(mainAvail), 0)
    if flexing and least.isAuto and c.fixedMain < 0 and c.kind < ukImage and not c.holds and
        (not c.clips or not row and c.field in {1'u8, 3, 4}):
      c.least =
        if row: min(c.minContentW(), mainAvail)
        elif measured: basis
        else: c.layout(c.cross, Unbounded, true, false).y
      let most = (if row: cb.maxW else: cb.maxH).resolve(mainAvail)
      if most >= 0: c.least = min(c.least, most)
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
  template fit(c: UiNode, v: float32): float32 =
    # Within its max-* and, above all, its least (CSS: the min wins).
    let most = (if row: c.box.maxW else: c.box.maxH).resolve(mainAvail)
    max(if most >= 0: min(v, most) else: v, c.least)
  for li, (s, e) in lines:
    # CSS's flexible lengths: each item from its base size, the free space
    # shared by grow (or shrink, by its size), and an item that would go
    # past its least or most frozen there and the rest shared again.
    var
      sum = 0'f32
      count = 0
    for i in s ..< e:
      template c: untyped = n.children[i]
      if c.inFlow:
        c.base = c.main
        c.main = c.fit(c.main)
        sum += c.main + c.margins[ms] + c.margins[me]
        inc count
    let
      gaps = gapMain * float32(count - 1)
      room = if mainDef: mainAvail else: min(mainAvail, sum + gaps)
      growing = sum + gaps < room
    for i in s ..< e:
      template c: untyped = n.children[i]
      c.frozen = not flexing or (if growing: c.box.grow <= 0 or c.base > c.main
        else: c.box.shrink <= 0 or c.base < c.main or
          c.fixedMain >= 0 and (if row: c.box.minW else: c.box.minH).isAuto)
    for _ in 0 .. count:
      var
        free = room - gaps
        factors, violation = 0'f32
      for i in s ..< e:
        template c: untyped = n.children[i]
        if c.inFlow:
          free -= c.margins[ms] + c.margins[me] + (if c.frozen: c.main else: c.base)
          if not c.frozen: factors += (if growing: c.box.grow else: c.box.shrink * c.base)
      if factors <= 0:
        break
      for i in s ..< e:
        template c: untyped = n.children[i]
        if c.inFlow and not c.frozen:
          c.main = c.base + free * (if growing: c.box.grow else: c.box.shrink * c.base) / factors
          violation += c.fit(c.main) - c.main
      let done = abs(violation) < 0.01
      for i in s ..< e:
        template c: untyped = n.children[i]
        if c.inFlow and not c.frozen:
          let f = c.fit(c.main)
          if done or f != c.main and (violation > 0) == (f > c.main):
            c.main = f
            c.frozen = true
      if done:
        break
    var tallest = 0'f32
    for i in s ..< e:
      template c: untyped = n.children[i]
      if not c.inFlow:
        continue
      if not c.frozen:
        c.main = c.fit(c.main)
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
    # Set or auto by its kind, not its sign: `left-[-40px]` (a window hanging
    # off the desktop) and `-top-1` (a badge over a corner) are offsets too.
    template given(l: Len, base: float32): bool = l.kind == lkPx or (l.kind == lkPct and base >= 0)
    let
      inset = c.box.inset
      left = inset[3].resolve(pw)
      right = inset[1].resolve(pw)
      top = inset[0].resolve(ph)
      bottom = inset[2].resolve(ph)
      hasLeft = given(inset[3], pw)
      hasRight = given(inset[1], pw)
      hasTop = given(inset[0], ph)
      hasBottom = given(inset[2], ph)
    var
      w = c.box.w.resolve(pw)
      h = c.box.h.resolve(ph)
    if w < 0 and hasLeft and hasRight: w = max(pw - left - right, 0)
    if h < 0 and hasTop and hasBottom: h = max(ph - top - bottom, 0)
    let s = c.layout(if w >= 0: w else: max(pw, 0), if h >= 0: h else: Unbounded, w >= 0, h >= 0)
    c.size = s
    c.x = b.border[3] + (if hasLeft: left elif hasRight: pw - right - s.x else: b.pad[3])
    c.y = b.border[0] + (if hasTop: top elif hasBottom: ph - bottom - s.y else: b.pad[0])

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
          if c.kind == ukText and c.text.nowrap and not c.arrangement.isNil:
            # Lines that do not wrap reach past the box they were set in (a
            # field's code): as wide as the longest.
            right = max(right, c.x + c.box.padX + c.arrangement.layoutBounds().x)
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
  ## stroke-opacity or stop-opacity. A fill is a value (pixie's `filled`):
  ## no "#rrggbb" written for the parse to read back, for every box and glyph.
  if attr == "fill":
    node.filled = true
    node.fill = c
    node.opacity = min(opacity, 1)
    return
  node.attrs.add((attr, c.hex))
  if c.a < 255:
    node.attrs.add((attr.split('-')[0] & "-opacity", num(c.a.float32 / 255)))

proc emit(n: UiNode, ox, oy, opacity: float32, drawn: var seq[SvgNode], gradients: var int,
    regions: var seq[UiRegion]) {.raises: [].}

# What an in-flow box is painted over while the emit is inside it: its
# parent's background when that is one flat opaque colour (a = 255), else
# nothing known (a = 0). A translucent background over it (a card's
# bg-white/10) is drawn as the opaque colour the blend makes: on a 565 or
# grey panel a translucent fill unpacks, blends and packs every pixel, and
# the "off" card of the home panel rastered 28 ms slower than the "on" one
# on an ESP32 for that alone (2026-11-07). Absolute children may lie over
# anything, so they are painted over nothing known.
var emitBackdrop {.threadvar.}: ColorRGBA
var
  linkQr {.threadvar.}: Image ## the QR code of the link that is up, while one is ...
  linkQrUrl {.threadvar.}: string ## ... its URL ...
  linkQrSide {.threadvar.}: int ## ... and the room it was made for

proc overBackdrop(c: ColorRGBA, opacity: float32): tuple[color: ColorRGBA, opacity: float32] =
  ## `c` at `opacity`, as the colour it makes over the backdrop.
  let a = c.a.float32 / 255 * opacity
  if emitBackdrop.a != 255 or a >= 1 or a <= 0:
    return (c, opacity)
  template mix(f, g: uint8): uint8 =
    uint8(clamp(round(f.float32 * a + g.float32 * (1 - a)), 0, 255))
  (rgba(mix(c.r, emitBackdrop.r), mix(c.g, emitBackdrop.g), mix(c.b, emitBackdrop.b), 255), 1'f32)

# A box's rounded outline and its border ring, one shared path per size,
# radii and border widths, at the origin, placed by SvgNode.offset: a card
# that changes only its colour (a toggle) draws the same path, which pixie
# then fills from its kept coverage (paths.nim). A box with a gradient keeps
# a path of its own, where the gradient's coordinates are.
type ShapeKey = array[10, int32]
  ## The key of the shared paths below, boxes and glyphs alike: one Table
  ## type, one copy of its code in the firmware.

var boxShapes {.threadvar.}: Table[ShapeKey, Path]

const BoxShapesMax = 256

proc boxShape(w, h: float32, r: array[4, float32], bw: array[4, float32], ring: bool): Path =
  var key: ShapeKey
  key[0] = int32(w * 4)
  key[1] = int32(h * 4)
  for i in 0 .. 3:
    key[2 + i] = int32(r[i] * 4)
    key[6 + i] = if ring: int32(bw[i] * 4) + 1 else: 0
  if boxShapes.hasKey(key):
    return boxShapes.getOrDefault(key)
  if boxShapes.len >= BoxShapesMax:
    boxShapes.clear()
  result = newPath()
  result.roundedRect(0, 0, w, h, r[0], r[1], r[2], r[3])
  if ring:
    let
      iw = w - bw[1] - bw[3]
      ih = h - bw[0] - bw[2]
    if iw > 0 and ih > 0:
      result.roundedRect(bw[3], bw[0], iw, ih,
        max(r[0] - max(bw[3], bw[0]), 0), max(r[1] - max(bw[1], bw[0]), 0),
        max(r[2] - max(bw[1], bw[2]), 0), max(r[3] - max(bw[3], bw[2]), 0),
        clockwise = false)
  result.share() # never changed again: bounds, flattened shapes, coverage kept
  boxShapes[key] = result

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
    elif fill.len > 0:
      node = SvgNode(tag: "path", path: newPath())
      node.path.roundedRect(x, y, w, h, r[0], r[1], r[2], r[3])
      node.path.share() # never changed again: bounds and flattened shapes kept
    else:
      node = SvgNode(tag: "path", path: boxShape(w, h, r, bw = [0'f32, 0, 0, 0], ring = false),
        offset: vec2(x, y))
    if fill.len > 0:
      node.attrs.add(("fill", "url(#" & fill & ")"))
      if opacity < 1:
        node.attrs.add(("opacity", num(opacity)))
    else:
      let (bg, bgOpacity) = overBackdrop(b.bg, opacity)
      node.paint(bg, bgOpacity)
    drawn.add node
  let bw = b.border
  if bw != [0'f32, 0, 0, 0] and b.borderColor.a > 0:
    # The ring between the box and its inside, one fill whatever the widths.
    let node = SvgNode(tag: "path", path: boxShape(w, h, r, bw, ring = true),
      offset: vec2(x, y), attrs: @[("fill-rule", "evenodd")])
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

# -------- Glyph runs
#
# Text is drawn a glyph at a time: each glyph a glyph path (pixie's
# `glyphPath`: the face, the rune, the size and the glyph's box, no outline)
# placed with the node's `offset` at a quarter pixel. A fill draws it from
# pixie's glyph cache (paths.nim): its coverage at that size and quarter-pixel
# offset, four bits a pixel, kept the first time it is drawn, so a letter
# drawn again (in another label, in the next render, in a changed card's new
# text) is a mask blended into the panel, not an outline read, flattened and
# scanned. A run's path, new for every new text, was most of a toggled card's
# raster on an ESP32 (docs/perf-todo.md). Glyphs sit up to an eighth of a
# pixel from where the typesetter put them.

proc quarter(v: float32): float32 {.inline.} =
  round(v * 4) / 4

proc glyphPath(font: Font, rune: Rune): Path =
  ## The rune's glyph at the font's size, at the origin; nil for a glyph that
  ## draws nothing.
  try:
    font.typeface.glyphPath(rune, font.size)
  except PixieError:
    nil

proc emitColorGlyph(font: Font, rune: Rune, at: Vec2, x, y, opacity: float32,
    drawn: var seq[SvgNode]): bool =
  ## A colour (emoji) glyph is a picture, not an outline: an <image> where the
  ## pen puts it, drawn by the same pass as the text, from the emoji face the
  ## text falls back to (pixie's colorGlyphImage). False for a rune with none.
  var off: Vec2
  let image =
    try: font.typeface.colorGlyphImage(rune, font.size, off)
    except PixieError: nil
  if image.isNil:
    return false
  let node = SvgNode(tag: "image", image: image, attrs: @[
    ("x", num(round(at.x + x + off.x))), ("y", num(round(at.y + y + off.y))),
    ("width", num(image.width.float32)), ("height", num(image.height.float32))])
  if opacity < 1:
    node.attrs.add(("opacity", num(opacity)))
  drawn.add node
  true

proc emitGlyphs(arrangement: Arrangement, n: UiNode, x, y, opacity: float32,
    drawn: var seq[SvgNode]): bool =
  ## The arrangement as glyph runs; false when it has what glyphs cannot
  ## carry (an underline, a strikethrough), for the path per span instead.
  for font in arrangement.fonts:
    if font.underline or font.strikethrough:
      return false
  for spanIndex, (start, stop) in arrangement.spans:
    let
      font = arrangement.fonts[spanIndex]
      color = font.paint.color.rgba
      bold = font in n.bold
      strike = quarter(font.size / 24)
    for i in start .. stop:
      let rune = arrangement.runes[i]
      if rune.isWhiteSpace:
        continue
      if rune.int32 >= 0x80 and emitColorGlyph(font, rune, arrangement.positions[i], x, y, opacity, drawn):
        continue
      let path = glyphPath(font, rune)
      if path.isNil:
        continue
      let
        at = arrangement.positions[i]
        offset = vec2(quarter(at.x + x), quarter(at.y + y))
        node = SvgNode(tag: "path", path: path, offset: offset)
      node.paint(color, opacity)
      drawn.add node
      if bold:
        # No bold face to draw it in (an ESP32 has one): the same outline
        # filled again a little to the right, the double strike of a
        # typewriter. (It was a round-joined stroke of the outline, a circle
        # per join: over half the raster of a toggled card, 2026-11-07.)
        let second = SvgNode(tag: "path", path: path, offset: offset + vec2(strike, 0))
        second.paint(color, opacity)
        drawn.add second
  true

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
  # arrange() sets text a pixel wider than its box, to wrap where it was
  # measured: centered or right-aligned lines come back by what it added.
  let shift =
    case n.text.align
    of CenterAlign: -0.5'f32
    of RightAlign: -1
    else: 0
  var paths: seq[Path]
  if not arrangement.emitGlyphs(n, x + shift, y, opacity, drawn):
    try:
      paths = arrangement.computePaths()
    except PixieError:
      return
    for spanIndex, (start, stop) in arrangement.spans:
      for i in start .. stop:
        if arrangement.runes[i].int32 >= 0x80:
          discard emitColorGlyph(arrangement.fonts[spanIndex], arrangement.runes[i],
            arrangement.positions[i], x + shift, y, opacity, drawn)
  for i, path in paths:
    let font = arrangement.fonts[i]
    path.transform(translate(vec2(x + shift, y)))
    let node = SvgNode(tag: "path", path: path)
    node.paint(font.paint.color.rgba, opacity)
    drawn.add node
    if font in n.bold:
      # No bold face to draw it in (an ESP32 has one): the same outline filled
      # again a little to the right, the double strike of a typewriter. It
      # was a round-joined stroke of the outline; pixie built a circle per
      # join, 303 for an 11-glyph label, and that one label was over half
      # the raster of a toggled home-panel card (2026-11-07). The second fill
      # shares the path, so its flattened shapes are flattened once.
      let strike = SvgNode(tag: "path", path: path, offset: vec2(font.size / 24, 0))
      strike.paint(font.paint.color.rgba, opacity)
      drawn.add strike
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

proc viewport(x, y, w, h, sx, sy: float32): SvgNode =
  ## A nested <svg> that shows (x, y, w, h) and cuts off the rest, what is in
  ## it moved by (sx, sy): pixie's clip. A box that clips, and a line of a
  ## selection on paper.
  SvgNode(tag: "svg", attrs: @[("x", num(x)), ("y", num(y)), ("width", num(w)),
    ("height", num(h)), ("viewBox", nums([x + sx, y + sy, w, h]))])

proc isWordByte(c: char): bool {.inline.} =
  ## Part of a word: a letter, a digit, `_`, or any byte of a character past
  ## ASCII (é, ł, 字 are letters; a selection's ends are never inside one).
  c in {'a' .. 'z', 'A' .. 'Z', '0' .. '9', '_'} or ord(c) >= 0x80

proc runeIndex(text: string, at: int): int {.inline.} =
  ## How many runes come before byte `at`.
  text.toOpenArray(0, min(at, text.len) - 1).runeLen

proc emitField(n: UiNode, x, y, w, h: float32, sx, sy: var float32, marks: var seq[SvgNode]): array[4, float32] =
  ## The focused field's caret, where it is in the text: placed where a tap
  ## landed, and the field scrolled so it shows. Its box, unscrolled. A
  ## selection is drawn into `marks` (a band a line of it, under the text),
  ## and then no caret: its width is 0.
  template b: untyped = n.box
  let t = n.children[0] # the field's one run of text
  let
    tx = round(x + t.x)
    ty = round(y + t.y)
    arrangement = t.arrange(round(x + t.x + t.size.x) - tx, t.text.align)
  if arrangement.runes.len == 0:
    return
  when not defined(frameosEmbedded): # only a mouse sets it: none on an ESP32
    if ui.anchor:
      # A drag that selects: where it went down is the selection's other end.
      ui.anchor = false
      ui.sel = n.value.runeOffset(arrangement.caretAt(ui.anchorX - (tx - x) + sx, ui.anchorY - (ty - y) + sy)) + 1
  if ui.place:
    ui.place = false
    ui.goal = false
    ui.caret = n.value.runeOffset(arrangement.caretAt(ui.placeX - (tx - x) + sx, ui.placeY - (ty - y) + sy))
  ui.caret = clamp(ui.caret, 0, n.value.len)
  ui.secret = n.src.attr("type") == "password"
  if ui.word:
    # The word at the caret (the one before it at its end): a password's
    # whole text, whose words are not shown.
    ui.word = false
    var (a, z) = (ui.caret, ui.caret)
    if ui.secret:
      (a, z) = (0, n.value.len)
    else:
      while a > 0 and n.value[a - 1].isWordByte: dec a
      while z < n.value.len and n.value[z].isWordByte: inc z
    if z > a:
      ui.sel = a + 1
      ui.caret = z
  var
    i = min(n.value.toOpenArray(0, ui.caret - 1).runeLen, arrangement.runes.len)
    r = arrangement.selectionRects[min(i, arrangement.runes.high)]
  when not defined(frameosEmbedded):
    if ui.lineStep != 0:
      # A line up or down (ArrowUp / ArrowDown on a keyboard): the nearest
      # edge on that line to the x the caret set out from, kept across the
      # lines it walks; off the first line the start, off the last the end.
      var line = arrangement.lines.high
      for l, span in arrangement.lines:
        if i <= span[1]:
          line = l
          break
      if not ui.goal:
        ui.goal = true
        ui.goalX = if i < arrangement.runes.len: r.x else: r.x + r.w
      let to = line + ui.lineStep
      ui.lineStep = 0
      let rune =
        if to < 0: 0
        elif to > arrangement.lines.high: arrangement.runes.len
        else:
          let row = arrangement.selectionRects[arrangement.lines[to][0]]
          arrangement.caretAt(ui.goalX, row.y + row.h / 2)
      ui.caret = clamp(n.value.runeOffset(rune), 0, n.value.len)
      i = min(n.value.toOpenArray(0, ui.caret - 1).runeLen, arrangement.runes.len)
      r = arrangement.selectionRects[min(i, arrangement.runes.high)]
  let cw = max(1'f32, round(t.text.size / 16))
  result = [tx + (if i < arrangement.runes.len: r.x else: r.x + r.w), ty + r.y, cw, r.h]
  if ui.sel > 0:
    ui.sel = clamp(ui.sel, 1, n.value.len + 1)
    let (a, z) = ui[].selected
    if z > a:
      # The selected glyphs' boxes, a band a line, in the text's color at a
      # third (pixie draws it: one rasterizer for everything a UI shows).
      let
        last = min(n.value.runeIndex(z), arrangement.runes.len) - 1
        band = SvgNode(tag: "path", path: newPath())
      marks.add band
      var j = min(n.value.runeIndex(a), arrangement.runes.len)
      while j <= last:
        let first = arrangement.selectionRects[j]
        var right = first.x + first.w
        while j < last and arrangement.selectionRects[j + 1].y == first.y:
          inc j
          right = max(right, arrangement.selectionRects[j].x + arrangement.selectionRects[j].w)
        band.path.rect(tx + first.x, ty + first.y, right - first.x, first.h)
        if ui.paper:
          # E-paper dithers a third of a color into a stipple that eats the
          # glyphs: a solid band, the text in it inverted as on a lit key.
          # A viewport a line, which emit fills with the text again.
          marks.add viewport(tx + first.x, ty + first.y, right - first.x, first.h, 0, 0)
        inc j
      band.paint(t.text.color, if ui.paper: 1'f32 else: 0.3)
      result[2] = 0 # no caret while text is selected
      if ui.handles:
        # Its ends, for the handles a finger drags (layoutUi draws them).
        let
          first = arrangement.selectionRects[min(n.value.runeIndex(a), arrangement.runes.high)]
          final = arrangement.selectionRects[max(last, 0)]
        ends = [[tx + first.x, ty + first.y, 0, first.h], [tx + final.x + final.w, ty + final.y, 0, final.h]]
        endsFound = true
  if ui.menu and not endsFound:
    # A menu with nothing selected (Paste): at the caret.
    ends = [[result[0], result[1], 0, r.h], [result[0], result[1], 0, r.h]]
    endsFound = true
  if not revealCaret:
    # Scrolled by a finger or the wheel: the caret may be out of sight, as
    # in a browser, until the next edit or key brings it back.
    return
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
    marks: seq[SvgNode] # a focused field's selection, under its text
  if clips:
    sx = clamp(sx, 0, n.maxX)
    sy = clamp(sy, 0, n.maxY)
    if n.field > 0 and n.key == ui.focus - 1 and n.children.len > 0:
      focusSeen = true
      caret = n.emitField(x, y, w, h, sx, sy, marks)
    elif n.field > 0 and n.field != 2:
      # A field that lets go of the keyboard shows its text from the start;
      # a <textarea> stays where it was scrolled to, like any box.
      sx = 0
      sy = 0
    setScroll(n.key, sx, sy)
    n.scrollAt = (sx, sy)
  let
    at = [x, y, w, h, op, sx, sy]
    call = (n.lastFix, n.lastW, n.lastH)
  if n.kind == ukBox and n.emittedAt == at and n.emittedFor == call and n.emittedGradients[0] == gradients and
      n.emittedOver == emitBackdrop:
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
    # A <textarea> scrolls its text like a box with overflow-y-auto.
    scrollsY = b.overflowY == ovScroll or n.field == 2
    scrolls = b.overflowX == ovScroll and n.maxX > 0 or scrollsY and n.maxY > 0
  n.emitPaint(x, y, w, h, op, drawn, gradients)
  # A link with no `cursor-*` of its own shows the hand, as in a browser.
  let cursor = when defined(frameosEmbedded): 0'u8
    else: (if b.cursor == 0 and n.handlers[ueClick] == LinkOpen + 1: csPointer.cursorCode else: b.cursor)
  if n.hover or n.active or n.group or n.handlers != default(array[UiEvent, int]) or
      n.field > 0 or scrolls or cursor != 0:
    # In paint order: whatever comes later is on top.
    regions.add UiRegion(x: x, y: y, w: w, h: h, visible: [x, y, x + w, y + h], key: n.key,
      handlers: n.handlers, hover: n.hover, active: n.active, group: n.group, field: n.field,
      scrollX: (if b.overflowX == ovScroll: n.maxX else: 0),
      scrollY: (if scrollsY: n.maxY else: 0))
    when not defined(frameosEmbedded):
      regions[^1].cursor = cursor
      regions[^1].cursorBand = b.cursorBand
  case n.kind
  of ukText:
    n.emitText(cx, cy, cw, op, drawn)
  of ukImage:
    let
      embedded = n.src.tag == "Scene"
      url = if embedded or not n.src.image.isNil: "" else: n.src.attr("src")
    if (embedded or url.len > 0 or not n.src.image.isNil) and cw > 0 and ch > 0:
      let node = SvgNode(tag: "image", image: n.src.image, attrs: @[("x", num(cx)),
        ("y", num(cy)), ("width", num(cw)), ("height", num(ch)),
        ("preserveAspectRatio", ["none", "xMidYMid meet", "xMidYMid slice"][ord(b.fit)])])
      if url.len > 0:
        # `<img src="https://…">`: fetched by the app runtime at the size laid
        # out here (fillUrlImages), nothing drawn until it is in.
        node.attrs.add(("image-url", url))
      if embedded:
        node.attrs.add(("scene-id", n.src.attr("id")))
        node.attrs.add(("scene-props", n.src.attr("props")))
        # Where it is in paint order, for the pointer (UiRegion.scene), with
        # the layout's own handlers on it (`<Scene onPointerDown>`), which
        # run when an event reaches the scene there (uiSceneHandler).
        regions.add UiRegion(x: cx, y: cy, w: cw, h: ch, visible: [cx, cy, cx + cw, cy + ch], key: -1,
          scene: true, handlers: n.handlers)
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
      view = viewport(vx, vy, vw, vh, sx, sy)
      if marks.len > 0:
        view.children.add marks[0] # the selection's band, under the text
    let outer = emitBackdrop
    for pass in [false, true]:
      # What the children are painted over (overBackdrop): this box's own
      # background when it leaves one flat opaque colour, the one it was
      # painted over when it has none, nothing known under absolute ones.
      emitBackdrop =
        if pass: rgba(0, 0, 0, 0)
        elif b.gradient > 0 or b.bg.a == 0 and op < 1: rgba(0, 0, 0, 0)
        elif b.bg.a == 0: outer
        else:
          let saved = emitBackdrop
          emitBackdrop = outer
          let (bg, bgOpacity) = overBackdrop(b.bg, op)
          emitBackdrop = saved
          if bg.a == 255 and bgOpacity >= 1: bg else: rgba(0, 0, 0, 0)
      for c in n.children:
        if c.box.absolute == pass:
          if clips: c.emit(x, y, op, view.children, gradients, regions)
          else: c.emit(x, y, op, drawn, gradients, regions)
    emitBackdrop = outer
    if marks.len > 1:
      # E-paper: the selected text again over its band, in the other ink,
      # each line's viewport cutting it to the band.
      let
        c = n.text.color
        ink = SvgNode()
      ink.paint(if c.r.int + c.g.int + c.b.int < 384: rgba(255, 255, 255, 255) else: rgba(0, 0, 0, 255), 1)
      for m in 1 ..< marks.len:
        for k in 1 ..< view.children.len:
          template glyph: untyped = view.children[k]
          if not glyph.path.isNil:
            marks[m].children.add SvgNode(tag: "path", path: glyph.path, offset: glyph.offset,
              filled: ink.filled, fill: ink.fill, opacity: ink.opacity)
        view.children.add marks[m]
    if clips:
      if caret[2] > 0:
        let bar = SvgNode(tag: "rect", attrs: @[("x", num(caret[0])), ("y", num(caret[1])),
          ("width", num(caret[2])), ("height", num(caret[3]))])
        bar.paint(n.text.color, op)
        view.children.add bar
      drawn.add view
      if endsFound and n.field > 0 and n.key == ui.focus - 1:
        # Where the selection ends, as a region a pixel wide that the boxes
        # around scroll and cut off like any: layoutUi takes them back out.
        for e in 0 .. 1:
          regions.add UiRegion(x: ends[e][0], y: ends[e][1], w: 1, h: ends[e][3], key: EndsKey + e,
            visible: [ends[e][0], ends[e][1], ends[e][0] + 1, ends[e][1] + ends[e][3]])
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
      if scrollsY and n.maxY > 0:
        # Where in what it holds it shows: a thin bar at its right edge.
        let
          barH = max(vh * vh / (vh + n.maxY), min(vh, 16))
          bar = SvgNode(tag: "path", path: newPath())
        bar.path.roundedRect(vx + vw - 5, vy + (vh - barH) * sy / n.maxY, 3, barH, 1.5, 1.5, 1.5, 1.5)
        bar.path.share()
        bar.paint(n.text.color, op * 0.35)
        drawn.add bar
    n.emitted = drawn[first .. ^1]
    n.emittedRegions = regions[firstRegion .. ^1]
    n.emittedAt = at
    n.emittedOver = emitBackdrop
    n.emittedFor = call
    n.emittedGradients = (firstGradient, gradients - firstGradient)

proc reveal(n: UiNode, key: int, r: var array[4, float32]): bool =
  ## Whether the field at `key` is in `n`: then `r` is its box from n's
  ## corner as n shows it, every box on the way that scrolls scrolled so it
  ## is in sight, a little room around it.
  if n.key == key and n.field > 0:
    r = [0'f32, 0, n.size.x, n.size.y]
    revealLine = [0'f32, n.size.y]
    if n.field == 2 and n.children.len > 0 and not n.children[0].arrangement.isNil:
      # Its line with the caret (the tap's, which placed it), for a box
      # around that cannot show it all (a code editor's lines).
      let
        t = n.children[0]
        a = t.arrangement
        lineH = if a.selectionRects.len > 0: a.selectionRects[0].h else: t.text.size
      revealLine[1] = lineH
      if ui.place:
        revealLine[0] = ui.placeY - lineH / 2
      elif a.runes.len > 0:
        let i = min(n.value.toOpenArray(0, clamp(ui.caret, 0, n.value.len) - 1).runeLen, a.runes.high)
        revealLine[0] = t.y + a.selectionRects[i].y - scrollOf(n.key)[1]
    return true
  if n.kind != ukBox:
    return false
  for c in n.children:
    if c.reveal(key, r):
      template b: untyped = n.box
      r[0] += c.x
      r[1] += c.y
      if b.overflowY == ovScroll and r[3] > n.size.y - b.border[0] - b.border[2] - 16:
        # Taller than this box shows: the caret's line in sight, not its top.
        r[1] += revealLine[0]
        r[3] = revealLine[1]
        revealLine = [0'f32, r[3]]
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

proc measureText*(texts: openArray[string], classes: string, width: float32): seq[float32] =
  ## `frameos.measureText`: how tall each text is, set in `classes` into
  ## `width` as a field sets its text (its spaces kept, an empty one a line
  ## tall): a code editor's lines, wrapped, before they are laid out.
  let kept = memo
  memo = nil # no layout's type cache: this is no layout
  var
    style = initText()
    box = initBox()
  box.applyClasses(style, classes, width, width)
  for text in texts:
    let n = newUiNode(ukText, style)
    n.keep = true
    n.runs.add SvgNode(tag: "&", text: if text.len == 0: " " else: text)
    n.styles.add style
    result.add n.arrange(width, style.align).layoutBounds().y
  memo = kept

proc fieldText*(memo: UiMemo, key: int): string =
  ## The text the last layout gave the field at `key` ("" for none).
  if not memo.isNil:
    let n = memo.root.fieldIn(key)
    if not n.isNil:
      result = n.value

proc selectOption*(memo: UiMemo, key, option: int, handler: var int): string =
  ## The value of option number `option` of the <select> at `key` as the last
  ## layout had it, and its onChange as UiRegion.handlers has it.
  let n = memo.root.fieldIn(key)
  if not n.isNil:
    handler = n.handlers[ueChange]
    result = n.src.children[option].attr("value")

proc linkAt*(memo: UiMemo, key: int): string =
  ## The href of the link at `key` as the last layout had it ("" for none).
  if not memo.isNil:
    let n = memo.root.fieldIn(key) # a link's key is its own, as a field's is
    if not n.isNil and not n.src.isNil:
      result = n.src.attr("href")

proc linkCard(url: string, width, height: float32, input: var UiInput, drawn: var seq[SvgNode],
    gradients: var int, regions: var seq[UiRegion]) =
  ## A link's QR code over the whole UI, for a phone to open it: the code as
  ## large as fits, its URL under it and a Close button. Black on white, as a
  ## camera reads it best, on every panel. A tap anywhere puts it away, and
  ## it is all there is to touch while it is up. The code gets all the room
  ## the URL (two lines at most) and the button leave: a first pass lays the
  ## card out with the code as a box that grows into it, the second draws the
  ## code at the size that box got.
  let
    code = el("img", "flex-1 min-h-0 w-full")
    card = el("div", "flex flex-col items-center justify-center gap-2 p-3 bg-white text-black text-sm", code)
  card.attrs.add(("on-click", LinkCloseAttr))
  card.children.add el("div", "text-center line-clamp-2 max-w-full", SvgNode(text: url))
  card.children.add el("div", "px-4 py-1 border border-black rounded font-bold", SvgNode(text: "Close"))
  var shown: UiNode
  for pass in 0 .. 1:
    shown = card.build(initText(), width, height, 0, LinkKey, input, false, nil)
    shown.size = shown.layout(width, height, true, true)
    if pass == 0:
      let
        room = shown.children[0].size
        side = max(int(min(room.x, room.y)), 32)
      if linkQr.isNil or linkQrUrl != url or linkQrSide != side:
        linkQrUrl = url
        linkQrSide = side
        try:
          linkQr = qrImage(qrEncode(url), side)
        except Exception:
          linkQr = nil
      var classes = "shrink-0"
      let at = if linkQr.isNil: side else: linkQr.width
      classes.px("w", at)
      classes.px("h", at)
      code.attrs[0][1] = move classes
      code.image = linkQr
  regions.setLen(0)
  shown.emit(0, 0, 1, drawn, gradients, regions)

proc popup(anchor: UiNode, r: UiRegion, width, height: float32, input: var UiInput, drawn: var seq[SvgNode],
    gradients: var int, regions: var seq[UiRegion]): bool =
  ## An open <select>'s list, as the region it opened from was just placed: a
  ## box of its width under it, or above it when there is more room there and
  ## not enough below, never past the screen. What does not fit scrolls. Each
  ## option is a row as tall as the select, its classes the app's. It goes on
  ## top of everything, and all there is to touch while it is up: `regions`,
  ## which `r` is one of, start again. False with no option.
  const
    gap = 4'f32
    inner = 4'f32 # the box's padding, each way
    edge = 8'f32
  # A round panel's corners are not there, and no ESP32 board is round.
  let margin = when defined(frameosEmbedded): edge else: (if input.round: height / 8 else: edge)
  let
    options = anchor.src.children
    count = options.len
  if count == 0:
    return false
  let list = el("div", "flex flex-col overflow-y-auto p-[4px] border")
  for i in 0 ..< count:
    var row = options[i].attr("class")
    row.add " shrink-0 flex items-center truncate"
    row.px("h", int(r.h))
    row.px("px", int(anchor.box.pad[3]))
    list.children.add SvgNode(tag: "div", children: options[i].children,
      attrs: @[("class", move row), ("on-click", $(OptionBase + i))])
  let
    rowH = r.h
    wanted = rowH * count.float32 + 2 * inner + 2 # its padding and border
    top = r.visible[1]
    bottom = r.visible[3]
    below = height - margin - bottom - gap
    above = top - margin - gap
    down = wanted <= below or below >= above
    # With little room either side it keeps three rows, over the select.
    h = min(min(wanted, height - 2 * margin), max(if down: below else: above, rowH * 3))
    w = min(r.w, width - 2 * edge)
  let shown = list.build(anchor.text, width, height, 0, PopupKey, input, false, if memo.isNil: nil else: memo.popup)
  template box: untyped = shown.box
  # The select's own box: its background (one that reads, without any), its
  # corners, and a line around it to tell it from what is behind it.
  box.bg = anchor.box.bg
  if box.bg.a < 255:
    box.bg = if anchor.text.color.g < 128: rgba(255, 255, 255, 255) else: rgba(0, 0, 0, 255)
  box.radius = anchor.box.radius
  box.borderColor = anchor.text.color
  if not input.paper:
    box.borderColor.a = box.borderColor.a div 3
  shown.size = shown.layout(w, h, true, true)
  shown.x = clamp(r.x, edge, max(width - edge - w, edge))
  shown.y = clamp(if down: bottom + gap else: top - gap - h, margin, max(height - margin - h, margin))
  if input.fresh:
    # What it holds in the middle of the list, and in sight.
    input.fresh = false
    let held = max(anchor.src.heldOption, 0)
    input.scrollTo(PopupKey, 0, clamp(rowH * held.float32 + inner - (h - rowH) / 2, 0, shown.maxY))
  regions.setLen(0)
  shown.emit(0, 0, 1, drawn, gradients, regions)
  if not memo.isNil:
    memo.popup = shown
  true

proc accentPopup(r: UiRegion, width, height: int, input: var UiInput, drawn: var seq[SvgNode],
    gradients: var int, regions: var seq[UiRegion]): bool =
  ## The accents of the held key, `r` its region as the keyboard was just
  ## placed: a row of keys its size above it (ui/keyboard.nim `accentTree`),
  ## centred on it as far as the screen, or a round panel's circle, allows,
  ## and under it when there is no room above. It goes on top of everything;
  ## the keyboard stays there to touch (a tap on it puts the row away and
  ## types, ui/events.nim). False for a key without accents.
  let
    count = formCount(input.accents, input.page)
    hinted = hintOf(input.accents, input.page).len > 0
  if count == 0:
    return false
  let
    keyH = int(r.h)
    gap = max(keyH div 8, 3)
    edge = 4
    popH = keyH + 2 * gap + 4 # its padding and border
    above = int(r.y) - gap - popH
    y = if above >= edge: above else: int(r.y + r.h) + gap
  var
    lo = edge
    hi = width - edge
  when not defined(frameosEmbedded):
    if input.round:
      # Inside the circle at the row's edge farther from its centre.
      let
        radius = max(min(width, height) div 2 - RoundInset, 8)
        dy = max(abs(y - height div 2), abs(y + popH - height div 2))
        half = chordHalf(radius, dy) - edge
      lo = max(lo, width div 2 - half)
      hi = min(hi, width div 2 + half)
  let
    centre = int(r.x + r.w / 2)
    # A letter's row has its symbol right over the key and the rest in order
    # away from it, toward the side with room: to the right, or, near the
    # right edge, to the left, the symbol at the row's right end (a finger on
    # o slides left through its forms, as on a phone). Its forms narrow until
    # the row fits that side. Any other row is centred on its key.
    rightW = (hi - centre - 2 - count * gap).float32 / (count.float32 - 0.5)
    leftW = (centre - lo - 2 - count * gap).float32 / (count.float32 - 0.5)
    reversed = hinted and rightW < r.w and leftW > rightW
    keyW =
      if hinted: max(min(int(r.w), int(if reversed: leftW else: rightW)), 8)
      else: max(min(int(r.w), (hi - lo - 4 - (count + 1) * gap) div count), 8)
    popW = count * keyW + (count + 1) * gap + 4
    lead = 2 + gap + keyW div 2 # from the row's end to the middle of the form there
    x = clamp(
      if not hinted: centre - popW div 2
      elif reversed: centre + lead - popW
      else: centre - lead, lo, max(hi - popW, lo))
    # The first form's middle: the symbol's, on a letter's row over the key.
    first = if reversed: float32(x + popW - lead) else: float32(x + lead)
  # The accent under the finger's x, as near as it gets: a finger that slides
  # sideways off the key it holds needs to go no higher than the row. On a
  # letter's row, by how far the finger went from where it held (`accentFrom`):
  # the symbol is lit until it moves, wherever the screen's edge put the row.
  input.accentLit = -1
  if input.accentX >= 0:
    # As ui/events.nim's `accentNear`.
    let at = if hinted: input.accentX - input.accentFrom + first else: input.accentX
    let steps = (if reversed: first - at else: at - first) / float32(keyW + gap)
    input.accentLit = clamp(int(round(steps)), 0, count - 1)
  let shown = accentTree(input.accents, input.shift, keyW, keyH, gap, input.paper, input.page,
    input.accentLit, reversed)
    .build(initText(), width.float32, height.float32, 0, AccentKey, input, false,
      if memo.isNil: nil else: memo.accents)
  shown.size = shown.layout(popW.float32, popH.float32, true, true)
  shown.x = float32(x)
  shown.y = float32(y)
  shown.emit(0, 0, 1, drawn, gradients, regions)
  if not memo.isNil:
    memo.accents = shown
  true

proc selectionChrome(at: array[2, array[3, float32]], seen: array[2, bool], width, height: int,
    input: var UiInput, drawn: var seq[SvgNode], gradients: var int, regions: var seq[UiRegion]) =
  ## A selection made by touch, `at` its start and end (x, top, line height)
  ## as its field showed them (`seen`: an end scrolled out of sight is not;
  ## its place is the other's): a handle under each end that shows
  ## (ui/events.nim drags them, SelectBase + 0 and + 1), and its menu over
  ## it, or under it without room (Cut and Copy with text selected and no
  ## password, Paste with something on the clipboard, Select all with more
  ## to select). Plain numbers, not regions: on an ESP32 every region copied
  ## is a hundred bytes of code.
  let
    lineH = max(at[0][2], at[1][2])
    radius = clamp(round(lineH * 0.4), 7, 14)
    (a, z) = input.selected
  var lowest = 0'f32
  if z > a and input.handles:
    let knobs = SvgNode(tag: "path", path: newPath())
    for e in 0 .. 1:
      if not seen[e]:
        continue
      let
        x = at[e][0]
        bottom = at[e][1] + at[e][2]
      # A bar on the end and a knob under it, leaning out of the selection
      # (left at its start, right at its end), so two that meet both show.
      knobs.path.rect(x - 1, at[e][1], 2, at[e][2])
      knobs.path.circle(x + float32(e * 2 - 1) * 0.7 * radius, bottom + radius, radius)
      lowest = max(lowest, bottom + 2 * radius)
      regions.setLen(regions.len + 1)
      template handle: untyped = regions[^1]
      handle.x = x - 2 * radius
      handle.y = bottom - at[e][2] / 2
      handle.w = 4 * radius
      handle.h = at[e][2] / 2 + 2.5 * radius
      handle.key = EndsKey + e
      handle.visible = [handle.x, handle.y, handle.x + handle.w, handle.y + handle.h]
      handle.handlers[ueClick] = SelectBase + e + 1
    knobs.paint(if input.paper: rgba(0, 0, 0, 255) else: rgba(14, 165, 233, 255), 1) # sky-500
    drawn.add knobs
  if not input.menu:
    return
  var items: set[EditCut .. EditSelectAll]
  if z > a and not input.secret: items.incl {EditCut, EditCopy}
  if clipboard.len > 0: items.incl EditPaste
  if input.text.len > 0 and (a > 0 or z < input.text.len): items.incl EditSelectAll
  if items == {}:
    return
  let
    shown = editMenuTree(items, int(clamp(round(lineH * 0.6), 12, 22)), input.paper)
      .build(initText(), width.float32, height.float32, 0, MenuKey, input, false,
        if memo.isNil: nil else: memo.menu)
    edge = 4'f32
    gap = max(lineH / 4, 4)
  shown.size = shown.layout(Unbounded, Unbounded, false, false)
  let
    w = min(shown.size.x, width.float32 - 2 * edge)
    h = shown.size.y
    above = at[0][1] - gap - h
    centre = if at[0][1] == at[1][1]: (at[0][0] + at[1][0]) / 2 else: at[0][0]
  if w < shown.size.x:
    shown.size = shown.layout(w, h, true, true)
  shown.x = clamp(round(centre - w / 2), edge, max(width.float32 - edge - w, edge))
  shown.y = round(if above >= edge: above else: min(max(at[1][1] + at[1][2], lowest) + gap, height.float32 - edge - h))
  shown.emit(0, 0, 1, drawn, gradients, regions)
  if not memo.isNil:
    memo.menu = shown

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
  endsFound = false
  var kbTop, kb: int
  if input.keyboard and input.focus > 0: (kbTop, kb) = keyboardBox(width, height, input.round)
  else: kbTop = height
  let
    w = width.float32
    h = float32(kbTop)
  var before: UiNode
  if not memo.isNil:
    inc memo.gen
    if memo.olderDropped != waitingTextDrops:
      # Memory short or a scene gone (utils/memory): the texts that wait go.
      memo.olderDropped = waitingTextDrops
      memo.older.setLen(0)
    if memo.rootW == w and memo.rootH == h:
      before = memo.root
  var top: UiNode
  probe(phLayout):
    probe(phBuild):
      top = root.build(initText(), w, h, 0, 0, input, false, before)
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
  revealCaret = input.reveal or input.place or input.lineStep != 0
  input.reveal = false
  result = SvgNode(tag: "svg", attrs: @[("width", $width), ("height", $height)])
  if kb > 0 and top.box.bg.a == 255 and top.box.gradient == 0:
    # The UI's page under the keyboard too: an opaque first paint over the
    # whole image, so a key repaints only what it changed.
    let page = SvgNode(tag: "rect", attrs: @[("width", $width), ("height", $height)])
    page.paint(top.box.bg, 1)
    result.children.add page
  var gradients = 0
  emitBackdrop = rgba(0, 0, 0, 0) # the root is painted over whatever the scene drew
  probe(phEmit):
    top.emit(0, 0, 1, result.children, gradients, regions)
  if input.open > 0:
    var shown = false
    let anchor = top.fieldIn(input.open - 1)
    if not anchor.isNil and anchor.field == 4:
      for i in 0 ..< regions.len:
        if regions[i].key == input.open - 1:
          shown = anchor.popup(regions[i], w, h, input, result.children, gradients, regions)
          break
    if not shown:
      input.open = 0
  if input.link.len == 0:
    linkQr = nil # no card up: its picture goes
  if input.link.len > 0:
    # A link's QR code: over everything, the keyboard gone (events.openLink).
    input.open = 0
    linkCard(input.link, w, height.float32, input, result.children, gradients, regions)
  elif kb > 0:
    let keys = keyboardTree(width, kb, input.page, input.shift, input.paper, input.round, kbTop,
      height, input.accents, input.flash).build(initText(), w, kb.float32, 0, KeyboardKey, input, false,
      if memo.isNil: nil else: memo.keyboard)
    keys.size = keys.layout(w, kb.float32, true, true)
    keys.y = h
    keys.emit(0, 0, 1, result.children, gradients, regions)
    if input.flash > 0:
      input.flashDrawn = true
    if not memo.isNil:
      memo.keyboard = keys
    if input.accents > 0:
      # The held key's accents, over the keyboard, from where it drew the key
      # (none when the page turned and the key is gone).
      var shown = false
      for i in countdown(regions.high, 0):
        if regions[i].handlers[ueClick] - 1 == KeyBase + input.accents:
          let key = regions[i]
          shown = key.accentPopup(width, height, input, result.children, gradients, regions)
          break
      if not shown:
        input.accents = 0
  else:
    input.accents = 0
  if input.accents == 0:
    input.accentLit = -1
  if input.handles or input.menu:
    # A selection made by touch: its handles and its menu, on top of it all.
    # The selection's ends the field left (one-pixel regions), taken back out.
    var
      at: array[2, array[3, float32]]
      seen: array[2, bool]
      k = 0
    for i in 0 ..< regions.len:
      let e = regions[i].key - EndsKey
      if e == 0 or e == 1:
        at[e] = [regions[i].x, regions[i].y, regions[i].h]
        seen[e] = true
      else:
        if k != i: regions[k] = regions[i]
        inc k
    regions.setLen(k)
    if seen[0] or seen[1]:
      if not seen[0]: at[0] = at[1]
      if not seen[1]: at[1] = at[0]
      selectionChrome(at, seen, width, height, input, result.children, gradients, regions)
    elif not endsFound:
      input.handles = false
      input.menu = false
  if input.focus > 0 and not focusSeen:
    # The field is gone: nothing has the keyboard.
    input.focus = 0
    input.keyboard = false
  if not memo.isNil:
    # What this layout did not use waits one more layout, 64 entries at
    # most, as it always did; what waited before it stays behind it, newest
    # first, TextMemoWaitingBytes of it at most. A text that comes back a
    # few layouts later (a switch's "On" and "Off", a count going up and
    # down) is not set in type again: waiting one layout only, it was set
    # again at every toggle of the Home sample.
    var waiting = move(memo.last)
    if waiting.len > 64:
      waiting.setLen(64)
    var bytes = 0
    for i in 0 ..< memo.older.len:
      let cost = memo.older[i].waitingBytes
      if waiting.len >= 64 or bytes + cost > TextMemoWaitingBytes:
        break
      bytes += cost
      waiting.add move(memo.older[i])
    memo.older = move(waiting)
    memo.last = move(memo.kept)
    memo.root = top
    memo.rootW = w
    memo.rootH = h
    memo = nil
  ui = nil

proc source*(memo: UiMemo): SvgNode =
  ## The tree the last layout was built from: the one handed in, or, when
  ## nothing in it had changed, the one the layout before had kept. A caller
  ## that keeps the tree keeps this one, not an equal second.
  if memo.isNil or memo.root.isNil: nil else: memo.root.src

proc layoutUi*(root: SvgNode, width, height: int): SvgNode =
  var
    regions: seq[UiRegion]
    input: UiInput
  layoutUi(root, width, height, input, regions)

proc seekHoles(n: UiNode, ox, oy, opacity: float32, scrolled, yieldReady: bool, holes: var UiHoles) =
  ## In paint order, as `emit` walks: each `<Scene>` and `<yield />`, then
  ## whether anything painted after it lands on it.
  template b: untyped = n.box
  let op = opacity * b.opacity
  if b.display == diNone or op <= 0:
    return
  let
    x = round(ox + n.x)
    y = round(oy + n.y)
    w = round(ox + n.x + n.size.x) - x
    h = round(oy + n.y + n.size.y) - y
  if n.kind != ukBox or b.bg.a > 0 or b.gradient > 0 or b.border[0] + b.border[1] + b.border[2] + b.border[3] > 0:
    for i in 0 ..< holes.count:
      template hole: untyped = holes.items[i]
      if x < hole.x + hole.w and x + w > hole.x and y < hole.y + hole.h and y + h > hole.y:
        hole.clean = false
  if n.kind == ukImage and n.src.tag == "Scene":
    let
      yields = n.src.attr("id") == SceneYieldId
      cw = w - b.padX
      ch = h - b.padY
    if cw <= 0 or ch <= 0 or holes.count == MaxHoles or (yields and not yieldReady):
      return
    if yields:
      if holes.firstYield > 0:
        # The same scene in two places is drawn as pictures.
        holes.items[holes.firstYield - 1].clean = false
        return
      holes.firstYield = holes.count + 1
    holes.items[holes.count] = UiHole(x: x + b.pad[3] + b.border[3], y: y + b.pad[0] + b.border[0], w: cw, h: ch,
      clean: op >= 1 and not scrolled and n.x >= 0 and n.y >= 0)
    inc holes.count
    return
  if n.kind != ukBox:
    return
  # A box that clips and has nothing out of sight clips nothing.
  let moves = scrolled or (b.overflowX != ovVisible or b.overflowY != ovVisible) and (n.maxX > 0 or n.maxY > 0)
  for pass in [false, true]:
    for c in n.children:
      if c.box.absolute == pass:
        c.seekHoles(x, y, op, moves, yieldReady, holes)

proc seekHoles*(memo: UiMemo, input: UiInput, yieldReady: bool): UiHoles =
  ## Where the embedded scenes of the UI just laid out sit, in its own pixels,
  ## and which can be holes: fully opaque, nothing painted over them, not in
  ## anything that scrolls, and for `<yield />` only one and a scene to wrap. A
  ## popup or a held key's accents can land on any, so a UI showing one is drawn
  ## the slow way until it goes.
  if memo.isNil or memo.root.isNil:
    return
  memo.root.seekHoles(0, 0, 1, false, yieldReady, result)
  if input.open > 0 or input.accents > 0 or input.link.len > 0:
    for i in 0 ..< result.count:
      result.items[i].clean = false

proc indexAt*(holes: UiHoles, x, y: float32): int =
  ## The clean hole at this place in the UI, -1 for none.
  for i in 0 ..< holes.count:
    if holes.items[i].clean and abs(holes.items[i].x - x) < 0.5 and abs(holes.items[i].y - y) < 0.5:
      return i
  -1

{.pop.}
