# FrameOS ESP32 firmware

FrameOS for ESP32-S3 microcontrollers. The firmware provisions Wi-Fi over a
captive portal or the serial console, renders scenes **on-device** with the Nim
runtime (pixie in PSRAM), drives Waveshare SPI e-ink panels through the same
vendor drivers the Raspberry Pi build uses, and can alternatively run as a thin
client fetching backend-rendered bitmaps.

Reference hardware: ESP32-S3 module with 8MB flash and 8MB+ octal PSRAM.
The default 8MB profile supports OTA updates with two 3520K app slots and a
1M SPIFFS state partition for scenes/user data. FrameOS also ships explicit
4MB, 16MB, and 32MB profiles. The 4MB profile has no OTA support because it
uses a single app slot to leave room for the firmware and state partition.

## Layout

```
main/                     boot orchestration + platform modules
  main.c                  app_main: config → display → wifi/portal → http → render loop
  fos_config.c            NVS config store (wifi, backend, panel, pins, intervals)
  fos_wifi.c              STA connect, SoftAP portal, DNS hijack, SNTP
  fos_http.c              esp_http_server route layer (portal + /status + actions)
  fos_client.c            render loop: Nim local render or thin-client fetch → blit
  fos_ota.c               OTA manifest check + esp_https_ota when an OTA partition exists
  fos_cloud.c             cloud-managed frames: claim-token enrollment + management WS
  fos_console.c           serial REPL (UART0 + USB-Serial/JTAG): status / set / wifi / render / ota / ...
  fos_defaults.h          compile-time defaults; generated_config.h (from the
                          backend's per-frame build) overrides them
components/
  frameos_display/        DEV_Config on ESP-IDF (spi_master/gpio, runtime pin remap);
                          one selected root Waveshare EPD_*.c symlinked at
                          configure time and wrapped from generated metadata
  frameos_nim/            the FrameOS Nim runtime compiled to C (see build_nim.sh);
                          builds a stub when nimcache/ is absent
partitions_4mb.csv        4MB: nvs + phy + factory app + 512K state; no OTA
partitions.csv            8MB: nvs + otadata + phy + ota_0/ota_1 (3520K each) + 1M state
partitions_ota_16mb.csv   16MB: nvs + otadata + ota_0/ota_1 (4032K each) + 8M state
partitions_ota_32mb.csv   32MB: nvs + otadata + ota_0/ota_1 (4032K each) + 24M state
build_nim.sh              nim c --compileOnly --os:freertos --cpu:esp → nimcache/
```

## Toolchain

Requires [ESP-IDF](https://docs.espressif.com/projects/esp-idf/) v5.5.x:

```bash
mkdir -p ~/esp && cd ~/esp
git clone --depth 1 --branch v5.5.4 --recursive --shallow-submodules \
  https://github.com/espressif/esp-idf.git
cd esp-idf && ./install.sh esp32s3,esp32c3
```

The backend finds the toolchain via the `IDF_PATH` env var, falling back to
`~/esp/esp-idf`. The on-device Nim runtime additionally needs `nim` (>= 2.2) on
the worker's PATH; without it the firmware builds in thin-client-only mode.

The FrameOS Docker image includes ESP-IDF at `/opt/esp/esp-idf`, native ESP-IDF
host tools under `/opt/esp/idf-tools`, and the Nim toolchain, so firmware builds
started from the packaged backend run inside the container without mounting a
separate host toolchain.

Backend builds put their `build-<platform>-<flash>/` directories next to this
README. `FRAMEOS_EMBEDDED_BUILD_ROOT` moves them elsewhere — the Docker
entrypoint points it at a volume (`/data` under the Home Assistant add-on,
`/app/db` otherwise), because a build directory on the container's writable
layer is discarded on every restart and a cold build is ~1300 objects. The same
entrypoint parks `CCACHE_DIR` there; `ccache` on the worker's PATH is enough for
the backend to enable it, and it is what makes a second frame's image cheap.
A slow host is worth checking before assuming a build has wedged: progress
reaches the frame log as `Compiling firmware: N/M`.

## Build and flash by hand

```bash
. ~/esp/esp-idf/export.sh
./build_nim.sh             # compile the Nim runtime to C (optional but recommended)
idf.py set-target esp32s3
FRAMEOS_SELECTED_PANEL=EPD_7in5_V2 idf.py reconfigure build
# reconfigure picks up new nimcache/generated_config.h. Every supported panel
# driver is compiled in; FRAMEOS_SELECTED_PANEL only sets the boot-time
# default panel (optional — `set panel <key>` switches at runtime).
idf.py -p /dev/tty.usbmodem* flash monitor
```

Or flash the single merged image produced by `idf.py merge-bin` (what the backend
serves and the browser flasher writes):

```bash
esptool.py --chip esp32s3 --port /dev/tty.usbmodem* --baud 460800 --flash_size 8MB write_flash 0x0 merged-binary.bin
# Use --flash_size 4MB, 16MB, or 32MB when building one of those profiles.
```

**App-only flashes: the app offset depends on the partition table, and a
wrong offset fails silently.** An 8 MB layout (`partitions.csv`) puts ota_0
at 0x10000; the 16 MB layout (`partitions_ota_16mb.csv`) puts it at 0x20000.
`write_flash` to the wrong offset lands mid-partition, the image is never
found, and the bootloader silently keeps running the *old* app from the
other slot — esptool reports "Hash of data verified" either way. This once
cost a full day of benchmarking two "different" firmwares that were the same
untouched binary. After every flash, check the boot log for
`boot: Loaded app from partition at offset ...` and confirm the slot;
`esp_image: image at 0x10000 has invalid magic byte` means the write went to
the wrong offset.

**Serial drops output during CPU-bound bursts.** The USB-Serial/JTAG console
loses lines while `fos_client` holds the CPU — a cold boot's transpile
window comes back as a multi-second gap with corrupted joins
(`MEMMEMPROBE`, `MEMrender`). Absence of a probe line is not evidence the
probe did not fire; read with a tight poll loop and expect to repeat the
capture.

CI uses the same full-image path, including Nim runtime generation, ESP-IDF
`build merge-bin`, partition/size checks, and an optional QEMU boot smoke:

```bash
FRAMEOS_ESP32_QEMU=1 bash embedded/esp32/ci_build_image.sh
```

With `FRAMEOS_ESP32_QEMU=1`, the script adds `sdkconfig.qemu.defaults` to route
logs to UART0 only and avoid QEMU's PSRAM path; the default build profile
keeps octal PSRAM and both consoles. The QEMU smoke verifies that the
bootloader selects `ota_0` and ESP-IDF starts the `frameos_esp32` app image;
when QEMU reaches `app_main`, the script reports that stronger signal too.

## Chip targets and supported boards

Two chip targets build from this project:

- **ESP32-S3** (default): the full firmware, including the on-device Nim/pixie
  renderer and QuickJS. Needs a module with PSRAM for local rendering.
- **ESP32-C3**: thin-client-only firmware for PSRAM-less boards
  (`FRAMEOS_ESP32_PLATFORM=esp32-c3 ./ci_build_image.sh`, or backend builds
  for a frame whose platform is `esp32-c3`). ~380 KB of usable SRAM rules out
  the local renderer; the backend renders the frame's scenes server-side in
  the wasm scene runtime (`backend/app/utils/embedded_render.py`) and the
  device blits the packed bitmap.
  Built with the 4 MB no-OTA layout so one image fits every supported C3 board.

Known boards ship as hardware presets (`set hardware <preset>` on the console,
or the preset dropdown in the frontends — the authoritative table is
`EMBEDDED_HARDWARE_PRESETS` in `backend/app/tasks/embedded_firmware.py`):

| Preset | Chip | Panel | Notes |
| --- | --- | --- | --- |
| `waveshare_esp32_s3_photopainter` | S3 | EPD_7in3e 7.3" Spectra | PMIC power-up, TF socket |
| `waveshare_esp32_s3_epaper_13_3e6` | S3 | EPD_13in3e 13.3" Spectra | dual CS, TF socket |
| `trmnl_og` | C3 | EPD_7in5_V2 7.5" mono | TRMNL OG; battery GPIO3 ÷2 |
| `trmnl_bwry` | C3 | EPD_7in5yr 7.5" BWRY | TRMNL BWRY; battery GPIO3 ÷2 |
| `trmnl_og_diy_kit` | S3 | EPD_7in5_V2 | Seeed XIAO ePaper Driver Board; battery GPIO1 ÷2, switch GPIO6 |
| `trmnl_4in26_diy_kit` | S3 | EPD_4in26 4.26" | Seeed XIAO ePaper Driver Board; battery GPIO1 ÷2, switch GPIO6 |
| `xteink_x4` | C3 | EPD_4in26 4.26" | XTEINK X4 reader; TF shares EPD SPI, SD assets off; battery GPIO0 ÷2 |

Board facts worth knowing before reading a schematic (from the Waveshare docs),
for the two Spectra boards most of the bench work runs on:

- **13.3E6** — 32 MB flash, 16 MB PSRAM, TF slot on SPI3, MX1.25 battery
  header. The charge IC is an ETA6098, *not* an I2C PMIC, but VBAT is on
  **ADC1_CH7 = GPIO8 through a 1/3 divider** (Waveshare's own `01_ADC_Test`
  examples read CHANNEL_7 and multiply the calibrated voltage by 3), so
  `battery_pin 8` + `battery_divider 3` gives voltage telemetry; the backend
  preset bakes both. No RTC chip. No user buttons: BOOT and Reset only,
  which is why GPIO wake has nothing to wake on. Internal RAM on 2026.8.17
  firmware idles at **~103 KB free** (47 KB largest block) with a scene
  resident and the cloud link up — the old ~16-19 KB figure predates the
  PSRAM Nim heap and one-file-per-scene. `set api_key ""` clears a stored
  key (the console's empty-value convention covers it now).
- **PhotoPainter 7.3"** — 8 MB PSRAM, PMIC power-up, TF socket, and a KEY
  button next to BOOT (`0:BOOT`, `4:KEY1` in the preset's `gpio_buttons`).
| `seeed_reterminal_sticky` | S3 | EPD_3in97 3.97" | reTerminal Sticky, 32MB flash |
| `seeed_reterminal_e1001` | S3 | EPD_7in5_V2 7.5" mono | reTerminal E1001, 32MB flash; battery GPIO1 ÷2, switch GPIO21 |
| `seeed_reterminal_e1002` | S3 | EPD_7in3e 7.3" Spectra | reTerminal E1002, 32MB flash; battery GPIO1 ÷2, switch GPIO21 |
| `seeed_reterminal_e1004` | S3 | EPD_13in3e 13.3" Spectra (T133A01 tuning) | reTerminal E1004, 32MB flash, 8MB PSRAM — renders on-device on the 16-bit canvas |
| `elecrow_crowpanel_5in79` | S3 | EPD_5in79 5.79" 4-gray | CrowPanel, dual SSD1683 |

The TRMNL X (10.3" 1872×1404 parallel e-ink over EPDIY/FastEPD) is not yet
supported — it needs a parallel display driver class this component does not
have.

## First boot and provisioning

Unprovisioned devices start a captive portal: join the `FrameOS-XXXX` Wi-Fi network
and any page redirects to the setup form (Wi-Fi, backend URL, frame ID/API key,
panel, render mode). Backend-built images arrive fully provisioned via
`main/generated_config.h`, including Wi-Fi from the frame's per-frame `network`
settings (the same place the Pi flows keep it) and optional native HTTPS using
the same per-frame certificate material as Raspberry Pi Caddy proxies.

The serial console (115200) is always available and quicker for development.
It answers on whichever USB port the board brings out: the chip's own
USB-Serial/JTAG device ("USB JTAG/serial debug unit" — XIAO ESP32-S3) and
UART0 behind an on-board USB-UART bridge ("USB Single Serial" — the Seeed
reTerminal E10xx wire USB-C to a CH340 on UART0 and leave the chip's USB pins
unconnected; the PhotoPainter 13.3" has both). `sdkconfig.defaults` makes
UART0 the primary console and USB-Serial/JTAG the secondary: stdout reaches
both, and `fos_console.c` reads commands from both drivers. GPIO 43/44 (U0TXD/
U0RXD) are therefore off-limits for panel or button pins.

```
frameos> status
frameos> wifi MySSID MyPassword          # saves and reboots
frameos> set panel EPD_7in5_V2
frameos> set pins rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1
frameos> set render_mode local           # or: remote (thin client)
frameos> set deep_sleep 1                # battery mode: deep sleep between refreshes
frameos> set wake_schedule 1             # align wake to wall-clock interval boundaries
frameos> set battery_pin 2               # ADC1 GPIO tapping VBAT (-1 = none)
frameos> set battery_divider 2.0         # Vbat = Vpin * divider
frameos> render                          # render immediately
frameos> ota                             # check for an OTA update now
frameos> factory-reset
```

## Self-hosted provisioning (no per-frame build)

A self-hosted backend can flash a blank board two ways, and the deploy
drawer's firmware card offers both:

* **Flash latest release** writes the published *generic* image
  (`frameos-<version>-esp32-{s3,c3}-generic.bin`) and then sends this frame's
  settings over the USB console. Nothing has to be compiled.
* **Flash from browser** compiles a per-frame image with those settings baked
  into `main/generated_config.h`. The first build of a chip target is ~1100
  ESP-IDF objects — tens of minutes on a NUC, over an hour on a Home
  Assistant box.

The two produce the same frame because every panel driver is compiled into
every image and each baked value has a `set` key here. The command list the
first path replays comes from the backend (`embedded_provisioning_plan` in
`backend/app/tasks/embedded_firmware.py`), built from the same helpers that
generate the header, so the two cannot drift. By hand it is:

```
frameos> set hardware xteink_x4          # board bundle FIRST: panel, wiring, buttons, TF socket
frameos> set panel EPD_4in26             # then anything the frame overrides
frameos> set pins rst=5,dc=4,cs=21,cs2=-1,busy=6,sck=8,mosi=10,pwr=-1
frameos> set backend http://10.0.0.5:8989
frameos> set api_key <the frame's server_api_key>
frameos> set frame_id 9
frameos> wifi MySSID MyPassword          # saves and reboots
```

Four things exist only as compile-time defaults, because the console has no
key for them: the DHCP hostname, the HTTP response limit, the device's own
TLS certificate, and the device admin login. A frame that terminates TLS is
refused by the release path (its backend could not fetch from it); the rest
are reported as warnings on the button.

## Cloud enrollment (cloud-managed frames)

Generic firmware can enroll directly with a cloud provider (enrollment flow A
in `docs/cloud-frames.md`) instead of — or before — being paired with a
self-hosted backend. The browser flasher provisions `cloud_url` and
`claim_token` into NVS over the USB serial API after flashing; by hand it is:

```
frameos> set cloud_url https://cloud.frameos.net
frameos> set claim_token FRCT_...        # single use, never echoed back
frameos> wifi MySSID MyPassword          # saves and reboots
frameos> status                          # cloud: pending → enrolled
```

Once Wi-Fi is up, the device generates an Ed25519 keypair (vendored
Monocypher; the 32-byte seed lives in NVS key `cloud_sk` and is never
printed), POSTs `{cloud_url}/api/frames/enroll`, and on success persists the
access token / frame id / WS path (NVS `cloud_token` / `cloud_fid` /
`cloud_ws`) and erases the claim token. A `400` response (invalid, expired,
or already-used token) also erases the claim token — it is dead after one
use — and `status` shows `cloud: error` plus a `cloud_error:` detail line
until a fresh token is set. Transient failures retry with exponential backoff
(10 s → 15 min).

Expected `status` line while waiting for enrollment:

```
cloud:       pending url=https://cloud.frameos.net claim_token=(set) ws=off
```

and after enrollment (`GET /status` carries the same data under `"cloud"`):

```
cloud:       enrolled url=https://cloud.frameos.net claim_token=(none) frame=… ws=connected
```

`cloud_url` must be `https://`; plain `http://` is accepted only for
localhost, `.local`/`.localhost` names and private-network literals, so a
typo cannot silently ship the claim token and bearer token in the clear.
`set cloud_url` rejects anything else outright, and the enrollment/WS paths
refuse to dial it.

When enrolled, the firmware dials the management WebSocket
(`esp_websocket_client` managed component) and runs the
hello/challenge/auth/ready handshake, signing the base64-**decoded** nonce
bytes with the device key. Implemented verbs: `get_state`, `render`,
`reboot`, `restart_runtime` (same as reboot on ESP32), `set_current_scene`,
`set_scenes` (stored through the same interpreted-scene path as
`usb_api upload-scenes`; `scene_ack` is sent only after the render task has
actually hot-loaded the payload), `set_settings` (the `interval`/`name`
subset), `image_get` (the packed framebuffer as BMP, built a row at a time
straight off the boot-time framebuffer reservation — since 2026.8.43 the
preview snapshot borrows that buffer instead of copying it, and the stream
allocates one 24 KiB chunk, so an 8 MB board with a 960 KB panel can finally
serve one; an `image_get` that arrives before the wake's render waits for it,
and the deep sleep holds while the stream goes out), and the full asset verb
set — `assets_list`,
`asset_get`, `asset_put`, `asset_mkdir`, `asset_delete`, `asset_rename` —
against the mounted SD card (shared implementation in `main/fos_assets.c`,
also behind the local HTTP asset API and the `usb_api` asset commands).
Write-verb acks are sent after the SD write finishes. Log shipping is
implemented behind the `telemetry:logs` scope, with `get_logs` replaying the
on-device ring (last 128 lines); `get_metrics` returns the newest metrics
sample and the device pushes a `metrics` message after each render pass when
`telemetry:metrics` is granted (with `onBattery`, the same cell-present test
the deep-sleep decision uses). A deep-sleeping frame sends a `sleep` message
(`wake_in_seconds`, `next_render_at`, `reason`, `wake_check`) synchronously
right before `esp_deep_sleep`, so the provider can show "asleep · wakes in
5 min" and drop the socket at once instead of waiting for a missed
heartbeat. `set_schedule` stores the schedule to
`/state/schedule.json` and `main/fos_schedule.c` evaluates it once per
wall-clock minute on the render task (same event model as the Pi
scheduler: minute/hour/weekday 0=daily 1-7 8=weekdays 9=weekends), in
frame-local time via a backend-supplied UTC offset. The one documented
verb outside this profile — `notify_update_available` — is acked
`unsupported_verb`; anything not in the protocol is acked `unknown_verb`.
Both are logged.

Redials use jittered exponential backoff (5 s → 5 min), and three consecutive
authentication rejections (HTTP 401 on the upgrade, or a 4401 close) demote
the device back to standalone: the access token, frame id and WS path are
dropped from NVS, the device key is kept, and the last pushed scenes keep
rendering. `factory-reset` erases all cloud state, including the device key.

A single management WebSocket message is capped at **512 KiB** (the same
ceiling as the on-device scene store); larger frames are dropped and acked
`message_too_large`.

Secrets at rest: `cloud_sk` (the Ed25519 seed), `cloud_token`, the unspent
claim token and the WiFi PSK live in NVS in plaintext unless the board is
provisioned with ESP-IDF flash encryption. The firmware never prints or
echoes them, but physical access to an unencrypted module means physical
access to the link — see the "Secrets at rest on ESP32" note in
`docs/cloud-frames.md`.

## Power management (M4)

`deep_sleep` powers the chip down between refreshes; with a panel attached the
render task calls `esp_deep_sleep` and the device cold-boots for the next pass.

`wake_schedule` changes how the sleep duration is computed: with a synced clock
it aligns the wake to wall-clock interval boundaries (a 1h frame wakes at the
top of the hour, a 5-minute frame on :00/:05/...), so clock faces update on
time. Without it (or before SNTP syncs) the time already spent awake this cycle
— boot, Wi-Fi, render — is subtracted from the interval so the cadence doesn't
drift by however long a render took.

`deep_sleep_on_battery` deep-sleeps between refreshes only while a battery is
detected on `battery_pin` (cell voltage above ~2.5 V — the best power-source
signal we have; no supported board exposes VBUS on a readable pin, so a
plugged-in-and-charging frame counts as "on battery" too, which just means it
sleeps while charging). Without a configured battery pin the flag never fires
and the frame stays connected.

`wake_check` (seconds, 0 = off, floored to 60) makes a deep-sleeping frame
wake at least this often to check the control plane for queued commands. The
scheduled render's due time survives the reboot in RTC memory, so a check-in
wake connects, applies whatever is queued (`set_scenes`, `set_settings`,
schedules, OTA nudges — each arriving cloud verb holds the device awake for
15 s so a burst completes) and goes back to sleep **without** refreshing the
panel; an explicit `render` command still repaints immediately. Before any
deep sleep a cloud-enrolled frame also holds the boot open up to 20 s for the
management socket, so queued commands are not lost to a race with the sleep.

**Wake on button (2026.8.42).** Right before `esp_deep_sleep` every
registered `gpio_buttons` pin that sits on a wake-capable pad — an RTC IO
(GPIO 0-21) on the ESP32-S3, GPIO 0-5 on the ESP32-C3 — is armed as a wake
source (`ext1` any-low on the S3, `esp_deep_sleep_enable_gpio_wakeup` on the
C3; the RTC_PERIPH domain stays powered so the internal pull-ups hold), next
to the timer. A press brings the frame back early: the boot notes which pin
woke it (`fos_buttons_wake_boot`), replays the press to the scene as the usual
`button` event (`"wake": true`) on the first render pass, and that pass
renders instead of counting as a command check-in. A key still held at the
moment of sleep is skipped for that sleep only (any-low would wake the chip
instantly). `buttons:listening` lists `"wake"` per pin, the `sleep` line
lists `wakeButtons`, `status` prints `wake_on_button`, and the `metrics`
sample carries `wakeCause` (`timer` / `button` / `power_on` / `restart` /
`panic` / `watchdog` / `brownout`) so a battery graph can be read against
what actually woke the frame. The pure pin arithmetic is `fos_wake.c`, host
tested by `main/tests/test_fos_wake.c`.

**What a deep-sleep wake costs, and what 2026.8.42 trimmed.** Measured on a
reTerminal E1004 (1200×1600 Spectra 6) on battery with a 15-minute weather
scene: a few seconds of boot + Wi-Fi + cloud session, ~23 s scene render,
~22 s dither + pack, ~30 s panel refresh, then sleep — roughly 80-90 s awake
per 900 s, with the radio listening the whole time. Three things changed:

- **Wi-Fi modem sleep** (`WIFI_PS_MIN_MODEM`) is on whenever `deep_sleep` or
  `deep_sleep_on_battery` is set. The radio used to run with power save
  disabled for the whole wake (~80-100 mA on an S3); DTIM-paced listening
  costs a little throughput and a few ms of latency, which a frame that spends
  its wake dithering and waiting on BUSY never notices. Stay-connected frames
  keep power save off for their local HTTP API.
- **No SNTP wait on a deep-sleep wake.** The RTC keeps the clock through the
  sleep (and the wake timer runs on the same oscillator, so the wake-check
  bookkeeping agrees with it); SNTP now corrects it in the background instead
  of holding the boot for a round trip — or the full 10 s timeout on a slow
  pool.
- **The log queue drains before the CPU halts.** Everything logged after the
  panel refresh — `render:done`, the `metrics` sample with the battery
  reading, the `sleep` forecast — is queued for the cloud task's 1 s batch
  tick, and `esp_deep_sleep` used to come first: a v2026.8.40 frame shipped
  not one battery sample in 20 hours of cycles. The sleep now waits up to
  2.5 s for the log queue to empty **and** the pass's `metrics` sample to be
  pushed (`fos_cloud_flush_logs`) before announcing the sleep (the hub drops
  the socket on `sleep`). A deep-sleep frame samples metrics exactly once per
  wake, at the end of its pass (after the render and the panel refresh, so
  `renderLastMs` is this wake's); that one sample is now delivered every
  cycle instead of winning a race with the sleep.

The pass-start power decision (2026.8.43, `fos_power.c`, host-tested by
`main/tests/test_fos_power.c`) reads the cell twice a moment apart and keeps
the higher burst, then weighs it against the last believed reading kept in
RTC memory: a cell that was there a pass ago survives one implausible
reading (two consecutive sub-2.5 V reads mean "no cell"), "critical" takes
two consecutive passes below 3.2 V, and a critical cell always deep sleeps
under `deep_sleep_on_battery` — it is a battery by definition. Before this,
one 16-sample ADC burst reading "0 %" on a 3.9 V cell both parked the frame
in the six-hour critical sleep and, because a sub-2.5 V reading also meant
"no cell", switched deep sleep OFF, so the frame sat awake with the radio on
for nine hours (E1004, 2026-08-27). Every pass now logs a `power` line —
`deepSleep` (`battery` / `always` / `critical` / `off`), `onBattery`,
`wakeCheckSeconds`, the millivolts read and, when they differ, the
millivolts believed (`suspect: true`) — so "deep sleep silently off" and
"the owner switched it off" are told apart in the cloud log; a settings
push or poll that changes anything logs `settings:cloud` / `settings:sync`
`applied` with the keys and values that changed.

A pass that ends in an awake hold (a verb arrived, `keep_awake`) no longer
renders again when the hold ends: the next panel refresh's due time is kept
for every wait, so the follow-up pass checks in and sleeps until it. And
the SNTP sync flag is also set from the sync callback: a pool that answered
after the boot-time wait used to leave the whole boot "unsynced" — hub-stamped
logs, no wake-check schedule — for as long as the frame stayed up.

The sleep also **holds for a running OTA** (up to 15 min): the
`notify_update_available` verb only keeps the frame awake 15 s while the
download takes minutes, so a battery frame used to halt mid-download every
wake, boot the old image, be told again, and loop — with nothing in the log
but `ota:cloud downloading`. The cloud OTA now logs `progress` every 512 KB,
names its failure (`download-failed:<err>@<bytes>/<expected>`,
`image-rejected:<err>`, `signature-rejected`), and after 3 consecutive
failures of one offered version stops re-downloading it (`gave-up`, kept in
RTC memory: a newer release or a power cycle resets it).

**The follow-ups the same log asked for (2026.8.42).**

- **Dither + pack.** `forEachPaletteDithered` (utils/dither.nim) now copies the
  palette into flat int arrays and searches it inline, walks its error rows
  through unchecked pointers, reads a canvas row straight from the buffer
  (`rgb565ToRgbx` on a 565 canvas), and keeps those rows in internal SRAM
  (`fos_nim_internal_alloc`, PSRAM seq fallback). The four pack procs in
  embedded_main.nim compile with bounds/overflow/range checks off and GCC's
  `optimize("O2")` attribute while the rest of the image stays `-Os`. Output
  is bit-identical (the reference-equivalence suite in
  utils/tests/test_dither.nim covers RGBX, 565 and views); the on-device gain
  is read from the next `dither+pack` log line — a laptop runs the old loop
  at 40 ns/pixel, so the 11 µs/pixel on the S3 is the build, not the maths.
- **Service settings survive a reboot.** Cloud-only frames keep the six
  groups in NVS (`svc_cache` / `svc_etag` / `svc_at`, same namespace as the
  bearer token) and apply them before the first render
  (`fos_settings_boot_apply_cache`, `settings:services origin=cache`). A
  deep-sleep frame used to render its only pass with no service settings —
  `ready` asks for the pull after the pass has started, and the pass that
  would pull never comes — and every boot that did pull paid a full TLS
  handshake for a body that rarely changes. `ready` now skips the pull while
  the copy is under 6 h old; the queued `refresh_service_settings` nudge, a
  `403 insufficient_scope`, a demotion and `factory-reset` all clear or
  refresh it.
- **`cloud:session_ready` says how the previous session ended**
  (`previousClose: {how, code}`, plus `session` count and `uptimeSeconds`):
  the E1004 redialed 17 s into some wakes with nothing logged between, and
  the close code only ever went to the USB console.
- **The emergency-reserve line names the request**: `a N-byte request with
  F bytes free, largest block L` — a shortage and a fragmentation dip look
  the same without it. The 1200×1600 Weather render dips every pass with
  2.3 MB free before it; the size is what identifies the allocation.

`battery_pin` enables battery sensing on an **ADC1** GPIO (ADC2 conflicts with
Wi-Fi). The reading is divider-corrected (`battery_divider`, default 2.0 for a
100k/100k tap), mapped to a percentage via a Li-ion curve, and reported in
`status` and `GET /status`. Below 3% the render + panel refresh is skipped and
the device sleeps 6h to keep a low cell from being cycled down to damage. The
integrated-board hardware presets carry known battery wiring (see the Notes
column of the preset table: the Waveshare 13.3" E6 taps VBAT on GPIO 8 through
a 3.0 divider; the reTerminal E-series, the XIAO ePaper Driver Board, the
TRMNL OG/BWRY and the XTEINK X4 use a 2:1 divider, on the Seeed boards behind
a load switch that `battery_enable_pin` pulses around each read). Applying a
preset (`set hardware`, or the preset in the frontends) seeds these; a frame
provisioned before its preset knew the wiring keeps `battery_pin -1` until the
three values are set — over the console, or in the frame's "Power" settings.
The backend can bake them in per-frame via `device_config`: `deepSleep`,
`deepSleepOnBattery`, `wakeSchedule`, `wakeCheckSeconds`, `batteryPin`,
`batteryDivider`, `batteryEnablePin` — and the cloud can set the same live
over `set_settings` (`deep_sleep`, `deep_sleep_on_battery`,
`wake_check_seconds`, `battery_pin`, `battery_divider`, `battery_enable_pin`),
surfaced as the frame's "Power" settings section.

## Scene storage and memory (2026.8.13)

Scenes arrive as one combined `scenes.json` — from the USB upload, the
backend sync or the cloud's `set_scenes` — and that stays the wire format.
The device does **not** keep them that way. On apply the payload is split
into `/state/scene-<slot>.json` plus `/state/scene-index.json`, the combined
file is deleted (the `state` partition is 1M and a payload may be 512K, so
both do not fit), and only the **active** scene is parsed and resident. The
index carries ids, names and refresh intervals, so the frame can list and
switch scenes without holding them. It also carries a top-level
`"source": "local" | "backend" | "cloud"` key recording who installed the
payload (missing = `local` on pre-upgrade stores); `fos_cloud.c` keys the
private-network egress deny on it, so provider-pushed scenes stay fenced off
the owner's LAN even after the frame is demoted from cloud management. The
source is mirrored in NVS so it survives the store→apply window across a
reboot.

Slot numbers rather than scene ids, because `CONFIG_SPIFFS_OBJ_NAME_LEN` is
32 and a scene id is a 36-character uuid: `/<uuid>.json` cannot be opened at
all. The id ↔ slot mapping lives in the index. Every failure path (an
unsplittable payload, more than 32 scenes, a full partition) falls back to
loading the combined file whole, so a frame cannot lose its scenes to a
failed optimization.

## The render canvas is 16-bit (2026.8.31)

The canvas format is decided per board (`fos_render_canvas_bytes_per_pixel`
in `components/frameos_display`): **RGBX when a full canvas takes at most
half the module's PSRAM, else 16-bit RGB 5/6/5.** The 800×480 boards (1.5 MB
of 8 MB) and a 1200×1600 panel on a 16 MB module (7.3 MB) render in full
colour; **1200×1600 on an 8 MB module is the one that needs 565** — RGBA is
7.3 MiB and does not fit, 565 is 3.7 MiB and does
(`fos_display_render_psram_bytes`: canvas + packed + 1.5 MiB reserve =
6.1 MiB). 565 is not free of cost even though the dither keeps its error
rows at full precision (`forEachPaletteDithered` / `forEachGrayDithered` in
`frameos/src/frameos/utils/dither.nim`): rounding every stored pixel to 5/6
bits turns a smooth gradient into plateaus — a 480-row sky keeps 11 blue
levels of 90 — and the diffusion pass prints the plateau edges as bands
(seen on the 7.3" weather scene, 2026-08-23). So a 565 canvas stores with
pixie's per-pixel dither (`Image.ditherStores`, hashed rounding offsets,
idempotent for exact colours), which brings the gradient back at no memory
cost: 88 row-mean levels against RGBX's 90 on the same sky.

The canvas is also **one block for the device's uptime**: `main.c` calls
`frameos_nim_reserve_canvas(fos_display_canvas_bytes())` right after the
fit check and before `fos_wifi_init`, so the multi-MB contiguous run exists
before Wi-Fi and TLS fragment the heap, and `embedded_runtime.nim`'s
`renderCanvas()` wraps it with `newImage565Over` and reuses it every render.
Nothing aliases the canvas across renders (the value pipeline never caches
the live canvas), so reuse is safe, and the per-render allocate/collect
churn is gone. `-d:frameosCanvasRgbx` / `-d:frameosCanvas565` in
`FRAMEOS_EXTRA_NIM_FLAGS` force a format for A/B measurement. The Pi runtime and the wasm preview are
untouched and keep full RGBA.

Two allocation facts worth knowing before profiling anything here:

- The Nim heap allocates from PSRAM explicitly (`fos_nim_heap_malloc` in the
  glue). Plain `malloc` would not: `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL` is
  16384, so everything smaller than 16K comes from the ~300K internal pool,
  which is also where Wi-Fi, lwIP and TLS allocate. That is why a frame with
  many scenes could render happily and still be unable to open a TLS
  connection.
- QuickJS allocates from PSRAM too (`fos_js_new_runtime` in the
  `frameos_quickjs` component installs `JSMallocFunctions` backed by
  `heap_caps_malloc(MALLOC_CAP_SPIRAM)`). cJSON still uses libc `malloc`, so
  it lands in internal RAM; the scene splitter deliberately avoids cJSON on
  the large payload for that reason, scanning bracket depth over the raw
  bytes instead.
- What is left in internal RAM is the firmware's own footprint: FreeRTOS task
  stacks (the `fos_client` render task alone is 40 KB, and it must stay
  internal because it writes NVS — a PSRAM stack asserts inside the flash
  driver), Wi-Fi and lwIP, the WebSocket client's task and buffers, SPIFFS.
  A healthy S3 frame idles around 80–90 KB free with a 40–50 KB largest
  block, flat across renders; that number is the same with one scene or
  twenty, because only the active scene is resident (see the lazy path
  above).

The cloud link refuses to dial below 24K free internal with a 12K contiguous
block (`FOS_CLOUD_WS_MIN_INTERNAL_*`, floors for starting a session — the
mbedTLS side is in PSRAM) and says so in `status` and the logs, rather than
failing inside esp-tls as a connection reset. `frontend/src/utils/frameMemory.ts`
mirrors these numbers for the workspace banner; change both.

## Memory guardrails (M4)

The on-device renderer composites into an RGBA pixie buffer (4 B/px), packs it
to the selected panel format (1bpp, dual 1bpp, 2bpp gray/color, or 4bpp
palette/gray), and needs headroom for the Nim heap + QuickJS. At boot the
firmware compares that requirement against the module's PSRAM
(`fos_display_render_psram_bytes` vs `heap_caps_get_total_size`) and, if the
panel won't fit, refuses to start the local renderer and falls back to
thin-client mode. Backend local-render builds run the same check
(`check_embedded_panel_fits_memory`, module size from `device_config.psramMB`,
default 8MB) and fail early with an actionable error; backend-rendered
thin-client builds are allowed for panels that exceed local PSRAM.

**Thin clients reserve their framebuffer at boot.** A PSRAM-less board (every
supported ESP32-C3) has no second heap to put the packed panel buffer in, so
`fos_big_malloc` lands it on internal RAM — and an XTEINK X4 asking a
Wi-Fi-fragmented C3 heap for 96000 contiguous bytes fails with six figures
still free. `fos_framebuffer_reserve()` therefore takes that buffer once in
`app_main`, right after the panel is known and before the network stack
starts, and `fos_framebuffer_acquire()/release()` lend the same pointer to
every full-frame call site (render, portal status screen, `display_test`).
Peak usage is unchanged; what changes is that the allocation can no longer
fail later. PSRAM boards skip the reservation and keep allocating per render.
The reservation is skipped, with a log line saying so, if it would leave less
than `FOS_FRAMEBUFFER_MIN_HEAP_AFTER_RESERVE` (96 KB) for Wi-Fi and TLS — a
frame that renders but cannot fetch is no better than one that retries.

**No image proxies, ever:** when a remote image source serves files too large
to decode on-device (e.g. multi-MB PNGs), the fix is a streaming decoder —
incremental inflate with row-by-row unfilter/scale into the render target, so
a decode needs the compressed body plus a few rows instead of a full-size
RGBA buffer. Never route the frame's downloads through the backend, and don't
lean on host-side resize params. Proxying has been built and reverted before;
do not build it again.

TODO: streaming PNG decode into target (`decodePngScaledInto` currently does a
full `decodePng` first — that is what OOMs on multi-MB PNGs under PSRAM
fragmentation; the gallery scenes hit this on the 13.3" Spectra-6 frame).

Default pins target the XIAO ESP32-S3: CS=GPIO3 (D2), DC=GPIO4 (D3), RST=GPIO5 (D4),
BUSY=GPIO6 (D5), SCK=GPIO7 (D8), MOSI=GPIO9 (D10). Remap at runtime with `set pins`,
in the portal, or per-frame via `deviceConfig.pins` in the backend. The 13.3-inch
Spectra 6 panel (`EPD_13in3e`) has two controllers and requires `cs2`.

`GET /status` reports the chip it is actually running on (`board.target` from
`CONFIG_IDF_TARGET`, `board.module` and `config.hardwarePreset` from the preset
the backend baked in). It also reports `memory.internalLargestBlock` next to
`internalFree`, because on a fragmented heap only the first of those explains
a failed allocation.

When connected, the device serves `GET /status` (heap/PSRAM/Wi-Fi/render stats JSON)
and `POST /api/action/render` / `POST /api/action/ota` on port 80. If
`https_proxy.enable` is baked into the image, the same API is also served over
native ESP-IDF HTTPS on the configured `https_proxy.port` (8443 by default).

## OTA

The default 8MB flash profile has an A/B OTA partition table: two 3520K app
slots (about 3.44MiB each) and a 1M `/state` SPIFFS partition at the end of
flash for scenes and other user data. The current size-tuned firmware fits in
either OTA slot, so devices can update through `esp_https_ota` instead of only
USB/browser flashing the merged image.

For other flash sizes, append the matching defaults file:

```bash
SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.4mb-no-ota" \
  idf.py reconfigure build

SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.16mb-ota" \
  idf.py reconfigure build

SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.32mb-ota" \
  idf.py reconfigure build
```

OTA profiles boot new images as "pending verify" (`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`);
the app marks itself valid once the network is up, otherwise the next reset rolls
back to the previous slot. The device polls `/api/frames/{id}/embedded/ota/manifest`
daily (or on `ota`) and applies new builds via `esp_https_ota`. The 4MB profile
has no OTA partition, so firmware updates must be flashed over USB.

## Adding a panel

1. Add or update the root Waveshare driver wrapper under
   `frameos/src/drivers/waveshare/...`. The ESP32 generator reads that metadata
   (`init`, `clear`, `display`, dimensions, color option) and symlinks every
   supported root C source/header into the IDF build tree.
2. If the wrapper is a native Nim port with a separate C fallback, add the source
   mapping to `components/frameos_display/generate_panel_table.py`.
3. If it introduces a new packed pixel layout, add the matching
   `fos_pixel_format_t`, backend FOSB packer, and Nim dither/pack path.
4. Bump `EMBEDDED_FIRMWARE_VERSION`.

Every supported panel driver is compiled into each firmware image
(`generate_panel_table.py` emits a runtime table of name, dimensions, format
and driver function pointers; ~75 KB of flash for all of them — the 4MB
no-OTA profile still has ~430 KB free). The active
panel is picked at runtime from the configured panel name, so switching panels
is `set panel EPD_13in3e` on the serial console (or the setup portal dropdown,
which lists the whole table) followed by a restart — no rebuild. Panels whose
symbols collide with a newer variant of the same family are excluded
(`EPD_7in5_V2_gray`, `EPD_4in2b_V2_old`, `EPD_7in5b_V2_old`), as are the
IT8951 and 12.48" controller stacks. `FRAMEOS_SELECTED_PANEL` (backend builds
set it from the frame's device) only chooses the boot-time default panel.
Published release images remain per flash-size profile, but one generic image
now covers all panels.
