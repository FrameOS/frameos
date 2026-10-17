## What the dispatcher knows about a person's input between events, on every
## host: where each pointer is and what it holds, the cursor a relative mouse
## moves, which modifier keys are down, what a key means under the frame's
## keyboard layout, and which GPIO buttons are held. Out of that it makes the
## events a scene hears — one `pointerMove` per motion report with the position
## every pointer event carries, `textInput` from a key, `tap` / `doubleTap` /
## `longPress` / `swipe` from a down and an up, a button's `gpio` edges and
## the `button` press / doublePress / longPress they add up to — so the three hosts
## agree on all of it, and a driver or a preview has to say only what it saw.
##
## Pure: no clock (every entry point takes `now`), no channel, no scene. Fed by
## `event_loop.nim`, tested by `tests/test_input_state.nim`, its numbers from
## docs/events-contract.json (`gestures`, `buttons`, `keyboard`).
##
## Positions are scene pixels — the picture as the viewer sees it, rotation and
## flip applied — from the moment they enter here; the 0..PointerWireMax wire
## form (docs/events.md) is converted at the door. That makes the cursor of a
## relative mouse move along the picture's axes on a rotated frame.
##
## The ESP32 has buttons and nothing else (the contract's `hosts.esp32` says so
## for every pointer and keyboard event), so the pointer, keyboard and gesture
## half is not compiled there: it was 17 KB of an image that runs at 90% of
## its OTA slot.

import std/[json, monotimes, strutils, times]
import ./events
import ./types
when not defined(frameosEmbedded):
  import std/[tables, unicode]
  import ./driver_abi
  import ./keyboard_gen
  import ./utils/image

const
  ## A relative pointer's cursor is drawn (by the Linux runner) for this long
  ## after it last moved, then hidden until it moves again.
  CursorHideMs* = 5000

type
  InputDelivery* = object
    ## One event for the scene, with the origin of what caused it.
    name*: string
    payload*: JsonNode
    origin*: EventOrigin

  ButtonKey = object
    ## A key the button layer has not finished with: held (`down`), or a
    ## short press that is over and not yet a `press` (a down of the same pin
    ## within `ButtonDoublePressMs` of `releasedAt` makes the pair a
    ## `doublePress` instead; once the window has passed it is a `press`).
    ## One record for both, so the ESP32 carries one set of seq hooks.
    pin: int
    label, role: string
    origin: EventOrigin
    down: bool
    downAt, releasedAt: MonoTime
    atMs: int       ## the down edge's `atMs`, -1 without one: the `press` or `longPress` it becomes says it
    durationMs: int ## a waiting tap's hold
    twice: bool     ## the second down of a double press: that and nothing more
    wake: bool      ## began with the down that woke the device: its button-layer event says so

when not defined(frameosEmbedded):
  type PointerRecord = object
    x, y: int
    buttons: int
    pointerType: string
    origin: EventOrigin
    down: bool
    downAt: MonoTime
    downX, downY: int
    moved: bool       ## left the tap slop while down
    longPressed: bool
    hasLastTap: bool
    lastTapAt: MonoTime
    lastTapX, lastTapY: int

type
  InputState* = object
    buttonRoles: seq[(int, string)] ## pin -> the role the frame configured
    buttons: seq[ButtonKey]         ## held, or a short press in its double-press window
    when not defined(frameosEmbedded):
      width, height: int             ## scene pixels
      panelWidth, panelHeight, rotate: int
      flip: string
      keyboardLayout: string
      cursorX*, cursorY*: int        ## pointer 0: the one cursor every mouse moves
      cursorMovedAt: MonoTime
      cursorEverMoved: bool
      cursorShown: bool
      cursorDirty*: bool             ## the host should draw (or clear) the cursor
      pointers: Table[int, PointerRecord]
      shift, ctrl, altLeft, altRight, meta, capsLock: bool
      pointerInputLost*: bool        ## a queue dropped pointer input: what is down gets a cancel

proc initInputState*(config: FrameConfig): InputState =
  result = InputState(buttonRoles: @[], buttons: @[])
  when not defined(frameosEmbedded):
    result.pointers = initTable[int, PointerRecord]()
    result.keyboardLayout = "us"
  if config.isNil:
    return
  for button in config.gpioButtons:
    if not button.isNil and button.role.len > 0:
      result.buttonRoles.add((button.pin, button.role))
  when not defined(frameosEmbedded):
    result.panelWidth = config.width
    result.panelHeight = config.height
    result.rotate = config.rotate
    result.flip = config.flip
    if config.rotate in [90, 270]:
      result.width = config.height
      result.height = config.width
    else:
      result.width = config.width
      result.height = config.height
    if not config.inputSettings.isNil and config.inputSettings.keyboardLayout.len > 0:
      result.keyboardLayout = config.inputSettings.keyboardLayout
    # A cursor parked in a corner needs a full sweep of the desk before it is
    # anywhere useful: start at the centre.
    result.cursorX = max(0, result.width div 2)
    result.cursorY = max(0, result.height div 2)

proc msSince(now, then: MonoTime): int =
  int(inMilliseconds(now - then))

proc isInt(payload: JsonNode, key: string): bool =
  ## `payload{key}` is nil without the key, and `.kind` on nil is a nil
  ## dereference (the ESP32 bench found that once; wasm hides it).
  let node = payload{key}
  not node.isNil and node.kind == JInt

proc seenAt(payload: JsonNode, now: MonoTime): MonoTime =
  ## When the driver saw this edge: its `atMs` (ms on the host's monotonic
  ## clock, the one `now` reads; CLOCK_MONOTONIC on Linux, esp_timer on the
  ## ESP32), or `now` for a producer that gives none. An ESP32 drains its
  ## button queue between renders, so an edge can be half a minute old by the
  ## time it is delivered; measuring the hold from `now` made a tap during a
  ## panel refresh a 30 s long press. A time in the future is a clock the
  ## producer does not share: it reads as now.
  if payload.isInt("atMs"):
    let nowMs = now.ticks div 1_000_000
    let ago = nowMs - payload["atMs"].getInt()
    if ago > 0:
      return now - initDuration(milliseconds = ago)
  now

# ------------------------------------------------------------------- buttons

proc buttonRole*(state: InputState, pin: int, label: string): string =
  ## The configured role of a button, or the default its label carries.
  for (configuredPin, role) in state.buttonRoles:
    if configuredPin == pin:
      return role
  buttonRoleForLabel(label.strip().toUpperAscii())

proc addButton(output: var seq[InputDelivery], name: string, origin: EventOrigin, pin: int,
               label, role, action: string, atMs = -1, durationMs = -1, level = -1, wake = false) =
  ## One `gpio` (an edge) or `button` (a press) event for the scene. Every one
  ## is built here, so the ESP32 carries this code once: the four fields each
  ## has, then the optional ones when set. `heldSeconds` (the hold in whole
  ## seconds) always comes with `durationMs`.
  let payload = %*{"pin": pin, "label": label, "role": role, "action": action}
  if level >= 0:
    payload["level"] = %level
  if wake:
    payload["wake"] = %true
  if atMs >= 0:
    payload["atMs"] = %atMs
  if durationMs >= 0:
    payload["durationMs"] = %durationMs
    payload["heldSeconds"] = %(durationMs div 1000)
  output.add(InputDelivery(name: name, origin: origin, payload: payload))

proc keyFor(state: InputState, pin: int, label: string): int =
  ## A key is its pin and its label. On a frame a pin's label never changes;
  ## the preview's buttons have no pin at all (-1), and a tap on A then on B
  ## is two presses, not a double press.
  for index, key in state.buttons:
    if key.pin == pin and key.label == label:
      return index
  -1

proc tickButtons(state: var InputState, now: MonoTime, output: var seq[InputDelivery]) =
  ## Time passing for the button layer: a short press whose double-press
  ## window has closed is a `press`. Nothing happens while a key is held; a
  ## long press is decided by its `up`.
  var index = 0
  while index < state.buttons.len:
    let key = state.buttons[index]
    if not key.down and msSince(now, key.releasedAt) > ButtonDoublePressMs:
      output.addButton(evButton, key.origin, key.pin, key.label, key.role, "press", key.atMs, key.durationMs,
        wake = key.wake)
      state.buttons.delete(index)
    else:
      inc index

proc button(state: var InputState, name: string, payload: JsonNode, origin: EventOrigin, now: MonoTime,
            output: var seq[InputDelivery]) =
  ## GPIO buttons, as two events (docs/events.md, "Buttons").
  ##
  ## An edge — `gpio` with `level` (0 is down: the line is pulled up) or the
  ## action `down` / `up` — is delivered at once as `gpio`, and fed to the
  ## button layer, which makes a `button` `press` / `doublePress` /
  ## `longPress` out of the edges, each press exactly one of them. Producers
  ## until 2026.10.16 sent their edges as `button` (with `level`, the action
  ## `down` / `up`, or before that `press` / `release`); such a `button` is an
  ## edge too, so they still work.
  ##
  ## A `button` that is not an edge — HTTP, the cloud, a schedule or a scene
  ## saying a button was pressed — moved no line and has nothing to time: it
  ## is delivered as said, with no `action` meaning `press`. A `gpio` that
  ## names no edge moved no line either, and is dropped.
  ##
  ## Time is the edge's: a driver that says when it saw the edge (`atMs`) has
  ## every rule timed from there, and the button layer advances to that
  ## moment before the edge applies (a `press` whose window closed before
  ## this down comes first). A host must therefore not tick to now on an
  ## event's way in: a tick is time passing between events.
  let pin = payload{"pin"}.getInt(-1)
  let label = payload{"label"}.getStr()
  var role = payload{"role"}.getStr()
  if role.len == 0:
    role = state.buttonRole(pin, label)
  let action = payload{"action"}.getStr()
  let atMs = if payload.isInt("atMs"): payload["atMs"].getInt() else: -1
  let given = if payload.isInt("durationMs"): payload["durationMs"].getInt() else: -1
  let wake = payload{"wake"}.getBool()
  if not (payload.isInt("level") or action in ["down", "up"]):
    if name == evButton:
      output.addButton(evButton, origin, pin, label, role, if action.len == 0: "press" else: action, atMs, given,
        wake = wake)
    return
  let down = if payload.isInt("level"): payload["level"].getInt() == 0 else: action == "down"
  let at = payload.seenAt(now)
  state.tickButtons(at, output) # a tap whose window closed before this edge is a press first
  let index = state.keyFor(pin, label)
  if down:
    output.addButton(evGpio, origin, pin, label, role, "down", atMs, level = 0, wake = wake)
    # A key still waiting out its window makes this down the double press;
    # one still held missed its `up`, and this down starts over. The down
    # that woke the device is a press like any other: the ESP32 stamps it
    # (at the reset when the key is still down once it can look, else when
    # it first saw it), and its hold, its `up` and a second tap follow.
    let twice = index >= 0 and not state.buttons[index].down
    let startedByWake = wake or (twice and state.buttons[index].wake)
    if index >= 0:
      state.buttons.delete(index)
    state.buttons.add(ButtonKey(pin: pin, label: label, role: role, origin: origin, down: true,
      downAt: at, atMs: atMs, twice: twice, wake: startedByWake))
    if twice:
      output.addButton(evButton, origin, pin, label, role, "doublePress", atMs, wake = startedByWake)
  elif index < 0 or not state.buttons[index].down:
    # No down to measure from (a key held since before the driver started):
    # the host's own count if it gave one.
    output.addButton(evGpio, origin, pin, label, role, "up", atMs, max(given, 0), level = 1)
  else:
    let key = state.buttons[index]
    let duration = msSince(at, key.downAt)
    output.addButton(evGpio, origin, pin, label, role, "up", atMs, duration, level = 1)
    if not key.twice and duration < ButtonLongPressMs:
      # A short press: it waits out its window before it is a `press`.
      state.buttons[index].down = false
      state.buttons[index].releasedAt = at
      state.buttons[index].durationMs = duration
    else:
      state.buttons.delete(index)
      if not key.twice:
        # Held at least `ButtonLongPressMs`: a long press, decided now that
        # it is over, with how long it was. Once, never while held. (A
        # double press is that and nothing more.)
        output.addButton(evButton, key.origin, pin, label, role, "longPress", key.atMs, duration, wake = key.wake)

proc buttonsHeld*(state: InputState): int =
  for key in state.buttons:
    if key.down:
      inc result

proc buttonsBusy*(state: InputState): int =
  ## Keys down plus short presses still in their double-press window: a
  ## `press`, `doublePress` or `longPress` is still to come. A host keeps
  ## ticking while a tap waits, so its `press` arrives on time.
  state.buttons.len

when not defined(frameosEmbedded):
  proc isStr(payload: JsonNode, key: string): bool =
    let node = payload{key}
    not node.isNil and node.kind == JString

  # ----------------------------------------------------------------- positions

  proc clampX(state: InputState, x: int): int =
    if state.width > 0: max(0, min(state.width - 1, x)) else: max(0, min(PointerWireMax, x))

  proc clampY(state: InputState, y: int): int =
    if state.height > 0: max(0, min(state.height - 1, y)) else: max(0, min(PointerWireMax, y))

  proc wireToScene(state: InputState, wireX, wireY: int): (int, int) =
    ## The 0..PointerWireMax wire position across the panel as a scene pixel.
    if state.panelWidth > 0 and state.panelHeight > 0:
      let point = pointerToScenePoint(wireX, wireY, state.panelWidth, state.panelHeight, state.rotate, state.flip)
      (point.x, point.y)
    else:
      (state.clampX(wireX), state.clampY(wireY))

  proc pointerTypeName(kind: int): string =
    case kind
    of ord(dptTouch): "touch"
    of ord(dptPen): "pen"
    else: "mouse"

  # ------------------------------------------------------------------ pointers

  proc pointer(state: var InputState, id: int, pointerType: string, origin: EventOrigin): ptr PointerRecord =
    if not state.pointers.hasKey(id):
      state.pointers[id] = PointerRecord(x: state.cursorX, y: state.cursorY,
        pointerType: (if pointerType.len > 0: pointerType else: "mouse"), origin: origin)
    result = addr state.pointers[id]
    if pointerType.len > 0:
      result.pointerType = pointerType
    result.origin = origin

  proc pointerPayload(rec: PointerRecord, id: int): JsonNode =
    %*{"x": rec.x, "y": rec.y, "pointerId": id, "pointerType": rec.pointerType, "buttons": rec.buttons}

  proc moveCursorTo(state: var InputState, x, y: int, now: MonoTime) =
    state.cursorX = state.clampX(x)
    state.cursorY = state.clampY(y)
    state.cursorMovedAt = now
    state.cursorEverMoved = true

  proc place(state: var InputState, rec: ptr PointerRecord, x, y: int) =
    ## The pointer is here now — from a move, or the position a press or a
    ## release carries. A held pointer that got this far from where it went down
    ## has moved, whichever event said so: a `pointerUp` far from its down is a
    ## swipe, not a tap.
    rec.x = state.clampX(x)
    rec.y = state.clampY(y)
    if rec.down and not rec.moved and (abs(rec.x - rec.downX) > GestureTapSlopPx or
        abs(rec.y - rec.downY) > GestureTapSlopPx):
      rec.moved = true
    # The cursor follows every pointer, so a mouse picked up after a touch
    # continues from where the finger was. Only a relative mouse SHOWS it.
    state.cursorX = rec.x
    state.cursorY = rec.y

  proc pointerMoved(state: var InputState, id: int, pointerType: string, x, y: int,
                    origin: EventOrigin, now: MonoTime, output: var seq[InputDelivery]) =
    let rec = state.pointer(id, pointerType, origin)
    state.place(rec, x, y)
    output.add(InputDelivery(name: evPointerMove, payload: pointerPayload(rec[], id), origin: origin))

  proc cursorMovedBy(state: var InputState, dx, dy: int, origin: EventOrigin, now: MonoTime,
                     output: var seq[InputDelivery]) =
    ## A relative mouse: the host owns the position. One count is one scene pixel.
    state.moveCursorTo(state.cursorX + dx, state.cursorY + dy, now)
    if not state.cursorShown:
      state.cursorShown = true
    state.cursorDirty = true
    state.pointerMoved(0, "mouse", state.cursorX, state.cursorY, origin, now, output)

  proc pointerDown(state: var InputState, id: int, pointerType: string, button: int,
                   origin: EventOrigin, now: MonoTime, output: var seq[InputDelivery]) =
    let rec = state.pointer(id, pointerType, origin)
    if button >= 0 and button < 31:
      rec.buttons = rec.buttons or (1 shl button)
    if not rec.down:
      rec.down = true
      rec.downAt = now
      rec.downX = rec.x
      rec.downY = rec.y
      rec.moved = false
      rec.longPressed = false
    var payload = pointerPayload(rec[], id)
    payload["button"] = %button
    output.add(InputDelivery(name: evPointerDown, payload: payload, origin: origin))

  proc gesture(rec: PointerRecord, id: int, name: string, origin: EventOrigin): InputDelivery =
    InputDelivery(name: name, origin: origin,
      payload: %*{"x": rec.x, "y": rec.y, "pointerId": id, "pointerType": rec.pointerType})

  proc pointerUp(state: var InputState, id: int, pointerType: string, button: int,
                 origin: EventOrigin, now: MonoTime, output: var seq[InputDelivery]) =
    let rec = state.pointer(id, pointerType, origin)
    if button >= 0 and button < 31:
      rec.buttons = rec.buttons and not (1 shl button)
    var payload = pointerPayload(rec[], id)
    payload["button"] = %button
    output.add(InputDelivery(name: evPointerUp, payload: payload, origin: origin))
    if not rec.down or rec.buttons != 0:
      return
    rec.down = false
    # Gestures are made of the primary button only: a right click is not a tap.
    if button != 0:
      return
    let held = msSince(now, rec.downAt)
    let dx = rec.x - rec.downX
    let dy = rec.y - rec.downY
    if rec.longPressed:
      # Delivered while held (a host that ticks) or now (one that does not).
      return
    if not rec.moved:
      if held >= GestureLongPressMs:
        var press = gesture(rec[], id, evLongPress, origin)
        press.payload["durationMs"] = %held
        output.add(press)
        rec.hasLastTap = false
        return
      if held <= GestureTapMs:
        output.add(gesture(rec[], id, evTap, origin))
        if rec.hasLastTap and msSince(now, rec.lastTapAt) <= GestureDoubleTapMs and
            abs(rec.x - rec.lastTapX) <= GestureTapSlopPx and abs(rec.y - rec.lastTapY) <= GestureTapSlopPx:
          output.add(gesture(rec[], id, evDoubleTap, origin))
          rec.hasLastTap = false
        else:
          rec.hasLastTap = true
          rec.lastTapAt = now
          rec.lastTapX = rec.x
          rec.lastTapY = rec.y
      return
    rec.hasLastTap = false
    if max(abs(dx), abs(dy)) >= GestureSwipeMinPx:
      var swipe = gesture(rec[], id, evSwipe, origin)
      swipe.payload["direction"] = %(if abs(dx) >= abs(dy): (if dx > 0: "right" else: "left")
                                     else: (if dy > 0: "down" else: "up"))
      swipe.payload["startX"] = %rec.downX
      swipe.payload["startY"] = %rec.downY
      output.add(swipe)

  proc pointerCancel(state: var InputState, id: int, origin: EventOrigin, output: var seq[InputDelivery]) =
    if not state.pointers.hasKey(id):
      return
    let rec = addr state.pointers[id]
    if rec.down or rec.buttons != 0:
      output.add(InputDelivery(name: evPointerCancel, origin: origin,
        payload: %*{"x": rec.x, "y": rec.y, "pointerId": id, "pointerType": rec.pointerType}))
    rec.down = false
    rec.buttons = 0
    rec.hasLastTap = false

  proc cancelPointers*(state: var InputState, origin: EventOrigin, output: var seq[InputDelivery],
                       deviceId = -1, mouseToo = true) =
    ## Every pointer that is down lets go: the queue dropped input between a down
    ## and its up, or a device went away (`deviceId`: only that device's
    ## pointers, and the cursor when `mouseToo`). A scene holding a drag hears it.
    var ids: seq[int]
    for id, rec in state.pointers:
      if not (rec.down or rec.buttons != 0):
        continue
      if deviceId >= 0 and id != 0 and id div PointersPerDevice != deviceId:
        continue
      if id == 0 and not mouseToo:
        continue
      ids.add(id)
    for id in ids:
      state.pointerCancel(id, origin, output)
    if deviceId < 0:
      state.pointerInputLost = false

  proc wheel(state: var InputState, deltaX, deltaY: int, origin: EventOrigin, output: var seq[InputDelivery]) =
    let rec = state.pointer(0, "", origin)
    output.add(InputDelivery(name: evWheel, origin: origin,
      payload: %*{"deltaX": deltaX, "deltaY": deltaY, "x": rec.x, "y": rec.y}))

  # ------------------------------------------------------------------ keyboard

  proc isLetterKey(code: string): bool =
    code.len == 4 and code.startsWith("Key")

  proc keyValue(state: InputState, code: string, shift, altGr: bool): string =
    ## What `code` means right now: a named key, or the layout's character under
    ## the modifiers held. "Unidentified" is the W3C's word for a key it has no
    ## name for (a gamepad button, a code the tables do not know).
    let named = keyNamedValue(code)
    if named.len > 0:
      return named
    let (base, shifted, third) = keyboardLayoutKey(state.keyboardLayout, code)
    if altGr and third.len > 0:
      return third
    let upper = if isLetterKey(code): shift != state.capsLock else: shift
    if upper and shifted.len > 0:
      return shifted
    if base.len > 0:
      return base
    "Unidentified"

  proc isPrintable(key: string): bool =
    key.runeLen == 1

  proc trackModifier(state: var InputState, code: string, down: bool) =
    case code
    of "ShiftLeft", "ShiftRight": state.shift = down
    of "ControlLeft", "ControlRight": state.ctrl = down
    of "AltLeft": state.altLeft = down
    of "AltRight": state.altRight = down
    of "MetaLeft", "MetaRight": state.meta = down
    of "CapsLock":
      if down: state.capsLock = not state.capsLock
    else: discard

  proc keyPayload(state: InputState, code, key: string, down, repeat: bool, linuxCode: int): JsonNode =
    result = %*{"code": code, "key": key, "shift": state.shift, "ctrl": state.ctrl,
      "alt": state.altLeft or state.altRight, "meta": state.meta}
    if down:
      result["repeat"] = %repeat
    if linuxCode >= 0:
      result["linuxCode"] = %linuxCode

  proc keyFromLinux(state: var InputState, linuxCode: int, down, repeat: bool,
                    origin: EventOrigin, output: var seq[InputDelivery]) =
    ## A key as the evdev driver reports it: a number, and whether it went down.
    var code = linuxKeyCode(linuxCode)
    if code.len == 0:
      code = "Unidentified"
    if not repeat:
      state.trackModifier(code, down)
    let key = state.keyValue(code, state.shift, state.altRight)
    output.add(InputDelivery(name: (if down: evKeyDown else: evKeyUp), origin: origin,
      payload: state.keyPayload(code, key, down, repeat and down, linuxCode)))
    if down and isPrintable(key) and not (state.ctrl or state.meta or state.altLeft):
      output.add(InputDelivery(name: evTextInput, origin: origin, payload: %*{"text": key}))

  proc keyFromPayload(state: var InputState, name: string, payload: JsonNode,
                      origin: EventOrigin, output: var seq[InputDelivery]) =
    ## A key as a preview, an HTTP request or a scene says it: W3C `code` and
    ## `key` when it knows them, the flags it knows. What it leaves out is
    ## filled in here; a `key` it did not give is mapped through the layout, and
    ## only then is a `textInput` made — a browser sends its own.
    let down = name == evKeyDown
    var linuxCode = -1
    var code = payload{"code"}.getStr()
    if payload.isInt("code"):
      # The 2026.9.21 payload: `key` was the Linux name, `code` its number.
      linuxCode = payload["code"].getInt()
      code = linuxKeyCode(linuxCode)
    elif payload.isInt("linuxCode"):
      linuxCode = payload["linuxCode"].getInt()
      if code.len == 0:
        code = linuxKeyCode(linuxCode)
    if code.len == 0:
      code = "Unidentified"
    let repeat = down and payload{"repeat"}.getBool()
    let ownFlags = payload.hasKey("shift") or payload.hasKey("ctrl") or payload.hasKey("alt") or payload.hasKey("meta")
    if not ownFlags and not repeat:
      state.trackModifier(code, down)
    let shift = if payload.hasKey("shift"): payload["shift"].getBool() else: state.shift
    let ctrl = if payload.hasKey("ctrl"): payload["ctrl"].getBool() else: state.ctrl
    let alt = if payload.hasKey("alt"): payload["alt"].getBool() else: state.altLeft or state.altRight
    let meta = if payload.hasKey("meta"): payload["meta"].getBool() else: state.meta
    let gaveKey = payload.isStr("key") and payload["key"].getStr().len > 0 and
      not payload["key"].getStr().startsWith("KEY_")
    let key = if gaveKey: payload["key"].getStr() else: state.keyValue(code, shift, state.altRight)
    var delivered = %*{"code": code, "key": key, "shift": shift, "ctrl": ctrl, "alt": alt, "meta": meta}
    if down:
      delivered["repeat"] = %repeat
    if linuxCode >= 0:
      delivered["linuxCode"] = %linuxCode
    output.add(InputDelivery(name: name, origin: origin, payload: delivered))
    if down and not gaveKey and isPrintable(key) and not (ctrl or meta or (alt and not state.altRight)):
      output.add(InputDelivery(name: evTextInput, origin: origin, payload: %*{"text": key}))

  # ------------------------------------------------------------------- entries

  proc applyDriverInput*(state: var InputState, event: DriverInputEvent, origin: EventOrigin,
                         now: MonoTime, output: var seq[InputDelivery]) =
    ## One struct from an input driver (frameos/driver_abi) -> the events it means.
    let hasPosition = (event.flags.int and ord(difHasPosition)) != 0
    let pointerType = pointerTypeName(event.pointerType.int)
    case DriverInputKind(event.kind)
    of dikPointerAbs:
      let (x, y) = state.wireToScene(event.x.int, event.y.int)
      state.pointerMoved(event.pointerId.int, pointerType, x, y, origin, now, output)
    of dikPointerRel:
      state.cursorMovedBy(event.x.int, event.y.int, origin, now, output)
    of dikPointerDown, dikPointerUp:
      if hasPosition:
        let (x, y) = state.wireToScene(event.x.int, event.y.int)
        state.place(state.pointer(event.pointerId.int, pointerType, origin), x, y)
      if DriverInputKind(event.kind) == dikPointerDown:
        state.pointerDown(event.pointerId.int, pointerType, event.code.int, origin, now, output)
      else:
        state.pointerUp(event.pointerId.int, pointerType, event.code.int, origin, now, output)
    of dikPointerCancel:
      if event.pointerId < 0:
        state.cancelPointers(origin, output, deviceId = event.deviceId.int,
          mouseToo = event.pointerType.int == ord(dptMouse))
      else:
        state.pointerCancel(event.pointerId.int, origin, output)
    of dikWheel:
      state.wheel(event.x.int, event.y.int, origin, output)
    of dikKeyDown:
      state.keyFromLinux(event.code.int, true, event.value == 2, origin, output)
    of dikKeyUp:
      state.keyFromLinux(event.code.int, false, false, origin, output)
    of dikNone:
      discard

  proc pointerFromPayload(state: var InputState, payload: JsonNode, origin: EventOrigin): (int, string) =
    ## The pointer a JSON pointer event is about, its position applied.
    let id = payload{"pointerId"}.getInt(0)
    let pointerType = payload{"pointerType"}.getStr()
    let rec = state.pointer(id, pointerType, origin)
    if payload.isInt("x") and payload.isInt("y"):
      let (x, y) = state.wireToScene(payload["x"].getInt(), payload["y"].getInt())
      state.place(rec, x, y)
    (id, rec.pointerType)

  proc applyNamedPointerOrKey(state: var InputState, name: string, payload: JsonNode, origin: EventOrigin,
                              now: MonoTime, output: var seq[InputDelivery]): bool =
    case name
    of evPointerMove, evMouseMove:
      let id = payload{"pointerId"}.getInt(0)
      let pointerType = payload{"pointerType"}.getStr()
      if payload.isInt("x") and payload.isInt("y"):
        let (x, y) = state.wireToScene(payload["x"].getInt(), payload["y"].getInt())
        state.pointerMoved(id, pointerType, x, y, origin, now, output)
      else:
        let rec = state.pointer(id, pointerType, origin)
        state.pointerMoved(id, pointerType, rec.x, rec.y, origin, now, output)
    of evPointerDown, evMouseDown:
      let (id, pointerType) = state.pointerFromPayload(payload, origin)
      state.pointerDown(id, pointerType, payload{"button"}.getInt(0), origin, now, output)
    of evPointerUp, evMouseUp:
      let (id, pointerType) = state.pointerFromPayload(payload, origin)
      state.pointerUp(id, pointerType, payload{"button"}.getInt(0), origin, now, output)
    of evPointerCancel:
      let id = payload{"pointerId"}.getInt(0)
      discard state.pointer(id, payload{"pointerType"}.getStr(), origin)
      state.pointerCancel(id, origin, output)
    of evWheel:
      if payload.isInt("x") and payload.isInt("y"):
        discard state.pointerFromPayload(payload, origin)
      state.wheel(payload{"deltaX"}.getInt(), payload{"deltaY"}.getInt(), origin, output)
    of evTap, evDoubleTap, evLongPress, evSwipe:
      # Injected, not made here: the position is converted, the rest passes.
      let (id, pointerType) = state.pointerFromPayload(payload, origin)
      let rec = state.pointers[id]
      var delivered = copy(payload)
      delivered["x"] = %rec.x
      delivered["y"] = %rec.y
      delivered["pointerId"] = %id
      delivered["pointerType"] = %pointerType
      output.add(InputDelivery(name: name, origin: origin, payload: delivered))
    of evKeyDown, evKeyUp:
      state.keyFromPayload(name, payload, origin, output)
    of evTextInput:
      output.add(InputDelivery(name: name, origin: origin, payload: %*{"text": payload{"text"}.getStr()}))
    else:
      return false
    true

  proc tickPointers(state: var InputState, now: MonoTime, output: var seq[InputDelivery]) =
    for id, rec in state.pointers.mpairs:
      if rec.down and not rec.moved and not rec.longPressed and msSince(now, rec.downAt) >= GestureLongPressMs:
        rec.longPressed = true
        rec.hasLastTap = false
        var press = gesture(rec, id, evLongPress, rec.origin)
        press.payload["durationMs"] = %msSince(now, rec.downAt)
        output.add(press)
    if state.cursorShown and msSince(now, state.cursorMovedAt) >= CursorHideMs:
      state.cursorShown = false
      state.cursorDirty = true

  proc cursorVisible*(state: InputState): bool =
    ## Whether the host should draw the cursor: a relative mouse moved it lately.
    state.cursorShown

  proc takeCursorDirty*(state: var InputState): bool =
    result = state.cursorDirty
    state.cursorDirty = false

  proc pointersDown*(state: InputState): int =
    ## How many pointers are held: what a host asks to know whether to tick.
    for _, rec in state.pointers:
      if rec.down:
        inc result
else:
  proc cursorVisible*(state: InputState): bool = false
  proc takeCursorDirty*(state: var InputState): bool = false
  proc pointersDown*(state: InputState): int = 0

proc applyNamedInput*(state: var InputState, name: string, payload: JsonNode, origin: EventOrigin,
                      now: MonoTime, output: var seq[InputDelivery]): bool =
  ## An input event as JSON — from the preview, an HTTP request, a schedule, a
  ## scene, or an older driver — under its new name or an old one. Positions
  ## on the wire are 0..PointerWireMax across the panel (docs/events.md); a
  ## payload without one is at the pointer's last position. False when `name`
  ## is not an input event this module makes: the caller delivers it as it is.
  if name == evGpio or name == evButton:
    state.button(name, payload, origin, now, output)
    return true
  when defined(frameosEmbedded):
    false
  else:
    state.applyNamedPointerOrKey(name, payload, origin, now, output)

proc tick*(state: var InputState, now: MonoTime, output: var seq[InputDelivery]) =
  ## Time passing: a pointer held long enough is a `longPress`, a short button
  ## press whose double-press window closed is a `press`, a cursor nobody
  ## moved hides. A host calls this between events, never on one's way in:
  ## an edge that was seen earlier (`atMs`) advances the state to its own
  ## time. A host that cannot tick (the ESP32 in a render) gets a pointer's
  ## long press on release instead, and a button's `press` at its next edge
  ## or tick.
  when not defined(frameosEmbedded):
    state.tickPointers(now, output)
  state.tickButtons(now, output)
