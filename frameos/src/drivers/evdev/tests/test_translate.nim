## Sequences as real devices send them (`evtest` dumps, trimmed), run through
## the translator. Codes are written as numbers on purpose: the dump is the
## fixture, and a renamed constant must not quietly change what it says.
##
## What comes out is the driver ABI's struct (frameos/driver_abi): positions
## on the 0..32767 wire, a relative mouse's counts as they are. Where the
## cursor ends up, what a tap is, what a key means — that is the host's
## (frameos/input_state.nim, tests/test_input_state.nim).

import ../translate
import ../pointer

const
  EvSyn = 0
  EvKey = 1
  EvRel = 2
  EvAbs = 3
  EvMsc = 4
  EvLed = 0x11

type Raw = (int, int, int) # type, code, value

proc run(state: var DeviceTranslator, dump: openArray[Raw], unknown: var int): seq[DriverInputEvent] =
  for (evType, code, value) in dump:
    if translate(state, evType, code, value, result) == trUnknownType:
      inc unknown

proc run(state: var DeviceTranslator, dump: openArray[Raw]): seq[DriverInputEvent] =
  var unknown = 0
  run(state, dump, unknown)

proc k(ev: DriverInputEvent): DriverInputKind = DriverInputKind(ev.kind)
proc hasPosition(ev: DriverInputEvent): bool = (ev.flags.int and ord(difHasPosition)) != 0

proc mouse(): DeviceTranslator = initDeviceTranslator(0, 0, 0, 0)

block test_a_usb_mouse_sends_its_counts:
  # The bug, once: EV_REL fell into the unknown-event log branch, so an
  # ordinary mouse clicked but never moved, and wrote a log line per motion
  # event. Now the counts go to the host, which owns the cursor.
  var state = mouse()
  var unknown = 0
  let events = run(state, [
    (EvRel, 0, 10), (EvRel, 1, -4), (EvSyn, 0, 0),
    (EvRel, 0, 5), (EvRel, 0, 2), (EvSyn, 0, 0),
  ], unknown)
  doAssert unknown == 0
  doAssert events.len == 2
  doAssert events[0].k == dikPointerRel and events[0].x == 10 and events[0].y == -4
  doAssert events[0].pointerId == 0 and events[0].pointerType == ord(dptMouse)
  # Two REL_X in one report add up.
  doAssert events[1].k == dikPointerRel and events[1].x == 7 and events[1].y == 0

block test_a_click_follows_the_move_of_its_frame:
  var state = mouse()
  let events = run(state, [
    # MSC_SCAN, BTN_LEFT down, and motion in the same report
    (EvMsc, 4, 0x90001), (EvKey, 0x110, 1), (EvRel, 0, 3), (EvSyn, 0, 0),
    (EvMsc, 4, 0x90001), (EvKey, 0x110, 0), (EvSyn, 0, 0),
    # right, middle
    (EvKey, 0x111, 1), (EvSyn, 0, 0), (EvKey, 0x111, 0), (EvSyn, 0, 0),
    (EvKey, 0x112, 1), (EvSyn, 0, 0), (EvKey, 0x112, 0), (EvSyn, 0, 0),
  ])
  doAssert events.len == 7
  doAssert events[0].k == dikPointerRel
  doAssert events[1].k == dikPointerDown and events[1].code == 0 and events[1].pointerId == 0
  doAssert not events[1].hasPosition # a relative device has none to give
  doAssert events[2].k == dikPointerUp and events[2].code == 0
  doAssert events[3].k == dikPointerDown and events[3].code == 1
  doAssert events[4].k == dikPointerUp and events[4].code == 1
  doAssert events[5].k == dikPointerDown and events[5].code == 2
  doAssert events[6].k == dikPointerUp and events[6].code == 2

block test_the_wheel_is_one_event_per_frame_in_dom_signs:
  var state = mouse()
  var unknown = 0
  let events = run(state, [
    # one notch towards the user: REL_WHEEL -1 with its hi-res twin
    (EvRel, 8, -1), (EvRel, 0x0b, -120), (EvSyn, 0, 0),
    # two notches away, and a tilt to the right
    (EvRel, 8, 2), (EvRel, 0x0b, 240), (EvRel, 6, 1), (EvRel, 0x0c, 120), (EvSyn, 0, 0),
    # a report with only a hi-res fraction in it says nothing
    (EvRel, 0x0b, 30), (EvSyn, 0, 0),
  ], unknown)
  doAssert unknown == 0
  doAssert events.len == 2
  doAssert events[0].k == dikWheel and events[0].y == 1 and events[0].x == 0
  doAssert events[1].k == dikWheel and events[1].y == -2 and events[1].x == 1

block test_a_held_key_is_a_down_repeats_and_an_up:
  # The bug, once: `if value == 1: keyDown else: keyUp` turned every
  # auto-repeat (value 2) into a keyUp. Then repeats were dropped. Now they are
  # what they are: a keyDown the host marks `repeat`.
  var state = mouse()
  let events = run(state, [
    (EvMsc, 4, 0x70004), (EvKey, 30, 1), (EvSyn, 0, 0),
    (EvKey, 30, 2), (EvSyn, 0, 1), # the kernel marks repeat reports with SYN value 1
    (EvKey, 30, 2), (EvSyn, 0, 1),
    (EvMsc, 4, 0x70004), (EvKey, 30, 0), (EvSyn, 0, 0),
  ])
  doAssert events.len == 4
  doAssert events[0].k == dikKeyDown and events[0].code == 30 and events[0].value == 1
  doAssert events[1].k == dikKeyDown and events[1].code == 30 and events[1].value == 2
  doAssert events[2].k == dikKeyDown and events[2].value == 2
  doAssert events[3].k == dikKeyUp and events[3].code == 30 and events[3].value == 0

block test_a_keyboard_led_is_reported_once:
  var state = mouse()
  var unknown = 0
  let events = run(state, [
    (EvKey, 58, 1), (EvSyn, 0, 0), (EvLed, 1, 1), (EvSyn, 0, 0),
    (EvKey, 58, 0), (EvSyn, 0, 0),
    (EvKey, 58, 1), (EvSyn, 0, 0), (EvLed, 1, 0), (EvSyn, 0, 0),
    (EvKey, 58, 0), (EvSyn, 0, 0),
    (0x15, 0, 1), (EvSyn, 0, 0), # a second unknown type is its own line
  ], unknown)
  doAssert unknown == 2
  doAssert events.len == 4
  # Another device has not said it yet.
  var other = mouse()
  discard run(other, [(EvLed, 1, 1)], unknown)
  doAssert unknown == 3

block test_a_touchscreen_tap_lands_where_the_finger_is:
  # BTN_TOUCH arrives ahead of the coordinates it belongs to. A single-touch
  # device (no ABS_MT_SLOT): the kernel's emulation is what is read.
  var state = initDeviceTranslator(0, 479, 0, 799, deviceId = 2, pointerType = dptTouch)
  let events = run(state, [
    (EvAbs, 0x39, 12),                # ABS_MT_TRACKING_ID (ignored: not multitouch)
    (EvAbs, 0x35, 240), (EvAbs, 0x36, 400), # ABS_MT_POSITION_X/Y
    (EvKey, 0x14a, 1),                # BTN_TOUCH
    (EvAbs, 0, 240), (EvAbs, 1, 400), # ABS_X, ABS_Y
    (EvAbs, 0x18, 60),                # ABS_PRESSURE must not read as a position
    (EvSyn, 0, 0),
    (EvAbs, 0x39, -1), (EvKey, 0x14a, 0), (EvSyn, 0, 0),
  ])
  doAssert events.len == 3
  doAssert events[0].k == dikPointerAbs
  doAssert events[0].x == scalePointerAxis(240, 0, 479)
  doAssert events[0].y == scalePointerAxis(400, 0, 799)
  doAssert events[0].pointerId == 2 * PointersPerDevice + 1
  doAssert events[0].pointerType == ord(dptTouch)
  doAssert events[1].k == dikPointerDown and events[1].code == 0
  # The press carries the frame's position, so it needs no move ahead of it.
  doAssert events[1].hasPosition and events[1].x == events[0].x and events[1].y == events[0].y
  doAssert events[2].k == dikPointerUp and events[2].code == 0 and events[2].hasPosition

block test_a_lift_with_no_new_position_sends_no_move:
  var state = initDeviceTranslator(0, 479, 0, 799, pointerType = dptTouch)
  discard run(state, [(EvAbs, 0, 10), (EvAbs, 1, 10), (EvKey, 0x14a, 1), (EvSyn, 0, 0)])
  let events = run(state, [(EvKey, 0x14a, 0), (EvSyn, 0, 0)])
  doAssert events.len == 1 and events[0].k == dikPointerUp

block test_a_touchpad_tap_is_one_press:
  # The bug, once: every code in BTN_MISC..BTN_GEAR_UP was a mouse button, so
  # BTN_TOOL_FINGER made a tap two mouseDowns, the second with `button: -1`.
  var state = initDeviceTranslator(0, 1200, 0, 700, pointerType = dptTouch)
  let events = run(state, [
    (EvKey, 0x14a, 1), (EvKey, 0x145, 1), # BTN_TOUCH, BTN_TOOL_FINGER
    (EvAbs, 0, 600), (EvAbs, 1, 350), (EvSyn, 0, 0),
    (EvKey, 0x14a, 0), (EvKey, 0x145, 0), (EvSyn, 0, 0),
    # two fingers, a pen coming near: none is a press
    (EvKey, 0x14d, 1), (EvSyn, 0, 0), (EvKey, 0x14d, 0), (EvSyn, 0, 0),
    (EvKey, 0x140, 1), (EvSyn, 0, 0), (EvKey, 0x140, 0), (EvSyn, 0, 0),
  ])
  doAssert events.len == 3
  doAssert events[0].k == dikPointerAbs
  doAssert events[1].k == dikPointerDown and events[1].code == 0
  doAssert events[2].k == dikPointerUp and events[2].code == 0

block test_a_pen_barrel_button_is_a_pointer_button:
  var state = initDeviceTranslator(0, 1000, 0, 1000, pointerType = dptPen)
  let events = run(state, [
    (EvKey, 0x140, 1), (EvAbs, 0, 500), (EvAbs, 1, 500), (EvSyn, 0, 0), # BTN_TOOL_PEN near
    (EvKey, 0x14b, 1), (EvSyn, 0, 0), (EvKey, 0x14b, 0), (EvSyn, 0, 0), # BTN_STYLUS
    (EvKey, 0x14a, 1), (EvSyn, 0, 0), (EvKey, 0x14a, 0), (EvSyn, 0, 0), # BTN_TOUCH: the tip
  ])
  doAssert events.len == 5
  doAssert events[0].k == dikPointerAbs and events[0].pointerType == ord(dptPen)
  doAssert events[1].k == dikPointerDown and events[1].code == 1
  doAssert events[2].k == dikPointerUp and events[2].code == 1
  doAssert events[3].k == dikPointerDown and events[3].code == 0
  doAssert events[4].k == dikPointerUp and events[4].code == 0

block test_two_fingers_are_two_pointers:
  # Protocol B, as a Goodix panel sends it: slots with tracking ids. BTN_TOUCH
  # is the emulation for single-touch readers and must not double the press.
  var state = initDeviceTranslator(0, 479, 0, 799, deviceId = 1, pointerType = dptTouch, multitouch = true)
  let first = 1 * PointersPerDevice + 1
  let second = first + 1
  var events = run(state, [
    (EvAbs, 0x2f, 0), (EvAbs, 0x39, 7), (EvAbs, 0x35, 100), (EvAbs, 0x36, 200),
    (EvKey, 0x14a, 1), (EvAbs, 0, 100), (EvAbs, 1, 200), (EvSyn, 0, 0),
  ])
  doAssert events.len == 2
  doAssert events[0].k == dikPointerAbs and events[0].pointerId == first
  doAssert events[0].x == scalePointerAxis(100, 0, 479) and events[0].y == scalePointerAxis(200, 0, 799)
  doAssert events[1].k == dikPointerDown and events[1].pointerId == first and events[1].hasPosition
  # A second finger, while the first moves.
  events = run(state, [
    (EvAbs, 0x2f, 1), (EvAbs, 0x39, 8), (EvAbs, 0x35, 300), (EvAbs, 0x36, 600),
    (EvAbs, 0x2f, 0), (EvAbs, 0x35, 110), (EvSyn, 0, 0),
  ])
  doAssert events.len == 3
  doAssert events[0].k == dikPointerAbs and events[0].pointerId == first and events[0].x == scalePointerAxis(110, 0, 479)
  doAssert events[1].k == dikPointerAbs and events[1].pointerId == second
  doAssert events[2].k == dikPointerDown and events[2].pointerId == second
  # First finger up, second stays.
  events = run(state, [(EvAbs, 0x2f, 0), (EvAbs, 0x39, -1), (EvSyn, 0, 0)])
  doAssert events.len == 1
  doAssert events[0].k == dikPointerUp and events[0].pointerId == first and events[0].hasPosition
  # Second finger up: BTN_TOUCH 0 says nothing extra.
  events = run(state, [(EvAbs, 0x2f, 1), (EvAbs, 0x39, -1), (EvKey, 0x14a, 0), (EvSyn, 0, 0)])
  doAssert events.len == 1
  doAssert events[0].k == dikPointerUp and events[0].pointerId == second
  # A slot that lifted and lands again is a new contact with the same id.
  events = run(state, [(EvAbs, 0x2f, 1), (EvAbs, 0x39, 9), (EvAbs, 0x35, 10), (EvAbs, 0x36, 10), (EvSyn, 0, 0)])
  doAssert events.len == 2 and events[1].k == dikPointerDown and events[1].pointerId == second

block test_a_gamepad_button_is_a_key_not_a_mouse_button:
  var state = mouse()
  let events = run(state, [
    (EvKey, 0x130, 1), (EvSyn, 0, 0), (EvKey, 0x130, 0), (EvSyn, 0, 0), # BTN_SOUTH
    (EvKey, 0x100, 1), (EvSyn, 0, 0), (EvKey, 0x100, 0), (EvSyn, 0, 0), # BTN_0
    (EvKey, 0x150, 1), (EvSyn, 0, 0),                                   # BTN_GEAR_DOWN
  ])
  doAssert events.len == 5
  for event in events:
    doAssert event.k in {dikKeyDown, dikKeyUp}
  doAssert events[0].code == 0x130 and events[2].code == 0x100 and events[4].code == 0x150

block test_every_mouse_button_has_its_number_and_none_is_minus_one:
  var state = mouse()
  for offset in 0 .. 7:
    let events = run(state, [(EvKey, 0x110 + offset, 1), (EvSyn, 0, 0)])
    doAssert events.len == 1
    doAssert events[0].k == dikPointerDown and events[0].code == offset
  for code in 0x100 .. 0x151:
    let events = run(state, [(EvKey, code, 1), (EvSyn, 0, 0)])
    for event in events:
      doAssert event.k == dikKeyDown or event.code >= 0

block test_a_multitouch_separator_does_not_end_the_frame:
  # Protocol A sends SYN_MT_REPORT between contacts; the press still waits
  # for the SYN_REPORT that carries its position.
  var state = initDeviceTranslator(0, 479, 0, 799, pointerType = dptTouch)
  var output: seq[DriverInputEvent] = @[]
  discard translate(state, EvKey, 0x14a, 1, output)
  discard translate(state, EvSyn, 2, 0, output)
  doAssert output.len == 0
  discard translate(state, EvAbs, 0, 100, output)
  discard translate(state, EvAbs, 1, 200, output)
  discard translate(state, EvSyn, 0, 0, output)
  doAssert output.len == 2
  doAssert output[0].k == dikPointerAbs and output[1].k == dikPointerDown

block test_a_device_going_away_cancels_its_pointers:
  let state = initDeviceTranslator(0, 479, 0, 799, deviceId = 3, pointerType = dptTouch)
  let cancel = state.cancelEvent()
  doAssert cancel.k == dikPointerCancel and cancel.pointerId == -1 and cancel.deviceId == 3
