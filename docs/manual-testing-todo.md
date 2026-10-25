# Manual testing todo

Everything here shipped with green automated suites but needs a bench. Open
boxes only, grouped by bench — when a box passes, delete it (what was seen
goes in the PR or commit that closes it); delete the file when it is empty.
Every box below needs hardware that was not to hand.

### reTerminal Sticky bench (everything: no board has run this yet)

Every pin is from Seeed's hardware specification for porting; the firmware
has never seen a Sticky. In order of what breaks the most:

- [ ] **It boots and renders** on `set hardware seeed_reterminal_sticky`:
  the panel behind EP_PWR_EN GPIO47 refreshes (`display_test bands`), the
  console on the CH343 keeps working after the microphone takes GPIO19/20.
- [ ] **The keys**: `buttons watch` names GPIO4 AI, GPIO5 UP, GPIO6 DOWN;
  UP/DOWN held switch scenes; a press clicks the 4 kHz buzzer.
- [ ] **The glass** (`touch`): `touch:ready` in the boot log with the
  GT911's address and range; `swapped` matches the panel (a tap at the top
  left of the picture lands at the top left: the "Button tester" store scene
  shows `tap` coordinates). A drag is one `pointerMove` per report, a swipe
  arrives as `swipe`. A touch made during a refresh arrives as a tap after it.
- [ ] **Voice**: `mic 2` reads a peak in the thousands when spoken to (0 =
  the USB PHY is still on the pads, or PDM_EN GPIO38 is not the power pin);
  AI held talks.
- [ ] **The sensor bus** (`i2c`): pcf8563, sht4x, lsm6ds3 and bq27220 all
  answer on sda1/scl0; `status` prints the gauge's mV / % / mA; `gauge`
  current is positive on USB and negative unplugged, and the power line says
  `onBattery:false` on USB.
- [ ] **Deep sleep on battery**: unplugged, the frame sleeps between renders
  and a tap or a key wakes it (`wake` cause `touch` / `button`); the GT911
  stays powered through the sleep (sleep current to note).
- [ ] **The TF socket** mounts on the shared bus (CS8, MISO12, power 10,
  detect 11); if not, try mounting before the display init (Seeed's note).

### reTerminal E1003 bench (everything: no board has run this yet)

The IT8951 driver (`components/frameos_display/it8951.c`) and every pin are
from Zephyr's board file, Seeed's E1003 examples and SenseCraft HMI config,
and TRMNL's firmware; nothing has met an E1003. In order of what breaks the
most:

- [ ] **The controller answers**: after `set hardware seeed_reterminal_e1003`
  and a restart, the first `display_test bands` prints `it8951: 1872x1404,
  image buffer 0x…, firmware …, LUT …, VCOM -1400 mV, mirrored, temperature
  NN C`. `IT8951 drives a 0x0 panel … (no answer on MISO)` = the read path
  (MISO GPIO8, the controller power on GPIO21); `busy (HRDY low)` = the
  controller is unpowered or held in reset.
- [ ] **The picture is the right way round and sharp**: text reads left to
  right (if it is mirrored, the E1003 variant's `mirror_x` is wrong); a
  1-pixel checkerboard or thin vertical lines show no pairs of swapped
  columns; the 16 grey bands of `display_test` are 16 distinct steps.
- [ ] **It refreshes every time**: two different renders in a row both
  flash (the temperature command is what makes the E1003 run the waveform at
  all); a whole frame's `it8951: 1404 of 1404 rows up in` is about 550 ms
  (1.25 MiB at 20 MHz; if reads or the picture break at 20 MHz, try
  `FOS_IT8951_SPI_HZ` 16 or 12 MHz), and nothing is cut short by standby.
- [ ] **Only changed rows go up**: a clock scene's minute tick uploads tens
  of rows and flashes only that band, and the rest of the picture is intact
  afterwards (standby keeps the controller's memory; if the unchanged part
  turns to noise, it does not, and every refresh must send the whole frame).
  The same picture twice logs `no row changed, refresh skipped`.
- [ ] **It renders on-device in grey**: the boot log says `canvas: 1872x1404
  gray8`; a photo and a text-heavy scene render without `OOM` and look like
  their RGBA preview in grey (2.5 MiB canvas + 1.25 MiB buffer + the 1.5 MiB
  reserve on 8 MB); note the `freePsramKB` after the first render.
- [ ] **The glass** (`touch`): `touch:ready` on sda19/scl20 at 0x5d with the
  GT911's range; a tap at the top left lands at the top left (the "Button
  tester" store scene); `i2c` still lists pcf8563, sht4x and sy6974b, and an
  `i2c` rescan keeps the touch panel working (the lent bus).
- [ ] **The rest of the board**: keys GPIO3 REFRESH / 4 LEFT / 5 RIGHT
  (`buttons watch`); the LED on GPIO16 lights with the buzzer's notes; the
  TF socket mounts with its power on GPIO39; `battery` reads the cell through
  GPIO1 with GPIO40 switching the divider; `mic 2` reads a peak; REFRESH
  held talks.

### SenseCAP Indicator bench (what the 2026-10-25 bench could not see)

The D1S on the desk booted the LCD, the FT6336U answered, the demo scene
rendered and its 24-bit snapshot read right over `/image`; left to a pair of
eyes and a finger:

- [ ] **The glass itself**: the picture is upright and the right way round
  (the ST7701S init sends MADCTL 0x10; ESPHome mirrors both axes on this
  board, Seeed's demo does not — if it is mirrored, `rotate 180` is the
  quick fix and the init's 0x36 byte the real one); colours are not swapped
  (`display_test bands` draws black, red, green, blue, yellow, white left to
  right). Steadiness was measured with `lcd` (no dropped frames or late
  refills over renders, a moving finger, button presses); still to watch by
  eye: a scene with a big download, a settings save (one disturbed frame
  per flash write is expected), an OTA.
- [ ] **A tap** lands where the finger is: the "Button tester" store scene
  shows `tap` coordinates; a drag is `pointerMove`s; `touch` on the console
  shows the last raw point.
- [ ] **The top button** (GPIO38) held shows the next scene (presses,
  double presses and the long press reach the event map on the bench; a
  second scene is needed to see the switch).
- [ ] **Later batches** carry an HT8574 at 0x39 instead of the TCA9535 at
  0x20 (Seeed's BSP probes both): the driver's 8-bit path is untested.
- [ ] **A D1L/D1Pro**: the LoRa radio's expander lines (P0..P3) are left as
  inputs; nothing talks to the SX1262.

### Waveshare PhotoPainter / 13.3E6 bench (the codec, `fos_codec.c`)

- [ ] **The chips answer**: `i2c` lists es8311 and es7210 on the board's bus
  (47/48 on the PhotoPainter, 41/42 on the 13.3E6); `status` prints `codec:`.
- [ ] **The speaker**: `beep` and a press's clicks come out of the speaker
  at a sensible volume (ES8311 volume 0xBF, amplifier on for the note); no
  pop or hiss between notes (the amplifier is switched off at the rest).
- [ ] **The microphone**: `mic 2` reads a peak in the thousands; KEY1
  (PhotoPainter) / BOOT (13.3E6) held talks and the transcript is right
  (the left ADC slot is the one taken: if it is silence, the microphones
  are on the right slot or need the TDM mode).
- [ ] **The PhotoPainter's PMIC** still powers the panel with the codec on
  its I2C port (the two share port 0).

### reTerminal E1002 bench (voice chat, `docs/voice-chat.md`)

Bench 2026-10-24 (E1002 over USB, a backend running the branch): `mic 2` read
peak 5162; "Switch to the calendar." was transcribed, answered and applied
(`commands:sync received 1`, Calendar rendered); the keys' `up` edges
logged `claimed:true`. "Write Hello World on the board" ran `activate_scene`
then `set_scene_state`, and without the render hold the switch's render
(45 s on this panel) showed the notice over the old text, the state a second
refresh later — the hold (`docs/voice-chat.md` "The notice") is the fix to
confirm. Still open:

- [ ] **Hold REFRESH on a cloud-managed frame** ends the same way (the
  cloud route is integration-tested only): `voice:reply` with the transcript,
  the switch delivered over the socket.
- [ ] **By ear**: the sparkle at 1 s in place of the first hold "dun", no
  further duns and no release click on the key, every two seconds after the
  release a tiny high tick while the
  upload finishes and a quiet low bop while the answer is awaited (none
  while listening),
  three rising notes when the chat switched a scene, two when it
  only answered, one low note for nothing heard, two low notes on an error,
  the dull pair for a hold while a session still answers. The sparkle must
  not show up in the transcript (the first 300 ms are dropped).
- [ ] **By eye**: the notice box across the bottom of the panel — the
  sentence in quotes and the reply — on ONE render that carries both the
  switch and the state ("Write Hello World on the board" from another scene:
  the Message board with "Hello World" and the notice in the same refresh,
  `voice:shown` right before `render:done`, no second `render:scene`), and as
  a repaint of the last image when the chat only answered ("What's on the
  frame?": the photo stays, no `render:scene` at all); the next render takes
  it off. An error shows its sentence ("I didn't catch that…" for silence).
- [ ] **"Voice chat may"** (Settings → Buzzer and microphone, `docs/voice-chat.md`
  "What the voice chat may do"): with **Use installed scenes** off, "switch
  to the calendar" is declined in a sentence and nothing is queued
  (`voice:reply` names no tool, `commands:sync received 0`); with **Create
  new scenes** left off (the default) "show me a banana" is declined the same
  way, and turned on it previews the picture; with **Change settings** off
  "rotate the frame" leaves it unturned; with **Access photo albums** off
  "show the summer photos" is declined, and on (the default) it installs the
  album scene next to the frame's scenes and shows it (`docs/photos.md`: the
  frame's own share link, one photo a render). Once on the backend and once
  on a cloud-managed frame; the switches save with the frame's Settings and
  apply to the next sentence without a push.
- [ ] **No microphone, no controls**: on the E1004 (no microphone reported)
  the Settings panel shows the Microphone GPIO pins and neither the Voice
  chat switch nor "Voice chat may"; setting clock 42 and data 41 makes them
  appear, -1 takes them away again.
- [ ] **"Show me a banana"** (with **Create new scenes** on) pushes a preview scene (`Voice: a banana`, an
  Unsplash photo; "generate a banana" → OpenAI art when the project has an
  `openAI.apiKey`) next to the saved scenes and shows it in the one render
  with the notice; "switch to the calendar" afterwards still works. On a
  cloud frame the sources are the groups granted to its scenes only.
- [ ] **"Rotate 90 degrees"**: the answer reaches the panel (un-rotated, with
  the notice), THEN the frame restarts and comes back rotated; "every ten
  minutes" changes the interval without a restart.
- [ ] **Early release** (REFRESH up before 1 s) is an ordinary press (a
  refresh, as before); a second hold while the first is still answering gets
  the dull pair.
- [ ] **The binding moves**: Settings → Button actions → REFRESH long press
  set to Refresh and LEFT long press to Voice chat (`event_map` in the
  settings change log): LEFT held now talks, REFRESH held refreshes, nothing
  else changes; the row offers Voice chat for long presses only.
- [ ] **Wake from deep sleep with REFRESH held** records at once and
  uploads once Wi-Fi is up (`voice:sent` after `wifi` connected); an E1002
  with `voice_chat 0` gives the dull pair at the hold and nothing else.
- [ ] **Settings** → GPIO buttons → "Voice chat" off/on reaches the frame
  live on both planes (`voice_chat` in the settings change log).

### reTerminal E-series peripherals bench (the SD slot, the LED, the clock, the charger)

Bench 2026-10-25 (E1002 over USB, cloud-enrolled, a 64 GB FAT32 card seated,
firmware from the branch flashed into both OTA slots of its 8 MB layout):
the board provisioned before the keys existed came up with the slot on
(`SD assets mounted at /srv/assets (60906 MB, … on the panel's SPI bus)`),
`i2c` found `sda19/scl20: pcf8563 sht4x; sda39/scl40: sy6974b`, the charger
read `usb_power=1 charging=1` and the metrics said `onBattery:false` with
USB in (the old firmware said true), the first SNTP sync wrote the PCF8563
and the next reset said `rtc: clock set from the PCF8563: 2026-10-25
00:09:36 UTC` before Wi-Fi, `display_test bands` refreshed the panel on the
shared bus (`ESP_OK`) and `usb_api list-assets` read the card right after,
`led blink` / `beep` ran, the cloud hello carried `ledPin 6`, `ledType
gpio_inverted`, `rtc`, `charger`, `climateSensor`, `sdCard`. Internal RAM
idled at 80 KB free as before the branch. Two things found on the bench and
fixed: the PCF8563 NACKed every write (I2C error 0x103) until the USB
Serial/JTAG PHY was detached from GPIO19/20 (the S3's USB pads, which these
boards use for I2C), and the SNTP callback wrote the clock on lwIP's thread,
now a flag the render pass acts on. A frame with no scenes loaded logs
"retrying in 10 s" and does not (the pass waits the whole interval; a
manual `render` runs it); older than this branch, noted here. Unplugged for
a few minutes, the metrics read `usbPower:false charging:false
onBattery:true` (3902 mV) and flipped back on the replug. The LED blinks on
`led blink` and is held lit through a voice recording (`fos_led_hold`).
Still open:

- [ ] **Hold REFRESH on a cloud-managed frame** ends the same way (the
  cloud route is integration-tested only): `voice:reply` with the transcript,
  the switch delivered over the socket.
- [ ] **By ear**: the sparkle at 1 s in place of the first hold "dun", no
  further duns and no release click on the key, every two seconds after the
  release a tiny high tick while the
  upload finishes and a quiet low bop while the answer is awaited (none
  while listening),
  three rising notes when the chat switched a scene, two when it
  only answered, one low note for nothing heard, two low notes on an error,
  the dull pair for a hold while a session still answers. The sparkle must
  not show up in the transcript (the first 300 ms are dropped).
- [ ] **By eye**: the notice box across the bottom of the panel — the
  sentence in quotes and the reply — on ONE render that carries both the
  switch and the state ("Write Hello World on the board" from another scene:
  the Message board with "Hello World" and the notice in the same refresh,
  `voice:shown` right before `render:done`, no second `render:scene`), and as
  a repaint of the last image when the chat only answered ("What's on the
  frame?": the photo stays, no `render:scene` at all); the next render takes
  it off. An error shows its sentence ("I didn't catch that…" for silence).
- [ ] **"Show me a banana"** pushes a preview scene (`Voice: a banana`, an
  Unsplash photo; "generate a banana" → OpenAI art when the project has an
  `openAI.apiKey`) next to the saved scenes and shows it in the one render
  with the notice; "switch to the calendar" afterwards still works. On a
  cloud frame the sources are the groups granted to its scenes only.
- [ ] **"Rotate 90 degrees"**: the answer reaches the panel (un-rotated, with
  the notice), THEN the frame restarts and comes back rotated; "every ten
  minutes" changes the interval without a restart.
- [ ] **Early release** (REFRESH up before 1 s) is an ordinary press (a
  refresh, as before); a second hold while the first is still answering gets
  the dull pair.
- [ ] **The binding moves**: Settings → Button actions → REFRESH long press
  set to Refresh and LEFT long press to Voice chat (`event_map` in the
  settings change log): LEFT held now talks, REFRESH held refreshes, nothing
  else changes; the row offers Voice chat for long presses only.
- [ ] **Wake from deep sleep with REFRESH held** records at once and
  uploads once Wi-Fi is up (`voice:sent` after `wifi` connected); an E1002
  with `voice_chat 0` gives the dull pair at the hold and nothing else.
- [ ] **Settings** → GPIO buttons → "Voice chat" off/on reaches the frame
  live on both planes (`voice_chat` in the settings change log).

### reTerminal E-series peripherals bench (the SD slot, the LED, the clock, the charger)

Bench 2026-10-25 (E1002 over USB, cloud-enrolled, a 64 GB FAT32 card seated,
firmware from the branch flashed into both OTA slots of its 8 MB layout):
the board provisioned before the keys existed came up with the slot on
(`SD assets mounted at /srv/assets (60906 MB, … on the panel's SPI bus)`),
`i2c` found `sda19/scl20: pcf8563 sht4x; sda39/scl40: sy6974b`, the charger
read `usb_power=1 charging=1` and the metrics said `onBattery:false` with
USB in (the old firmware said true), the first SNTP sync wrote the PCF8563
and the next reset said `rtc: clock set from the PCF8563: 2026-10-25
00:09:36 UTC` before Wi-Fi, `display_test bands` refreshed the panel on the
shared bus (`ESP_OK`) and `usb_api list-assets` read the card right after,
`led blink` / `beep` ran, the cloud hello carried `ledPin 6`, `ledType
gpio_inverted`, `rtc`, `charger`, `climateSensor`, `sdCard`. Internal RAM
idled at 80 KB free as before the branch. Seen once and not reproduced: with
`render` and two `usb_api list-assets` (a 33 KB JSON of a 300-entry card
held in internal RAM) back to back, the console and the render task went
silent while the cloud socket stayed up; a second identical run only showed
`freeHeapMallocKB: 0` for the moment of the listing and recovered. Watch
for it. Unplugged for a few minutes, the metrics read `usbPower:false
charging:false onBattery:true` (3902 mV) and flipped back on the replug.
Still open:

- [ ] **By eye**: the LED with the two clicks of a press and each tick of a
  hold, held lit for a whole REFRESH hold (the recording) and back to the
  ticks and the answer after the release, with `set buzzer_pin -1` too;
  Settings → "Buzzer, LED and microphone" shows `6 on the frame` and setting
  -1 darkens it live.
- [ ] **`deep_sleep_on_battery 1` with USB in** stays awake, and sleeps
  between renders once unplugged (the switch is off on the bench frame).
- [ ] **The RTC through a real power cut.** Twice on the bench E1002 the rear
  switch (30-60 s off) came back with `{"event":"rtc","action":"boot",
  "loaded":false,"reason":"not_set"}`: the PCF8563 raised its integrity flag,
  so it lost power with the board; the firmware waited for SNTP and wrote it
  back, as designed. A reset that keeps power (`esptool`, the reset button)
  loads the clock from the chip every time. Check the CR1220 holder on that
  board (the E1002 V1.2 schematic feeds RTC_VDD from the cell through a
  diode); with a cell in, the cold boot should say `loaded:true`.
- [x] **The E1004** (bench 2026-10-25, frame 70 on the self-hosted backend, the
  32 MB image): the boot found `sda19/scl20: pcf8563 sht4x sy6974b` (the
  charger on the clock's bus, as its schematic says), mounted the preinstalled
  16 GB card on the panel bus through the migration path, kept its clock
  through a reset, and decided `deepSleep: off, onBattery: false, usbPower:
  true` with `deep_sleep_on_battery 1` — the desk-bound E1004 stays awake on
  USB now. `display_test bands` (the 13.3" refresh, 1200x1600) came back
  `ESP_OK` on the shared bus and `usb_api list-assets` read the card right
  after; `i2c sync` wrote the clock first time. Its LED is lit HIGH (the
  table said inverted and it idled lit, blinking dark on a press; fixed in the
  table and the preset, `set led_type gpio` on a board whose NVS already
  holds the earlier default). Seen by eye on the fixed polarity: dark at
  rest, green on a press, and only a blink of green at reset now that the
  pin is claimed dark at boot. Nothing left to see on this board.
- [ ] **The WS2812 kind** (no board with one is to hand): `set led_type
  ws2812` on a pin with a pixel lights it soft white per note.

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

### Input on a Pi

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
  held 2.5 s logs a `gpio` `down`, then on the release a `gpio` `up` and a
  `button` `longPress`, both with `durationMs` near 2500, and the Counter
  sample counts one per press (a quick double is one `doublePress`, a hold one
  `longPress`).
- [ ] **GPIO buttons on a Pi (Inky Impression):** the fastest tap and double
  tap you can make register with the 30 ms lgpio debounce (`down`, `up`,
  `press`; `down`, `up`, `down`, `doublePress`, `up`), and a slow press does
  not bounce into two. The same checks passed on the E1004, sounds included
  (2026-10-18).

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
  Full deploy logs `ota:backend downloading … verified`, the frames list
  and the OTA card spin with "updating firmware NN%" meanwhile (the button
  disabled), the board reboots into the release and the spinner clears, and
  a second request answers `up-to-date`. With HTTPS
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

### Setup hotspot bench

The captive portal (#580: the dnsmasq drop-in on NetworkManager images, the
redirect-only listener on `10.42.0.1:80`) and the made-up hotspot credentials
(#579) have not met a phone.

- [ ] **The captive sheet:** a phone (iOS and Android) joining the setup
  hotspot gets the "sign in to network" sheet with the setup form in it, on a
  `raspberry-pi-64` / `raspberry-pi-5` image AND on the armv6 supplicant image
  (whose dnsmasq already answered every name). A frame with a screen shows
  its made-up `FrameOS-XXXX` name and password with the QR code, and the QR
  code joins.
- [ ] **"Saved!" inside the sheet:** it is a restricted browser that may not
  run the page's timers, so the move to the frame's LAN address may not
  happen there. The page reads right without script (a link, a `<noscript>`
  line); if the sheet closes the moment the hotspot drops, the link is what
  the owner uses. Decide whether the sheet needs a "Done, open the app" step.
- [ ] **A frame flashed before the drop-in:** root is read-only, so it gets
  the DNS half only with a new image. The portal still works there the old
  way (two QR codes), with the :80 listener bound but idle.

### Scene import bench

- [ ] **Import from a frame that ran standalone first** (`scenes_get` + the
  importer, `docs/cloud-frames.md` "Scenes the frame already had"): the
  scenes land, the one on screen stays there, and an album scene keeps its
  place after the push. So far covered by Nim, hub and auth-web tests
  against a fake device only.
