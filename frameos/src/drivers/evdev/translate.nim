## The evdev driver's translation: raw kernel `input_event`s in, the events a
## scene hears out. Kept apart from libevdev and from the host so it compiles
## and is tested on a machine that has neither — every rule in here was a bug
## once, and the read loop it used to live in could not be tested at all.
##
## Nothing here allocates JSON or knows a key's name: the I/O shell
## (evdev.nim) builds the payload when it sends, and asks libevdev for the name.

import ./linuxInput
import ./pointer

type
  InputEventKind* = enum
    iekMouseMove ## x, y: the 0..32767 wire contract (pointer.nim)
    iekMouseDown ## button
    iekMouseUp   ## button
    iekKeyDown   ## code: the kernel's KEY_* / BTN_* number
    iekKeyUp     ## code
    iekWheel     ## deltaX, deltaY: notches, DOM signs (down and right are positive)

  InputEvent* = object
    kind*: InputEventKind
    x*, y*: int
    button*: int
    code*: int
    deltaX*, deltaY*: int

  PointerCursor* = object
    ## The one pointer of the frame, in panel pixels. A relative mouse reports
    ## motion only, so somebody has to own a position; it is shared by every
    ## device because the host has one anonymous pointer — a mouse picked up
    ## after a touch continues from where the finger was.
    x*, y*: int
    maxX*, maxY*: int

  DeviceTranslator* = object
    ## Per-device state: the position an absolute device last reported, and
    ## what the input frame being read has produced so far.
    minX*, maxX*, minY*, maxY*: int
    lastX, lastY: int
    hasX, hasY, absMoved, relMoved: bool
    wheelX, wheelY: int
    # Key and button events of the input frame being read, held until its
    # SYN_REPORT so they follow the frame's position. A touchscreen reports
    # BTN_TOUCH ahead of the coordinates it belongs to; sent as it arrived, the
    # press would land wherever the previous touch ended.
    pending: seq[InputEvent]
    unknownTypesSeen: set[uint8]

  TranslateResult* = enum
    trOk
    trUnknownType ## the first event of a type this driver does not handle,
                  ## once per device per type: worth one log line, not one
                  ## per event (a mouse sends hundreds a second)

const VirtualCursorMax = PointerRange
  ## A frame that does not know its panel size still gets a moving pointer:
  ## the cursor then lives in the wire range itself.

proc initPointerCursor*(width, height: int): PointerCursor =
  ## Starts at the centre: a cursor parked in a corner needs a full sweep of
  ## the desk before it is anywhere useful.
  result.maxX = if width > 0: width - 1 else: VirtualCursorMax
  result.maxY = if height > 0: height - 1 else: VirtualCursorMax
  result.x = result.maxX div 2
  result.y = result.maxY div 2

proc initDeviceTranslator*(minX, maxX, minY, maxY: int): DeviceTranslator =
  DeviceTranslator(minX: minX, maxX: maxX, minY: minY, maxY: maxY)

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
  else: -1

proc isToolCode(code: int): bool =
  ## BTN_TOOL_* say WHAT is near the surface (a finger, a pen, two fingers),
  ## not that anything was pressed: a touchpad tap sends BTN_TOOL_FINGER next
  ## to BTN_TOUCH, and read as a button that was two presses per tap. The
  ## stylus barrel buttons share the range and wait for a pen model.
  code >= BTN_DIGI and code <= BTN_TOOL_QUADTAP and code != BTN_TOUCH

proc moveCursor(value: var int, delta, maximum: int) =
  value = max(0, min(maximum, value + delta))

proc cursorFromAxis(value, minimum, maximum, cursorMax: int): int =
  ## Straight from the device's own range, rounded: by way of the 0..32767
  ## wire value, pixel 240 of a 480-pixel touchscreen came back as 239.
  var lo = minimum
  var hi = maximum
  if hi <= lo:
    # No declared range: scalePointerAxis passes such a value through as a
    # wire value, so that is what it is here too.
    lo = 0
    hi = PointerRange
  let clamped = max(lo, min(hi, value))
  let span = (hi - lo).int64
  int(((clamped - lo).int64 * cursorMax.int64 + span div 2) div span)

proc flush(state: var DeviceTranslator, cursor: var PointerCursor, output: var seq[InputEvent]) =
  # One mouseMove per input frame, from THIS device's latest absolute X/Y
  # (keyed on ABS_X/ABS_Y, so pressure and multitouch axes or another device's
  # values never mix into the position) or from the shared cursor.
  if state.absMoved and state.hasX and state.hasY:
    let x = scalePointerAxis(state.lastX, state.minX, state.maxX)
    let y = scalePointerAxis(state.lastY, state.minY, state.maxY)
    # The cursor follows a touch, so a mouse does not jump back to where it
    # was before the finger came down.
    cursor.x = cursorFromAxis(state.lastX, state.minX, state.maxX, cursor.maxX)
    cursor.y = cursorFromAxis(state.lastY, state.minY, state.maxY, cursor.maxY)
    output.add(InputEvent(kind: iekMouseMove, x: x, y: y))
  elif state.relMoved:
    output.add(InputEvent(kind: iekMouseMove,
      x: scalePointerAxis(cursor.x, 0, cursor.maxX),
      y: scalePointerAxis(cursor.y, 0, cursor.maxY)))
  state.absMoved = false
  state.relMoved = false
  if state.wheelX != 0 or state.wheelY != 0:
    output.add(InputEvent(kind: iekWheel, deltaX: state.wheelX, deltaY: state.wheelY))
    state.wheelX = 0
    state.wheelY = 0
  for event in state.pending:
    output.add(event)
  state.pending.setLen(0)

proc translate*(state: var DeviceTranslator, cursor: var PointerCursor,
                evType, code, value: int, output: var seq[InputEvent]): TranslateResult =
  ## Feeds one kernel event in. Events for the scene are appended to `output`,
  ## which stays empty until the input frame's SYN_REPORT.
  result = trOk
  case evType
  of EV_SYN:
    # Only SYN_REPORT ends an input frame. SYN_MT_REPORT separates the
    # contacts INSIDE one; flushing there would send the press ahead of its
    # position again.
    if code == SYN_REPORT:
      flush(state, cursor, output)
  of EV_MSC:
    discard
  of EV_KEY:
    # 1 is down and 0 is up. 2 is the kernel's auto-repeat of a held key, which
    # used to reach the scene as a keyUp per repeat. Until the payload can say
    # `repeat`, a repeat is dropped rather than lied about.
    if value != 0 and value != 1:
      return
    let down = value == 1
    let button = pointerButton(code)
    if button >= 0:
      state.pending.add(InputEvent(kind: if down: iekMouseDown else: iekMouseUp, button: button))
    elif isToolCode(code):
      discard
    else:
      # Keyboard keys, and every button that is not a pointer's: gamepads,
      # joysticks, BTN_0..BTN_9. They used to arrive as `mouseDown {button: -1}`.
      state.pending.add(InputEvent(kind: if down: iekKeyDown else: iekKeyUp, code: code))
  of EV_ABS:
    if code == ABS_X:
      state.lastX = value
      state.hasX = true
      state.absMoved = true
    elif code == ABS_Y:
      state.lastY = value
      state.hasY = true
      state.absMoved = true
  of EV_REL:
    case code
    of REL_X:
      moveCursor(cursor.x, value, cursor.maxX)
      state.relMoved = true
    of REL_Y:
      moveCursor(cursor.y, value, cursor.maxY)
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
