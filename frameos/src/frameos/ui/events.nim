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

import std/json
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

const MaxTargets = 16

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
    result = UiTarget(sceneId: sceneId, nodeId: nodeId, memo: UiMemo(), dragKey: -1)
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
  ## keyboard wants keys, and a tap anywhere (one elsewhere puts it away).
  for target in targets:
    if target.sceneId == sceneId:
      if target.input.focus > 0 and event in ["tap", "keyDown", "textInput"]:
        return true
      for r in target.regions:
        if r.wants(event):
          return true

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
    i.text = r.value
    i.page = if r.field == 3: kpNumbers else: kpLetters
    i.shift = 0
  i.caret = r.value.len
  i.place = true
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
  target.inputOnly = true

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
  i.reveal = true
  let payload = newJObject()
  payload["value"] = newJString(i.text)
  target.fieldCall(ueChange, "change", payload)
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

proc pressKey(target: UiTarget, code: int) =
  ## A key of the on-screen keyboard (ui/keyboard.nim): a character typed,
  ## or what its byte stands for.
  template i: untyped = target.input
  target.inputOnly = true
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
    of "ArrowLeft", "ArrowRight", "Home", "End":
      let key = payload{"key"}.getStr()
      i.caret =
        if key == "Home": 0
        elif key == "End": i.text.len
        else: step(i.text, clamp(i.caret, 0, i.text.len), key == "ArrowRight")
      i.place = false
      i.reveal = true
      target.inputOnly = true
    else: discard

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
    released = event in ["pointerUp", "pointerCancel"]
    placed = not payload.isNil and payload.kind == JObject and payload.hasKey("x") and payload.hasKey("y")
    # A swipe belongs to where it began: a card swiped is the card the finger
    # went down on, wherever it lifted.
    starts = placed and event == "swipe" and payload.hasKey("startX") and payload.hasKey("startY")
    x = if starts: payload["startX"].getFloat() elif placed: payload["x"].getFloat() else: 0
    y = if starts: payload["startY"].getFloat() elif placed: payload["y"].getFloat() else: 0
    touch = placed and payload{"pointerType"}.getStr() == "touch"
    kind = handlerKind(event)
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
  for target in targets:
    if target.sceneId != sceneId:
      continue
    when not defined(frameosEmbedded):
      if event in ["keyDown", "textInput"]:
        if target.input.focus > 0:
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
    if target.dragKey >= 0 and target.dragPointer == pointer and (follows or event == "pointerDown"):
      let r = target.regionOf(target.dragKey)
      if r < 0 or event == "pointerDown":
        target.dragKey = -1
      elif event == "pointerMove" and placed:
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
    if released:
      target.release(pointer)
      if target.input.pressed.len > 0:
        target.input.pressed.setLen(0)
        moved = true
      # A finger that lifts is not over anything any more.
      if touch and target.input.hovered.len > 0:
        target.input.hovered.setLen(0)
        moved = true
    if placed and event in ["pointerMove", "pointerDown"]:
      let hovered = target.keysOver(lx, ly, false)
      if hovered != target.input.hovered:
        target.input.hovered = hovered
        moved = true
      if event == "pointerDown":
        let pressed = target.keysOver(lx, ly, true)
        if pressed != target.input.pressed:
          target.input.pressed = pressed
          moved = true
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
    if event == "swipe" and target.dragged:
      # The swipe a drag made scrolled the box: nothing else hears it.
      target.dragged = false
      continue
    if event == "tap" and placed:
      # A tap on a field gives it the keyboard; one anywhere else but the
      # keyboard takes it away, and then does what it does.
      var hit = -1
      for i in countdown(target.regions.high, 0):
        let r = target.regions[i]
        if (r.field > 0 or r.handlers[ueClick] > 0) and r.inside(lx, ly):
          hit = i
          break
      if hit >= 0 and target.regions[hit].field > 0:
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
        if handler - 1 == KeyBase:
          break # between the keys: the keyboard's, and nothing to draw
        if handler > KeyBase:
          target.pressKey(handler - 1 - KeyBase)
        else:
          target.call(handler - 1, event, payload, [float32(lx - r.x), float32(ly - r.y), r.w, r.h])
          target.inputOnly = false # whatever the handler changed, get() shows it
        result = true
        break
