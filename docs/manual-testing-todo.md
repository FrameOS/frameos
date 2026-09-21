# Manual testing todo

Everything here shipped with green automated suites but needs a bench. Open
boxes only, grouped by bench — when a box passes, delete it (what was seen
goes in the PR or commit that closes it); delete the file when it is empty.
Every box below needs hardware that was not to hand.

### HyperPixel 4.0 bench

Two display paths, picked on the device (`driver:hyperPixel4` logs
`"path"`): **`kms`** on a Pi 5 — the firmware cannot drive DPI there, so setup
enables the kernel's `vc4-kms-dpi-hyperpixel4*` overlay and the driver only
writes fb0 — and **`firmware-dpi`** on a Pi 0–4, where the driver inits the
panel over GPIO itself like the 2.1" Round. The firmware path is written from
Pimoroni's and the kernel's sources and **has not met a panel**; its log also
says which way the clock pin went (`"clock": "gpiomem"` is the expected
answer).

Bench notes from the passes so far (Pi 5 + 4.0 Touch, Zero 2 W + Round
touch, both 2026-09-19):

- The touch-test scene is `mouseMove` → state, `mouseUp` → redraw a dot. Test
  orientation at an OFF-diagonal point: a transposed axis is invisible on
  the diagonal, and that mistake has been made once.
- `dtparam=i2c_arm=on` makes `drm-rp1-dpi` fail with no fb0 (GPIO 2/3 are
  DPI pins) — setup writes `i2c_arm=off` and `spi=off` for that reason; a
  later `dtoverlay=i2c-gpio` silently re-points the touch bus at GPIO 23/24.
- `systemctl stop frameos` puts the panel to sleep AND frees the backlight
  GPIO, so a raw `cat > /dev/fb0` test pattern shows nothing afterwards.

- [ ] **Pi 0–4, HyperPixel 4.0, no touch (`pimoroni.hyperpixel4`):** first
  deploy writes the DPI block (`dpi_timings=480 0 10 16 59 800 …`), reboots
  once, and the panel shows the scene in its native 480x800 portrait;
  `rotate: 90` / `270` gives the 800x480 landscape. "Turn display off / on"
  drops and restores the backlight without the next render waking it.
- [ ] **Pi 0–4, HyperPixel 4.0 Touch (`pimoroni.hyperpixel4_touch`):**
  `/boot/firmware/overlays/frameos-hyperpixel4-touch.dtbo` exists,
  `dtoverlay=frameos-hyperpixel4-touch` is in config.txt, `dmesg | grep -i
  goodix` shows the controller bound at 0x14 or 0x5d, and `driver:evdev`
  lists it. A touch-test scene must put its dot under the finger at an
  OFF-diagonal point, as it does on the Pi 5; if not, the fix is the `touchscreen-inverted-*` / `touchscreen-swapped-x-y`
  properties in `frameos/src/drivers/hyperPixel4/overlays/*.dts` (rebuild the
  `.dtbo` with the `dtc` line in its header). Touch must survive "Turn display
  off / on": that path borrows GPIO 27, the touch interrupt, for the init
  clock.
- [ ] **HyperPixel 4.0 Square, with and without touch
  (`pimoroni.hyperpixel4sq`, `…_touch`), either board:** the same checks at
  720x720, with `edt_ft5x06` at 0x48 in `dmesg`. Pimoroni's legacy overlay
  inverts both touch axes where the kernel's does not; ours follows the
  kernel's, so a corner-tap test is the one that settles it.
- [ ] **Touch on a rotated frame:** at `rotate` 90 / 270 the touch-test dot
  is still under the finger (rotate 0 passed on the Pi 5).
- [ ] **"Turn display off / on" end to end on the Pi 5** (menu → event →
  driver). The write the driver makes (`echo 1 > /sys/class/graphics/fb0/blank`)
  was run by hand as uid 990 and took `bl_power` 0 → 4 and DPMS On → Off.
- [ ] **HyperPixel 2.1" Round on a Pi 5 (`"path":"kms"`):** setup writes
  `dtoverlay=vc4-kms-v3d` + `dtoverlay=vc4-kms-dpi-hyperpixel2r`, the panel
  shows the scene, "Turn display off / on" blanks and restores it. No touch
  there by design (the kernel's init bus holds the touch bus's pins). Same
  code shape as the 4.0's KMS path, which passed; this one has not met a
  panel.
- [ ] **Round touch during a display power change:** a finger on the glass
  while "Turn display off / on" runs is the one window where the init bus and
  the kernel's I2C can collide (nothing arbitrates GPIO 10/11). Expected
  worst case: a garbled panel until the next init. Off/on with nobody
  touching passed.
- [ ] **Moving a card between HyperPixels and boards:** change the device
  4.0 → Square → 2.1" Round and back; after each deploy + reboot config.txt
  holds exactly one `dpi_timings=` line and at most one HyperPixel
  `dtoverlay=` line.

### ESP32 bench

What already passed, so it is not repeated: flash-id detection picks the
4 MB C3 and 8 MB S3 generic images, a hand relayout of a 13.3E6 to the 32 MB
layout boots and takes a cloud OTA, "Apply frame settings" provisions a
board flashed by hand and carries on past keys an older firmware does not
know, and the self-hosted "Flash latest release" provisions a blank C3 end
to end.

- [ ] **Layout-matched release image on a 16 MB C3 (XTEINK X4):** "Flash
  latest release" picks `esp32-c3-16mb`, the "4MB layout / no OTA" warnings
  are gone, the board boots and later takes an OTA.
- [ ] **"Add frame → Connect & flash" on a 32 MB S3 (13.3E6)** picks
  `esp32-s3-32mb` in the browser click-through (the firmware side passed by
  hand). Note "Update firmware" keeps whatever layout the board has, so only
  this path exercises the pick.
- [ ] **Cloud flasher on a 16 MB XIAO:** the "Connect & flash" log says
  `Flash size 16MB: using the esp32-s3-16mb image built for that layout`,
  the board boots, and its first OTA check asks for
  `platform=esp32-s3-16mb`; an 8 MB board stays on `esp32-s3-generic`.
- [ ] **Backend OTA onto the release image** (needs an OTA-capable board on
  a self-hosted backend — the 4 MB C3 is not one): "Update over the air" /
  Full deploy logs `ota:backend downloading … verified`, the board reboots
  into the release, and a second request answers `up-to-date`. With HTTPS
  enabled on the frame, `status` says `https: … cert=yes key=yes` and the
  API answers on 8443. Finally a board still on a per-frame image from
  before release images must OTA onto the release image from the new
  manifest (the legacy `sha256` field) and verify from then on.
- [ ] **One event dispatcher on a board** (`docs/events.md`; the Nim side is
  covered by `test_event_loop.nim` and the C edge by
  `test_fos_events_dispatch.c`, but no board has run them together). With a
  scene whose `button` listener sets state: a press renders once; a press no
  listener's state reacts to does not refresh the panel. `event button
  {"label":"A"}` on the console does the same. `POST /event/setCurrentScene`
  with `state` switches AND applies the state (it used to be dropped); the
  same from the cloud's scene activation. `POST /event/restart` answers 200
  and then restarts. A schedule entry firing a custom event reaches only a
  scene that declares it with `origins: ["schedule"]`, and the log says
  `event:refused … undeclared` otherwise. From the cloud: a scene's control
  rail (`setSceneState` → `scene_event`) changes the picture while a render
  is NOT in progress, and answers `busy` — without dropping the WebSocket —
  when sent during a 13.3" render. Watch the cloud task's stack high-water
  mark once: `scene_event` runs scene handlers on it.
