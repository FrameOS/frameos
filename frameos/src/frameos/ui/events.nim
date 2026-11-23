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

import std/[json, monotimes, strutils, times]
import frameos/events_gen
import frameos/ui/layout
import frameos/ui/keyboard
when not defined(frameosEmbedded):
  import frameos/cursor_shape

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
    owner*: pointer             ## the app that last drew here. Two instances of a scene share this target:
                                ## a layout worn by the scene and by the switcher opened over it
    offsetX*, offsetY*: float32 ## the UI's corner in the scene's canvas
    scale*: float32             ## canvas pixels per layout pixel (render_scale.nim); 0 = 1
    regions*: seq[UiRegion]     ## the last render's, in paint order
    input*: UiInput             ## what the pointer and the keyboard are doing, for the next one
    memo*: UiMemo               ## the last layout's type, for the next one
    inputOnly*: bool            ## the pointer changed what it is over or
                                ## pressing, and no handler ran: the next
                                ## render needs no new tree (app_runtime.get)
    partial*, full*: bool       ## since the last render: a handler set signals (and only that) / did not
    declined*: bool             ## the pointer handler just run returned false: no render for it
    captures*: seq[(int, int)]  ## (pointerId, region key) of each press held
    call*: UiHandlerCall
    heard: seq[(int, float32, float32)] ## where each box with an onScroll was when it last heard
    # A press on a box that scrolls: the pointer, the box, where the press
    # began and how far the box was scrolled then; `dragging` once it moved
    # far enough to be a scroll rather than a tap.
    dragPointer, dragKey: int
    dragX, dragY: float32
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
    # The character key a finger went down on (-1: none), where, how wide and
    # when. Its tap lifting on another character well to the side, quickly,
    # is two thumbs a touch controller took for one finger, the second
    # landing before the first lifted: the FT6336U glides its one point from
    # the first to the second, and the first key was lost (SenseCAP
    # Indicator, 2026-11-14). Both are typed (`typeGlided`).
    glidePointer, glideCode: int
    glideX, glideY, glideW: float32
    glideAt: MonoTime
    # A press that selects text in the focused field as it drags (-1: none):
    # a mouse's on a field. Where it went down, from the field's corner,
    # is the selection's other end, unless shift kept the one before.
    selectPointer: int
    selectX, selectY: float32
    selectKept: bool
    selectDX, selectDY: float32 ## a handle: from where the finger holds it to the end it drags

const
  MaxTargets = when defined(frameosEmbedded): 16 else: 64
    ## The UIs kept live at once, the oldest let go past it: one let go loses
    ## its press, hover, field and scroll. More off an ESP32, where a desktop
    ## may have any number of windows, each one a UI or more
    ## (docs/scene-layouts.md "Windows"); an ESP32 runs two to four
    ## (app_runtime.windowLimit).
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
  uiOpenLink* {.threadvar.}: proc(url: string): bool {.nimcall, raises: [].}
    ## A host that can open a link itself (the browser's preview, which opens
    ## a tab: wasm_main.nim): true when it did. Nil, or false, and the link's
    ## QR code goes up over the UI instead (docs/jsx-ui.md "Links").
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
      repeatPointer: -1, spacePointer: -1, swallowTap: -1, glidePointer: -1, selectPointer: -1)
    result.input.accentLit = -1
    targets.add result

proc forgetUiTarget*(sceneId: string, nodeId: int, owner: pointer = nil) =
  ## The app node's scene is torn down: its regions, what the pointer was
  ## doing over them and its way into the app go with it. A target kept
  ## called the app the scene had before, which was gone. With `owner`, only
  ## if that app is the one that last drew here: another instance of the scene
  ## may have, and its taps are not this one's to take away.
  for i in countdown(targets.high, 0):
    if targets[i].sceneId == sceneId and targets[i].nodeId == nodeId and
        (owner.isNil or targets[i].owner.isNil or targets[i].owner == owner):
      targets.delete(i)

when not defined(frameosEmbedded):
  const
    MaxKeptText = 8192
    MaxKeptScrolls = 64

  proc lastingUiInput*(): JsonNode =
    ## What every UI on the glass keeps between pictures — the field with the
    ## keyboard, its caret and text, the keyboard's page and shift, the open
    ## <select>, how far each box is scrolled — for a host that draws each
    ## picture in a fresh process: the wasm runtime a control plane renders a
    ## frame with (docs/server-rendering.md, "Kept between pulls"), which
    ## hands it back with the next pull (`restoreLastingUiInput`). What the
    ## pointer is doing this moment (hover, press, a key's light, its
    ## accents, a caret yet to be placed) is not kept: the pull that carried
    ## it is over. A UI this process did not draw (no regions) is not on the
    ## glass any more and is left out. `{}` when nothing is kept. Not in the
    ## firmware: a device keeps its UIs in its own memory.
    var kept = newJArray()
    for target in targets:
      if target.regions.len == 0:
        continue
      let i = target.input
      var scrolls = newJArray()
      for (key, x, y) in i.scrolls:
        if (x != 0 or y != 0) and scrolls.len < MaxKeptScrolls:
          scrolls.add %*[newJInt(key), newJFloat(x.float), newJFloat(y.float)]
      if i.focus <= 0 and i.open <= 0 and i.link.len == 0 and scrolls.len == 0:
        continue
      var entry = newJObject()
      entry["sceneId"] = newJString(target.sceneId)
      entry["nodeId"] = newJInt(target.nodeId)
      if i.focus > 0:
        entry["focus"] = newJInt(i.focus)
        entry["caret"] = newJInt(i.caret)
        if i.sel > 0:
          entry["sel"] = newJInt(i.sel)
        entry["text"] = newJString(i.text)
        entry["keyboard"] = newJBool(i.keyboard)
        entry["page"] = newJInt(ord(i.page))
        entry["shift"] = newJInt(i.shift)
      if i.open > 0:
        entry["open"] = newJInt(i.open)
      if i.link.len > 0:
        entry["link"] = newJString(i.link)
      if scrolls.len > 0:
        entry["scrolls"] = scrolls
      kept.add entry
    result = newJObject()
    if kept.len > 0:
      result["targets"] = kept

  proc restoreLastingUiInput*(state: JsonNode): int =
    ## What `lastingUiInput` kept, put back on the UIs it names before
    ## anything lays them out, as if this process had drawn the pictures
    ## before it. How many UIs it put back; anything malformed is skipped.
    if state.isNil or state.kind != JObject:
      return 0
    let entries = state{"targets"}
    if entries.isNil or entries.kind != JArray:
      return 0
    for entry in entries:
      if result >= MaxTargets:
        break
      if entry.kind != JObject:
        continue
      let
        sceneId = entry{"sceneId"}.getStr()
        nodeId = entry{"nodeId"}
      if sceneId.len == 0 or nodeId.isNil or nodeId.kind != JInt:
        continue
      let target = uiTarget(sceneId, nodeId.getInt())
      template i: untyped = target.input
      i.focus = max(entry{"focus"}.getInt(), 0)
      if i.focus > 0:
        i.text = entry{"text"}.getStr()
        if i.text.len > MaxKeptText:
          i.text.setLen(MaxKeptText)
        i.caret = clamp(entry{"caret"}.getInt(i.text.len), 0, i.text.len)
        i.sel = clamp(entry{"sel"}.getInt(), 0, i.text.len + 1)
        i.keyboard = entry{"keyboard"}.getBool()
        i.page = KeyboardPage(clamp(entry{"page"}.getInt(), ord(low(KeyboardPage)), ord(high(KeyboardPage))))
        i.shift = clamp(entry{"shift"}.getInt(), 0, 2)
      else:
        i.text = ""
        i.caret = 0
        i.sel = 0
        i.keyboard = false
      i.open = max(entry{"open"}.getInt(), 0)
      let link = entry{"link"}.getStr()
      if link.isLink:
        i.link = link
      i.scrolls.setLen(0)
      let scrolls = entry{"scrolls"}
      if not scrolls.isNil and scrolls.kind == JArray:
        for scroll in scrolls:
          if i.scrolls.len >= MaxKeptScrolls:
            break
          if scroll.kind == JArray and scroll.len == 3 and scroll[0].kind == JInt:
            i.scrolls.add (scroll[0].getInt(), scroll[1].getFloat().float32, scroll[2].getFloat().float32)
      inc result

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
  of "pinch": ord(uePinch)
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

template overScene(r: UiRegion, lx, ly: float32): bool =
  ## A `<Scene>` or `<yield />` at the point, in paint order: what the UI
  ## drew under it is covered there, and hears nothing of the pointer.
  r.scene and r.inside(lx, ly)

template typesIn(r: UiRegion): bool =
  ## A field that holds text: an <input> or a <textarea>, not a <select>.
  r.field > 0 and r.field < 4

template stop(r: UiRegion, list: bool): bool =
  ## An element Tab stops at; with a <select>'s list up, its options alone.
  if list: r.handlers[ueClick] - 1 >= OptionBase
  else: r.field > 0 or r.handlers[ueClick] > 0 and r.handlers[ueClick] - 1 <= LinkOpen

proc walkable(target: UiTarget): bool =
  ## Whether the keys have somewhere to go in the UI.
  if target.input.ring > 0 or target.input.focus > 0 or target.input.open > 0 or target.input.link.len > 0:
    return true
  for r in target.regions:
    if r.stop(false):
      return true

proc wants(r: UiRegion, event: string, slowPanel: bool): bool =
  case event
  of "pointerMove": r.hover or r.group or r.handlers[uePointerMove] > 0 or r.scrolls
  of "pointerDown", "pointerUp", "pointerCancel":
    r.active or r.hover or r.group or r.handlers[uePointerDown] > 0 or
      r.handlers[uePointerUp] > 0 or r.handlers[uePointerMove] > 0 or r.scrolls or
      # A field: a mouse pressed on it selects as it drags (no mouse on an ESP32).
      (not defined(frameosEmbedded) and event == "pointerDown" and r.typesIn)
  of "tap": r.field > 0 or r.handlers[ueClick] > 0 or r.labelFor > 0
  of "longPress", "doubleTap":
    # A field: the word there is selected, as on a phone. On a slow panel a
    # hold on what only clicks is its click (dispatchUiEvent).
    r.typesIn or r.labelFor > 0 or r.handlers[UiEvent(handlerKind(event))] > 0 or
      event == "longPress" and slowPanel and r.handlers[ueClick] > 0
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
      if target.selectPointer >= 0 and event in ["pointerMove", "pointerUp", "pointerCancel"]:
        return true
      if target.input.handles and event == "pointerDown":
        return true # a selection's handle may be dragged
      if event == "uiTimer" and target.timerPending:
        return true
      if event in ["keyDown", "button"] and target.walkable:
        return true # Tab, Enter and Escape, and the frame's buttons as them
      for r in target.regions:
        if r.wants(event, target.input.slow):
          return true

proc keyboardShown*(sceneId: string): bool =
  ## Whether a UI of the scene has the keyboard on the screen up.
  for target in targets:
    if target.sceneId == sceneId and target.input.keyboard and target.input.focus > 0:
      return true

proc keyboardState*(sceneId: string, scale: var float32, accents: var int, field: var array[4, float32]): bool =
  ## The scene's UI with the keyboard on the screen up, for the frame's keyboard
  ## (ui/layout.nim KeyboardDock): its canvas pixels to each of its own, the
  ## key whose accents show (0: none) and where its focused field is in the
  ## scene's canvas (x, y, w, h). False when none has it up.
  for target in targets:
    if target.sceneId == sceneId and target.input.keyboard and target.input.focus > 0:
      scale = if target.scale > 0: target.scale else: 1'f32
      accents = target.input.accents
      field = [0'f32, 0, 0, 0]
      for r in target.regions:
        if r.key == target.input.focus - 1:
          field = [target.offsetX + r.x * scale, target.offsetY + r.y * scale, r.w * scale, r.h * scale]
          break
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
  ## rows below it); -1 when it is, -2 when the last render drew no row. On
  ## a letter's row (its symbol first), by how far the finger went from
  ## where it held, from the symbol: as ui/layout.nim's `accentPopup`.
  result = -2
  var
    best = high(float32)
    top = high(float32)
    bottom = 0'f32
    x = lx
  if hintOf(target.input.accents, target.input.page).len > 0:
    for r in target.regions:
      if r.handlers[ueClick] - 1 == AccentBase:
        x = lx - target.input.accentFrom + r.x + r.w / 2
  for r in target.regions:
    let handler = r.handlers[ueClick] - 1
    if handler < AccentBase or handler >= SelectBase:
      continue
    top = min(top, r.y)
    bottom = max(bottom, r.y + r.h)
    let d = abs(x - (r.x + r.w / 2))
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

proc hitAt(target: UiTarget, lx, ly: float32, also: UiEvent): int =
  ## The topmost field, or element with a tap handler or one for `also`,
  ## under the point; -1 for none, or a `<Scene>` drawn over it there. One
  ## walk for a tap, a long press, a double tap and a mouse's press.
  for i in countdown(target.regions.high, 0):
    template r: untyped = target.regions[i]
    if r.overScene(lx, ly):
      return -1
    if (r.field > 0 or r.handlers[ueClick] > 0 or r.handlers[also] > 0 or r.labelFor > 0) and r.inside(lx, ly):
      if r.labelFor == 0:
        return i
      # Around a field (look="field"): the field's.
      for f in 0 ..< target.regions.len:
        if target.regions[f].key == r.labelFor - 1 and target.regions[f].labelFor == 0:
          return f
  -1

proc regionOf(target: UiTarget, key: int): int =
  ## The last render's region for the element at `key`, -1 when it drew none.
  for i in 0 ..< target.regions.len:
    if target.regions[i].key == key and target.regions[i].labelFor == 0:
      return i
  -1

# ------------------------------------------------------------------ fields

proc focusField(target: UiTarget, r: UiRegion, lx, ly: float32, extend = false) =
  ## A tap on a field: it has the keyboard, the caret where the tap landed
  ## (the next layout knows the glyphs), and the keyboard on the screen
  ## unless the frame has one of its own. `extend` (shift held, on the field
  ## that has it): the selection runs from where the caret was to the tap.
  template i: untyped = target.input
  if i.focus != r.key + 1:
    i.focus = r.key + 1
    i.text = target.memo.fieldText(r.key)
    i.page = if r.field == 3: kpNumbers else: kpLetters
    i.shift = 0
    i.accents = 0
    i.sel = 0
    i.secret = true # until a layout says what it is: nothing copied before
  elif not defined(frameosEmbedded) and extend: # shift: no keyboard on an ESP32
    if i.sel == 0:
      i.sel = clamp(i.caret, 0, i.text.len) + 1
  else:
    i.sel = 0
  i.anchor = false
  i.word = false
  i.handles = false
  i.menu = false
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
  target.input.sel = 0
  target.input.anchor = false
  target.input.word = false
  target.input.handles = false
  target.input.menu = false
  target.selectPointer = -1
  target.inputOnly = true

proc dismissKeyboard*(sceneId: string, nodeId: int): bool =
  ## `back` while a field has the keyboard or a <select> its list, as on a
  ## phone: the field lets go and the keyboard goes away, or the list closes.
  ## With a key's accents up, those go first. False when none was up.
  let target = uiTarget(sceneId, nodeId, create = false)
  if target.isNil or (target.input.focus == 0 and target.input.open == 0 and target.input.link.len == 0):
    return false
  if target.input.link.len > 0:
    target.input.link = "" # a link's QR code goes first
    target.inputOnly = true
    return true
  if target.input.handles or target.input.menu:
    # A selection made by touch lets go first, the field keeps the keyboard.
    target.input.handles = false
    target.input.menu = false
    target.input.sel = 0
    target.inputOnly = true
    return true
  if target.input.accents > 0:
    target.input.accents = 0
    target.inputOnly = true
    return true
  target.input.open = 0
  target.blurField()
  true

proc openLink(target: UiTarget, key: int) =
  ## A tap on a link: the host opens it if it can (a browser tab), else its
  ## QR code goes up over the UI for a phone to open it, the keyboard and
  ## any <select>'s list put away first.
  let url = target.memo.linkAt(key)
  if not url.isLink:
    return
  if not uiOpenLink.isNil and uiOpenLink(url):
    return
  if target.input.focus > 0:
    target.blurField()
  target.input.open = 0
  target.input.link = url
  target.inputOnly = true

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

proc scrolledBy(target: UiTarget, r: UiRegion, unheard = false) =
  ## A finger or the wheel scrolled the box: its onScroll hears where to, as
  ## `scrollTop` and `scrollLeft` (a code editor's lines that show). With
  ## `unheard`, only when it is not where it last heard: a scroll the layout
  ## made (the caret brought into sight) is heard with the next event.
  if r.handlers[ueScroll] > 0 and not target.call.isNil:
    let (x, y) = target.input.scrolled(r.key)
    var at = target.heard.len
    for i in 0 ..< target.heard.len:
      if target.heard[i][0] == r.key: at = i
    if at == target.heard.len:
      target.heard.add((r.key, x, y))
      if unheard: return # first seen: where the app put it
    elif unheard and target.heard[at][1] == x and target.heard[at][2] == y:
      return
    target.heard[at] = (r.key, x, y)
    let payload = newJObject()
    payload["scrollTop"] = newJFloat(y)
    payload["scrollLeft"] = newJFloat(x)
    target.call(r.handlers[ueScroll] - 1, "scroll", payload, [0'f32, 0, r.w, r.h])
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
  i.handles = false # typed over: the selection's handles and menu go
  i.menu = false
  target.fieldCall(ueChange, "change", changeOf(i.text))
  target.inputOnly = false

proc cut(text: var string, a, z: int) =
  ## Bytes a ..< z taken out, in place (strutils' `delete` brings a `$` of
  ## its slice for the error it raises: half a KiB on an ESP32).
  let n = z - a
  for k in a ..< text.len - n:
    text[k] = text[k + n]
  text.setLen(text.len - n)

proc dropSelected(target: UiTarget): bool =
  ## The selected text taken out, the caret where it was. False for none.
  template i: untyped = target.input
  let (a, z) = i.selected
  i.sel = 0
  i.anchor = false
  if z > a:
    i.text.cut(a, z)
    i.caret = a
    result = true

proc insert(target: UiTarget, text: string) =
  ## Typed (or pasted) at the caret, over what is selected.
  template i: untyped = target.input
  discard target.dropSelected()
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
  ## Backspace (the rune before the caret) or Delete (the one after); with
  ## text selected, that text.
  template i: untyped = target.input
  if target.dropSelected():
    target.changed()
    return
  i.caret = clamp(i.caret, 0, i.text.len)
  let
    other = step(i.text, i.caret, forward)
    a = min(i.caret, other)
    b = max(i.caret, other)
  if b > a:
    i.text.cut(a, b)
    i.caret = a
    target.changed()

proc enter(target: UiTarget, heard = false) =
  ## Enter: a line in a <textarea>; elsewhere the field is done. `heard`: its
  ## onKeyDown has had the key already (one typed on a keyboard), and runs once.
  if not heard:
    target.keyDown("Enter")
  let r = target.regionOf(target.input.focus - 1)
  if r >= 0 and target.regions[r].field == 2:
    target.insert("\n")
  else:
    # What onKeyDown did (a form sent on Enter) is drawn by get(): letting go
    # of the field alone would only lay the last tree out again.
    let asked = not target.inputOnly
    target.blurField()
    if asked:
      target.inputOnly = false

proc flashKey(target: UiTarget, code: int) =
  ## The key just typed stays lit for a moment once a render shows it
  ## (`uiTimerDue`), so a quick tap says which key it was. Not on a slow
  ## panel (e-paper), where a refresh to put the light out costs seconds.
  if target.input.slow:
    return
  target.input.flash = code
  target.input.flashDrawn = false
  target.flashSeen = false

proc nextField(target: UiTarget, back = false) =
  ## The on-screen keyboard's Tab: the focus goes to the next field down the
  ## tree (the one before with `back`: Tab held), around past the last, the
  ## keyboard staying up. A <select> is passed over: its list is no place to
  ## type. A keyboard's Tab walks everything there is to press (`uiKeys`).
  var
    at = -1
    fields: seq[int]
  for i in 0 ..< target.regions.len:
    if target.regions[i].typesIn:
      if target.regions[i].key == target.input.focus - 1:
        at = fields.len
      fields.add i
  if fields.len == 0:
    return
  let next =
    if at < 0: (if back: fields.len - 1 else: 0)
    elif back: (at + fields.len - 1) mod fields.len
    else: (at + 1) mod fields.len
  let r = target.regions[fields[next]]
  target.input.ring = r.key + 1
  if r.key + 1 != target.input.focus:
    target.focusField(r, r.x + r.w - 1, r.y + r.h / 2)

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
  elif code == ord(kTab): target.nextField()
  elif code == ord(kLetters): i.page = kpLetters
  elif code == ord(kSymbols): i.page = kpSymbols
  elif code == ord(kMore): i.page = kpMore
  elif code >= 32:
    let text = typed(code, i.shift)
    target.keyDown(text)
    target.insert(text)

const
  GlideKeys = 1.5 ## how many of its key's widths a glide goes sideways at least
  GlideMs = 250   ## and in how long at most, from the press to the tap

proc isCharacter(code: int): bool =
  ## A key that types a character other than a space (ui/keyboard.nim).
  code > ord(' ') and code < AccentBase - KeyBase

proc typeGlided(target: UiTarget, code, pointer: int, lx, ly: float32) =
  ## The key a tap went down on, typed before `code` (the one it lifts on)
  ## when the two are characters 1.5 keys or more apart sideways, mostly
  ## sideways and within 250 ms: two thumbs (`glidePointer`). A finger that
  ## rolls goes up the keys, and one that slides to choose takes longer:
  ## either types where it lifts.
  if target.glidePointer != pointer:
    return
  target.glidePointer = -1
  let dx = abs(lx - target.glideX)
  if code.isCharacter and code != target.glideCode and dx >= target.glideW * GlideKeys and
      dx > 2 * abs(ly - target.glideY) and
      getMonoTime() - target.glideAt <= initDuration(milliseconds = GlideMs):
    target.pressKey(target.glideCode)

proc holdKey(target: UiTarget, code, pointer: int, lx: float32) =
  ## A key held (`longPress`, while the finger is still down at `lx`): its
  ## accents come up above it, the one nearest the finger's x lit, for that
  ## finger to slide along and lift on, or to lift away from and tap one
  ## (ui/keyboard.nim `Accents`, drawn by ui/layout.nim). Backspace erases,
  ## and goes on erasing until the finger lifts (`uiTimer`). A key with
  ## neither has no long-press handler, so this never sees one.
  template i: untyped = target.input
  if code == ord(kTab):
    target.nextField(back = true)
    return
  if code == ord(kBackspace):
    target.pressKey(code)
    if i.slow:
      return # one: a refresh a character is seconds
    target.repeatPointer = pointer
    target.repeatCode = code
    target.repeats = 0
    target.repeatDue = getMonoTime() + initDuration(milliseconds = RepeatFirstMs)
    return
  if formCount(code, i.page) == 0:
    return
  i.accents = code
  i.accentX = lx
  i.accentFrom = lx
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
  let text = formText(i.accents, index, i.shift, i.page)
  i.accents = 0
  target.inputOnly = true
  if text.len > 0:
    target.keyDown(text)
    target.insert(text)

proc moveCaret(target: UiTarget, key: string, extend = false) =
  ## An arrow, Home or End: the caret a rune, a line or to an end. A key on a
  ## keyboard, or the space bar dragged. `extend` (shift held) selects from
  ## where the caret was; without it a selection lets go, left or right of
  ## it putting the caret at that end, as on a desktop.
  template i: untyped = target.input
  if key notin ["ArrowLeft", "ArrowRight", "Home", "End", "ArrowUp", "ArrowDown"]:
    # Any other key's keyDown (a letter: its text comes as `textInput` next)
    # leaves the selection alone, so the text typed replaces it. Letting go
    # here made a typed letter go after the selected text instead.
    return
  let (a, z) = i.selected
  i.handles = false
  i.menu = false
  if not defined(frameosEmbedded) and extend: # shift: no keyboard on an ESP32
    if i.sel == 0:
      i.sel = clamp(i.caret, 0, i.text.len) + 1
  elif i.sel > 0:
    i.sel = 0
    if z > a and key in ["ArrowLeft", "ArrowRight"]:
      i.caret = if key == "ArrowLeft": a else: z
      i.place = false
      i.goal = false
      i.reveal = true
      target.inputOnly = true
      return
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

proc selectAll(target: UiTarget) =
  ## The whole text selected, the caret at its end.
  template i: untyped = target.input
  i.sel = 1
  i.caret = i.text.len
  i.place = false
  i.anchor = false
  target.inputOnly = true

proc copySelected(target: UiTarget, cut: bool) =
  ## Copy (or Cut) the selected text to the frame's clipboard. Never a
  ## password's: a cut of one only takes the text out.
  let (a, z) = target.input.selected
  if z <= a:
    return
  if not target.input.secret:
    setUiClipboard(target.input.text[a ..< z])
  if cut and target.dropSelected():
    target.changed()

proc paste(target: UiTarget) =
  ## The clipboard typed at the caret, over what is selected. A field of
  ## one line takes the first line of it.
  var text = uiClipboard()
  let r = target.regionOf(target.input.focus - 1)
  if r >= 0 and target.regions[r].field != 2:
    let nl = text.find('\n')
    if nl >= 0:
      text.setLen(nl)
  if text.len > 0:
    target.insert(text)

proc follow(target: UiTarget, pointer: int, dx, dy = 0'f32, kept = true) =
  ## From now on `pointer` moves an end of the focused field's selection,
  ## `dx`, `dy` from where it holds it; `kept` (a touch's, or shift's) keeps
  ## the other end, else (a mouse's drag) it is where the press went down.
  target.selectPointer = pointer
  target.selectKept = kept
  target.selectDX = dx
  target.selectDY = dy

proc selectWord(target: UiTarget, r: UiRegion, lx, ly: float32) =
  ## A long press or a double tap on a field, as on a phone: it has the
  ## keyboard, the word there is selected (by the next layout, which knows
  ## the glyphs), with handles at its ends and its menu over it. On no
  ## word, the menu alone, at the caret (Paste, Select all).
  target.focusField(r, lx, ly)
  target.input.word = true
  target.input.handles = true
  target.input.menu = true

proc editAction(target: UiTarget, item: int) =
  ## A tap on an item of a selection's menu (ui/keyboard.nim `editMenuTree`).
  ## A tap on a handle (0, 1) is no action: dragging it is.
  template i: untyped = target.input
  case item
  of EditCut: target.copySelected(cut = true)
  of EditCopy:
    target.copySelected(cut = false)
    i.menu = false
    target.inputOnly = true
  of EditPaste: target.paste()
  of EditSelectAll:
    target.selectAll()
    i.handles = true
    i.menu = true
  else: discard

proc spaceDrag(target: UiTarget, lx, ly: float32, slop: float32): bool =
  ## The space bar held and dragged, as on a phone: the caret follows the
  ## finger, a rune per step across and a line per row up or down, as the
  ## arrow keys would (the field's onKeyDown hears them). True when it moved.
  let
    dx = lx - target.spaceX
    dy = ly - target.spaceY
  if not target.spaceDragging:
    # Sideways first: a thumb landing low on the bar and rolling up onto the
    # letters above is typing one of them, not moving the caret up a line
    # (which in an <input> is to its start: "banana" came out "ana|b").
    if abs(dx) <= slop or abs(dx) < abs(dy):
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
    let key = payload{"key"}.getStr()
    if (payload{"ctrl"}.getBool() or payload{"meta"}.getBool()) and not payload{"alt"}.getBool():
      # Ctrl (or Cmd) and a letter: the letter as the layout has it, else
      # the key it is on (a layout that is not Latin).
      let code = payload{"code"}.getStr()
      let letter =
        if key.len == 1: key[0].toLowerAscii
        elif code.len == 4 and code.startsWith("Key"): code[3].toLowerAscii
        else: '\0'
      case letter
      of 'a': target.selectAll()
      of 'c': target.copySelected(cut = false)
      of 'x': target.copySelected(cut = true)
      of 'v': target.paste()
      else: discard
      return
    case key
    of "Backspace": target.erase(false)
    of "Delete": target.erase(true)
    of "Enter": target.enter(heard = true)
    of "Escape": target.blurField()
    else: target.moveCaret(key, extend = payload{"shift"}.getBool())

  const WheelNotchPx = 72'f32
    ## A notch of the wheel: about three lines of text, as a browser scrolls.
    ## A trackpad's fractions of a notch scroll their share of it.

  var wheelScrolled* {.threadvar.}: bool
    ## A wheel scrolled a box (set, never cleared, here): a layout that handed
    ## the wheel to the scene under it scrolls its own box under the pointer
    ## only when the scene's did not move (interpreter.runEventInner).

  proc wheel(target: UiTarget, r: UiRegion, payload: JsonNode): bool =
    ## A wheel over a box that scrolls. False when the box is at its end that
    ## way, so the box around it scrolls instead, as in a browser.
    let (fromX, fromY) = target.input.scrolled(r.key)
    let
      sx = clamp(fromX + payload{"deltaX"}.getFloat() * WheelNotchPx, 0, r.scrollX)
      sy = clamp(fromY + payload{"deltaY"}.getFloat() * WheelNotchPx, 0, r.scrollY)
    if sx == fromX and sy == fromY:
      return false
    target.input.scrollTo(r.key, sx, sy)
    target.inputOnly = true
    target.scrolledBy(r)
    wheelScrolled = true
    true

# ------------------------------------------------------------------ keys
#
# Tab, Enter and Escape, from a keyboard or the frame's buttons (docs/jsx-ui.md
# "Keys"): Tab walks every element there is to press (a field, a <select>, an
# onClick, a link), Shift+Tab back, around past either end; the element it is
# on is ringed (`input.ring`, drawn by ui/layout.nim) and Enter presses it, opens
# its list or gives it the keyboard; Escape closes a list, lets go of a field,
# then takes the ring away. The UIs of a scene and of the layout it wears are
# one walk, so there is one ring on the frame, never one in each.

proc tabStep(list: seq[UiTarget], back, typed, dry: bool): bool =
  ## Tab once: the ring to the next element of the UIs in `list` (the one
  ## before with `back`), from where it is, else from the focused field, else
  ## from the top (or the bottom). One stop per element, however many regions
  ## it drew. Typed on a keyboard, a field it lands on takes the keys too; a
  ## frame's button only rings it, and Enter gives it the keyboard. `dry`:
  ## whether it would, and nothing done.
  var at = -1
  for i, t in list:
    if t.input.open > 0:
      at = i
      break
  let listUp = at >= 0
  if not listUp:
    for i, t in list:
      if t.input.ring > 0 or t.input.focus > 0:
        at = i
        break
  var
    stops: seq[(int, int)] # (UI, region)
    current = -1
  for i, t in list:
    if listUp and i != at:
      continue
    let here = if i != at: -1 elif t.input.ring > 0: t.input.ring - 1 else: t.input.focus - 1
    for j, r in t.regions:
      if not r.stop(listUp):
        continue
      var seen = false
      for (u, k) in stops:
        if u == i and t.regions[k].key == r.key:
          seen = true
          break
      if not seen:
        if r.key == here:
          current = stops.len
        stops.add (i, j)
  if stops.len == 0 or dry:
    return stops.len > 0
  let next =
    if current < 0: (if back: stops.len - 1 else: 0)
    elif back: (current + stops.len - 1) mod stops.len
    else: (current + 1) mod stops.len
  let (u, k) = stops[next]
  for i, t in list:
    if i != u:
      if t.input.ring > 0:
        t.input.ring = 0
        t.inputOnly = true
      if t.input.focus > 0:
        t.blurField()
  let
    t = list[u]
    r = t.regions[k]
  if typed and t.input.focus > 0:
    t.keyDown("Tab") # the field's onKeyDown hears it go
  if t.input.focus > 0 and t.input.focus != r.key + 1:
    t.blurField()
  t.input.ring = r.key + 1
  t.input.reveal = true
  t.inputOnly = true
  if typed and not listUp and r.typesIn and t.input.focus != r.key + 1:
    t.focusField(r, r.x + r.w - 1, r.y + r.h / 2)
  true

proc pressRing(list: seq[UiTarget], typed, dry: bool): bool =
  ## Enter: a link's card goes; with a list up, the option ringed is picked
  ## and the ring goes back to its <select>; a field with the keys is done
  ## (one typed on a keyboard is the field's own, `typedKey`); else the
  ## element ringed is pressed, as a tap in its middle would.
  for t in list:
    if t.input.link.len > 0:
      if not dry:
        t.input.link = ""
        t.inputOnly = true
      return true
  for t in list:
    if t.input.open > 0:
      let
        select = t.input.open
        i = t.regionOf(t.input.ring - 1)
      if t.input.ring > 0 and i >= 0 and t.regions[i].handlers[ueClick] - 1 >= OptionBase:
        if not dry:
          t.pickOption(t.regions[i].handlers[ueClick] - 1 - OptionBase)
          t.input.ring = select
        return true
      return false
    if t.input.focus > 0:
      if typed:
        return false
      if not dry:
        t.enter()
      return true
  for t in list:
    if t.input.ring == 0:
      continue
    let i = t.regionOf(t.input.ring - 1)
    if i < 0:
      return false
    let
      r = t.regions[i]
      handler = r.handlers[ueClick] - 1
    if r.field == 0 and (handler < 0 or handler > LinkOpen or handler < LinkOpen and t.call.isNil):
      return false
    if dry:
      return true
    if r.field == 4:
      t.input.open = r.key + 1
      t.input.fresh = true
      t.input.ring = 0
      t.inputOnly = true
    elif r.typesIn:
      t.focusField(r, r.x + r.w - 1, r.y + r.h / 2)
    elif handler == LinkOpen:
      t.openLink(r.key)
    else:
      let
        scale = if t.scale > 0: t.scale else: 1'f32
        lx = (max(r.visible[0], r.x) + min(r.visible[2], r.x + r.w)) / 2
        ly = (max(r.visible[1], r.y) + min(r.visible[3], r.y + r.h)) / 2
        event = newJObject()
      event["x"] = newJFloat(t.offsetX + lx * scale)
      event["y"] = newJFloat(t.offsetY + ly * scale)
      event["pointerId"] = newJInt(0)
      event["key"] = newJString("Enter")
      t.call(handler, "tap", event, [lx - r.x, ly - r.y, r.w, r.h])
      t.inputOnly = false # whatever the handler changed, get() shows it
    return true

proc escape(list: seq[UiTarget], typed, dry: bool): bool =
  ## Escape: a link's card or a <select>'s list goes (the ring back on the
  ## select), else a field lets go of the keys (one typed on a keyboard is the
  ## field's own, `typedKey`), else the ring goes.
  for t in list:
    if t.input.link.len > 0 or t.input.open > 0:
      if not dry:
        if t.input.open > 0:
          t.input.ring = t.input.open
        t.input.open = 0
        t.input.link = ""
        t.inputOnly = true
      return true
  for t in list:
    if t.input.focus > 0:
      if typed:
        return false
      if not dry:
        t.blurField()
      return true
  for t in list:
    if t.input.ring > 0:
      if not dry:
        t.input.ring = 0
        t.inputOnly = true
      return true

proc uiKeys*(sceneIds: openArray[string], key: string, back = false, typed = false, dry = false): bool =
  ## Tab (back: Shift+Tab), Enter or Escape for the UIs of `sceneIds` as one:
  ## the scene showing and the layout it wears. True when it did something,
  ## and a new picture is due; with `dry`, whether it would, nothing done.
  ## `typed`: on a keyboard, whose Tab gives a field the keys at once.
  var list: seq[UiTarget]
  for id in sceneIds:
    for target in targets:
      if target.sceneId == id and target.regions.len > 0:
        list.add target
  if typed:
    physicalKeyboard = true
  case key
  of "Tab": tabStep(list, back, typed, dry)
  of "Enter": pressRing(list, typed, dry)
  of "Escape": escape(list, typed, dry)
  else: false

proc uiKeyOf*(event: string, payload: JsonNode): tuple[key: string, back: bool, times: int] =
  ## The key an event is to a UI, and how many times; none (0) for any other.
  ## A frame's button, by its role: next and down are Tab, prev and up
  ## Shift+Tab, primary (a reTerminal's green key) Enter, back and menu
  ## (a way out) Escape; `refresh`, which no label is given any more, Enter; a press is one, a double press two and a triple press three, so every tap counts
  ## however quickly they come, and a long press is the frame's event map's
  ## (walk the scenes, talk), never a key. A keyboard's Tab, Shift+Tab, Enter
  ## and Escape, once; with Ctrl, Alt or Cmd held, the scene's own.
  if payload.isNil or payload.kind != JObject:
    return
  if event == "button":
    result.times = case payload{"action"}.getStr()
      of "press", "": 1
      of "doublePress": 2
      of "triplePress": 3
      else: 0
    case payload{"role"}.getStr()
    of "next", "down": result.key = "Tab"
    of "prev", "up": (result.key, result.back) = ("Tab", true)
    of "primary", "refresh": result.key = "Enter"
    of "back", "menu": result.key = "Escape"
    else: result.times = 0
  else:
    when not defined(frameosEmbedded):
      result.key = payload{"key"}.getStr()
      if event == "keyDown" and result.key in ["Tab", "Enter", "Escape"] and not payload{"ctrl"}.getBool() and
          not payload{"alt"}.getBool() and not payload{"meta"}.getBool():
        result.back = payload{"shift"}.getBool()
        result.times = 1

proc uiKeysFor*(sceneIds: openArray[string], event: string, payload: JsonNode, dry = false): bool =
  ## A frame's button, or a key typed on a keyboard, as the keys
  ## (`uiKeyOf`), as many times as it says. True when any of them did
  ## something (with `dry`, would).
  let (key, back, times) = uiKeyOf(event, payload)
  for _ in 1 .. times:
    if uiKeys(sceneIds, key, back, typed = event == "keyDown", dry = dry):
      result = true
      if dry:
        return

proc uiButtonKeys*(sceneIds: openArray[string], payload: JsonNode): bool =
  ## A frame's button as the keys (`uiKeyOf`).
  uiKeysFor(sceneIds, "button", payload)

when not defined(frameosEmbedded):
  proc uiTypedKeys*(sceneIds: openArray[string], payload: JsonNode): bool =
    ## A keyboard's Tab, Shift+Tab, Enter and Escape as the keys (`uiKeyOf`).
    uiKeysFor(sceneIds, "keyDown", payload)

# ------------------------------------------------------------------ dispatch

proc uiOverScene*(sceneId, event: string; x, y: float32; pointer: int): bool =
  ## Whether a pointer event at (x, y), in the scene's pixels, over a
  ## `<Scene>` or `<yield />` it embeds, is its UI's instead: an element
  ## drawn over the scene there that wants the event (a menu, a window on
  ## top, a pane that takes a press to bring its window forward), or a UI
  ## holding this pointer's press. Otherwise the scene under it has it
  ## (interpreter.routePointer).
  for target in targets:
    if target.sceneId != sceneId:
      continue
    # A press it holds is its own; a new press goes by where it lands.
    if event != "pointerDown" and target.captureOf(pointer) >= 0:
      return true
    let
      scale = if target.scale > 0: target.scale else: 1'f32
      lx = (x - target.offsetX) / scale
      ly = (y - target.offsetY) / scale
    for i in countdown(target.regions.high, 0):
      template r: untyped = target.regions[i]
      if r.inside(lx, ly):
        if r.scene:
          break
        if r.wants(event, target.input.slow):
          return true

proc uiHoldsPointer*(sceneId: string, pointer: int): bool =
  ## Whether an element of the scene's UI holds this pointer's press (a title
  ## bar being dragged): its moves and its release are that element's,
  ## wherever they land.
  for target in targets:
    if target.sceneId == sceneId and target.captureOf(pointer) >= 0:
      return true

proc uiSceneHandler*(sceneId, event: string, payload: JsonNode): bool =
  ## A layout's own handler on the `<Scene>` an event reached
  ## (`<Scene id onPointerDown={...} />`, interpreter.routePointer): the
  ## topmost scene at the event's point, as it starts (a gesture's start).
  ## The scene has the event all the same; this is the layout hearing it,
  ## to give that scene the focus where it is. True when one ran.
  let kind = handlerKind(event)
  if kind < 0 or payload.isNil or payload.kind != JObject:
    return false
  let
    x = payload{"startX"}.getFloat(payload{"x"}.getFloat(-1))
    y = payload{"startY"}.getFloat(payload{"y"}.getFloat(-1))
  for target in targets:
    if target.sceneId != sceneId or target.call.isNil:
      continue
    let
      scale = if target.scale > 0: target.scale else: 1'f32
      lx = (x - target.offsetX) / scale
      ly = (y - target.offsetY) / scale
    for i in countdown(target.regions.high, 0):
      let r = target.regions[i]
      if r.scene and r.inside(lx, ly):
        let handler = r.handlers[UiEvent(kind)]
        if handler == 0:
          return false
        target.call(handler - 1, event, payload, [float32(lx - r.x), float32(ly - r.y), r.w, r.h])
        target.inputOnly = false # whatever the handler changed, get() shows it
        return true

when not defined(frameosEmbedded):
  proc uiCursorAt*(sceneId: string; x, y: float32; pointer = 0): int =
    ## The mouse cursor a UI of the scene asks for at (x, y), in the scene's
    ## pixels, as the last render drew it: the shape (`ord`) of the topmost
    ## element there, from its `cursor-*` class, the arrow for one without.
    ## -1 when no element is there or a `<Scene>` / `<yield />` is on top:
    ## the scene in it, or the scene's own, decides (interpreter
    ## `cursorShapeAt`). A press the UI holds is its element's to the end, so
    ## a window being resized keeps its arrows wherever the pointer goes.
    result = -1
    for target in targets:
      if target.sceneId != sceneId:
        continue
      let
        scale = if target.scale > 0: target.scale else: 1'f32
        lx = (x - target.offsetX) / scale
        ly = (y - target.offsetY) / scale
      var index = -1
      let held = target.captureOf(pointer)
      if held >= 0:
        index = target.regionOf(held)
      else:
        for i in countdown(target.regions.high, 0):
          if target.regions[i].inside(lx, ly):
            index = i
            break
      if index < 0:
        continue
      template r: untyped = target.regions[index]
      result =
        if r.scene and held < 0: -1
        elif r.cursor == CursorEdges: ord(edgeCursor(lx - r.x, ly - r.y, r.w, r.h, r.cursorBand))
        else: ord(cursorOfCode(r.cursor))
      if held >= 0:
        return

proc uiTakesPressAt*(sceneId: string; x, y: float32): bool =
  ## Whether a press at (x, y), in the scene's pixels, lands on something a UI
  ## of the scene does something with: an element with a handler, a field, a
  ## box that scrolls. Asked of what the last render drew.
  for target in targets:
    if target.sceneId != sceneId:
      continue
    let
      scale = if target.scale > 0: target.scale else: 1'f32
      lx = (x - target.offsetX) / scale
      ly = (y - target.offsetY) / scale
    for r in target.regions:
      if r.inside(lx, ly):
        if r.field > 0 or r.scrolls or r.labelFor > 0:
          return true
        for handler in r.handlers:
          if handler > 0:
            return true

proc uiPressRects*(sceneId: string; into: var seq[array[4, float32]]) =
  ## Where a press lands on something a UI of the scene does something with
  ## (uiTakesPressAt's regions), in the scene's pixels: x0, y0, x1, y1. What
  ## a control plane hands a board with its picture (interpreter.pressMap),
  ## so the board can click at the press without asking.
  for target in targets:
    if target.sceneId != sceneId:
      continue
    let scale = if target.scale > 0: target.scale else: 1'f32
    for r in target.regions:
      var takes = r.field > 0 or r.scrolls or r.labelFor > 0
      if not takes:
        for handler in r.handlers:
          if handler > 0:
            takes = true
            break
      if takes and r.visible[2] > r.visible[0] and r.visible[3] > r.visible[1]:
        into.add [target.offsetX + r.visible[0] * scale, target.offsetY + r.visible[1] * scale,
                  target.offsetX + r.visible[2] * scale, target.offsetY + r.visible[3] * scale]

proc handlerPayload(target: UiTarget, r: UiRegion, payload: JsonNode, scale: float32): JsonNode =
  ## What a pointer handler is handed: the event, a coalesced move's `points`
  ## (docs/events.md "Pointer") in the element's own pixels, as localX and
  ## localY are.
  let points = payload{"points"}
  if points.isNil or points.kind != JArray or points.len == 0:
    return payload
  result = copy(payload)
  let local = newJArray()
  for i in 0 ..< points.len:
    let v = points[i].getFloat()
    local.add(%(if (i and 1) == 0: (v - target.offsetX) / scale - r.x else: (v - target.offsetY) / scale - r.y))
  result["points"] = local

proc dispatchUiEvent*(sceneId, event: string, payload: JsonNode, keysOnly = false): bool =
  ## Hands a pointer event, or a key for a field, to the scene's UIs. True
  ## when the frame should render again: a handler ran (whatever it changed,
  ## the picture is the UI's), what the pointer is over or pressing changed,
  ## a field's text or caret moved, or a box scrolled. `keysOnly`: a press on
  ## the frame's keyboard, for the UI whose field has it and no other.
  let
    # The event as its handler kind, compared as a number from here on.
    kind = handlerKind(event)
    down = kind == ord(uePointerDown)
    released = event in ["pointerUp", "pointerCancel"]
    placed = not payload.isNil and payload.kind == JObject and payload.hasKey("x") and payload.hasKey("y")
    # A swipe belongs to where it began: a card swiped is the card the finger
    # went down on, wherever it lifted. A pinch too, from between its fingers.
    starts = placed and kind in [ord(ueSwipe), ord(uePinch)] and payload.hasKey("startX") and
      payload.hasKey("startY")
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
  if placed and not keysOnly and (down or kind == ord(ueClick)):
    # A finger or a mouse: the keys' ring goes, on every UI (docs/jsx-ui.md
    # "Keys"), as a browser's focus ring does after a click.
    for target in targets:
      if target.input.ring > 0:
        target.input.ring = 0
        target.inputOnly = true
        if target.sceneId == sceneId:
          result = true
  for target in targets:
    if target.sceneId != sceneId or keysOnly and not (target.input.keyboard and target.input.focus > 0):
      continue
    if not target.dragging:
      for r in target.regions:
        target.scrolledBy(r, unheard = true)
    when not defined(frameosEmbedded):
      if event in ["keyDown", "textInput"]:
        if (target.input.open > 0 or target.input.link.len > 0) and payload{"key"}.getStr() == "Escape":
          target.input.open = 0
          target.input.link = ""
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
    # On a slow panel a hold on what only clicks is a click: no press shows
    # there (showsPress below), so people hold until something does, and a
    # hold was a longPress that clicked nothing. A fast panel keeps a phone's
    # rule: a long press is no click. What has its own onLongPress, a field (the
    # word there is selected) and the keyboard's keys (their accents) keep it.
    var kind = kind
    if kind == ord(ueLongPress) and placed and target.input.slow:
      for i in countdown(target.regions.high, 0):
        let r = target.regions[i]
        if r.overScene(lx, ly):
          break
        if r.inside(lx, ly) and (r.handlers[ueLongPress] > 0 or r.handlers[ueClick] > 0 or r.field > 0):
          # A field keeps its hold: the word there is selected.
          if r.handlers[ueLongPress] == 0 and r.field == 0 and
              r.handlers[ueClick] > 0 and r.handlers[ueClick] - 1 < KeyBase:
            kind = ord(ueClick)
          break
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
        var box = target.regions[r]
        if not target.dragging and max(abs(dx), abs(dy)) > GestureTapSlopPx and
            (if abs(dy) > abs(dx): box.scrollY == 0 else: box.scrollX == 0):
          # Along a way this box does not scroll (a code editor's lines that
          # scroll sideways, in a page that scrolls down): the box around it
          # that does, under where the press went down, as in a browser.
          let
            downX = (target.dragX - target.offsetX) / scale
            downY = (target.dragY - target.offsetY) / scale
          for i in countdown(r - 1, 0):
            let o = target.regions[i]
            if (if abs(dy) > abs(dx): o.scrollY > 0 else: o.scrollX > 0) and o.inside(downX, downY):
              box = o
              target.dragKey = o.key
              break
        if not target.dragging and (box.scrollX > 0 and abs(dx) > GestureTapSlopPx or
            box.scrollY > 0 and abs(dy) > GestureTapSlopPx):
          target.dragging = true
          target.input.pressed.setLen(0)
        if target.dragging:
          # From where the box is now, by how far the finger moved since the
          # last move: an app that moved it meanwhile (scrollTop, a code
          # editor's lines measured above the screen) keeps what it did.
          let (sx, sy) = target.input.scrolled(box.key)
          target.input.scrollTo(box.key,
            # The finger moved in the canvas's pixels; the box scrolls in the UI's.
            if box.scrollX > 0: clamp(sx - dx / scale, 0, box.scrollX) else: sx,
            if box.scrollY > 0: clamp(sy - dy / scale, 0, box.scrollY) else: sy)
          target.dragX = x
          target.dragY = y
          target.inputOnly = true
          # A slow panel shows where it got to when the finger lifts.
          if not target.input.slow:
            target.scrolledBy(box)
            result = true
          continue
      elif released:
        target.dragKey = -1
        if target.dragging:
          target.dragging = false
          target.dragged = true
          if target.input.slow:
            target.scrolledBy(target.regions[r])
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
          # On every panel: only a touch screen slides, and a touch e-paper
          # draws its partial update in a fraction of a second. Shown only at
          # the lift, a slide along the row looked dead (the reTerminal
          # Sticky, 2026-11-23); the moves a refresh sits on fold into one.
          moved = true
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
    if target.selectPointer == pointer and (follows or down):
      # A press that selects as it drags: the caret goes where the pointer
      # is, the other end stays where it went down (or where shift kept it).
      let r = target.regionOf(target.input.focus - 1)
      if down or r < 0 or target.input.focus == 0:
        target.selectPointer = -1
      elif kind == ord(uePointerMove) and placed:
        let box = target.regions[r]
        when not defined(frameosEmbedded):
          # A mouse's drag (a touch keeps its end: selectKept): no mouse on an ESP32.
          if not target.selectKept:
            target.input.anchor = true
            target.input.anchorX = target.selectX
            target.input.anchorY = target.selectY
        target.input.place = true
        target.input.placeX = lx - target.selectDX - box.x
        target.input.placeY = ly - target.selectDY - box.y
        target.inputOnly = true
        # A slow panel shows the selection once the pointer lets go. The
        # drag is the field's: nothing under it hears the move.
        result = result or not target.input.slow
        continue
      elif released:
        target.selectPointer = -1
        if target.input.handles:
          target.input.menu = true # let go: the menu comes back
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
    # What the pointer is over or pressing is drawn (`hover:`, `active:`),
    # but not on a slow panel, as the scene switcher's and the keyboard's presses
    # are not: a render to show one is a refresh of seconds, and the tap's
    # own render waited behind it. On the reTerminal E1003 every tap through
    # a layout cost two renders, the page it turned showing only with the
    # second (2026-11-10). The two lists are for drawing alone.
    let showsPress = not target.input.slow
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
      if showsPress and hovered != target.input.hovered:
        target.input.hovered = hovered
        moved = true
      if down:
        let pressed = target.keysOver(lx, ly, true)
        if showsPress and pressed != target.input.pressed:
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
          # The character it lands on, for a tap that lifts on another.
          target.glidePointer = -1
          for r in target.regions:
            let code = r.handlers[ueClick] - 1 - KeyBase
            if code.isCharacter and r.inside(lx, ly):
              target.glidePointer = pointer
              target.glideCode = code
              target.glideX = lx
              target.glideY = ly
              target.glideW = r.w
              target.glideAt = getMonoTime()
              break
        # The innermost element that takes a press holds the pointer, unless
        # the innermost box that scrolls is that element or drawn over it
        # (inside it, or over it): then that box may be dragged. A menu takes
        # its presses, so the cover under it that closes it does not, and its
        # list still scrolls under a finger; a slider inside a list is drawn
        # over the list and stays the slider's.
        target.release(pointer)
        target.dragged = false
        var takes, box = -1
        for i in countdown(target.regions.high, 0):
          let r = target.regions[i]
          if r.overScene(lx, ly):
            break
          if takes < 0 and (r.handlers[uePointerDown] > 0 or r.handlers[uePointerMove] > 0) and r.inside(lx, ly):
            takes = i
          if box < 0 and r.scrolls and r.inside(lx, ly):
            box = i
          if takes >= 0 and box >= 0:
            break
        var grabbed = false
        if target.input.handles and target.input.focus > 0:
          # A handle of a selection made by touch: the finger drags that end,
          # the other stays. The menu waits until it lets go.
          # The handles are drawn over all but the menu, which keeps clear of
          # them: the one under the finger is the topmost there.
          let
            hit = target.hitAt(lx, ly, ueClick)
            handle = if hit >= 0: target.regions[hit].handlers[ueClick] - 1 - SelectBase else: -1
          if handle == 0 or handle == 1:
            let
              r = target.regions[hit]
              (a, z) = target.input.selected
            target.input.sel = (if handle == 0: z else: a) + 1
            target.input.caret = if handle == 0: a else: z
            target.input.menu = false
            # The end is at the handle's middle, its line's middle at its top.
            target.follow(pointer, lx - (r.x + r.w / 2), ly - r.y)
            grabbed = true
            takes = -1
            box = -1
            moved = true
        when not defined(frameosEmbedded):
          if not grabbed and payload{"pointerType"}.getStr() != "touch" and payload{"button"}.getInt() == 0:
            # A mouse (or a pen) on a field: it has the keyboard at once, the
            # caret where it went down, and a drag from there selects, as on
            # a desktop. Shift extends what was selected.
            let hit = target.hitAt(lx, ly, uePointerDown)
            if hit >= 0 and target.regions[hit].typesIn and target.input.open == 0:
              let r = target.regions[hit]
              let extend = payload{"shift"}.getBool() and target.input.focus == r.key + 1
              target.focusField(r, lx, ly, extend)
              target.follow(pointer, kept = extend)
              target.selectX = lx - r.x
              target.selectY = ly - r.y
              takes = -1
              box = -1
              moved = true
        if takes >= 0 and box < takes:
          target.captures.add((pointer, target.regions[takes].key))
        elif box >= 0:
          let r = target.regions[box]
          target.dragKey = r.key
          target.dragPointer = pointer
          target.dragX = x
          target.dragY = y
          target.dragging = false
    when not defined(frameosEmbedded):
      if event == "wheel" and placed:
        for i in countdown(target.regions.high, 0):
          if target.regions[i].scrolls and target.regions[i].inside(lx, ly) and
              target.wheel(target.regions[i], payload):
            result = true
            break
    if kind == ord(ueSwipe) and target.dragged:
      # The swipe a drag made scrolled the box: nothing else hears it.
      target.dragged = false
      continue
    if kind == ord(ueLongPress) and target.glidePointer == pointer:
      target.glidePointer = -1 # a hold is no tap: the key it went down on is not typed with another
    if kind == ord(ueClick) and target.swallowTap >= 0 and target.swallowTap == pointer:
      # The tap a drag of the space bar made on its release: no space.
      target.swallowTap = -1
      if moved:
        target.inputOnly = true
        result = true
      continue
    if (kind == ord(ueLongPress) or kind == ord(ueDoubleClick)) and placed and target.input.open == 0 and
        target.input.accents == 0:
      # On a field, the word there: as on a phone.
      let hit = target.hitAt(lx, ly, UiEvent(kind))
      if hit >= 0 and target.regions[hit].typesIn:
        target.selectWord(target.regions[hit], lx, ly)
        if kind == ord(ueLongPress):
          # Still down: a slide from here selects on to where it goes.
          target.follow(pointer)
          if target.dragPointer == pointer:
            target.dragKey = -1 # no scroll of the box around it
        moved = true
    if kind == ord(ueClick) and placed:
      # A tap on a field gives it the keyboard; one anywhere else but the
      # keyboard takes it away, and then does what it does.
      let hit = target.hitAt(lx, ly, ueClick)
      if target.input.accents > 0 and (hit < 0 or
          target.regions[hit].handlers[ueClick] - 1 < AccentBase or
          target.regions[hit].handlers[ueClick] - 1 >= SelectBase):
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
        let r = target.regions[hit]
        # Shift+click extends; a tap on an ESP32 has no shift to hold.
        target.focusField(r, lx, ly, not defined(frameosEmbedded) and payload{"shift"}.getBool() and
          target.input.focus == r.key + 1)
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
              target.declined = false
              target.call(handler - 1, event, target.handlerPayload(r, payload, scale),
                [float32(lx - r.x), float32(ly - r.y), r.w, r.h])
              target.inputOnly = false # whatever the handler changed, get() shows it
              handled = true
              # A pointer handler that returned false keeps what it did for
              # the next render (a drawing app batching a stroke's points).
              if not target.declined:
                result = true
            break
      continue
    # The innermost element with a handler for it: the last one painted. A
    # key of the on-screen keyboard is the field's to edit, not the app's.
    for i in countdown(target.regions.high, 0):
      let r = target.regions[i]
      if r.overScene(lx, ly):
        break
      let handler = r.handlers[UiEvent(kind)]
      if handler > 0 and r.inside(lx, ly):
        handled = true
        if handler - 1 == LinkOpen or handler - 1 == LinkClose:
          # Only a tap: a link has no other handler.
          if handler - 1 == LinkOpen:
            target.openLink(r.key)
          else:
            target.input.link = ""
            target.inputOnly = true
          result = true
          break
        if handler - 1 >= OptionBase:
          target.pickOption(handler - 1 - OptionBase)
          result = true
          break
        if handler - 1 >= SelectBase:
          target.editAction(handler - 1 - SelectBase)
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
            target.typeGlided(code, pointer, lx, ly)
            target.pressKey(code)
            result = true
          break
        if handler > KeyBase:
          if kind == ord(ueLongPress): target.holdKey(handler - 1 - KeyBase, pointer, lx)
          else:
            target.typeGlided(handler - 1 - KeyBase, pointer, lx, ly)
            target.pressKey(handler - 1 - KeyBase)
        else:
          target.declined = false
          target.call(handler - 1, event, target.handlerPayload(r, payload, scale),
            [float32(lx - r.x), float32(ly - r.y), r.w, r.h])
          target.inputOnly = false # whatever the handler changed, get() shows it
          if target.declined:
            break # no render for it: what it did shows with the next
        result = true
        break

{.pop.}
