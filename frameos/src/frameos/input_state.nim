## What the dispatcher knows about a person's input between events, on every
## host: where each pointer is and what it holds, the cursor a relative mouse
## moves, which modifier keys are down, what a key means under the frame's
## keyboard layout, and which GPIO buttons are held. Out of that it makes the
## events a scene hears — one `pointerMove` per motion report with the position
## every pointer event carries, `textInput` from a key, `tap` / `doubleTap` /
## `longPress` / `swipe` from a down and an up, `longPress` / `repeat` /
## `release {durationMs}` from a held button — so the three hosts agree on all
## of it, and a driver or a preview has to say only what it saw.
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

  ButtonHold = object
    pin: int
    label, role: string
    origin: EventOrigin
    downAt: MonoTime
    longPressed: bool
    lastRepeatAt: MonoTime

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
    buttons: seq[ButtonHold]        ## the ones held right now
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

# ------------------------------------------------------------------- buttons

proc buttonRole*(state: InputState, pin: int, label: string): string =
  ## The configured role of a button, or the default its label carries.
  for (configuredPin, role) in state.buttonRoles:
    if configuredPin == pin:
      return role
  buttonRoleForLabel(label.strip().toUpperAscii())

proc buttonPayload(pin: int, label, role, action: string): JsonNode =
  %*{"pin": pin, "label": label, "role": role, "action": action}

proc heldButton(state: InputState, pin: int): int =
  for index, hold in state.buttons:
    if hold.pin == pin:
      return index
  -1

proc button(state: var InputState, payload: JsonNode, origin: EventOrigin, now: MonoTime,
            output: var seq[InputDelivery]) =
  ## `button` as a driver says it — `{pin, label, level}` plus `action` (an
  ## edge) and `wake` — or as a preview, a schedule, the cloud or a scene
  ## re-sends it. A payload with no `action` is a press: that is all a driver
  ## from before 2026.9.23 ever sent.
  let pin = payload{"pin"}.getInt(-1)
  let label = payload{"label"}.getStr()
  var role = payload{"role"}.getStr()
  if role.len == 0:
    role = state.buttonRole(pin, label)
  let action = payload{"action"}.getStr("press")
  let wake = payload{"wake"}.getBool()
  var delivered = buttonPayload(pin, label, role, action)
  if payload.hasKey("level"):
    delivered["level"] = payload["level"]
  if wake:
    delivered["wake"] = %true
  let held = state.heldButton(pin)
  case action
  of "press":
    if held >= 0:
      state.buttons.delete(held)
    # A boot the button caused: the key was released seconds ago, so there
    # is no hold to follow.
    if not wake:
      state.buttons.add(ButtonHold(pin: pin, label: label, role: role, origin: origin, downAt: now))
  of "release":
    if held >= 0:
      delivered["durationMs"] = %msSince(now, state.buttons[held].downAt)
      state.buttons.delete(held)
    elif not payload.hasKey("durationMs"):
      delivered["durationMs"] = %0
  else:
    discard
  if payload.isInt("durationMs") and not delivered.hasKey("durationMs"):
    delivered["durationMs"] = payload["durationMs"]
  output.add(InputDelivery(name: evButton, origin: origin, payload: delivered))

proc tickButtons(state: var InputState, now: MonoTime, output: var seq[InputDelivery]) =
  for hold in state.buttons.mitems:
    let held = msSince(now, hold.downAt)
    if not hold.longPressed:
      if held >= ButtonLongPressMs:
        hold.longPressed = true
        hold.lastRepeatAt = now
        var press = buttonPayload(hold.pin, hold.label, hold.role, "longPress")
        press["durationMs"] = %held
        output.add(InputDelivery(name: evButton, origin: hold.origin, payload: press))
    elif msSince(now, hold.lastRepeatAt) >= ButtonRepeatMs:
      hold.lastRepeatAt = now
      var repeat = buttonPayload(hold.pin, hold.label, hold.role, "repeat")
      repeat["durationMs"] = %held
      output.add(InputDelivery(name: evButton, origin: hold.origin, payload: repeat))

proc buttonsHeld*(state: InputState): int =
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
  if name == evButton:
    state.button(payload, origin, now, output)
    return true
  when defined(frameosEmbedded):
    false
  else:
    state.applyNamedPointerOrKey(name, payload, origin, now, output)

proc tick*(state: var InputState, now: MonoTime, output: var seq[InputDelivery]) =
  ## Time passing: a pointer or a button held long enough is a `longPress`, a
  ## button held longer `repeat`s, a cursor nobody moved hides. A host calls
  ## this between drains; one that cannot (the ESP32 asleep in a render) gets
  ## the long press on release instead.
  when not defined(frameosEmbedded):
    state.tickPointers(now, output)
  state.tickButtons(now, output)
