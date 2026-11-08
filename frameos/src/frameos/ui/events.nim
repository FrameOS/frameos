## The pointer over JSX UIs (docs/jsx-ui.md "Events"): where the last render
## of each one put the elements the pointer can do something to, and what a
## tap, a press or a move over them does.
##
## One target per app node that draws a UI. The interpreter hands it the
## pointer events of its scene (runEventInner, every host) and renders again
## when one changed something: a handler ran, or the elements the pointer is
## over or pressing are not the ones the last render drew. The next layout
## reads those (`input`) for its hover:, active: and group-hover: classes.
##
## A press is captured, as a browser captures a touch: the innermost element
## with an onPointerDown or onPointerMove under it gets that pointer's moves
## and its release until it lifts, wherever they land (`captures`), with
## localX / localY still from its corner, so a slider follows a finger that
## slides off its end. A move with no press goes to the element under it.
## Every call also says how big the element is (`width`, `height`), so a
## slider works out how far along it a finger is at any frame size.
##
## Time passes for the keyboard on the screen too (`uiTimerDue`, asked by the
## dispatcher's tick, which sends the scene `uiTimer`): a key just typed
## stays lit for a moment once a render has shown it, and backspace held
## erases again and again until the finger lifts.

import std/[json, monotimes, times]
import frameos/events_gen
import frameos/ui/layout
import frameos/ui/keyboard

type
  UiHit* = array[4, float32]
    ## Where in an element the pointer is, from its corner, and the
    ## element's size: localX, localY, width, height. One array for the
    ## four, not four arguments: on the ESP32 each argument past the sixth
    ## goes on the stack at every call.
  UiHandlerCall* = proc(handler: int, name: string, event: JsonNode, hit: UiHit) {.closure, raises: [].}
    ## Runs handler number `handler` of the UI's last render, in its app,
    ## with the event, where in the element it landed and the element's size.

  UiTarget* = ref object
    sceneId*: string
    nodeId*: int
    offsetX*, offsetY*: float32 ## the UI's corner in the scene's canvas
    scale*: float32             ## canvas pixels per layout pixel (render_scale.nim); 0 = 1
    regions*: seq[UiRegion]     ## the last render's, in paint order
    input*: UiInput             ## what the pointer and the keyboard are doing, for the next one
    memo*: UiMemo               ## the last layout's type, for the next one
    inputOnly*: bool            ## the pointer changed what it is over or
                                ## pressing, and no handler ran: the next
                                ## render needs no new tree (app_runtime.get)
    captures*: seq[(int, int)]  ## (pointerId, region key) of each press held
    call*: UiHandlerCall
    # A press on a box that scrolls: the pointer, the box, where the press
    # began and how far the box was scrolled then; `dragging` once it moved
    # far enough to be a scroll rather than a tap.
    dragPointer, dragKey: int
    dragX, dragY, dragSX, dragSY: float32
    dragging, dragged: bool
    holdPointer: int            ## the pointer whose hold opened a key's accents, -1 for none
    # A key held that types again (backspace): its pointer (-1 for none), the
    # key, when it next types and how many times it has.
    repeatPointer, repeatCode, repeats: int
    repeatDue: MonoTime
    # The key just typed (`input.flash`): when it goes out, once a render
    # has shown it (`flashSeen`).
    flashDue: MonoTime
    flashSeen: bool
    # A finger that went down on the space bar (-1 for none): where, in the
    # UI's pixels, how far apart its steps are, the steps it has made the
    # caret take, and whether it moved enough to be a drag. A drag's tap
    # (the one its release makes) types no space (`swallowTap`).
    spacePointer: int
    spaceX, spaceY, spaceStep, spaceRow: float32
    spaceCols, spaceRows: int
    spaceDragging: bool
    swallowTap: int

const
  MaxTargets = 16
  FlashMs = 250
    ## How long a key just typed stays lit after a render first shows it.
  RepeatFirstMs = 100
  RepeatFastMs = 50
  RepeatFastAfter = 12
    ## Backspace held: one erase at the long press, then one every
    ## RepeatFirstMs, every RepeatFastMs after RepeatFastAfter of them.

# Flash on an ESP32: no checks the code above them already makes, and
# nothing raises (see ui/layout.nim).
{.push boundChecks: off, overflowChecks: off, rangeChecks: off, raises: [].}

var
  targets {.threadvar.}: seq[UiTarget]
  physicalKeyboard {.threadvar.}: bool
    ## A key was typed on a keyboard: fields need no keyboard on the screen.

when defined(testing):
  proc forgetTypedKeys*() =
    ## Tests: as if no key had been typed on a keyboard yet.
    physicalKeyboard = false

proc uiTarget*(sceneId: string, nodeId: int, create = true): UiTarget =
  ## The target of an app node's UI; nil when it has none and `create` is off.
  for target in targets:
    if target.sceneId == sceneId and target.nodeId == nodeId:
      return target
  if create:
    if targets.len >= MaxTargets:
      targets.delete(0)
    result = UiTarget(sceneId: sceneId, nodeId: nodeId, memo: UiMemo(), dragKey: -1, holdPointer: -1,
      repeatPointer: -1, spacePointer: -1, swallowTap: -1)
    result.input.accentLit = -1
    targets.add result

proc forgetUiTarget*(sceneId: string, nodeId: int) =
  ## The app node's scene is torn down: its regions, what the pointer was
  ## doing over them and its way into the app go with it. A target kept
  ## called the app the scene had before, which was gone.
  for i in countdown(targets.high, 0):
    if targets[i].sceneId == sceneId and targets[i].nodeId == nodeId:
      targets.delete(i)

proc uiSceneEvent*(sceneId: string) =
  ## Anything but the pointer happened to the scene (a state change, a
  ## button, a scheduled event): its UIs' next render runs get() again.
  for target in targets:
    if target.sceneId == sceneId:
      target.inputOnly = false

proc handlerKind(event: string): int =
  ## The UiEvent a pointer event runs handlers for, or -1.
  case event
  of "tap": ord(ueClick)
  of "doubleTap": ord(ueDoubleClick)
  of "longPress": ord(ueLongPress)
  of "pointerDown": ord(uePointerDown)
  of "pointerUp": ord(uePointerUp)
  of "pointerMove": ord(uePointerMove)
  of "swipe": ord(ueSwipe)
  else: -1

proc timerPending(target: UiTarget): bool =
  target.input.flash > 0 or target.repeatPointer >= 0

proc uiTimersPending*(): bool =
  ## Whether a UI is timing something (a key's light, a key held): a host
  ## that ticks only while input is held keeps ticking.
  for target in targets:
    if target.timerPending:
      return true

proc uiTimerDue*(sceneId: string, now: MonoTime): bool =
  ## Whether a UI of the scene showing has a timer due: the dispatcher's tick
  ## asks, and sends the scene `uiTimer`. A key's light starts its time when
  ## a render has shown it. A held key of a scene no longer showing lets go:
  ## its release went to another scene.
  for target in targets:
    if target.sceneId != sceneId:
      target.repeatPointer = -1
      continue
    if target.input.flash > 0 and target.input.flashDrawn:
      if not target.flashSeen:
        target.flashSeen = true
        target.flashDue = now + initDuration(milliseconds = FlashMs)
      elif now >= target.flashDue:
        result = true
    if target.repeatPointer >= 0 and now >= target.repeatDue:
      result = true

template scrolls(r: UiRegion): bool = r.scrollX > 0 or r.scrollY > 0

template inside(r: UiRegion, lx, ly: float32): bool =
  ## Under the point, where it shows (a box that scrolls cuts off the rest).
  lx >= r.visible[0] and ly >= r.visible[1] and lx < r.visible[2] and ly < r.visible[3]

proc wants(r: UiRegion, event: string): bool =
  case event
  of "pointerMove": r.hover or r.group or r.handlers[uePointerMove] > 0 or r.scrolls
  of "pointerDown", "pointerUp", "pointerCancel":
    r.active or r.hover or r.group or r.handlers[uePointerDown] > 0 or
      r.handlers[uePointerUp] > 0 or r.handlers[uePointerMove] > 0 or r.scrolls
  of "tap": r.field > 0 or r.handlers[ueClick] > 0
  of "wheel": r.scrolls
  else:
    let kind = handlerKind(event)
    kind >= 0 and r.handlers[UiEvent(kind)] > 0

proc uiListens*(sceneId, event: string): bool =
  ## Whether a UI in the scene wants `event`: the dispatcher builds a pointer
  ## event only for a scene that listens (event_loop.nim). A field with the
  ## keyboard wants keys, and a tap anywhere (one elsewhere puts it away);
  ## a key's accents want the finger that holds it, wherever it slides.
  for target in targets:
    if target.sceneId == sceneId:
      if target.input.focus > 0 and event in ["tap", "keyDown", "textInput"]:
        return true
      if target.input.accents > 0 and event in ["pointerMove", "pointerUp", "pointerCancel"]:
        return true
      if target.input.keyboard and event in ["pointerDown", "pointerUp", "pointerCancel"]:
        return true # a key held lets go, the space bar may be dragged
      if target.spacePointer >= 0 and event == "pointerMove":
        return true
      if event == "uiTimer" and target.timerPending:
        return true
      for r in target.regions:
        if r.wants(event):
          return true

proc keyboardAt*(sceneId: string, x, y: float32): bool =
  ## Whether the scene's keyboard on the screen is under (x, y), in its
  ## canvas's pixels, as the last render drew it. The dispatcher asks of a
  ## press (input_state.nim): the keyboard's outer keys reach the screen's
  ## edges, and a finger there is a key, never an edge swipe.
  for target in targets:
    if target.sceneId == sceneId and target.input.keyboard:
      let
        scale = if target.scale > 0: target.scale else: 1'f32
        lx = (x - target.offsetX) / scale
        ly = (y - target.offsetY) / scale
      for r in target.regions:
        # The keyboard's own box: its handler is the one between the keys.
        if r.handlers[ueClick] - 1 == KeyBase and r.inside(lx, ly):
          return true

proc nearestKey(target: UiTarget, lx, ly: float32): int =
  ## The key of the keyboard on the screen nearest (lx, ly), by its byte; -1
  ## when none was drawn. A tap between the keys, or in the keyboard's margin
  ## at the very edge of the screen, is the key beside it, as on a phone.
  result = -1
  var best = high(float32)
  for r in target.regions:
    let code = r.handlers[ueClick] - 1 - KeyBase
    if code <= 0 or code >= AccentBase - KeyBase:
      continue # not a key: the app's, the keyboard's own box, or an accent
    let
      dx = max(max(r.visible[0] - lx, lx - r.visible[2]), 0)
      dy = max(max(r.visible[1] - ly, ly - r.visible[3]), 0)
    if dx * dx + dy * dy < best:
      best = dx * dx + dy * dy
      result = code

proc accentNear(target: UiTarget, lx, ly: float32): int =
  ## The accent whose x is nearest lx, by its number, while the finger is
  ## no further from the row than the key it holds (above the row, or two
  ## rows below it); -1 when it is, -2 when the last render drew no row.
  result = -2
  var
    best = high(float32)
    top = high(float32)
    bottom = 0'f32
  for r in target.regions:
    let handler = r.handlers[ueClick] - 1
    if handler < AccentBase or handler >= OptionBase:
      continue
    top = min(top, r.y)
    bottom = max(bottom, r.y + r.h)
    let d = abs(lx - (r.x + r.w / 2))
    if d < best:
      best = d
      result = handler - AccentBase
  if result >= 0 and (ly < top - (bottom - top) or ly > bottom + 3 * (bottom - top)):
    result = -1

proc keysOver(target: UiTarget, lx, ly: float32, active: bool): seq[int] =
  ## The elements under the point: hover ones (and groups), or active ones.
  for r in target.regions:
    if (if active: r.active else: r.hover or r.group) and r.inside(lx, ly):
      result.add r.key

proc captureOf(target: UiTarget, pointer: int): int =
  ## The key of the element holding the pointer's press, -1 for none.
  for (held, key) in target.captures:
    if held == pointer:
      return key
  -1

proc release(target: UiTarget, pointer: int) =
  for i in countdown(target.captures.high, 0):
    if target.captures[i][0] == pointer:
      target.captures.delete(i)

proc regionOf(target: UiTarget, key: int): int =
  ## The last render's region for the element at `key`, -1 when it drew none.
  for i in 0 ..< target.regions.len:
    if target.regions[i].key == key:
      return i
  -1

# ------------------------------------------------------------------ fields

proc focusField(target: UiTarget, r: UiRegion, lx, ly: float32) =
  ## A tap on a field: it has the keyboard, the caret where the tap landed
  ## (the next layout knows the glyphs), and the keyboard on the screen
  ## unless the frame has one of its own.
  template i: untyped = target.input
  if i.focus != r.key + 1:
    i.focus = r.key + 1
    i.text = target.memo.fieldText(r.key)
    i.page = if r.field == 3: kpNumbers else: kpLetters
    i.shift = 0
    i.accents = 0
  i.caret = i.text.len
  i.place = true
  i.goal = false
  i.lineStep = 0
  i.placeX = lx - r.x
  i.placeY = ly - r.y
  i.keyboard = not physicalKeyboard
  i.reveal = true
  target.inputOnly = true

proc blurField(target: UiTarget) =
  ## Nothing has the keyboard: it goes away.
  target.input.focus = 0
  target.input.keyboard = false
  target.input.place = false
  target.input.accents = 0
  target.inputOnly = true

proc dismissKeyboard*(sceneId: string, nodeId: int): bool =
  ## `back` while a field has the keyboard or a <select> its list, as on a
  ## phone: the field lets go and the keyboard goes away, or the list closes.
  ## With a key's accents up, those go first. False when none was up.
  let target = uiTarget(sceneId, nodeId, create = false)
  if target.isNil or (target.input.focus == 0 and target.input.open == 0):
    return false
  if target.input.accents > 0:
    target.input.accents = 0
    target.inputOnly = true
    return true
  target.input.open = 0
  target.blurField()
  true

proc changeOf(value: string): JsonNode =
  ## What a field's or a <select>'s onChange hears.
  result = newJObject()
  result["value"] = newJString(value)

proc pickOption(target: UiTarget, code: int) =
  ## A tap on option `code` of an open <select>'s list, which its onChange
  ## hears as `value`, as a field's text. The list closes.
  var change = 0
  let value = target.memo.selectOption(target.input.open - 1, code, change)
  target.input.open = 0
  target.inputOnly = true
  if change > 0:
    target.call(change - 1, "change", changeOf(value), [0'f32, 0, 0, 0])
    target.inputOnly = false # whatever the handler changed, get() shows it

proc fieldCall(target: UiTarget, kind: UiEvent, name: string, payload: JsonNode) =
  ## The focused field's onChange or onKeyDown, if it has one.
  let i = target.regionOf(target.input.focus - 1)
  if i >= 0 and target.regions[i].handlers[kind] > 0 and not target.call.isNil:
    target.call(target.regions[i].handlers[kind] - 1, name, payload,
      [0'f32, 0, target.regions[i].w, target.regions[i].h])
    target.inputOnly = false # whatever the handler changed, get() shows it

proc keyDown(target: UiTarget, key: string) =
  let payload = newJObject()
  payload["key"] = newJString(key)
  target.fieldCall(ueKeyDown, "keyDown", payload)

proc changed(target: UiTarget) =
  ## The field's text changed: its onChange hears it as `value` (a JS app as
  ## React's `target.value` too), and the next render shows what the app
  ## made of it.
  template i: untyped = target.input
  i.place = false
  i.goal = false
  i.lineStep = 0
  i.reveal = true
  target.fieldCall(ueChange, "change", changeOf(i.text))
  target.inputOnly = false

proc insert(target: UiTarget, text: string) =
  template i: untyped = target.input
  i.caret = clamp(i.caret, 0, i.text.len)
  i.text.insert(text, i.caret)
  i.caret += text.len
  if i.shift == 1:
    i.shift = 0
  target.changed()

proc step(text: string, at: int, forward: bool): int =
  ## The next rune's start after (or before) byte `at`.
  result = at
  if forward:
    if result < text.len:
      inc result
      while result < text.len and (ord(text[result]) and 0xC0) == 0x80:
        inc result
  elif result > 0:
    dec result
    while result > 0 and (ord(text[result]) and 0xC0) == 0x80:
      dec result

proc erase(target: UiTarget, forward: bool) =
  ## Backspace (the rune before the caret) or Delete (the one after).
  template i: untyped = target.input
  i.caret = clamp(i.caret, 0, i.text.len)
  let
    other = step(i.text, i.caret, forward)
    a = min(i.caret, other)
    b = max(i.caret, other)
  if b > a:
    i.text = i.text[0 ..< a] & i.text[b .. ^1]
    i.caret = a
    target.changed()

proc enter(target: UiTarget) =
  ## Enter: a line in a <textarea>; elsewhere the field is done.
  target.keyDown("Enter")
  let r = target.regionOf(target.input.focus - 1)
  if r >= 0 and target.regions[r].field == 2:
    target.insert("\n")
  else:
    target.blurField()

proc flashKey(target: UiTarget, code: int) =
  ## The key just typed stays lit for a moment once a render shows it
  ## (`uiTimerDue`), so a quick tap says which key it was. Not on e-paper,
  ## where a refresh to put the light out costs seconds.
  if target.input.paper:
    return
  target.input.flash = code
  target.input.flashDrawn = false
  target.flashSeen = false

proc pressKey(target: UiTarget, code: int) =
  ## A key of the on-screen keyboard (ui/keyboard.nim): a character typed,
  ## or what its byte stands for.
  template i: untyped = target.input
  target.inputOnly = true
  i.accents = 0
  if code >= 32 or code == ord(kBackspace) or code == ord(kEnter):
    target.flashKey(code)
  if code == ord(kShift): i.shift = if i.shift == 0: 1 else: 0
  elif code == ord(kCapsLock): i.shift = 2
  elif code == ord(kBackspace):
    target.keyDown("Backspace")
    target.erase(false)
  elif code == ord(kEnter): target.enter()
  elif code == ord(kLetters): i.page = kpLetters
  elif code == ord(kSymbols): i.page = kpSymbols
  elif code == ord(kMore): i.page = kpMore
  elif code >= 32:
    let text = typed(code, i.shift)
    target.keyDown(text)
    target.insert(text)

proc holdKey(target: UiTarget, code, pointer: int, lx: float32) =
  ## A key held (`longPress`, while the finger is still down at `lx`): its
  ## accents come up above it, the one nearest the finger's x lit, for that
  ## finger to slide along and lift on, or to lift away from and tap one
  ## (ui/keyboard.nim `Accents`, drawn by ui/layout.nim). Backspace erases,
  ## and goes on erasing until the finger lifts (`uiTimer`). A key with
  ## neither has no long-press handler, so this never sees one.
  template i: untyped = target.input
  if code == ord(kBackspace):
    target.pressKey(code)
    if i.paper:
      return # one: a refresh a character is seconds
    target.repeatPointer = pointer
    target.repeatCode = code
    target.repeats = 0
    target.repeatDue = getMonoTime() + initDuration(milliseconds = RepeatFirstMs)
    return
  if accentCount(code) == 0:
    return
  i.accents = code
  i.accentX = lx
  i.accentLit = -1
  i.pressed.setLen(0)
  target.holdPointer = pointer
  target.inputOnly = true

proc timePassed(target: UiTarget, now: MonoTime): bool =
  ## `uiTimer`: a key's light goes out, a held key types again. True when
  ## the picture changed.
  template i: untyped = target.input
  if i.flash > 0 and target.flashSeen and now >= target.flashDue:
    i.flash = 0
    i.flashDrawn = false
    target.flashSeen = false
    target.inputOnly = true
    result = true
  if target.repeatPointer >= 0 and now >= target.repeatDue:
    if i.focus == 0 or not i.keyboard:
      target.repeatPointer = -1
    else:
      inc target.repeats
      target.pressKey(target.repeatCode)
      target.repeatDue = now + initDuration(milliseconds =
        if target.repeats >= RepeatFastAfter: RepeatFastMs else: RepeatFirstMs)
      result = true

proc pickAccent(target: UiTarget, index: int) =
  ## Accent number `index` of the held key, typed as a key is (a capital
  ## under shift); the row goes away. Once: the release that picked it is
  ## followed by no tap, but a tap on a row the next render has not yet
  ## taken down finds nothing to pick.
  template i: untyped = target.input
  if i.accents == 0:
    return
  let text = accentText(i.accents, index, i.shift)
  i.accents = 0
  target.inputOnly = true
  if text.len > 0:
    target.keyDown(text)
    target.insert(text)

proc moveCaret(target: UiTarget, key: string) =
  ## An arrow, Home or End: the caret a rune, a line or to an end. A key on a
  ## keyboard, or the space bar dragged.
  template i: untyped = target.input
  case key
  of "ArrowLeft", "ArrowRight", "Home", "End":
    i.caret =
      if key == "Home": 0
      elif key == "End": i.text.len
      else: step(i.text, clamp(i.caret, 0, i.text.len), key == "ArrowRight")
    i.place = false
    i.goal = false
    i.reveal = true
    target.inputOnly = true
  of "ArrowUp", "ArrowDown":
    # A line up or down in a <textarea>, by the next layout (it knows the
    # lines); the start or the end of an <input>, as in a browser.
    let
      up = key == "ArrowUp"
      r = target.regionOf(i.focus - 1)
    if r >= 0 and target.regions[r].field == 2:
      i.lineStep = if up: -1 else: 1
    else:
      i.caret = if up: 0 else: i.text.len
    i.place = false
    i.reveal = true
    target.inputOnly = true
  else: discard

proc spaceDrag(target: UiTarget, lx, ly: float32, slop: float32): bool =
  ## The space bar held and dragged, as on a phone: the caret follows the
  ## finger, a rune per step across and a line per row up or down, as the
  ## arrow keys would (the field's onKeyDown hears them). True when it moved.
  let
    dx = lx - target.spaceX
    dy = ly - target.spaceY
  if not target.spaceDragging:
    if abs(dx) <= slop and abs(dy) <= slop:
      return false
    target.spaceDragging = true
  let
    cols = int(dx / target.spaceStep)
    rows = int(dy / target.spaceRow)
  while target.spaceCols != cols:
    let key = if cols > target.spaceCols: "ArrowRight" else: "ArrowLeft"
    target.spaceCols += (if cols > target.spaceCols: 1 else: -1)
    target.keyDown(key)
    target.moveCaret(key)
    result = true
  if target.spaceRows != rows:
    # One line a layout: it knows where the lines are.
    let key = if rows > target.spaceRows: "ArrowDown" else: "ArrowUp"
    target.spaceRows += (if rows > target.spaceRows: 1 else: -1)
    target.keyDown(key)
    target.moveCaret(key)
    result = true

when not defined(frameosEmbedded):
  # No keyboard on an ESP32 (docs/events.md "Input"): typed keys and the
  # wheel are Linux's and the preview's.
  proc typedKey(target: UiTarget, event: string, payload: JsonNode) =
    ## A key typed on a keyboard, into the focused field: `textInput` is the
    ## text, `keyDown` everything else (and the field's onKeyDown).
    template i: untyped = target.input
    physicalKeyboard = true
    if i.keyboard:
      i.keyboard = false # typed on: no keyboard on the screen
      target.inputOnly = true
    if event == "textInput":
      target.insert(payload{"text"}.getStr())
      return
    target.fieldCall(ueKeyDown, "keyDown", payload)
    case payload{"key"}.getStr()
    of "Backspace": target.erase(false)
    of "Delete": target.erase(true)
    of "Enter": target.enter()
    of "Escape": target.blurField()
    else: target.moveCaret(payload{"key"}.getStr())

  proc wheel(target: UiTarget, r: UiRegion, payload: JsonNode) =
    ## A wheel over a box that scrolls: 48 px a notch.
    var (sx, sy) = target.input.scrolled(r.key)
    sx = clamp(sx + payload{"deltaX"}.getFloat() * 48, 0, r.scrollX)
    sy = clamp(sy + payload{"deltaY"}.getFloat() * 48, 0, r.scrollY)
    target.input.scrollTo(r.key, sx, sy)
    target.inputOnly = true

# ------------------------------------------------------------------ dispatch

proc dispatchUiEvent*(sceneId, event: string, payload: JsonNode): bool =
  ## Hands a pointer event, or a key for a field, to the scene's UIs. True
  ## when the frame should render again: a handler ran (whatever it changed,
  ## the picture is the UI's), what the pointer is over or pressing changed,
  ## a field's text or caret moved, or a box scrolled.
  let
    # The event as its handler kind, compared as a number from here on.
    kind = handlerKind(event)
    down = kind == ord(uePointerDown)
    released = event in ["pointerUp", "pointerCancel"]
    placed = not payload.isNil and payload.kind == JObject and payload.hasKey("x") and payload.hasKey("y")
    # A swipe belongs to where it began: a card swiped is the card the finger
    # went down on, wherever it lifted.
    starts = placed and kind == ord(ueSwipe) and payload.hasKey("startX") and payload.hasKey("startY")
    x = if starts: payload{"startX"}.getFloat() elif placed: payload{"x"}.getFloat() else: 0
    y = if starts: payload{"startY"}.getFloat() elif placed: payload{"y"}.getFloat() else: 0
    touch = placed and payload{"pointerType"}.getStr() == "touch"
    pointer = if payload.isNil or payload.kind != JObject: 0 else: payload{"pointerId"}.getInt(0)
    follows = event in ["pointerMove", "pointerUp", "pointerCancel"]
  var
    handled = false
    capturing: UiTarget # the UI holding this pointer's press, if one does
  if follows:
    for target in targets:
      if target.sceneId == sceneId and target.captureOf(pointer) >= 0:
        capturing = target
        break
  if event == "uiTimer":
    let now = getMonoTime()
    for target in targets:
      if target.sceneId == sceneId and target.timePassed(now):
        result = true
    return
  for target in targets:
    if target.sceneId != sceneId:
      continue
    when not defined(frameosEmbedded):
      if event in ["keyDown", "textInput"]:
        if target.input.open > 0 and payload{"key"}.getStr() == "Escape":
          target.input.open = 0
          target.inputOnly = true
          result = true
        elif target.input.focus > 0:
          target.typedKey(event, payload)
          result = true
        continue
    var moved = false
    let captured = if follows: target.captureOf(pointer) else: -1
    # The regions are in the UI's own pixels: at render scale 2 a UI laid out
    # at half the canvas's size is drawn twice as large.
    let
      scale = if target.scale > 0: target.scale else: 1'f32
      lx = (x - target.offsetX) / scale
      ly = (y - target.offsetY) / scale
    # A press on a box that scrolls drags it once it moves: from then on the
    # moves scroll it and press nothing.
    if target.dragKey >= 0 and target.dragPointer == pointer and (follows or down):
      let r = target.regionOf(target.dragKey)
      if r < 0 or down:
        target.dragKey = -1
      elif kind == ord(uePointerMove) and placed:
        let
          dx = x - target.dragX
          dy = y - target.dragY
          box = target.regions[r]
        if not target.dragging and (box.scrollX > 0 and abs(dx) > GestureTapSlopPx or
            box.scrollY > 0 and abs(dy) > GestureTapSlopPx):
          target.dragging = true
          target.input.pressed.setLen(0)
        if target.dragging:
          target.input.scrollTo(box.key,
            # The finger moved in the canvas's pixels; the box scrolls in the UI's.
            if box.scrollX > 0: clamp(target.dragSX - dx / scale, 0, box.scrollX) else: target.dragSX,
            if box.scrollY > 0: clamp(target.dragSY - dy / scale, 0, box.scrollY) else: target.dragSY)
          target.inputOnly = true
          # E-paper shows where it got to when the finger lifts.
          result = result or not target.input.paper
          continue
      elif released:
        target.dragKey = -1
        if target.dragging:
          target.dragging = false
          target.dragged = true
          result = true
    if target.repeatPointer == pointer and (released or down):
      target.repeatPointer = -1 # backspace let go
    if target.holdPointer == pointer and (follows or down):
      # The finger that holds a key, its accents up: the accent nearest its
      # x lights, wherever it is along the row, and lifting types it. Gone
      # far from the row, none is lit, and lifted there the row stays for a
      # tap.
      if down or target.input.accents == 0:
        target.holdPointer = -1
      elif kind == ord(uePointerMove) and placed:
        # Not drawn yet (-2): the layout lights the one nearest the x.
        let near = target.accentNear(lx, ly)
        target.input.accentX = if near == -1: -1 else: lx
        if near >= -1 and near != target.input.accentLit:
          # E-paper shows which once the finger lifts on it.
          moved = not target.input.paper
      elif released:
        target.holdPointer = -1
        # Lifted on the row's x, the accent there; far from it, or before a
        # render drew the row, the row stays for a tap.
        let near = if placed and event == "pointerUp": target.accentNear(lx, ly) else: -1
        target.input.accentX = -1
        if near >= 0:
          target.pickAccent(near)
          result = true
        else:
          moved = true
    if target.spacePointer == pointer and (follows or down):
      if down:
        target.spacePointer = -1
      elif kind == ord(uePointerMove) and placed:
        if target.input.focus > 0 and target.spaceDrag(lx, ly, float32(GestureTapSlopPx) / scale):
          moved = true
      elif released:
        if target.spaceDragging:
          target.swallowTap = pointer # its tap types no space
        target.spacePointer = -1
    if released:
      target.release(pointer)
      if target.input.pressed.len > 0:
        target.input.pressed.setLen(0)
        moved = true
      # A finger that lifts is not over anything any more.
      if touch and target.input.hovered.len > 0:
        target.input.hovered.setLen(0)
        moved = true
    if placed and (down or kind == ord(uePointerMove)):
      let hovered = target.keysOver(lx, ly, false)
      if hovered != target.input.hovered:
        target.input.hovered = hovered
        moved = true
      if down:
        let pressed = target.keysOver(lx, ly, true)
        if pressed != target.input.pressed:
          target.input.pressed = pressed
          moved = true
        # The space bar: held, the finger may drag the caret.
        target.swallowTap = -1
        if target.input.keyboard and target.input.focus > 0:
          for r in target.regions:
            if r.handlers[ueClick] - 1 == KeyBase + ord(' ') and r.inside(lx, ly):
              target.spacePointer = pointer
              target.spaceX = lx
              target.spaceY = ly
              target.spaceStep = max(r.h * 0.45, 4)
              target.spaceRow = max(r.h, 8)
              target.spaceCols = 0
              target.spaceRows = 0
              target.spaceDragging = false
              break
        # The innermost element that takes a press holds the pointer; else
        # the innermost box that scrolls may be dragged.
        target.release(pointer)
        target.dragged = false
        for i in countdown(target.regions.high, 0):
          let r = target.regions[i]
          if (r.handlers[uePointerDown] > 0 or r.handlers[uePointerMove] > 0) and r.inside(lx, ly):
            target.captures.add((pointer, r.key))
            break
        if target.captureOf(pointer) < 0:
          for i in countdown(target.regions.high, 0):
            let r = target.regions[i]
            if r.scrolls and r.inside(lx, ly):
              (target.dragSX, target.dragSY) = target.input.scrolled(r.key)
              target.dragKey = r.key
              target.dragPointer = pointer
              target.dragX = x
              target.dragY = y
              target.dragging = false
              break
    when not defined(frameosEmbedded):
      if event == "wheel" and placed:
        for i in countdown(target.regions.high, 0):
          if target.regions[i].scrolls and target.regions[i].inside(lx, ly):
            target.wheel(target.regions[i], payload)
            result = true
            break
    if kind == ord(ueSwipe) and target.dragged:
      # The swipe a drag made scrolled the box: nothing else hears it.
      target.dragged = false
      continue
    if kind == ord(ueClick) and target.swallowTap >= 0 and target.swallowTap == pointer:
      # The tap a drag of the space bar made on its release: no space.
      target.swallowTap = -1
      if moved:
        target.inputOnly = true
        result = true
      continue
    if kind == ord(ueClick) and placed:
      # A tap on a field gives it the keyboard; one anywhere else but the
      # keyboard takes it away, and then does what it does.
      var hit = -1
      for i in countdown(target.regions.high, 0):
        let r = target.regions[i]
        if (r.field > 0 or r.handlers[ueClick] > 0) and r.inside(lx, ly):
          hit = i
          break
      if target.input.accents > 0 and (hit < 0 or
          target.regions[hit].handlers[ueClick] - 1 < AccentBase or
          target.regions[hit].handlers[ueClick] - 1 >= OptionBase):
        # A key's accents are up: a tap on one picks it (below); one
        # anywhere else puts the row away, and then does what it does.
        target.input.accents = 0
        moved = true
      if target.input.open > 0:
        # The list is all there is to touch: around it, it closes.
        if hit < 0:
          target.input.open = 0
          moved = true
      elif hit >= 0 and target.regions[hit].field == 4:
        # A <select>: its list opens (the keyboard goes first), the next
        # layout knowing where the select is once it has gone.
        if target.input.focus > 0:
          target.blurField()
        target.input.open = target.regions[hit].key + 1
        target.input.fresh = true
        moved = true
      elif hit >= 0 and target.regions[hit].field > 0:
        target.focusField(target.regions[hit], lx, ly)
        moved = true
      elif target.input.focus > 0 and (hit < 0 or target.regions[hit].handlers[ueClick] <= KeyBase):
        target.blurField()
        moved = true
    if moved:
      target.inputOnly = true
      result = true
    if not placed or handled or kind < 0 or target.call.isNil:
      continue
    if not capturing.isNil:
      # A held press: its moves and its release go to the element that took
      # it, inside its box or not, and to nothing else.
      if captured >= 0:
        for r in target.regions:
          if r.key == captured:
            let handler = r.handlers[UiEvent(kind)]
            if handler > 0:
              target.call(handler - 1, event, payload, [float32(lx - r.x), float32(ly - r.y), r.w, r.h])
              target.inputOnly = false # whatever the handler changed, get() shows it
              handled = true
              result = true
            break
      continue
    # The innermost element with a handler for it: the last one painted. A
    # key of the on-screen keyboard is the field's to edit, not the app's.
    for i in countdown(target.regions.high, 0):
      let r = target.regions[i]
      let handler = r.handlers[UiEvent(kind)]
      if handler > 0 and r.inside(lx, ly):
        handled = true
        if handler - 1 >= OptionBase:
          target.pickOption(handler - 1 - OptionBase)
          result = true
          break
        if handler - 1 >= AccentBase:
          target.pickAccent(handler - 1 - AccentBase)
          result = true
          break
        if handler - 1 == KeyBase:
          # Between the keys or around them: the nearest key. The field keeps
          # the keyboard either way.
          let code = target.nearestKey(lx, ly)
          if code > 0:
            target.pressKey(code)
            result = true
          break
        if handler > KeyBase:
          if kind == ord(ueLongPress): target.holdKey(handler - 1 - KeyBase, pointer, lx)
          else: target.pressKey(handler - 1 - KeyBase)
        else:
          target.call(handler - 1, event, payload, [float32(lx - r.x), float32(ly - r.y), r.w, r.h])
          target.inputOnly = false # whatever the handler changed, get() shows it
        result = true
        break

{.pop.}
