# FrameOS Pico thin client

FrameOS for the Raspberry Pi Pico W (RP2040) and Pico 2 W (RP2350) — most
notably the Pimoroni Inky Frame family, which carries a Pico W (originals)
or Pico 2 W (2025 refresh) on the back of the panel.

## Why a thin client, on the Pico 2 W too

There is **no on-device renderer**, and on these boards there cannot be one.
The ESP32-S3 build runs Nim + pixie + QuickJS out of 8 MB of *memory-mapped*
PSRAM. A Pico W has 264 KB of SRAM. A Pico 2 W has 520 KB, and the 8 MB PSRAM
chip on the 7.3" Inky Frames does not change that: it hangs off a plain SPI
bus (CS on GP3, sharing SPI0 with the panel), and the Pico 2 W module does not
bring the RP2350's QSPI bus out, so that memory can never be mapped — it is a
slow block device, not RAM. An 800×480 canvas alone is 768 KB (RGB565) to
1.5 MB (RGBX), before a font cache or one QuickJS runtime.

So the control plane renders. The backend runs the frame's scenes in the real
FrameOS runtime compiled to wasm (`backend/app/utils/embedded_render.py`),
dithers and packs the result for the panel, and the board pulls it from
`/api/frames/{id}/embedded/render`. That is the ruling in
`docs/convergence-todo.md` §3 (boards below the capability line are thin
clients), and it is what makes **every scene work**: JS apps, SVG, fonts,
image decoding, scene state, rotation — none of it has to fit on the board.

Everything *else* an ESP32 frame does, this firmware does too:

| | |
| --- | --- |
| Provisioning from the browser | The frame's deploy panel downloads the UF2, then "Connect over USB" speaks the same `usb_api` protocol as the ESP32 and applies the frame's settings + Wi-Fi |
| Setup without a computer | No network to join → WPA2 hotspot `FrameOS-XXXX` with a captive-portal setup page; SSID, password and address are drawn on the panel |
| Settings that follow the frame | Pulls `/embedded/settings` (ETag'd) each pass: interval, name, deep sleep, device login |
| Device HTTP API | `/status`, `/logs`, `/image`, `/ping`, `/event/*`, `/api/action/*` — what the backend calls on an embedded frame — and `<hostname>.local` over mDNS |
| Logs | A log ring on the device, `usb_api logs`, `GET /logs`, and batched upload to the backend's log view (`bootup`, `render:*`, `metrics`, `wake`, `button`, `sleep`) |
| No wasted refreshes | The payload is hashed; an unchanged frame skips the 25-second refresh. The hash lives in a wear-levelled flash log, so it survives the power cut |
| Battery | RTC power-cut sleep between renders (~20 µA), always or only when off USB; wake on the interval or any front button |
| Inky Frame extras | Front buttons (press = render now, logged with its label), button/activity/connection LEDs, battery-backed clock seeded from SNTP |

What it does **not** have: OTA (2–4 MB of flash with no second slot — update
by UF2, `bootsel` makes that one click), a FrameOS Cloud link (the cloud
cannot render for thin clients yet, see "Limitations"), SD-card assets (the
scene runs on the backend, which has its own asset store).

## Supported hardware

| Preset | Board | Panel |
| --- | --- | --- |
| `pimoroni_inky_frame_4` | Pico W | 4.0" 640x400 7-color (EPD_4in01f class) |
| `pimoroni_inky_frame_5_7` | Pico W | 5.7" 600x448 7-color (EPD_5in65f class) |
| `pimoroni_inky_frame_7_3` | Pico W | 7.3" 800x480 7-color (EPD_7in3f class) |
| `pimoroni_inky_frame_7_3_pico2` | Pico 2 W | 7.3" 800x480 7-color (Dec 2024 refresh) |
| `pimoroni_inky_frame_7_3_spectra` | Pico 2 W | 7.3" 800x480 Spectra 6 (Aug 2025+, black top border) |

Bare Pico W/2W boards wired to a supported panel work too: `set pins …` and
`set panel …` over the console instead of a preset.

Two render paths, chosen at build time by whether a frame fits in RAM
(`PK_FRAMEBUFFER_BYTES`, `src/pk_render.h`): the **Pico 2 W buffers** the
192 KB payload first — a dropped connection never leaves the controller half
written, an unchanged frame never even powers the panel, and `GET /image`
serves what is on the glass — while the **Pico W streams** segments from the
socket straight into the controller and ends without the refresh command when
the hash matches.

## Build

Requires [pico-sdk](https://github.com/raspberrypi/pico-sdk) 2.x, CMake,
Ninja, and an `arm-none-eabi` GCC with newlib (the official Arm GNU
toolchain; Homebrew's bare `arm-none-eabi-gcc` formula lacks `nosys.specs`):

```bash
cmake -B build -DPICO_BOARD=pico2_w -DPICO_SDK_PATH=$HOME/pico-sdk -G Ninja
cmake --build build
# → build/frameos_pico.uf2   (use -DPICO_BOARD=pico_w for the Pico W)
```

Releases carry `frameos-<version>-pico-w.uf2` and `frameos-<version>-pico-2w.uf2`
(signed like every other release asset); the backend lists and serves them.

### Host tests

The portable half of the firmware — every parser, the log ring, the hotspot's
DHCP and DNS, the flash state log, the status screen, the BMP writer — has no
SDK includes and runs on the host under ASan + UBSan:

```bash
make -C tests            # CC=/usr/bin/clang on macOS if your cc has no sanitizers; or SANITIZE=
```

`tests/build/portal_800x480.pbm` is the setup screen as the panel will show
it. CI runs these on every PR (`pico-firmware` in `pull-request-tests.yml`).
A module belongs in `FRAMEOS_PICO_PORTABLE_SOURCES` (CMakeLists.txt) when it
includes nothing from the SDK; keep it that way.

## Flash and provision

**From FrameOS (the normal way).** Create the frame (mode *Embedded*, preset
*Pimoroni Inky Frame 7.3" Spectra 6*), open its deploy panel:

1. *Download firmware (.uf2)*. Hold BOOTSEL while plugging in USB; a drive
   named `RP2350` (Pico 2 W) or `RPI-RP2` (Pico W) appears; drag the file onto
   it. The board reboots into FrameOS.
2. *Connect over USB* → *Set up as this frame*. The browser sends the preset,
   backend URL, frame id, API key, device login and Wi-Fi over `usb_api`, and
   restarts the board.

Updating later is the same file onto the same drive; *Reboot into BOOTSEL*
(or `bootsel` on the console) saves holding the button. Config and render
state live in the last two flash sectors, which a UF2 does not touch.

**Without a computer.** A board with no network to join opens the hotspot
shown on its panel. Join it, the setup page opens by itself (or browse to
`http://192.168.4.1/`), fill in Wi-Fi + backend URL + frame id + API key (the
deploy panel shows them).

**By hand**, over the USB serial console (any baud rate):

```
frameos> set hardware pimoroni_inky_frame_7_3_spectra
frameos> set backend http://192.168.1.10:8989
frameos> set frame_id 42
frameos> set api_key <the frame's server_api_key>
frameos> wifi "My Network" MyPassword      # saves and reboots
frameos> status
frameos> render                            # fetch + refresh now
frameos> logs
```

`set` takes the ESP32 console's key vocabulary, because the backend emits one
provisioning plan for every embedded board; keys that only mean something with
an on-device renderer (`rotate`, `scaling_mode`, `assets_sd`, …) are accepted
and ignored. Rotation is applied by the backend before packing.

## Battery mode

`deep_sleep` (always) or `deep_sleep_on_battery` (only while VBUS is absent)
powers the board off completely after each pass via the Inky Frame's
PCF85063A RTC + HOLD_VSYS latch (~20 µA), cold-booting on the next interval or
on any front button. On USB power the latch cannot cut VSYS, so the firmware
waits in place instead — and anything a person does (a console line, a button,
a render request over HTTP) ends the wait. The RTC timer is 8 bits: whole seconds up to
255, then whole minutes up to 4 h 15 min; a longer interval wakes early, finds
the frame unchanged, skips the refresh and sleeps again. A provisioned frame on
battery that cannot find its Wi-Fi sleeps the interval out rather than opening
a hotspot.

On battery **every reset is a power cut**: a watchdog or software reset floats
HOLD_VSYS_EN and the rail drops. So `pk_reboot()` arms a 3-second RTC wake
first, the power cut refuses to happen unless the RTC confirmed its timer, and
while the firmware runs an 8-second hardware watchdog is backed by an RTC
dead-man timer (re-armed every minute, 4 minutes long): a hang ends in a reset,
the reset ends in a wake, instead of a latch held until the cells are empty or
a frame that stays dark until somebody presses a button.

## TLS

`https://` backends work: TLS 1.2 via pico-sdk's mbedTLS behind lwIP altcp,
with hostname verification against an embedded bundle of the major public
CA roots (`src/certs/pk_ca_roots.h` — ISRG, DigiCert, Amazon, GlobalSign,
USERTrust, GoDaddy; swap in your own root for a private CA). Certificate
validity periods check against the RTC / SNTP time, falling back to a
build-time floor when neither has it. The device's *own* server is plain HTTP
(no TLS listener): on the LAN it is guarded by the frame's API key or device
login, in hotspot mode by the WPA2 passphrase.

## Layout

```
src/main.c              boot order, the render/sleep loop, buttons, wake reason
src/pk_platform.c       pk_poll()/pk_wait_ms(): nothing in here sleeps blind
src/pk_render.c         the pass: settings → FOSB → hash → panel; status screens; log upload
src/pk_http.c           streaming HTTP(S) client        pk_http_response.c*  framing, chunked, ETag
src/pk_httpd.c          the device's HTTP server         pk_httpd_parse.c*    requests, auth, forms
src/pk_wifi.c           station, scan, hotspot, mDNS     pk_hotspot.c*        DHCP, DNS, passphrase
src/pk_console.c        console + usb_api                pk_args.c*           quoting
src/pk_config.c         flash config (v2 → v3 migrated)  pk_config_keys.c*    `set`, presets, pins
src/pk_settings_parse.c* settings pull                   pk_json.c*           JSON walker/escaper
src/pk_log.c*           log ring + upload batches        pk_state.c*          append-only render state
src/pk_status_screen.c* scanline status screen           pk_bmp.c*            GET /image
src/pk_fosb.c*          payload format                   pk_hash.h* pk_datetime.h*
src/pk_rtc.c pk_leds.c pk_shiftreg.c pk_display.c drivers/   Inky Frame hardware
                                                         * portable, host-tested
```

## First power-on checklist (hardware validation)

None of this firmware has met glass yet; the host tests cover the logic, not
the wiring. In order, with the console open:

1. Flash the UF2; `status` answers, `buttons` prints a shift-register byte that
   changes while a button is held.
2. `set hardware pimoroni_inky_frame_7_3_spectra`, `restart` with no Wi-Fi set:
   the setup screen draws (expect ~25–30 s), `FrameOS-XXXX` appears, a phone
   pops the portal, CONNECTION LED blinks.
3. Provision from the deploy panel; after the restart: `wifi: connected`,
   `bootup` in the backend log, first scene on the panel, `render:done`.
4. `render` again with the same scene: `render:device … unchanged`, no flash.
5. `http://<hostname>.local/status` with the device login; `/image` returns a
   BMP matching the panel.
6. Rotate the frame 90° in settings: the next pass is upright in portrait.
7. Battery: `set deep_sleep 1`, unplug USB → board dies after the pass and
   returns on the interval; a button wakes it and the log says which. `status`
   → `heap:` stays level across a dozen passes.
8. Battery again: `restart` from the console with USB unplugged — the board
   must come back by itself within a few seconds (RTC wake after the reset
   drops the latch).
9. An `https://` backend, if you use one: a render and a log upload both
   complete (16 KB TLS records need the 17 KB TCP window; request bodies go
   out in 1 KB pieces because mbedTLS's output record is 2 KB).
10. Known unknowns worth a look: the Spectra init is Waveshare's 7.3" E table
    (Pimoroni drives the panel with the ACeP one); the 4.0" panel's scan
    orientation; TLS handshake time against the 8 s watchdog on the RP2040.

## Limitations

- **No FrameOS Cloud link.** The cloud does not render for thin clients yet
  (`docs/convergence-todo.md` §3 — the entitlement shipped, the renderer did
  not), so a cloud-only Pico would have nothing to show. `set cloud_url` says
  so. When the hub renders, this firmware needs a WebSocket client and the
  enrollment handshake; everything else is already shaped for it.
- Front buttons re-render and are logged with their label, but do not reach
  the scene as a `button` event (the scene lives on the backend; the ESP32
  thin client has the same limit).
- `GET /state` / `/states` are not served: scene state for a thin client lives
  in the backend's store.
