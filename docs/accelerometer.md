# The accelerometer

Two boards FrameOS runs on carry an accelerometer: the Seeed reTerminal
Sticky (an ST LSM6DS3TR-C at I2C 0x6a) and the Waveshare
ESP32-S3-Touch-AMOLED-1.75 (a QST QMI8658 at 0x6b). The firmware reads it,
works out which way down is and what the person holding the frame did with
it, and hands that to three readers:

- **a scene**: `frameos.accelerometer()` for a reading, and four input events,
  `tilt`, `flick`, `shake` and `orientation`, for a gesture;
- **the event maps**: the frame's "Button actions" and an installed scene's
  "Map buttons" bind a gesture as they bind a key (a flick right is
  `forward`: a page turned in a book);
- **auto-rotate**: the frame's setting that turns the picture to stand upright
  as the frame is turned.

No other host has an accelerometer: a Raspberry Pi, the browser preview and a
frame its control plane renders answer `null` and send none of the events
(a frame rendered on its plane does relay the events its own accelerometer
makes, like its keys: docs/server-rendering.md). A scene made for tilting
still works there by touch, keys or buttons, and the scene store tags it
"Accelerometer" (`utils/sceneNeeds.ts`) and puts it first on a frame that
has one, never leaving it out elsewhere.

## Frames of reference

Everything a scene hears is along **the picture's axes as the frame shows it
now**: x towards the picture's right, y towards its bottom, z out of the glass
towards whoever looks at it. The rotation in the frame's settings and
auto-rotate's turn are both taken out, so a scene never needs to know either.

`frameos.accelerometer()` answers **gravity**, in g: which way down is.

| the frame | x | y | z |
|---|---|---|---|
| standing upright | 0 | 1 | 0 |
| lying face up on a table | 0 | 0 | -1 |
| lying face down | 0 | 0 | 1 |
| leaning to its left | < 0 | | |

Shaking it adds to that (a reading is the force on the chip, turned around):
sand that falls along `(x, y)` falls the right way and sloshes when shaken.
A reading is the latest of 50 a second while a scene reads it (25 otherwise),
lightly smoothed (about 60 ms), so an animation reads it every frame and
nothing more. `app.frame.accelerometer` is `true` on a frame that has one,
without reading it.

## The gestures

`fos_motion.c` makes them, by the numbers in the contract's `motion` block
(`docs/events-contract.json`; the firmware's copy is generated into
`fos_events_gen.h`). All are input events from the origin `driver`, delivered
to a scene that listens and to the event maps first.

- **tilt** `{direction, x, y}`: the frame tipped towards one side of the
  picture, past `tiltG` (0.35 g, about 20 degrees) from how it rested before,
  and stayed there for `tiltHoldMs` (350 ms). `direction` is the side that
  went down, `x` and `y` the lean then. Measured from the rest, not from
  level, so it works lying on a table and held in a hand at any angle. It
  comes again only once the frame has rested (still for `restMs`, 600 ms, back
  within `restG` of the rest): holding a tilt is one tilt, and coming back to
  level is no tilt the other way. A frame held tipped for three times `restMs`
  takes that as its new rest.
- **flick** `{direction, x, y}`: tipped past `tiltG` and back within
  `tiltHoldMs`: a flick of the wrist. Never also a tilt. The natural page
  turn: bound to `forward` / `back`, or heard by a scene of its own.
- **shake** `{strength}`: `shakeCount` (3) jolts of more than `shakeG` (0.8 g)
  away from gravity, back and forth, within `shakeMs` (900 ms); `strength` the
  hardest, in g. A shake cancels a tip under way. The next shake needs a rest
  first.
- **orientation** `{position, rotate?}`: the frame came to rest in another
  position for `restMs`: `upright`, `turnedLeft` (its left side down),
  `turnedRight`, `upsideDown`, `faceUp` or `faceDown`, next to the way it was
  set up (the rotation in its settings). `rotate`, while it stands, is the
  rotation that shows the picture upright. The first position after a boot is
  learnt quietly: only a change is an event.

A scene for e-paper listens for these rather than polling: the Sticky's panel
draws a few pictures a second at best, and a gesture is one picture.

## Auto-rotate

`auto_rotate` (cloud `set_settings`, a backend's `autoRotate`, the frame page,
`set auto_rotate 1` on the console; default off) turns the picture to the
rotation the accelerometer reads once the frame has stood a new way for
`restMs`. Lying flat keeps what it had. The frame's own rotation stays what it
was: it is the picture's way up at boot and while auto-rotate is off, and the
reference `orientation` names positions from.

It is live: `fos_rotation.c` keeps the rotation the picture is drawn at
(`fos_rotation()`, which every picture-orientation reader in the firmware
uses: the packers, the touch, the overlays, the loading mark, a server-render
pull), and the render task hands the runtime a new one between renders
(`frameos_nim_set_rotation` → `setRuntimeRotation` in `embedded_runtime.nim`:
the canvas is made at the turned size by the next render, the press map and
the input state follow, what the rhythm kept is let go, a desktop refits its
windows by itself). Nothing restarts, unlike a change of the rotation itself.
The one exception is a board whose canvas is its panel buffer because nothing
turns it (a sixteen-grey or a colour e-paper at rotation 0, `main.c`
`canvas_is_panel_picture`): neither IMU board is one, but such a board takes a
restart to turn auto-rotate on, and keeps a canvas of its own from then.

The picture's turn is never saved and never reported as the frame's rotation.
`hardware.autoRotate` reports the setting; the planes adopt a change made on
the frame page (`settings:frame` with `autoRotate`) as they adopt the rotation.

## Axes

Each board's chip sits on its board some way round: `fos_imu.c`'s
`k_board_axes` says which chip axis is the panel's x, y and z (`x=-y,y=x,z=z`),
and `set imu_axes <map>` (or `default`) overrides it on a frame, live. The
console's `imu` prints the chip's reading, gravity along the picture, the map
in use, the position and auto-rotate's reading: standing the frame upright
must print `y=+1000` and lying it face up `z=-1000`. The two boards' rows come
from the bench (2026-11-28, both standing on an edge): the Sticky's chip has
its -x up standing in the portrait its preset draws, the AMOLED's its +x up
standing upright at rotation 0. That fixes which chip axis is the panel's y
(and on the Sticky its x); the z rows assume each chip faces away from the
glass, and the third axis follows from handedness (`test_fos_motion.c`
`test_board_axes`). **Lying each board face up once and reading `z=-1000`
confirms the rest**; tilts, flicks and shakes come regardless, but which side
a tilt names, `orientation` and auto-rotate follow the map.

## Power

The task reads the chip while the frame is awake: a frame that deep-sleeps
between renders hears no gesture while it sleeps (a wake on motion, the
chips' interrupt pins, is not wired yet). The read is one 6-byte I2C
transaction (about 1 ms at 100 kHz) every 20 or 40 ms. The gyroscopes stay
off.

## Where it lives

| part | file |
|---|---|
| the chips, the axis map, the task | `embedded/esp32/main/fos_imu.c` |
| readings to gestures and positions (pure, host-tested) | `fos_motion.c`, `tests/test_fos_motion.c` |
| the live rotation | `fos_rotation.c`, `embedded_main.nim` `fos_nim_set_rotation_impl` |
| `frameos.accelerometer()`, `app.frame.accelerometer` | `js_runtime/app_runtime.nim` (`accelerometerReader`) |
| the events and the numbers | `docs/events-contract.json` (`motion`) |
| the store tag | `frontend/src/utils/sceneNeeds.ts` (`accelerometer`) |
| binding gestures | `frontend/src/utils/frameEventMap.ts`, `utils/accelerometer.ts` |
| the samples | Sand, Spirit level, Oracle ball, Marble maze, and tilting in 2048 |
