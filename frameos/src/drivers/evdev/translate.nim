## The evdev driver's translation: raw kernel `input_event`s in, the driver's
## input structs (frameos/driver_abi `DriverInputEvent`) out. Kept apart from
## libevdev and from the host so it compiles and is tested on a machine that
## has neither — every rule in here was a bug once, and the read loop it used
## to live in could not be tested at all.
##
## Nothing here allocates JSON, knows a key's name or owns a cursor: a relative
## mouse's counts go to the host as they are (frameos/input_state.nim keeps the
## one cursor, in scene pixels, so it moves along the picture's axes on a
## rotated frame), and the I/O shell (evdev.nim) only reads and sends.

import ./linuxInput
import ./pointer
import frameos/driver_abi

export driver_abi.DriverInputEvent, driver_abi.DriverInputKind, driver_abi.DriverPointerType, driver_abi.PointersPerDevice,
  driver_abi.DriverInputFlag

const
  MaxSlots = PointersPerDevice - 1

type
  SlotState = object
    trackingId: int ## -1: no contact in this slot
    x, y: int
    hasX, hasY: bool
    moved: bool     ## a position report this frame
    began: bool     ## a contact arrived this frame
    ended: bool     ## a contact left this frame

  DeviceTranslator* = object
    ## Per-device state: the position an absolute device last reported, and
    ## what the input frame being read has produced so far.
    deviceId: int
    minX*, maxX*, minY*, maxY*: int
    pointerType*: DriverPointerType
    multitouch: bool ## ABS_MT_SLOT: protocol B, a contact per slot
    lastX, lastY: int
    hasX, hasY, absMoved, relMoved: bool
    relX, relY: int
    wheelX, wheelY: int
    slot: int
    slots: array[MaxSlots, SlotState]
    # Key and button events of the input frame being read, held until its
    # SYN_REPORT so they follow the frame's position. A touchscreen reports
    # BTN_TOUCH ahead of the coordinates it belongs to; sent as it arrived, the
    # press would land wherever the previous touch ended.
    pending: seq[DriverInputEvent]
    unknownTypesSeen: set[uint8]

  TranslateResult* = enum
    trOk
    trUnknownType ## the first event of a type this driver does not handle,
                  ## once per device per type: worth one log line, not one
                  ## per event (a mouse sends hundreds a second)

proc initDeviceTranslator*(minX, maxX, minY, maxY: int, deviceId = 0,
                           pointerType = dptMouse, multitouch = false): DeviceTranslator =
  result = DeviceTranslator(deviceId: deviceId, minX: minX, maxX: maxX, minY: minY, maxY: maxY,
    pointerType: pointerType, multitouch: multitouch)
  for slot in result.slots.mitems:
    slot.trackingId = -1

proc pointerButton(code: int): int =
  ## The button number of a pointer button, -1 for every other code.
  case code
  of BTN_LEFT: 0
  of BTN_RIGHT: 1
  of BTN_MIDDLE: 2
  of BTN_SIDE: 3
  of BTN_EXTRA: 4
  of BTN_FORWARD: 5
  of BTN_BACK: 6
  of BTN_TASK: 7
  of BTN_TOUCH: 0 # a finger down is the primary button
  of BTN_STYLUS: 1 # a pen's barrel buttons
  of BTN_STYLUS2: 2
  else: -1

proc isToolCode(code: int): bool =
  ## BTN_TOOL_* say WHAT is near the surface (a finger, a pen, two fingers),
  ## not that anything was pressed: a touchpad tap sends BTN_TOOL_FINGER next
  ## to BTN_TOUCH, and read as a button that was two presses per tap.
  code >= BTN_DIGI and code <= BTN_TOOL_QUADTAP and code != BTN_TOUCH and code != BTN_STYLUS and code != BTN_STYLUS2

proc absPointerId(state: DeviceTranslator): int =
  ## The one pointer of a single-touch or tablet device.
  state.deviceId * PointersPerDevice + 1

proc slotPointerId(state: DeviceTranslator, slot: int): int =
  state.deviceId * PointersPerDevice + 1 + slot

proc event(state: DeviceTranslator, kind: DriverInputKind, pointerId = 0): DriverInputEvent =
  DriverInputEvent(kind: ord(kind).cint, deviceId: state.deviceId.cint, pointerId: pointerId.cint,
    pointerType: ord(state.pointerType).cint)

proc withWirePosition(ev: var DriverInputEvent, state: DeviceTranslator, x, y: int) =
  ev.x = scalePointerAxis(x, state.minX, state.maxX).cint
  ev.y = scalePointerAxis(y, state.minY, state.maxY).cint
  ev.flags = ev.flags or ord(difHasPosition).cint

proc flushSlots(state: var DeviceTranslator, output: var seq[DriverInputEvent]) =
  ## Protocol B: per slot, the position first, then the contact's arrival or
  ## departure, so a down lands where the finger is.
  for index, slot in state.slots.mpairs:
    if slot.trackingId < 0 and not slot.ended:
      continue
    let id = state.slotPointerId(index)
    if (slot.moved or slot.began) and slot.hasX and slot.hasY:
      var move = state.event(dikPointerAbs, id)
      move.withWirePosition(state, slot.x, slot.y)
      output.add(move)
    if slot.began:
      var down = state.event(dikPointerDown, id)
      down.code = 0
      if slot.hasX and slot.hasY:
        down.withWirePosition(state, slot.x, slot.y)
      output.add(down)
    if slot.ended:
      var up = state.event(dikPointerUp, id)
      up.code = 0
      if slot.hasX and slot.hasY:
        up.withWirePosition(state, slot.x, slot.y)
      output.add(up)
      slot.trackingId = -1
    slot.moved = false
    slot.began = false
    slot.ended = false

proc flush(state: var DeviceTranslator, output: var seq[DriverInputEvent]) =
  # One move per input frame, from THIS device's latest absolute X/Y (keyed
  # on ABS_X/ABS_Y, so pressure and another device's values never mix into the
  # position) or its relative counts; the host does the rest.
  if state.multitouch:
    state.flushSlots(output)
  elif state.absMoved and state.hasX and state.hasY:
    var move = state.event(dikPointerAbs, state.absPointerId)
    move.withWirePosition(state, state.lastX, state.lastY)
    output.add(move)
  if state.relMoved:
    var move = state.event(dikPointerRel, 0)
    move.x = state.relX.cint
    move.y = state.relY.cint
    output.add(move)
  state.absMoved = false
  state.relMoved = false
  state.relX = 0
  state.relY = 0
  if state.wheelX != 0 or state.wheelY != 0:
    var wheel = state.event(dikWheel, 0)
    wheel.x = state.wheelX.cint
    wheel.y = state.wheelY.cint
    output.add(wheel)
    state.wheelX = 0
    state.wheelY = 0
  for pending in state.pending.mitems:
    # A button of an absolute device carries the frame's position, so a press
    # needs no move ahead of it.
    if pending.kind in [ord(dikPointerDown).cint, ord(dikPointerUp).cint] and
        pending.pointerId != 0 and state.hasX and state.hasY and not state.multitouch:
      pending.withWirePosition(state, state.lastX, state.lastY)
    output.add(pending)
  state.pending.setLen(0)

proc translate*(state: var DeviceTranslator, evType, code, value: int,
                output: var seq[DriverInputEvent]): TranslateResult =
  ## Feeds one kernel event in. Events for the host are appended to `output`,
  ## which stays empty until the input frame's SYN_REPORT.
  result = trOk
  case evType
  of EV_SYN:
    # Only SYN_REPORT ends an input frame. SYN_MT_REPORT separates the
    # contacts INSIDE one; flushing there would send the press ahead of its
    # position again.
    if code == SYN_REPORT:
      flush(state, output)
  of EV_MSC:
    discard
  of EV_KEY:
    # 1 is down, 0 is up, 2 is the kernel's auto-repeat of a held key: a
    # `keyDown {repeat: true}` — it used to reach the scene as a keyUp.
    if value < 0 or value > 2:
      return
    let down = value != 0
    let button = pointerButton(code)
    if button >= 0:
      if value == 2:
        return
      if code == BTN_TOUCH and state.multitouch:
        # Protocol B says it with tracking ids, per contact.
        return
      let pointerId = if code == BTN_TOUCH or code == BTN_STYLUS or code == BTN_STYLUS2 or state.pointerType != dptMouse:
          state.absPointerId
        else: 0
      var ev = state.event(if down: dikPointerDown else: dikPointerUp, pointerId)
      ev.code = button.cint
      state.pending.add(ev)
    elif isToolCode(code):
      discard
    else:
      # Keyboard keys, and every button that is not a pointer's: gamepads,
      # joysticks, BTN_0..BTN_9. They used to arrive as `mouseDown {button: -1}`.
      var ev = state.event(if down: dikKeyDown else: dikKeyUp, 0)
      ev.code = code.cint
      ev.value = value.cint
      state.pending.add(ev)
  of EV_ABS:
    case code
    of ABS_X:
      state.lastX = value
      state.hasX = true
      state.absMoved = true
    of ABS_Y:
      state.lastY = value
      state.hasY = true
      state.absMoved = true
    of ABS_MT_SLOT:
      if state.multitouch:
        state.slot = max(0, min(MaxSlots - 1, value))
    of ABS_MT_TRACKING_ID:
      if state.multitouch:
        let slot = addr state.slots[state.slot]
        if value >= 0 and slot.trackingId < 0:
          slot.trackingId = value
          slot.began = true
        elif value < 0 and slot.trackingId >= 0:
          slot.ended = true
    of ABS_MT_POSITION_X:
      if state.multitouch:
        state.slots[state.slot].x = value
        state.slots[state.slot].hasX = true
        state.slots[state.slot].moved = true
    of ABS_MT_POSITION_Y:
      if state.multitouch:
        state.slots[state.slot].y = value
        state.slots[state.slot].hasY = true
        state.slots[state.slot].moved = true
    else:
      # Pressure, tilt, distance, the tool type: nothing a scene hears yet.
      discard
  of EV_REL:
    case code
    of REL_X:
      state.relX += value
      state.relMoved = true
    of REL_Y:
      state.relY += value
      state.relMoved = true
    of REL_WHEEL:
      # The kernel counts a wheel turned away from the user as positive; the
      # DOM, which the browser preview speaks, counts scrolling down.
      state.wheelY -= value
    of REL_HWHEEL:
      state.wheelX += value
    else:
      # REL_WHEEL_HI_RES and friends repeat the notches above in finer units.
      discard
  else:
    let bit = uint8(max(0, min(255, evType)))
    if bit notin state.unknownTypesSeen:
      state.unknownTypesSeen.incl(bit)
      result = trUnknownType

proc cancelEvent*(state: DeviceTranslator): DriverInputEvent =
  ## What the shell sends when the device goes away: every pointer of it lets
  ## go (pointerId -1: all of this device's, the host works out which).
  result = state.event(dikPointerCancel, -1)
