## The input state (frameos/input_state.nim): what a scene hears out of what
## a driver, a preview or a request said. Positions are scene pixels on the
## way out; the wire is 0..PointerWireMax across the panel on the way in.

import std/[json, monotimes, times]
import ../input_state
import ../driver_abi
import ../events
import ../types

proc config(width, height: int, rotate = 0, layout = "us"): FrameConfig =
  FrameConfig(width: width, height: height, rotate: rotate, flip: "",
    inputSettings: InputSettingsConfig(keyboardLayout: layout, grabKeyboard: true),
    gpioButtons: @[GPIOButton(pin: 5, label: "A", role: "menu"), GPIOButton(pin: 6, label: "B")])

let t0 = getMonoTime()
proc at(ms: int): MonoTime = t0 + initDuration(milliseconds = ms)

proc abs(id, x, y: int, pointerType = dptTouch): DriverInputEvent =
  DriverInputEvent(kind: ord(dikPointerAbs).cint, pointerId: id.cint, pointerType: ord(pointerType).cint,
    x: x.cint, y: y.cint)

proc rel(dx, dy: int): DriverInputEvent =
  DriverInputEvent(kind: ord(dikPointerRel).cint, x: dx.cint, y: dy.cint)

proc down(id, button: int, pointerType = dptTouch): DriverInputEvent =
  DriverInputEvent(kind: ord(dikPointerDown).cint, pointerId: id.cint, pointerType: ord(pointerType).cint,
    code: button.cint)

proc up(id, button: int, pointerType = dptTouch): DriverInputEvent =
  DriverInputEvent(kind: ord(dikPointerUp).cint, pointerId: id.cint, pointerType: ord(pointerType).cint,
    code: button.cint)

proc key(code: int, value: int): DriverInputEvent =
  let kind = if value == 0: dikKeyUp else: dikKeyDown
  DriverInputEvent(kind: ord(kind).cint, code: code.cint, value: value.cint)

proc names(deliveries: seq[InputDelivery]): seq[string] =
  for d in deliveries: result.add(d.name)

block test_a_wire_position_becomes_a_scene_pixel_on_every_pointer_event:
  var state = initInputState(config(800, 480))
  var output: seq[InputDelivery]
  state.applyDriverInput(abs(17, PointerWireMax div 2, PointerWireMax), eoDriver, at(0), output)
  doAssert output.names == @[evPointerMove]
  doAssert output[0].payload["x"].getInt() == 399 and output[0].payload["y"].getInt() == 479
  doAssert output[0].payload["pointerId"].getInt() == 17 and output[0].payload["pointerType"].getStr() == "touch"
  doAssert output[0].payload["buttons"].getInt() == 0
  output.setLen(0)
  state.applyDriverInput(down(17, 0), eoDriver, at(10), output)
  doAssert output.names == @[evPointerDown]
  doAssert output[0].payload["x"].getInt() == 399 and output[0].payload["button"].getInt() == 0
  doAssert output[0].payload["buttons"].getInt() == 1

block test_the_position_follows_rotation:
  # A 480x800 panel rotated 90: the scene is 800x480, and the top-right of
  # the panel is the top-left of the picture (utils/image panelToScenePoint).
  var state = initInputState(config(480, 800, rotate = 90))
  var output: seq[InputDelivery]
  state.applyDriverInput(abs(1, PointerWireMax, 0), eoDriver, at(0), output)
  doAssert output[0].payload["x"].getInt() == 0 and output[0].payload["y"].getInt() == 0
  output.setLen(0)
  state.applyDriverInput(abs(1, 0, PointerWireMax), eoDriver, at(0), output)
  doAssert output[0].payload["x"].getInt() == 799 and output[0].payload["y"].getInt() == 479

block test_a_relative_mouse_moves_the_hosts_cursor_in_scene_pixels:
  var state = initInputState(config(480, 800, rotate = 90))
  var output: seq[InputDelivery]
  # The scene is 800x480; the cursor starts in the centre.
  doAssert state.cursorX == 400 and state.cursorY == 240
  state.applyDriverInput(rel(10, -4), eoDriver, at(0), output)
  doAssert output.names == @[evPointerMove]
  doAssert output[0].payload["x"].getInt() == 410 and output[0].payload["y"].getInt() == 236
  doAssert output[0].payload["pointerId"].getInt() == 0 and output[0].payload["pointerType"].getStr() == "mouse"
  doAssert state.cursorVisible and state.takeCursorDirty()
  doAssert not state.takeCursorDirty()
  # The edge does not store the overshoot.
  output.setLen(0)
  state.applyDriverInput(rel(5000, 5000), eoDriver, at(1), output)
  doAssert output[0].payload["x"].getInt() == 799 and output[0].payload["y"].getInt() == 479
  output.setLen(0)
  state.applyDriverInput(rel(-1, -1), eoDriver, at(2), output)
  doAssert output[0].payload["x"].getInt() == 798
  # A click of the mouse is at the cursor.
  output.setLen(0)
  state.applyDriverInput(down(0, 1, dptMouse), eoDriver, at(3), output)
  doAssert output[0].name == evPointerDown and output[0].payload["x"].getInt() == 798 and
    output[0].payload["button"].getInt() == 1 and output[0].payload["buttons"].getInt() == 2
  # It hides when nobody moves it.
  output.setLen(0)
  state.tick(at(2 + CursorHideMs), output)
  doAssert not state.cursorVisible and state.takeCursorDirty()

block test_a_mouse_picked_up_after_a_touch_continues_from_the_finger:
  var state = initInputState(config(800, 480))
  var output: seq[InputDelivery]
  state.applyDriverInput(abs(17, 0, 0), eoDriver, at(0), output)
  state.applyDriverInput(rel(1, 1), eoDriver, at(1), output)
  doAssert output[1].payload["x"].getInt() == 1 and output[1].payload["y"].getInt() == 1

block test_a_tap_is_a_down_and_an_up_in_one_place:
  var state = initInputState(config(800, 480))
  var output: seq[InputDelivery]
  state.applyDriverInput(abs(1, 1000, 1000), eoDriver, at(0), output)
  state.applyDriverInput(down(1, 0), eoDriver, at(0), output)
  state.applyDriverInput(abs(1, 1200, 1100), eoDriver, at(50), output) # inside the slop
  state.applyDriverInput(up(1, 0), eoDriver, at(120), output)
  doAssert output.names == @[evPointerMove, evPointerDown, evPointerMove, evPointerUp, evTap]
  doAssert output[4].payload["pointerId"].getInt() == 1
  # A second one right after, right there: a doubleTap too.
  output.setLen(0)
  state.applyDriverInput(down(1, 0), eoDriver, at(300), output)
  state.applyDriverInput(up(1, 0), eoDriver, at(380), output)
  doAssert output.names == @[evPointerDown, evPointerUp, evTap, evDoubleTap]
  # A third is a tap again (the pair was used up).
  output.setLen(0)
  state.applyDriverInput(down(1, 0), eoDriver, at(500), output)
  state.applyDriverInput(up(1, 0), eoDriver, at(560), output)
  doAssert output.names == @[evPointerDown, evPointerUp, evTap]
  # Too slow for a tap, but not moved: nothing.
  output.setLen(0)
  state.applyDriverInput(down(1, 0), eoDriver, at(1000), output)
  state.applyDriverInput(up(1, 0), eoDriver, at(1000 + GestureTapMs + 1), output)
  doAssert output.names == @[evPointerDown, evPointerUp, evLongPress]

block test_a_right_click_is_not_a_tap:
  var state = initInputState(config(800, 480))
  var output: seq[InputDelivery]
  state.applyDriverInput(down(0, 1, dptMouse), eoDriver, at(0), output)
  state.applyDriverInput(up(0, 1, dptMouse), eoDriver, at(50), output)
  doAssert output.names == @[evPointerDown, evPointerUp]

block test_a_long_press_is_delivered_while_held_when_the_host_ticks:
  var state = initInputState(config(800, 480))
  var output: seq[InputDelivery]
  state.applyDriverInput(abs(1, 100, 100), eoPreview, at(0), output)
  state.applyDriverInput(down(1, 0), eoPreview, at(0), output)
  output.setLen(0)
  state.tick(at(GestureLongPressMs - 1), output)
  doAssert output.len == 0
  state.tick(at(GestureLongPressMs), output)
  doAssert output.names == @[evLongPress]
  doAssert output[0].payload["durationMs"].getInt() == GestureLongPressMs
  doAssert output[0].origin == eoPreview
  output.setLen(0)
  state.tick(at(GestureLongPressMs + 100), output)
  doAssert output.len == 0 # once
  state.applyDriverInput(up(1, 0), eoPreview, at(GestureLongPressMs + 200), output)
  doAssert output.names == @[evPointerUp] # no tap after a long press

block test_a_swipe_is_a_down_and_an_up_far_apart:
  var state = initInputState(config(800, 480))
  var output: seq[InputDelivery]
  state.applyDriverInput(abs(1, 4000, 16000), eoDriver, at(0), output)
  state.applyDriverInput(down(1, 0), eoDriver, at(0), output)
  state.applyDriverInput(abs(1, 20000, 16500), eoDriver, at(100), output)
  state.applyDriverInput(up(1, 0), eoDriver, at(200), output)
  doAssert output.names == @[evPointerMove, evPointerDown, evPointerMove, evPointerUp, evSwipe]
  doAssert output[4].payload["direction"].getStr() == "right"
  doAssert output[4].payload["startX"].getInt() == 97 and output[4].payload["x"].getInt() == 488
  output.setLen(0)
  state.applyDriverInput(down(1, 0), eoDriver, at(300), output)
  state.applyDriverInput(abs(1, 20000, 2000), eoDriver, at(350), output)
  state.applyDriverInput(up(1, 0), eoDriver, at(400), output)
  doAssert output[^1].name == evSwipe and output[^1].payload["direction"].getStr() == "up"

block test_a_release_far_from_its_press_is_a_swipe_whichever_event_carried_the_position:
  # A press and a release with positions of their own, no move between them
  # (an HTTP request, a driver whose press carries the frame's position).
  var state = initInputState(config(800, 480))
  var output: seq[InputDelivery]
  doAssert state.applyNamedInput(evPointerDown, %*{"x": 8192, "y": 10922, "pointerId": 1, "pointerType": "touch",
    "button": 0}, eoHttpWrite, at(0), output)
  doAssert state.applyNamedInput(evPointerUp, %*{"x": 24576, "y": 10922, "pointerId": 1, "pointerType": "touch",
    "button": 0}, eoHttpWrite, at(100), output)
  doAssert output.names == @[evPointerDown, evPointerUp, evSwipe]
  doAssert output[2].payload["direction"].getStr() == "right"
  doAssert output[2].payload["startX"].getInt() == 200 and output[2].payload["x"].getInt() == 600

block test_a_cancel_lets_go_of_what_is_down:
  var state = initInputState(config(800, 480))
  var output: seq[InputDelivery]
  state.applyDriverInput(down(17, 0), eoDriver, at(0), output)
  state.applyDriverInput(down(0, 0, dptMouse), eoDriver, at(0), output)
  output.setLen(0)
  # The device (id 1: pointers 17..32) goes away; the mouse is another device.
  state.applyDriverInput(DriverInputEvent(kind: ord(dikPointerCancel).cint, deviceId: 1, pointerId: -1,
    pointerType: ord(dptTouch).cint), eoDriver, at(1), output)
  doAssert output.names == @[evPointerCancel] and output[0].payload["pointerId"].getInt() == 17
  output.setLen(0)
  state.pointerInputLost = true
  state.cancelPointers(eoDriver, output)
  doAssert output.names == @[evPointerCancel] and output[0].payload["pointerId"].getInt() == 0
  doAssert not state.pointerInputLost
  # Nothing is down any more: a second cancel says nothing.
  output.setLen(0)
  state.cancelPointers(eoDriver, output)
  doAssert output.len == 0

block test_the_old_names_arrive_and_are_the_new_events:
  var state = initInputState(config(800, 480))
  var output: seq[InputDelivery]
  doAssert state.applyNamedInput(evMouseMove, %*{"x": PointerWireMax, "y": 0}, eoPreview, at(0), output)
  doAssert state.applyNamedInput(evMouseDown, %*{"button": 0}, eoPreview, at(1), output)
  doAssert state.applyNamedInput(evMouseUp, %*{"button": 0}, eoPreview, at(50), output)
  doAssert output.names == @[evPointerMove, evPointerDown, evPointerUp, evTap]
  doAssert output[1].payload["x"].getInt() == 799 and output[1].payload["y"].getInt() == 0
  doAssert output[1].payload["pointerType"].getStr() == "mouse" and output[1].payload["pointerId"].getInt() == 0
  doAssert not state.applyNamedInput("nextPage", %*{}, eoScene, at(0), output)

block test_a_key_from_the_driver_is_mapped_through_the_layout:
  var state = initInputState(config(800, 480, layout = "de"))
  var output: seq[InputDelivery]
  state.applyDriverInput(key(21, 1), eoDriver, at(0), output) # KEY_Y: z on a German keyboard
  doAssert output.names == @[evKeyDown, evTextInput]
  doAssert output[0].payload["code"].getStr() == "KeyY" and output[0].payload["key"].getStr() == "z"
  doAssert output[0].payload["linuxCode"].getInt() == 21 and not output[0].payload["repeat"].getBool()
  doAssert not output[0].payload["shift"].getBool()
  doAssert output[1].payload["text"].getStr() == "z"
  output.setLen(0)
  state.applyDriverInput(key(21, 2), eoDriver, at(30), output) # auto-repeat
  doAssert output.names == @[evKeyDown, evTextInput] and output[0].payload["repeat"].getBool()
  output.setLen(0)
  state.applyDriverInput(key(21, 0), eoDriver, at(60), output)
  doAssert output.names == @[evKeyUp] and not output[0].payload.hasKey("repeat")
  # Shift held: Z. Caps lock: the same. Both: z.
  output.setLen(0)
  state.applyDriverInput(key(42, 1), eoDriver, at(100), output) # KEY_LEFTSHIFT
  doAssert output.names == @[evKeyDown] and output[0].payload["key"].getStr() == "Shift"
  state.applyDriverInput(key(21, 1), eoDriver, at(110), output)
  doAssert output[1].payload["key"].getStr() == "Z" and output[1].payload["shift"].getBool()
  doAssert output[2].name == evTextInput and output[2].payload["text"].getStr() == "Z"
  state.applyDriverInput(key(21, 0), eoDriver, at(120), output)
  state.applyDriverInput(key(42, 0), eoDriver, at(130), output)
  output.setLen(0)
  state.applyDriverInput(key(58, 1), eoDriver, at(200), output) # KEY_CAPSLOCK
  state.applyDriverInput(key(58, 0), eoDriver, at(210), output)
  state.applyDriverInput(key(21, 1), eoDriver, at(220), output)
  doAssert output[2].payload["key"].getStr() == "Z" and not output[2].payload["shift"].getBool()
  state.applyDriverInput(key(21, 0), eoDriver, at(230), output)
  output.setLen(0)
  state.applyDriverInput(key(42, 1), eoDriver, at(240), output)
  state.applyDriverInput(key(21, 1), eoDriver, at(250), output)
  doAssert output[1].payload["key"].getStr() == "z"
  state.applyDriverInput(key(21, 0), eoDriver, at(260), output)
  state.applyDriverInput(key(42, 0), eoDriver, at(270), output)
  state.applyDriverInput(key(58, 1), eoDriver, at(280), output)
  state.applyDriverInput(key(58, 0), eoDriver, at(290), output)
  # A number is not a letter: caps lock leaves it alone; shift takes the layout's.
  output.setLen(0)
  state.applyDriverInput(key(3, 1), eoDriver, at(300), output) # KEY_2
  doAssert output[0].payload["key"].getStr() == "2"
  state.applyDriverInput(key(3, 0), eoDriver, at(310), output)
  # AltGr + Q on the German layout: @. And no textInput for Ctrl+C.
  output.setLen(0)
  state.applyDriverInput(key(100, 1), eoDriver, at(400), output) # KEY_RIGHTALT
  doAssert output[0].payload["key"].getStr() == "AltGraph"
  state.applyDriverInput(key(16, 1), eoDriver, at(410), output) # KEY_Q
  doAssert output[1].payload["key"].getStr() == "@" and output[1].payload["alt"].getBool()
  doAssert output[2].name == evTextInput and output[2].payload["text"].getStr() == "@"
  state.applyDriverInput(key(16, 0), eoDriver, at(420), output)
  state.applyDriverInput(key(100, 0), eoDriver, at(430), output)
  output.setLen(0)
  state.applyDriverInput(key(29, 1), eoDriver, at(500), output) # KEY_LEFTCTRL
  state.applyDriverInput(key(46, 1), eoDriver, at(510), output) # KEY_C
  doAssert output.names == @[evKeyDown, evKeyDown]
  doAssert output[1].payload["key"].getStr() == "c" and output[1].payload["ctrl"].getBool()
  # Named keys and the ones nobody knows.
  output.setLen(0)
  state.applyDriverInput(key(28, 1), eoDriver, at(600), output) # KEY_ENTER
  doAssert output.names == @[evKeyDown] and output[0].payload["key"].getStr() == "Enter"
  state.applyDriverInput(key(0x130, 1), eoDriver, at(610), output) # BTN_SOUTH
  doAssert output[1].payload["code"].getStr() == "Unidentified" and output[1].payload["linuxCode"].getInt() == 0x130

block test_a_key_from_the_preview_is_taken_as_it_is:
  var state = initInputState(config(800, 480))
  var output: seq[InputDelivery]
  doAssert state.applyNamedInput(evKeyDown, %*{"code": "KeyA", "key": "A", "shift": true, "ctrl": false,
    "alt": false, "meta": false, "repeat": false}, eoPreview, at(0), output)
  doAssert output.names == @[evKeyDown] # the browser sends its own textInput
  doAssert output[0].payload["key"].getStr() == "A" and output[0].payload["shift"].getBool()
  doAssert not output[0].payload.hasKey("linuxCode")
  output.setLen(0)
  # A request with a code alone: the layout says what it means, and a
  # textInput follows.
  doAssert state.applyNamedInput(evKeyDown, %*{"code": "Digit1", "shift": true}, eoHttpWrite, at(0), output)
  doAssert output.names == @[evKeyDown, evTextInput] and output[1].payload["text"].getStr() == "!"
  output.setLen(0)
  # The 2026.9.21 payload: the Linux name and number.
  doAssert state.applyNamedInput(evKeyDown, %*{"key": "KEY_P", "code": 25}, eoHttpAdmin, at(0), output)
  doAssert output[0].payload["code"].getStr() == "KeyP" and output[0].payload["key"].getStr() == "p"
  doAssert output[0].payload["linuxCode"].getInt() == 25
  doAssert output[1].name == evTextInput

block test_a_button_has_a_role_and_an_action:
  var state = initInputState(config(800, 480))
  var output: seq[InputDelivery]
  # A driver from before releases: a press, and nothing follows.
  doAssert state.applyNamedInput(evButton, %*{"pin": 6, "label": "B", "level": 0}, eoDriver, at(0), output)
  doAssert output.names == @[evButton]
  doAssert output[0].payload["action"].getStr() == "press" and output[0].payload["role"].getStr() == "next"
  doAssert output[0].payload["level"].getInt() == 0
  # The configured role wins over the label's default.
  output.setLen(0)
  discard state.applyNamedInput(evButton, %*{"pin": 5, "label": "A", "level": 0, "action": "press"}, eoDriver, at(0), output)
  doAssert output[0].payload["role"].getStr() == "menu"
  # Held: longPress once, then repeats, then the release with how long.
  output.setLen(0)
  state.tick(at(ButtonLongPressMs - 1), output)
  doAssert output.len == 0
  state.tick(at(ButtonLongPressMs), output)
  doAssert output.names == @[evButton, evButton] # pin 6's hold from above, and pin 5's (in table order)
  for d in output:
    doAssert d.payload["action"].getStr() == "longPress" and d.payload["pin"].getInt() in [5, 6]
    doAssert d.payload["durationMs"].getInt() == ButtonLongPressMs
    doAssert d.payload["role"].getStr() == (if d.payload["pin"].getInt() == 5: "menu" else: "next")
  output.setLen(0)
  state.tick(at(ButtonLongPressMs + ButtonRepeatMs), output)
  doAssert output.names == @[evButton, evButton]
  for d in output:
    doAssert d.payload["action"].getStr() == "repeat"
  output.setLen(0)
  discard state.applyNamedInput(evButton, %*{"pin": 5, "label": "A", "level": 1, "action": "release"}, eoDriver,
    at(2000), output)
  doAssert output[0].payload["action"].getStr() == "release" and output[0].payload["durationMs"].getInt() == 2000
  doAssert output[0].payload["role"].getStr() == "menu"
  # A press that woke the device has no hold to follow.
  output.setLen(0)
  discard state.applyNamedInput(evButton, %*{"pin": 9, "label": "BOOT", "level": 0, "action": "press", "wake": true},
    eoDriver, at(3000), output)
  doAssert output[0].payload["wake"].getBool() and output[0].payload["role"].getStr() == "primary"
  output.setLen(0)
  state.tick(at(3000 + ButtonLongPressMs), output)
  for d in output:
    doAssert d.payload["pin"].getInt() != 9
  # A label nobody knows has no role.
  output.setLen(0)
  discard state.applyNamedInput(evButton, %*{"pin": 20, "label": "Zork", "level": 0}, eoDriver, at(4000), output)
  doAssert output[0].payload["role"].getStr() == ""

echo "input state ok"
