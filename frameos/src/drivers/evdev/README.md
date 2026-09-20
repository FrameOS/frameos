# evdev input driver

Reads every `/dev/input/event*` device that reports keys, buttons, relative or
absolute motion, and sends the scene events below.

- `evdev.nim` — the I/O shell: opens devices, reads `input_event`s through
  libevdev, sends what the translator returns. Links `-levdev`, so it only
  builds on Linux.
- `translate.nim` — what an `input_event` means. Pure (no libevdev, no host
  imports) and tested with recorded device dumps in `tests/test_translate.nim`;
  a change to the rules below starts with a dump there.
- `pointer.nim` — the 0..32767 pointer range and the axis scaling.
- `libevdev.nim`, `linuxInput.nim` — bindings, adapted from
  https://github.com/luked99/libevdev.nim which was 8 years old at the time of
  writing.

## Events

Everything a device reports in one input frame is sent at the frame's
`SYN_REPORT`, position first, so a press lands where the finger is.

| Event | Payload | From |
|---|---|---|
| `mouseMove` | `{x, y}`, both 0..32767 across the panel (the runner scales them into scene pixels) | `ABS_X`/`ABS_Y` scaled from the device's own range; `REL_X`/`REL_Y` through the driver's cursor |
| `mouseDown` / `mouseUp` | `{button}`: 0 left or touch, 1 right, 2 middle, 3 side, 4 extra, 5 forward, 6 back, 7 task | `BTN_LEFT`..`BTN_TASK`, `BTN_TOUCH` |
| `wheel` | `{deltaX, deltaY}` in notches, DOM signs: `deltaY > 0` scrolls down, `deltaX > 0` right | `REL_WHEEL` (negated), `REL_HWHEEL`, summed per input frame |
| `keyDown` / `keyUp` | `{key, code}`: the kernel's name (`"KEY_A"`) and number | every other `EV_KEY` code, gamepad and joystick buttons included |

Rules worth knowing:

- **A relative mouse moves a cursor the driver owns**: panel pixels, one count
  per pixel, starting at the centre, clamped to the panel. It is one cursor for
  all devices, and an absolute device moves it too, so a mouse picked up after
  a touch continues from the touch. Nothing draws the cursor. The driver knows
  the panel's size but not the frame's `rotate`, so on a rotated frame the
  mouse's axes are the panel's, not the scene's.
- **Key auto-repeat is dropped.** The kernel sends `value == 2` while a key is
  held; the payload has no `repeat` flag yet, so a held key is one `keyDown`
  and one `keyUp`.
- **`BTN_TOOL_*` and the stylus buttons are not presses** and send nothing. A
  touchpad tap is `BTN_TOOL_FINGER` plus `BTN_TOUCH`: one `mouseDown`.
- An event type the driver does not handle (`EV_LED`, `EV_SW`, …) is logged
  once per device per type as `driver:evdev`, never per event.
- Not handled yet: hotplug (devices are enumerated once at start), multitouch
  (`ABS_MT_*`; the kernel's single-touch emulation is what works), hi-res
  wheel, pressure.
