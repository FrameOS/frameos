## Sequences as real devices send them (`evtest` dumps, trimmed), run through
## the translator. Codes are written as numbers on purpose: the dump is the
## fixture, and a renamed constant must not quietly change what it says.

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

proc run(state: var DeviceTranslator, cursor: var PointerCursor, dump: openArray[Raw],
         unknown: var int): seq[InputEvent] =
  for (evType, code, value) in dump:
    if translate(state, cursor, evType, code, value, result) == trUnknownType:
      inc unknown

proc run(state: var DeviceTranslator, cursor: var PointerCursor, dump: openArray[Raw]): seq[InputEvent] =
  var unknown = 0
  run(state, cursor, dump, unknown)

proc mouse(): DeviceTranslator = initDeviceTranslator(0, 0, 0, 0)

block test_a_usb_mouse_moves_the_cursor:
  # The bug: EV_REL fell into the unknown-event log branch, so an ordinary
  # mouse clicked but never moved, and wrote a log line per motion event.
  var cursor = initPointerCursor(800, 480)
  var state = mouse()
  var unknown = 0
  let events = run(state, cursor, [
    (EvRel, 0, 10), (EvRel, 1, -4), (EvSyn, 0, 0),
    (EvRel, 0, 5), (EvSyn, 0, 0),
  ], unknown)
  doAssert unknown == 0
  doAssert events.len == 2
  doAssert events[0].kind == iekMouseMove
  # Centre of 800x480 is (399, 239); one count is one panel pixel.
  doAssert events[0].x == scalePointerAxis(409, 0, 799)
  doAssert events[0].y == scalePointerAxis(235, 0, 479)
  doAssert events[1].x == scalePointerAxis(414, 0, 799)
  doAssert events[1].y == scalePointerAxis(235, 0, 479)
  doAssert cursor.x == 414 and cursor.y == 235

block test_the_cursor_stops_at_the_panel_edge:
  var cursor = initPointerCursor(800, 480)
  var state = mouse()
  var events = run(state, cursor, [(EvRel, 0, 5000), (EvRel, 1, 5000), (EvSyn, 0, 0)])
  doAssert events.len == 1
  doAssert events[0].x == PointerRange and events[0].y == PointerRange
  events = run(state, cursor, [(EvRel, 0, -9000), (EvRel, 1, -9000), (EvSyn, 0, 0)])
  doAssert events[0].x == 0 and events[0].y == 0
  # The edge does not store the overshoot: one count back is one pixel back.
  events = run(state, cursor, [(EvRel, 0, 1), (EvSyn, 0, 0)])
  doAssert cursor.x == 1

block test_a_frame_without_a_panel_size_still_has_a_pointer:
  var cursor = initPointerCursor(0, 0)
  var state = mouse()
  let events = run(state, cursor, [(EvRel, 0, 100), (EvSyn, 0, 0)])
  doAssert events.len == 1
  doAssert events[0].x == PointerRange div 2 + 100
  doAssert events[0].y == PointerRange div 2

block test_a_click_follows_the_move_of_its_frame:
  var cursor = initPointerCursor(800, 480)
  var state = mouse()
  let events = run(state, cursor, [
    # MSC_SCAN, BTN_LEFT down, and motion in the same report
    (EvMsc, 4, 0x90001), (EvKey, 0x110, 1), (EvRel, 0, 3), (EvSyn, 0, 0),
    (EvMsc, 4, 0x90001), (EvKey, 0x110, 0), (EvSyn, 0, 0),
    # right, middle
    (EvKey, 0x111, 1), (EvSyn, 0, 0), (EvKey, 0x111, 0), (EvSyn, 0, 0),
    (EvKey, 0x112, 1), (EvSyn, 0, 0), (EvKey, 0x112, 0), (EvSyn, 0, 0),
  ])
  doAssert events.len == 7
  doAssert events[0].kind == iekMouseMove
  doAssert events[1].kind == iekMouseDown and events[1].button == 0
  doAssert events[2].kind == iekMouseUp and events[2].button == 0
  doAssert events[3].kind == iekMouseDown and events[3].button == 1
  doAssert events[4].kind == iekMouseUp and events[4].button == 1
  doAssert events[5].kind == iekMouseDown and events[5].button == 2
  doAssert events[6].kind == iekMouseUp and events[6].button == 2

block test_the_wheel_is_one_event_per_frame_in_dom_signs:
  var cursor = initPointerCursor(800, 480)
  var state = mouse()
  var unknown = 0
  let events = run(state, cursor, [
    # one notch towards the user: REL_WHEEL -1 with its hi-res twin
    (EvRel, 8, -1), (EvRel, 0x0b, -120), (EvSyn, 0, 0),
    # two notches away, and a tilt to the right
    (EvRel, 8, 2), (EvRel, 0x0b, 240), (EvRel, 6, 1), (EvRel, 0x0c, 120), (EvSyn, 0, 0),
    # a report with only a hi-res fraction in it says nothing
    (EvRel, 0x0b, 30), (EvSyn, 0, 0),
  ], unknown)
  doAssert unknown == 0
  doAssert events.len == 2
  doAssert events[0].kind == iekWheel and events[0].deltaY == 1 and events[0].deltaX == 0
  doAssert events[1].kind == iekWheel and events[1].deltaY == -2 and events[1].deltaX == 1

block test_a_held_key_is_one_down_and_one_up:
  # The bug: `if value == 1: keyDown else: keyUp` turned every auto-repeat
  # (value 2) into a keyUp.
  var cursor = initPointerCursor(800, 480)
  var state = mouse()
  let events = run(state, cursor, [
    (EvMsc, 4, 0x70004), (EvKey, 30, 1), (EvSyn, 0, 0),
    (EvKey, 30, 2), (EvSyn, 0, 1), # the kernel marks repeat reports with SYN value 1
    (EvKey, 30, 2), (EvSyn, 0, 1),
    (EvKey, 30, 2), (EvSyn, 0, 1),
    (EvMsc, 4, 0x70004), (EvKey, 30, 0), (EvSyn, 0, 0),
  ])
  doAssert events.len == 2
  doAssert events[0].kind == iekKeyDown and events[0].code == 30
  doAssert events[1].kind == iekKeyUp and events[1].code == 30

block test_a_keyboard_led_is_reported_once:
  var cursor = initPointerCursor(800, 480)
  var state = mouse()
  var unknown = 0
  let events = run(state, cursor, [
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
  discard run(other, cursor, [(EvLed, 1, 1)], unknown)
  doAssert unknown == 3

block test_a_touchscreen_tap_lands_where_the_finger_is:
  # BTN_TOUCH arrives ahead of the coordinates it belongs to.
  var cursor = initPointerCursor(480, 800)
  var state = initDeviceTranslator(0, 479, 0, 799)
  let events = run(state, cursor, [
    (EvAbs, 0x39, 12),                # ABS_MT_TRACKING_ID
    (EvAbs, 0x35, 240), (EvAbs, 0x36, 400), # ABS_MT_POSITION_X/Y
    (EvKey, 0x14a, 1),                # BTN_TOUCH
    (EvAbs, 0, 240), (EvAbs, 1, 400), # ABS_X, ABS_Y
    (EvAbs, 0x18, 60),                # ABS_PRESSURE must not read as a position
    (EvSyn, 0, 0),
    (EvAbs, 0x39, -1), (EvKey, 0x14a, 0), (EvSyn, 0, 0),
  ])
  doAssert events.len == 3
  doAssert events[0].kind == iekMouseMove
  doAssert events[0].x == scalePointerAxis(240, 0, 479)
  doAssert events[0].y == scalePointerAxis(400, 0, 799)
  doAssert events[1].kind == iekMouseDown and events[1].button == 0
  doAssert events[2].kind == iekMouseUp and events[2].button == 0
  # A mouse picked up next continues from the touch, not from the centre.
  doAssert cursor.x == 240 and cursor.y == 400

block test_a_lift_with_no_new_position_sends_no_move:
  var cursor = initPointerCursor(480, 800)
  var state = initDeviceTranslator(0, 479, 0, 799)
  discard run(state, cursor, [(EvAbs, 0, 10), (EvAbs, 1, 10), (EvKey, 0x14a, 1), (EvSyn, 0, 0)])
  let events = run(state, cursor, [(EvKey, 0x14a, 0), (EvSyn, 0, 0)])
  doAssert events.len == 1 and events[0].kind == iekMouseUp

block test_a_touchpad_tap_is_one_press:
  # The bug: every code in BTN_MISC..BTN_GEAR_UP was a mouse button, so
  # BTN_TOOL_FINGER made a tap two mouseDowns, the second with `button: -1`.
  var cursor = initPointerCursor(800, 480)
  var state = initDeviceTranslator(0, 1200, 0, 700)
  let events = run(state, cursor, [
    (EvKey, 0x14a, 1), (EvKey, 0x145, 1), # BTN_TOUCH, BTN_TOOL_FINGER
    (EvAbs, 0, 600), (EvAbs, 1, 350), (EvSyn, 0, 0),
    (EvKey, 0x14a, 0), (EvKey, 0x145, 0), (EvSyn, 0, 0),
    # two fingers, a pen coming near, a pen barrel button: none is a press
    (EvKey, 0x14d, 1), (EvSyn, 0, 0), (EvKey, 0x14d, 0), (EvSyn, 0, 0),
    (EvKey, 0x140, 1), (EvSyn, 0, 0), (EvKey, 0x140, 0), (EvSyn, 0, 0),
    (EvKey, 0x14b, 1), (EvSyn, 0, 0), (EvKey, 0x14b, 0), (EvSyn, 0, 0),
  ])
  doAssert events.len == 3
  doAssert events[0].kind == iekMouseMove
  doAssert events[1].kind == iekMouseDown and events[1].button == 0
  doAssert events[2].kind == iekMouseUp and events[2].button == 0

block test_a_gamepad_button_is_a_key_not_a_mouse_button:
  var cursor = initPointerCursor(800, 480)
  var state = mouse()
  let events = run(state, cursor, [
    (EvKey, 0x130, 1), (EvSyn, 0, 0), (EvKey, 0x130, 0), (EvSyn, 0, 0), # BTN_SOUTH
    (EvKey, 0x100, 1), (EvSyn, 0, 0), (EvKey, 0x100, 0), (EvSyn, 0, 0), # BTN_0
    (EvKey, 0x150, 1), (EvSyn, 0, 0),                                   # BTN_GEAR_DOWN
  ])
  doAssert events.len == 5
  for event in events:
    doAssert event.kind in {iekKeyDown, iekKeyUp}
  doAssert events[0].code == 0x130 and events[2].code == 0x100 and events[4].code == 0x150

block test_every_mouse_button_has_its_number_and_none_is_minus_one:
  var cursor = initPointerCursor(800, 480)
  var state = mouse()
  for offset in 0 .. 7:
    let events = run(state, cursor, [(EvKey, 0x110 + offset, 1), (EvSyn, 0, 0)])
    doAssert events.len == 1
    doAssert events[0].kind == iekMouseDown and events[0].button == offset
  for code in 0x100 .. 0x151:
    let events = run(state, cursor, [(EvKey, code, 1), (EvSyn, 0, 0)])
    for event in events:
      doAssert event.kind == iekKeyDown or event.button >= 0

block test_a_multitouch_separator_does_not_end_the_frame:
  # Protocol A sends SYN_MT_REPORT between contacts; the press still waits
  # for the SYN_REPORT that carries its position.
  var cursor = initPointerCursor(480, 800)
  var state = initDeviceTranslator(0, 479, 0, 799)
  var output: seq[InputEvent] = @[]
  discard translate(state, cursor, EvKey, 0x14a, 1, output)
  discard translate(state, cursor, EvSyn, 2, 0, output)
  doAssert output.len == 0
  discard translate(state, cursor, EvAbs, 0, 100, output)
  discard translate(state, cursor, EvAbs, 1, 200, output)
  discard translate(state, cursor, EvSyn, 0, 0, output)
  doAssert output.len == 2
  doAssert output[0].kind == iekMouseMove and output[1].kind == iekMouseDown
