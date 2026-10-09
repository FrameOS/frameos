# Manual testing todo

Everything here shipped with green automated suites but needs a bench. Open
boxes only, grouped by bench — when a box passes, delete it (what was seen
goes in the PR or commit that closes it); delete the file when it is empty.
Every box below needs hardware that was not to hand.

### HyperPixel 4.0 bench

One display path on every board (`driver:hyperPixel4` logs `"path":"kms"`):
setup enables `vc4-kms-v3d` and the kernel's `vc4-kms-dpi-hyperpixel4*`
overlay, which inits the panel, owns the backlight and brings touch up; the
driver only writes fb0. Pi 0–4 used a firmware-DPI path until 2026-09-22 —
it never brought a panel up (a Square on two Pi Zero Ws showed a fixed stripe
pattern) while the kernel's overlay drove the same panel on the same Zero, so
it was removed; setup now strips its config.txt block from old cards.

Bench notes from the passes so far (Pi 5 + 4.0 Touch, Zero 2 W + Round
touch, both 2026-09-19):

- The touch-test scene is `repo/scenes/samples/Touch test` (install it from
  the samples): a dot follows the pointer and the scene names the gesture it
  saw. Test orientation at an OFF-diagonal point: a transposed axis is
  invisible on the diagonal, and that mistake has been made once.
- `dtparam=i2c_arm=on` makes `drm-rp1-dpi` fail with no fb0 (GPIO 2/3 are
  DPI pins) — setup writes `i2c_arm=off` and `spi=off` for that reason; a
  later `dtoverlay=i2c-gpio` silently re-points the touch bus at GPIO 23/24.
- `systemctl stop frameos` puts the panel to sleep AND frees the backlight
  GPIO, so a raw `cat > /dev/fb0` test pattern shows nothing afterwards.

- [ ] **Pi 0–4, HyperPixel 4.0 (`pimoroni.hyperpixel4`, `…_touch`):** first
  deploy writes `dtoverlay=vc4-kms-v3d` + `dtoverlay=vc4-kms-dpi-hyperpixel4`
  (`,disable-touch` without touch), reboots once, and the panel shows the
  scene in its native 480x800 portrait; `rotate: 90` / `270` gives 800x480.
  With touch: `dmesg | grep -i goodix` shows the controller, `driver:evdev`
  lists it, and the touch-test dot lands under an OFF-diagonal finger. "Turn
  display off / on" blanks and restores fb0.
- [ ] **A card set up the old firmware-DPI way converts** through a normal
  FrameOS update: config.txt ends with no `dpi_*` / `gpio=…=a2` /
  `frameos-hyperpixel4*-touch` lines and the panel comes up on the next boot.
- [ ] **HyperPixel 4.0 Square on a Pi 3/4** (the kernel overlay drove it on a
  Pi Zero W and a Pi 5).
- [ ] **Touch on a rotated frame:** at `rotate` 90 / 270 the touch-test dot
  is still under the finger (rotate 0 passed on the Pi 5).
- [ ] **Input v2 on a Pi (2026.9.23, `docs/events.md` "Input"; run in the
  preview and under tests, never on hardware):** with a USB mouse on a
  framebuffer / HyperPixel frame the drawn cursor moves along the picture's
  axes at `rotate` 0 and 90, hides 5 s after the last motion, and a click of
  it is a `pointerDown` at the cursor; on the Touch test the gestures come
  out right (`tap`, `doubleTap`, `longPress` while still held, `swipe left`);
  two fingers are two `pointerId`s; a keyboard plugged in AFTER boot is found
  (`driver:evdev … listening`), is grabbed (`grabbed: true`; Ctrl+Alt+Del does
  nothing), and the Keyboard test shows `Shift+H` as `H` under the `us` layout
  and `z` for KEY_Y under `de` (`inputSettings.keyboardLayout`); a GPIO button
  held 500 ms logs a `longPress` then `repeat`s and the release carries
  `durationMs`, and the Counter sample still counts one per press. On an
  ESP32 (E1002 bench): a press logs `action: press`, the release `release`
  with `durationMs`, and a scene's `button` listener without an `action`
  filter runs once per press.
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
- [ ] **The event dispatcher's cloud and schedule paths on a board** (the
  console, render-rule, queued-dispatch, scene-switch and device-command
  paths passed on a reTerminal E1002, 2026-09-21). Still unseen, because they
  need a cloud that speaks `scene_event` and a schedule on the frame: a
  scene's control rail (`setSceneState` → `scene_event`) changes the picture
  while a render is NOT in progress, and answers `busy` — without dropping
  the WebSocket — when sent during a 13.3" render; watch the cloud task's
  stack high-water mark once, since `scene_event` runs scene handlers on it.
  A schedule entry firing a custom event reaches only a scene that declares
  it with `origins: ["schedule"]`, and the log says `event:refused …
  undeclared` otherwise. `POST /event/setCurrentScene` with `state` over
  HTTP, and a physical button press (origin `driver`), take the same C
  function the console does.
