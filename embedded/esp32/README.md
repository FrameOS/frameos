# FrameOS ESP32 firmware

FrameOS for ESP32-S3 microcontrollers. The firmware provisions Wi-Fi over a
captive portal or the serial console, renders scenes **on-device** with the Nim
runtime (pixie in PSRAM), drives Waveshare SPI e-ink panels through the same
vendor drivers the Raspberry Pi build uses, and can alternatively run as a thin
client fetching bitmaps its backend or the cloud rendered ("Rendering on the
server" below).

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
  fos_config_parse.c      the setting parsers/normalisers behind every writer (host-tested)
  fos_wifi.c              STA connect (waited for, or in the background), SoftAP portal, DNS hijack, scan, SNTP
  fos_frame_settings.c    the settings panel's frame page (behind its gear): the facts it shows, the Wi-Fi, rotation and scale it sets
  fos_wifi_networks.c     the order a scan's networks are listed in there: by name (host-tested)
  fos_http.c              esp_http_server route layer (portal + /status + actions)
  setup_page.html         the setup page (GET /), gzipped at build time by tools/gzip_setup_page.py;
                          its values come from GET /api/setup
  fos_client.c            render loop: Nim local render or thin-client fetch → blit
  fos_render_pull.c       the thin-client pull's URL, ETag and answers: backend or cloud (host-tested)
  fos_ota.c               signed release OTA (manifest + streaming verify) when an OTA partition exists
  fos_cloud.c             cloud-managed frames: claim-token enrollment + management WS
  fos_url_guard.c         provider URL rules: local-host exception for plain http/ws, ws_url
                          override guard, origin comparison for the OTA bearer, and "is this
                          request's Origin its own Host" for the HTTP server (host-tested)
  fos_tls.c               certificate validity dates for every TLS client (the bundle's attach,
                          taken at the link); fos_tls_dates.c is the rule, what a frame
                          without the time does included (host-tested)
  fos_minisig.c           minisign .minisig parser + "signed as which release?" check gating every OTA image (host-tested)
  fos_console.c           serial REPL (UART0 + USB-Serial/JTAG): status / set / wifi / render / ota / ...
  fos_usb_pads.c          the owner of the S3's native USB pads (GPIO19/20): every driver that
                          puts a peripheral on them claims the pads (the PHY comes off them), and
                          the console then offers no USB-Serial/JTAG channel
  fos_cloud_contract.c    the generated cloud verb/settings contract walker (fos_cloud_contract_gen.h)
  fos_json_guard.c        JSON depth pre-scan for the small-stack parser tasks
  fos_cxx_new.c           NVS's new[] (std::nothrow) / delete[] as malloc-or-abort / free, without
                          libstdc++'s exception runtime
  fos_printf.c            the printf family for the linker's --wrap: newlib's output from a small
                          formatter, doubles by QuickJS's js_dtoa, so newlib's is never linked (host-tested)
  fos_sscanf.c            sscanf and siscanf for the linker's --wrap: cJSON's "%lg" read-back as
                          strtod, tzset's TZ formats by an integer scanner that reads as newlib's,
                          so no newlib scanf engine is linked (host-tested)
  fos_settings.c          backend/cloud settings pull (TLS pair, admin login, service keys, schedule)
  fos_scenes.c            /state scene store: a whole set as changes, combined payload, per-scene split, OOM-restart mark, wipe
  fos_slot_cache.c        the scene files read last, kept in PSRAM so a switch skips the SPIFFS lookup (host-tested)
  fos_scene_state.c       scene state across deep sleep: one JSON file per scene under /state (host-tested)
  fos_commands.c          the backend's command queue: pulled once per pass and on a nudge, acked by id;
                          fetched on the backend link task and run on the render task (fos_client.c)
  fos_backend_http.c      the one HTTP client for the small pulls and posts (settings, scenes, commands, tz, OTA manifest)
  fos_http_body.c         its body read: a declared length read to the byte, a chunked one grown to the cap (host-tested)
  fos_login_throttle.h    how many wrong device logins the HTTP server looks at: ten in five minutes (host-tested)
  fos_schedule.c          schedule evaluation; fos_schedule_catchup.h its catch-up window (host-tested)
  fos_events.c            the ONE routing function for scene events (fos_events_dispatch): every
                          producer — /event/<name>, the schedule, the cloud verbs, the console's
                          `event`, the buttons — names its origin and calls it. Allow-list from
                          fos_events_gen.h (generated from docs/events-contract.json), then the
                          firmware's own part (render, setCurrentScene, reload / restart / reboot /
                          uploadScenes) or the Nim dispatcher; also the Nim runtime's
                          device-command hook (host-tested)
  fos_assets.c            asset verbs (list/get/put/mkdir/delete/rename)
  fos_assets_path.c       the assets-path rule behind every asset verb (host-tested)
  fos_assets_sd.c         SD card mount/probe/format for the assets root
  fos_assets_flash.c      the state partition's files: /srv/internal, and the assets root with no SD card in use
  fos_sd_probe.c          SD presence probe used by the assets layer
  fos_sd_diskio.c         FatFS's disk driver for the card: a buffer in PSRAM moves 16 sectors a
                          command through internal RAM, where IDF's moves it one sector a command
  fos_framebuffer.c       canvas allocation (RGB565, luma or 4-bit grey by panel) and dither/pack
  fos_status_screen.c     boot/status screen renderer (shared design with the Pi's)
  fos_panel_draw.c        5x7 font + rectangles straight into a packed panel buffer, rotation
                          aware: the status screen and the local network access code box (host-tested)
  fos_lan_access.c        the local network access and adoption codes: mint, scope, TTL, attempts,
                          constant-time check, the wrong-code window that grows (host-tested)
  fos_board.c             board table: pins, panel defaults, battery divider per board
  fos_buttons.c           GPIO button map → `gpio` edges (origin `driver`, via fos_events.c)
  fos_battery.c           battery ADC sampling; fos_battery_filter.c its outlier filter
  fos_power.c             deep sleep, wake-check render skip, VBUS truth
  fos_animation.c         animation mode: a scene below a 1 s interval on an LCD, paced in µs; the
                          render task's small rules (input hold, push gives way, backend link) (host-tested)
  fos_wake.c              wake scheduling (next render / schedule event)
  fos_tz.c                IANA zone → POSIX TZ rule
  fos_defaults.h          compile-time defaults of the generic image (NVS wins)
components/
  frameos_display/        DEV_Config on ESP-IDF (spi_master/gpio, runtime pin remap);
                          every root Waveshare EPD_*.c compiled in, with a
                          runtime table from generate_panel_table.py picking
                          the configured panel (see "Every supported panel
                          driver is compiled into each firmware image");
                          fos_refresh_queue.c the pictures owed to the full
                          refresh task (host-tested)
  frameos_nim/            the FrameOS Nim runtime compiled to C (see build_nim.sh);
                          builds a stub when nimcache/ is absent. fos_rows.c shares a
                          pixel loop's rows with a helper on the other core (resample.nim);
                          fos_js_io.c makes a JS app's fetch and <img src> requests, and
                          runs the scene store's work, on one task, one at a time
                          (docs/async-js.md); include/fos_tls_sessions.h the TLS sessions
                          a scene's HTTPS requests resume (host-tested)
partitions_4mb.csv        4MB: nvs + phy + factory app + 512K state; no OTA
partitions.csv            8MB: nvs + otadata + phy + ota_0/ota_1 (3520K each) + 1M state
partitions_ota_16mb.csv   16MB: nvs + otadata + ota_0/ota_1 (4032K each) + 8M state
partitions_ota_32mb.csv   32MB: nvs + otadata + ota_0/ota_1 (4032K each) + 24M state
build_nim.sh              nim c --compileOnly --os:freertos --cpu:esp → nimcache/, then
                          tools/fold_nim_inlines.py: one copy of each Nim inline helper
                          instead of one per C file (~30 KB; docs/esp32-image-size.md),
                          and tools/fold_nim_strings.py: one copy of each string literal
                          several modules hold (~28 KB)
link_order.txt            the order FrameOS's objects stand in inside the S3 image's code,
                          callers near what they call (a CALL8 is 3 bytes and reaches
                          512 KB, a longer call is 6): ~54 KB. CMakeLists.txt hands it to
                          the linker (tools/link_order.py emit); ci_build_image.sh prints
                          how many calls a build left long; `tools/link_order.py optimize`
                          writes the file again from a finished build
                          (docs/esp32-image-size.md, "Calls, alignment and strings")
main/tests/               host tests for the IDF-free modules (plain `cc`, no IDF; each file's
                          header carries its command line). The netguard, local network access code
                          (test_esp32_lan_access.py: fos_lan_access + fos_panel_draw), SD probe, board,
                          power, wake, battery-filter, version, Wi-Fi network order, OTA download, LCD splash and loading mark,
                          slot cache, refresh queue, TLS session table (test_esp32_tls_sessions.py), login
                          throttle (test_esp32_http_gate.py), certificate dates (test_esp32_tls_dates.py)
                          (lcd_loading.c) and scene-event (contract table +
                          fos_events.c dispatch) tests run from the backend's
                          pytest suite (backend/app/tasks/tests/test_esp32_*.py, which also
                          checks that every frameos_nim.h function has a frameos_nim_stub.c
                          twin: the C3 thin client links the stub, and only a release builds
                          it); the contract
                          walker, JSON guard, sscanf, upload limits, assets-path, URL guard, minisig,
                          config-parse, schedule catch-up, console-line and render-pull tests run in the ESP32 job of
                          .github/workflows/e2e-docker.yml. Nothing else runs them, so a new
                          host test is not a test until it is wired into one of the two.
```

## Toolchain

Requires [ESP-IDF](https://docs.espressif.com/projects/esp-idf/) v5.5.x:

```bash
mkdir -p ~/esp && cd ~/esp
git clone --depth 1 --branch v5.5.4 --recursive --shallow-submodules \
  https://github.com/espressif/esp-idf.git
cd esp-idf && ./install.sh esp32s3,esp32c3
```

Only the release job and local development build firmware: the self-hosted
backend and the cloud flash the signed generic release image for a board's
chip and flash layout and never compile. `ci_build_image.sh` is the release
recipe (`FRAMEOS_ESP32_PLATFORM=esp32-{s3,c3}[-{4,8,16,32}mb]`); the on-device
Nim runtime needs `nim` (>= 2.2) on PATH, without it the S3 image builds in
thin-client-only mode.

## Build and flash by hand

```bash
. ~/esp/esp-idf/export.sh
./build_nim.sh             # compile the Nim runtime to C (optional but recommended)
idf.py set-target esp32s3
FRAMEOS_SELECTED_PANEL=EPD_7in5_V2 idf.py reconfigure build
# reconfigure picks up a new nimcache. Every supported panel driver is
# compiled in; FRAMEOS_SELECTED_PANEL only sets the boot-time default panel
# (optional — `set panel <key>` switches at runtime).
idf.py -p /dev/tty.usbmodem* flash monitor
```

Or flash the single merged image produced by `idf.py merge-bin` (what the
release publishes and the browser flashers write):

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
| `waveshare_esp32_s3_photopainter` | S3 | EPD_7in3e 7.3" Spectra | PMIC power-up, TF socket; ES8311 speaker + ES7210 microphone on I2S (`codec_pins`, I2C 47/48); KEY1 held talks |
| `waveshare_esp32_s3_epaper_13_3e6` | S3 | EPD_13in3e 13.3" Spectra | dual CS, TF socket; ES8311 speaker + ES7210 microphone on I2S (`codec_pins`, I2C 41/42); BOOT held talks |
| `trmnl_og` | C3 | EPD_7in5_V2 7.5" mono | TRMNL OG; battery GPIO3 ÷2 |
| `trmnl_bwry` | C3 | EPD_7in5yr 7.5" BWRY | TRMNL BWRY; battery GPIO3 ÷2 |
| `esp32_c3_042_oled` | C3 | OLED_SSD1306_72x40 0.42" OLED (I2C) | HW-675 / 01Space C3 dev board; SDA5/SCL6 as mosi/sck, BOOT GPIO9; thin client, 4 MB |
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
  The cell has no divider to an ADC pin: the AXP2101 PMIC (0x34 on the
  SDA47/SCL48 bus, the one that switches EPD_VCC) is also its fuel gauge.
  `fos_gauge.c` reads it as it reads the Sticky's BQ27220 — VBAT (REG34/35),
  the gauge's state of charge (REG A4), VBUS-good and the charge state
  (REG00/01) — so the metrics carry `batteryMillivolts` / `batteryPercent`
  and `usbPower` / `charging`, and the frame deep-sleeps on the cell and
  stays awake on USB. The chip can boot with its gauge, battery detection
  and VBAT ADC off; the first read switches the three on (REG18 bit 3,
  REG68 bit 0, REG30 bit 0), after checking the chip id (0x4A) so nothing
  else at 0x34 gets the writes. The console's `i2c` prints the registers
  raw (`axp2101: reg00=… regA4=…`). The gauge learns
  the cell over its first few charge cycles, so the percentage is rough
  until then; it reports no current (`current_ma` 0).
- **Seeed reTerminal E-series (E1001/E1002/E1003/E1004)** — the TF socket shares
  the panel's SPI bus: `assets_sd_pins` names the panel's SCK7/MOSI9, so
  `fos_assets_sd.c` joins the display's bus instead of opening SPI3
  (`fos_display_spi_bus_share`), the panel holds the bus for each refresh
  (`DEV_SPI_Acquire`) and the sdspi driver takes its turns between. Every
  card is mounted with `wait_for_miso = -1` (`fos_assets_sd.c`): on the
  bench E1004 MISO never read high between commands, so IDF's default
  waited 40 ms before every one, which made a sector read 80 ms and a cloud
  upload 66 s a 256 KiB chunk (3 s without it, 2026-11-28). The bench
  E1002's card answers high; without the wait it moved a 4.8 MB file 10 %
  and upload chunks 28 % faster. The
  socket is powered through GPIO16 (GPIO39 on the E1003) and has a
  card-detect contact on GPIO15 (`pwr=16,det=15` in the spec; an empty slot
  is reported without a bus probe). The green status LED (`led_pin 6` with
  `led_type gpio_inverted`; `led_pin 16`, also lit low, on the E1003;
  `led_pin 48` with `led_type gpio` on the E1004, whose LED sits behind a
  transistor; `fos_led.c`) follows the buzzer's notes, so a
  frame with `buzzer_pin -1` still shows its presses and the voice chat's
  cues in light. `i2c_buses` (`fos_i2c.c`, probed at boot and by the console's
  `i2c`) finds the PCF8563 clock (`fos_rtc.c`: the system time is set from it
  on a cold boot, before Wi-Fi, and written back at every SNTP sync), the
  SY6974B charger (`fos_charger.c`: whether USB is in and the cell charging,
  which the power decision takes over the divider's cell test — a frame on
  its desk with USB in no longer deep-sleeps "on battery" — and the metrics
  carry as `usbPower` / `charging`) and the SHT40 climate sensor (reported
  as present; read only for the E1003's IT8951, below). A board provisioned
  before these keys existed gets all of them on its first boot of this
  firmware, as `set hardware` would give them.
  **GPIO19/20 are the S3's native USB pads**, and the ROM leaves the
  USB-Serial/JTAG PHY attached to them: with the PHY still on, the I2C bus on
  those pins answered its first read and then NACKed every write (I2C error
  `0x103`) until a bus re-init happened to win the pads back. `fos_usb_pads.c`
  owns the pads: every driver that puts a peripheral on 19 or 20 claims them
  (`fos_usb_pads_claim`), which detaches the PHY
  (`usb_serial_jtag_ll_phy_enable_pad(false)`) and remembers that they are
  spoken for, and the console then skips its USB-Serial/JTAG channel — the
  E-series' USB is a CH340 on UART0 anyway. **The claim is the pads'**: the
  console's USB-Serial/JTAG driver puts the PHY back on them
  (`usb_serial_jtag_driver_install` calls `usb_serial_jtag_ll_phy_enable_pad(true)`),
  so a driver that detached the PHY without claiming the pads lost them again
  — the Sunton's GT911 answered its first read and every read after the
  console came up timed out (`i2c.master: I2C software timeout`, 2026-11-22).
| `seeed_reterminal_sticky` | S3 | EPD_3in97 3.97" four-grey | reTerminal Sticky, 32MB flash, 8MB PSRAM (renders on-device); panel power GPIO47; keys AI (GPIO4), UP (5), DOWN (6): UP/DOWN held walk the scenes, AI held talks; 4 kHz buzzer GPIO48; PDM mic 19/20/38; GT911 touch panel (`touch_pins`); I2C 1/0 with the PCF8563 clock, SHT40, LSM6DS3TR-C IMU and the BQ27220 fuel gauge (no battery divider); BQ25616 charger enabled through GPIO39 (low); TF socket on the panel bus (CS8, MISO12, power 10, detect 11); deep-sleeps on battery |
| `seeed_reterminal_e1001` | S3 | EPD_7in5_V2 7.5" mono | reTerminal E1001, 32MB flash; battery GPIO1 ÷2, switch GPIO21; TF socket on the panel bus (MISO8, CS14, detect 15, power 16); green LED GPIO6 (lit low); I2C 19/20 (PCF8563 clock, SHT40) + 39/40 (SY6974B charger); PDM mic 42/41/38 |
| `seeed_reterminal_e1002` | S3 | EPD_7in3e 7.3" Spectra | reTerminal E1002, 32MB flash; the same peripherals as the E1001 |
| `seeed_reterminal_e1003` | S3 | EPD_10in3 10.3" sixteen greys (IT8951, E1003 tuning) | reTerminal E1003, 32MB flash, 8MB PSRAM — renders on-device on an 8-bit luma canvas (2.5 MiB); the IT8951 answers on MISO GPIO8 (`dc` slot), panel power GPIO11 (`pwr`), controller power GPIO21 (`cs2`); battery GPIO1 ÷2, switch GPIO40; TF socket on the panel bus (power 39); green LED GPIO16 (lit low); I2C 19/20 with the clock, the SHT40, the charger and the GT911 touch panel (INT 2, reset 48); PDM mic 42/41/38; deep-sleeps on battery, and its keys wake it, not the glass ("Wake on touch") |
| `seeed_reterminal_e1004` | S3 | EPD_13in3e 13.3" Spectra (T133A01 tuning) | reTerminal E1004, 32MB flash, 8MB PSRAM — renders on-device on the 16-bit canvas; TF socket as the E1001/E1002; green LED GPIO48 (lit high); I2C 19/20 carries the clock, the sensor AND the charger (39/40 is its J2 header); no microphone |
| `elecrow_crowpanel_5in79` | S3 | EPD_5in79_BW 5.79" black/white, partial refresh | Elecrow CrowPanel 5.79" (ESP32-S3-WROOM-1-N8R8, 8MB flash, 8MB PSRAM), dual SSD1683 on SCK12/MOSI11, CS45, DC46, RST47, BUSY48, the panel's supply on GPIO7 (high: without it the panel never leaves BUSY); its glass (GDEY0579T93) in black and white on its own waveforms, as Elecrow drives it, with partial updates (`EPD_5in79_BW`, `PARTIAL_PANELS`): the Waveshare 5.79"'s four-grey table (`EPD_5in79`) made its white a dark grey; keys HOME (2, the top one with the picture turned to the keys), EXIT (1, the bottom one) and the rocker NEXT (4), OK (5), PREV (6): HOME opens the scene switcher (held: the scene's settings), EXIT is back (the scene's page or photo before, the settings closed), the rocker held walks the scenes; TF slot on its own bus (CS10, SCK39, MISO13, MOSI40); power LED GPIO41 (lit high) |
| `elecrow_crowpanel_epd_4in2` | S3 | EPD_4in2_BW 4.2" black/white, partial refresh | Elecrow CrowPanel 4.2" e-paper HMI (ESP32-S3-WROOM-1-N8R8, 8MB flash, 8MB PSRAM), wired as the 5.79" (Elecrow's schematic): its 400x300 glass on SCK12/MOSI11, CS45, DC46, RST47, BUSY48 (low while busy), the panel's ground switched on by GPIO7 (high); the controller of the Waveshare 4.2" V1 (UC8176), which is what Elecrow's "green sticker" driver speaks and what the board on the bench has, sticker or not (its factory firmware carries that driver's waveforms); in black and white on Elecrow's waveforms (GC for a full refresh, DU for a partial update: `EPD_4in2_BW`, `PARTIAL_PANELS`; Waveshare's four-grey table, `EPD_4in2`, drew its white grey). A board with the first glass (an SSD1683, Elecrow's older driver) takes `set panel EPD_4in2_V2`, Waveshare's four-grey driver for it, untested here. The 5.79"'s keys (MENU = HOME 2, EXIT 1, the rocker UP = PREV 6, DOWN = NEXT 4, CONF = OK 5) and the same map; TF slot on its own bus (CS10, SCK39, MISO13, MOSI40), its supply on GPIO42 (high); power LED GPIO41 (lit high) |
| `seeed_xiao_ee02` | S3 | EPD_13in3e 13.3" Spectra (T133A01 tuning) | XIAO ePaper Display Board EE02, a XIAO ESP32-S3 Plus (16MB flash, 8MB PSRAM); SCK7/MOSI9, CS44, second CS41, DC10, RST38, BUSY4, panel power GPIO43; keys GPIO2/3/5; battery GPIO1 ÷2, switch GPIO6. Unverified on hardware |
| `seeed_xiao_ee03` | S3 | EPD_10in3 10.3" sixteen greys (IT8951, E1003 tuning) | XIAO ePaper Display Board EE03; the EE02's bus with MISO GPIO8 in the `dc` slot and no second CS; SHT40 on I2C 42/41 for the panel temperature. Unverified on hardware |
| `seeed_xiao_ee04` | S3 | EPD_7in5_V2 by default | XIAO ePaper Display Board EE04, a carrier for 24-pin panels and the 7.3" Spectra on its 50-pin socket: the panel is yours to choose (`set panel` after `set hardware`). Unverified on hardware |
| `seeed_xiao_ee05` | S3 | EPD_7in5_V2 by default | XIAO ePaper Display Board EE05, 24-pin panels only, chosen as on the EE04; KEY3 GPIO8, battery switch GPIO39. Unverified on hardware |
| `seeed_xiao_epaper_7in5` | C3 | EPD_7in5_V2 7.5" mono | XIAO 7.5" ePaper Panel, thin client; SCK8/MOSI10, CS3, DC5, RST2, BUSY4; BOOT GPIO9; no battery sense |
| `seeed_sensecap_indicator_d1` | S3 | LCD_ST7701S_480x480 4" IPS LCD (RGB, 16-bit colour) | SenseCAP Indicator D1/D1S/D1L/D1Pro, 8MB flash, 8MB PSRAM (renders on-device); the LCD's wiring is the driver's board table, no EPD pins; top button GPIO38 (pressed: the screen off or on, twice: the scene switcher; a swipe in from the left or right edge: `back` or `forward`, up from the bottom: the scene switcher, down from the top: the scene's settings); FT6336U touch on the LCD's I2C 39/40, polled; the TF socket, buzzer and sensors are the RP2040's |
| `guition_esp32_4848s040` | S3 | LCD_ST7701S_480x480 4" IPS LCD (RGB, 16-bit colour) | Guition ESP32-4848S040 (the 86-box wall panel), 16MB flash, 8MB PSRAM (renders on-device); the LCD's wiring is the driver's board table: the ST7701S is initialised over GPIO SPI (CS39/SCK48/SDA47), not an IO expander, so it needs the preset (`set panel LCD_ST7701S_480x480` alone picks the Indicator's wiring), backlight GPIO38, no EPD pins; no key (GPIO0 is an RGB data line), so only the edges swipe (left or right: `back` or `forward`, up from the bottom: the scene switcher, down from the top: the scene's settings); GT911 touch on I2C 19/45, polled, no reset line, both axes mirrored; the GPIO20 data line (G1) is on a USB pad, which the LCD driver claims from the USB-Serial/JTAG PHY as the panel comes up (`fos_lcd_st7701s_set_pad_claimer`, `fos_usb_pads.c`), so the console offers no USB-Serial/JTAG channel; the microSD slot is not supported yet; USB is a CH340 on UART0 |
| `sunton_esp32_8048s070` | S3 | LCD_EK9716_800x480 7" IPS LCD (RGB, 16-bit colour) | Sunton (GUITION) ESP32-8048S070, 16MB flash, 8MB PSRAM (renders on-device); the LCD's wiring is the driver's board table (no SPI init, no IO expander), chosen by the preset or, without one, by the panel alone (`set panel LCD_EK9716_800x480`), backlight GPIO2, no EPD pins; the BOOT key GPIO0 (pressed: the screen off or on, twice: the scene switcher; a swipe in from the left or right edge: `back` or `forward`, up from the bottom: the scene switcher, down from the top: the scene's settings); GT911 touch on the chip's I2C 19/20 (the pads are claimed from the USB-Serial/JTAG PHY first, `fos_usb_pads.c`, and the console then offers no USB-Serial/JTAG channel), reset GPIO38, polled (its interrupt line is behind an unpopulated R17); microSD on its own SPI bus (CS10/SCK12/MISO13/MOSI11); USB is a CH340 on UART0 |
| `elecrow_crowpanel_advance_7` | S3 | LCD_SC7277_800x480 7" IPS LCD (RGB, 16-bit colour) | Elecrow CrowPanel Advance 7.0" (hardware V1.2), ESP32-S3-WROOM-1-N16R8, 16MB flash, 8MB PSRAM (renders on-device, the generic image); the glass takes no init, its wiring the RGB driver's board table (`lcd_st7701s_rgb.c`: B GPIO21/47/48/45/38, G GPIO9-14, R GPIO7/17/18/3/46, DE42 VSYNC41 HSYNC40 PCLK39, falling edge, 21 MHz: 51 frames a second; at 12 MHz, 29, it flickered); the STC8H1K28 coprocessor at 0x30 on SDA15/SCL16 holds the GT911's reset and the backlight: `fos_board_i2c_writes` sends it 0x19 (touch out of reset) and 0x10 (backlight on) when the bus opens, and the backlight goes off and on through it (0x05 / 0x10, `fos_board_i2c_backlight`); the GT911 (polled, as Elecrow's driver has it: its INT on GPIO1 does not move) and the BM8563 clock (a PCF8563) on the same bus; BOOT GPIO0 (pressed: the screen off or on, twice: the scene switcher); the edges swipe. The DIP-switch-muxed microphone, speaker and TF slot are not driven; a V1.3+ board's coprocessor takes other commands (untried) |
| `elecrow_crowpanel_advance_2in8` | S3 | LCD_ST7789_320x240 2.8" IPS LCD (SPI, 16-bit colour) | Elecrow CrowPanel Advance 2.8" (hardware V1.2), ESP32-S3-WROOM-1-N16R8, 16MB flash, 8MB PSRAM (renders on-device, the generic image); the ST7789 keeps its own picture and is sent only what changed, on one SPI lane at 80 MHz through the watch's driver (`lcd_qspi_amoled.c`: CS40, SCLK42, MOSI39, D/C41, no reset line, so a software reset; MADCTL 0xA0 for its landscape, inverted colours); the backlight on GPIO38 through a transistor, dimmable (`set brightness`, `dim_after`); the FocalTech FT6336U at 0x38 on SDA15/SCL16 (INT 47, reset 48) reports the glass in portrait, so its axes are swapped and x mirrored (`FOS_BOARD_TOUCH_ACROSS`); the LMD3526 PDM microphone on clock 9 / data 10 through an SGM3799 switch that GPIO45 high turns from the wireless header to it (`micPwrPin`); the passive buzzer on GPIO8 (4 kHz); the TF slot on CS7/SCK5/MISO4/MOSI6; BOOT GPIO0 (pressed: the screen off and on; twice: the scene switcher; held: voice chat); the edges swipe. No clock chip and no coprocessor on this size (its STC8G only lights the charge LEDs); the cell has no divider to an ADC. Not driven: the NS4168 I2S speaker amplifier (GPIO11-13, mute GPIO21) and the wireless module header. |
| `waveshare_esp32_s3_touch_amoled_1_75` | S3 | AMOLED_CO5300_466x466 1.75" round AMOLED (QSPI, 16-bit colour) | Waveshare ESP32-S3-Touch-AMOLED-1.75 and its -B (the same board in a case), ESP32-S3R8, 16MB flash, 8MB PSRAM (renders on-device, the generic image); the CO5300 keeps its own picture and is sent only the rectangle that changed (`lcd_qspi_amoled.c`: CS12, SCLK38, D0-D3 GPIO4-7, reset 39), so a flash write never tears it and there is no "Updating" screen; only the circle is glass (`fos_display_round`: the switcher, the settings, the keyboard, the edge swipes and the loading mark keep inside it, and with no frame page on a round panel it sets up through the hotspot like an e-paper board); BOOT GPIO0 (held: voice chat) and PWR on the TCA9554 expander's P4 (`fos_board_expander_keys`, no setting names it; pressed: the screen off or on, twice: the scene switcher); the edges swipe; CST9217 touch (0x5a, INT 11, reset 40, read on its interrupt alone), the ES8311 speaker and ES7210 microphones (MCLK42, BCLK9, WS45, DIN10, DOUT8, PA46), the AXP2101 gauge, the PCF85063 clock and the QMI8658 accelerometer (`imu`) all on SDA15/SCL14; TF slot in SPI mode (CS41/SCK2/MISO3/MOSI1) |
| `elecrow_crowpanel_watch_2in01` | S3 | LCD_GC9309_240x296 2.01" IPS LCD (SPI, 16-bit colour) | Elecrow CrowPanel 2.01" watch, ESP32-S3R8, 16MB flash, 8MB PSRAM (renders on-device, the generic image); the GC9309 keeps its own picture and is sent only the rectangle that changed, on one SPI lane at 80 MHz (`lcd_qspi_amoled.c`, the AMOLED's driver: CS9, SCLK7, MOSI8, D/C10, reset 6, backlight 13); the board's rails GPIO47 high and GPIO40 low (`fos_board_rails`); BOOT GPIO0 (pressed: the screen off or on, twice: the scene switcher) and the crown: pressed OK (GPIO18, held: voice chat), turned NEXT / PREV presses (GPIO19 leads for NEXT, GPIO20, `fos_board_encoder_pins`); the power key is HOME and opens the scene switcher (its STC8G1K08 power chip flips GPIO14 while the key is down, `fos_board_toggle_key`: a flip after 400 ms of quiet is one press); the edges swipe; AXS5106L touch (0x63, FocalTech's registers, INT 2, reset 5) and the PCF8563 clock on SDA4/SCL3; LMD3526 PDM microphone (clock 12, data 11); the vibration motor (GPIO45) plays the buzzer's notes, the I2S speaker is not driven; LED GPIO16 (lit high); battery GPIO1 behind 100k / 137k |
| `elecrow_crowpanel_rotary_1in46` | S3 | LCD_ST77961_360x360 1.46" round IPS LCD (SPI, 16-bit colour) | Elecrow CrowPanel 1.46" rotary, ESP32-S3R8, 16MB flash, 8MB PSRAM (renders on-device, the generic image); the ST77961 keeps its own picture and is sent only the rectangle that changed, on one SPI lane at 80 MHz (`lcd_qspi_amoled.c`, the watch's driver: CS9, SCLK10, MOSI11, D/C3, reset 14, backlight 46); only the circle is glass (`fos_display_round`); the LCD's supply GPIO1 high (`fos_board_rails`); BOOT GPIO0 (pressed: the screen off or on, twice: the scene switcher) and the knob: pressed OK (GPIO41), turned NEXT / PREV presses (Elecrow's B GPIO42 leads for NEXT, A GPIO45, `fos_board_encoder_pins`). The press is the whole glass pushed down on the knob, so a press is also a tap wherever the finger lands: a scene sees both, and to press OK without tapping anything, push on a spot with nothing to tap; the edges swipe; CST816T touch (0x15 on its own SDA6/SCL7, INT 5, reset 13; told to stay awake and pull INT for every report); power LED GPIO40 (lit low). Not driven: the eight-LED ring (GPIO48, supply GPIO17); not read: the cell (its divider is on GPIO18, an ADC2 pin) |

- **Seeed reTerminal Sticky** — an ESP32-S3R8 (8 MB PSRAM, 32 MB flash), so
  it renders on-device like the E-series; every pin below is from Seeed's
  hardware specification for porting and **none of it has met a board yet**.
  The glass is a Goodix GT911 on its own I2C bus (`touch_pins
  sda=3,scl=2,int=21,rst=41,en=42`; `fos_touch.c`): a finger is `pointerDown`
  / `pointerMove` / `pointerUp` to the scene on the contract's wire, and the
  Nim dispatcher makes the taps, long presses and swipes of it exactly as on
  a Pi (`docs/events.md` "Input"). The controller reports in its own
  resolution; when its axes run across the panel's (a portrait glass on a
  landscape panel) the driver swaps them (`touch:ready` says `swapped`), and
  a glass mounted against its panel is mirrored by board
  (`fos_board_touch_mirror`: the SenseCAP Indicator's, both axes;
  `touch:ready` says `mirrored`). A
  touch wakes a deep-sleeping frame through ext0 on TP_INT (GPIO21, an RTC
  IO); the controller is held powered through the sleep for it (a few mA;
  "Wake on touch" below).
  The PDM microphone sits on GPIO19/20, the S3's native USB pads: the board's
  USB is a CH343 on UART0, so the pads are claimed from the USB-Serial/JTAG
  PHY at boot (`main.c` claims the configured microphone's pins,
  `fos_usb_pads.c`), before the console comes up — the console offers no
  USB-Serial/JTAG channel and says so on the wire. The
  cell has no divider: the BQ27220 fuel gauge (0x55 on the sensor bus)
  answers `fos_battery_read` with its own voltage and state of charge, and
  its discharge flag is the power decision's "on battery" (`fos_gauge.c`),
  so the frame deep-sleeps on the cell and stays awake on USB like the
  E-series with their charger. The charger is a BQ25616 with no bus, strapped
  for 4.2 V and 555 mA, and it charges only while EN_BAT_CHGn (GPIO39) is
  low. Left alone the pin reads high (it is the S3's MTCK, with a pull-up out
  of reset per the datasheet, against the board's 100 kΩ to ground) and the
  cell is never charged: `fos_charger_enable` drives it low at boot and holds
  it through a deep sleep (`fos_board_charge_enable_pin`). The red LED beside
  the port is the charger's STAT (CHARGE_STATE, GPIO40, not read): lit while
  it charges, blinking when it holds off (the cell too warm or cold, its
  safety timer). On the cell the 3.3 V rail runs while the AI/power key is
  down, and after that only while a 74AHC1G79 flip-flop holds it (the Power
  sheet's "Power up latch"): `fos_charger_latch_power` sets PWR_HOLD (GPIO45)
  high and raises PWR_LOCK (GPIO46) first thing in `app_main`, then lets both
  strapping pins go; the latch keeps the rail through a deep sleep by itself.
  Without it the board went off the instant USB came out (2026-11-23), and a
  press of the key got only as far as the boot splash. On the bench
  (2026-11-18) the pin read 1 and the cell sat at 3397 mV and 0 mA for two
  days on USB; driven low, STAT went low at once and the cell rose to
  3768 mV and 32% in twenty minutes. Seeed set the gauge up in tenths (a
  100 mΩ sense resistor, `design=7500mAh` for the 750 mAh cell), so its
  `current` reads ten times the milliamps: 5860 while charging at 586 mA.
  The LSM6DS3TR-C IMU (0x6a) and the SHT40 are
  found and reported, not read. The sensor bus's SCL is GPIO0, a strapping
  pin: the bus's pull-ups keep it high across a reset. Seeed notes the SD
  card brings up most reliably when mounted before the shared e-paper SPI
  path; the firmware mounts it after the display, as on the E-series — the
  first bench says whether that matters.
- **Waveshare PhotoPainter and 13.3E6: speaker and microphone** — both carry
  an Everest ES8311 DAC (the speaker, behind a power amplifier) and an ES7210
  ADC (the microphones) as slaves on one I2S bus (`codec_pins`; the chips on
  the board's I2C bus, `i2c_buses`). `fos_codec.c` clocks I2S0 at 16 kHz
  (MCLK 4.096 MHz on the MCLK pin, BCLK 512 kHz, TX and RX sharing the bit
  and word clocks) on the HAL's register layer like the PDM microphone, and
  writes the chips the register sequences of Espressif's reference drivers
  (esp-bsp's es8311 and es7210 components) for exactly that clock. The
  microphone is the voice chat's: `fos_mic.c` takes the ADC's left slot as
  16-bit mono when a board has no PDM pins, and the one user key each board
  has (KEY1 on the PhotoPainter, BOOT on the 13.3E6 — a GPIO0 key once
  booted) held is the voice key. The speaker plays the buzzer's notes
  (`fos_buzzer.c` hands every note to `fos_codec_tone`): a press's two
  clicks, the hold's seconds, the voice chat's cues, from a 32 ms DMA ring
  the CPU writes once per note (frequencies land on 31.25 Hz steps; the
  amplifier is enabled for the note). Neither board has been on a bench
  with this yet. `status` shows `codec:` and the microphone's source;
  `mic 2` and `beep` are the bench checks.

- **Seeed reTerminal E1003, and the IT8951** — the E1003's 10.3" 1872×1404
  sixteen-grey ED103TC2 sits behind an ITE IT8951 controller on the E-series
  SPI bus, the same chip and glass as the Waveshare 10.3" HAT, so both are
  panel `EPD_10in3` (`components/frameos_display/it8951.c`; any ESP32-S3
  wired to the HAT works too). The IT8951 is the one panel that answers the
  host — its panel size and image buffer address, the VCOM it holds, whether
  its waveform engine still runs — and it has no D/C line, so for this panel
  the `dc` pin slot is its **MISO** (`FOS_PANEL_BUS_SPI_READ`; the E1003's
  is GPIO8, the TF socket's line), `pwr` the panel's power switch (GPIO11)
  and `cs2` the controller's (GPIO21, which keeps the S3 heartbeat LED off
  it); HRDY is the busy pin, and the bus writes at 20 MHz for this panel
  (FastEPD's clock for the E1003; the write-only panels keep 8 MHz) and reads
  at 4 MHz, because MISO comes through the GPIO matrix and at 20 MHz the words
  came back scrambled. The
  first refresh of a boot resets the controller, reads its info (a panel
  that is not 1872×1404 fails the init with the size it reported) and
  writes VCOM only when the controller holds another value (it tries the
  setter Waveshare's examples use, then Seeed's, and reads back). Between
  refreshes the controller waits in **standby, which keeps its picture**,
  so a refresh wakes it, sends only the tiles (32x8 pixels) whose digest
  changed, as up to three rectangles (4-bit big-endian loads straight from
  the packed buffer, a few rows to a DMA transfer), and waits for `LUTAFSR`
  to clear before standby; a frame with nothing changed is no refresh at all.
  A whole frame is 1.25 MiB on the wire, about 0.65 s; a clock's digits, a few
  milliseconds. A failed step, a clear (the INIT waveform) or a boot sends the
  next picture whole. A new scene runs GC16 over the whole panel and a change
  in the same scene goes as a partial update, while someone taps one DU over
  all of it with greys as a halftone and their real greys 2.5 s later
  (docs/realtime-rendering.md, "Partial refresh on e-paper"). The console
  prints `it8951: N rect(s) up in … ms, GC16 in … ms` or `it8951: partial[
  fast], N rect(s) (G grey) up in … ms, waveform … ms` per refresh. The
  preset picks the E1003's variant: VCOM -1.40 V, columns that run right to
  left (rows go out mirrored, as Seeed's GxEPD2 and Gray16 examples, FastEPD
  and Zephyr's board file have it), and a temperature the controller must be
  told before every refresh — Seeed's driver says it skips the refresh
  without one — taken from the board's SHT40 (`fos_climate.c`, 16 °C without
  a reading). The HAT's variant: VCOM -1.50 V, the Pi driver's default.
  `it8951:` on the console at the first refresh prints the controller's
  firmware, LUT and VCOM; each refresh's line carries the temperature it
  was told. The E1003's GT911 touch
  panel shares the clock's I2C bus (19/20): `fos_i2c.c` lends `fos_touch.c`
  that bus instead of the touch driver opening a second one on the same pins,
  and a lent bus survives the console's `i2c` rescan. Its preset binds the
  Indicator's edge swipes besides the keys: in from the left `back`, from the
  right `forward`, up from the bottom the scene switcher, down from the top
  the scene's settings (docs/buttons.md; `fos_board_keys_gen.h`). The 8 MB module renders
  on-device in pixie's **8-bit luma canvas** (`pfGray8`; every grey or black-
  and-white panel gets one whatever fits, a colour panel too big for RGBX gets
  565): 2.5 MiB of canvas and 1.25 MiB of packed panel buffer beside the
  1.5 MiB render reserve, about 2.5 MiB more for scenes and apps than a 565
  canvas (5.0 MiB) would leave. A grey panel loses nothing to it: blending
  is per channel, so the luma of a composite is the composite of the lumas,
  and 256 levels feed at most 16. The boot log says `canvas: 1872x1404
  gray8`.
  **None of this has met an E1003 yet.**
- **Seeed SenseCAP Indicator D1 / D1S / D1L / D1Pro** — an ESP32-S3 (8 MB
  flash, 8 MB octal PSRAM) next to an RP2040. The 4" 480x480 ST7701S IPS
  glass hangs off the S3's parallel RGB interface: sixteen data lines
  (B0..B4 = GPIO15..11, G0..G5 = GPIO10..5, R0..R4 = GPIO4..0), HSYNC 16,
  VSYNC 17, DE 18, PCLK 21 — so GPIO21 is not a heartbeat LED here. The
  LCD peripheral scans continuously: three PSRAM frame buffers (a new
  picture goes into one that is neither scanned nor waiting to be, and is
  switched in at a frame boundary, so the glass never shows half of each and
  the next render never waits for the switch) feed two 20-line bounce buffers in
  internal RAM that an interrupt refills. That refill is the fragile part:
  PSRAM shares one bus with the program flash, and the generic image runs a
  160 MHz CPU, DIO flash (QIO on a frame flashed over USB since 2026-10-25)
  and 80 MHz PSRAM, so the pixel clock is 12 MHz
  (42 fps; Seeed's 18 and ESPHome's 16 dropped frames on the bench while a
  finger moved on the glass), the refill interrupt and the render task
  share core 1 (the render's bulk copies pause while it runs), big heap
  reallocs copy outside the heap's spinlock (`fos_heap_realloc`: the IDF
  heap copies with interrupts off, which held the refill off for 1-2 ms),
  the driver restarts the DMA at the next vertical blank after a frame that
  still starves (not `CONFIG_LCD_RGB_RESTART_IN_VSYNC`, whose restart at every
  blank kept a stale refill count and ran the picture one bounce buffer
  ahead, the top of the next frame on the bottom rows), and
  the "skip an unchanged picture" hash is not written to flash (a flash
  write switches the cache off and stalls the refill; an LCD comes up blank
  after a reboot anyway). Any other flash write (a settings save, an OTA) still
  costs one disturbed frame. A scene store is hundreds of them, so from the
  first write of a push to the new set's first picture the glass shows the
  FrameOS mark on black with "Updating" under it, the boot splash's drawing
  with the word clipped out of its "Updating firmware" line, so it costs no
  bytes of its own (`fos_lcd_st7701s_updating_begin`): where a write tears it the
  bands are black, no picture is presented over it, the picture from before
  stays in its buffer and comes back if the store fails (or after a backend
  sync's write, whose scenes show at the next render as before), and a timer
  ends it after two minutes whatever happens. `lcd` on the console
  counts dropped frames and late refills and sets the pixel clock live.
  From the moment the panel is up until the first picture it shows the
  FrameOS mark on black, its three squares walking the brand colors
  (`components/frameos_display/lcd_splash.c`, the mark rasterized from
  `frameos_mark.svg` by `frameos/tools/gen_splash_mark.nim`), at priority 1
  so the boot under it is not slower, and under it what the boot is waiting
  for once that has lasted a second: "Connecting to Wi-Fi", "Updating
  firmware", "Starting" (`fos_display_boot_status`). A scene switch that has
  not put its first picture up within 200 ms gets three pulsing dots over
  the picture still showing, drawn by a task on core 0 until the next
  picture (`components/frameos_display/lcd_loading.c`, host-tested; the dots
  are the runtime's `frameos/loading_mark.nim`; `docs/realtime-rendering.md`
  "A switch that takes a while"). An LCD does not wait for the clock: it renders once Wi-Fi is up and again when SNTP answers
  (`fos_wifi_set_late_time_hook`); the boot used to wait up to 10 s for it.
  An LCD board runs its CPU at 240 MHz, and so does any board whose touch
  controller answers at boot (the reTerminal E1003 and Sticky: someone at the
  glass waits for every frame); the generic image boots at 160 for the other
  battery frames, and `status` prints `cpu:`. The scene canvas is the
  panel's own back frame buffer (`fos_display_render_target`, 565 whatever
  the PSRAM): the scene draws straight into it, and the blit is a buffer
  switch — no pack, no copy, no hash. A scene whose `refreshInterval` is
  below a second **animates** (`main/fos_animation.c`): frames paced in
  microseconds, the pulls and sensors once a second, one frame in ten logged
  in full with a `render:animation` summary of the rest. DVD Logo Bounce
  runs at 19.6 fps there (one frame per 300 s before, ~570 ms a frame when
  forced); `docs/realtime-rendering.md` has the measurements and
  `docs/realtime-todo.md` what is left. The controller's own
  setup goes over a 9-bit 3-wire SPI bit-banged on GPIO41 (clock) and GPIO48
  (data) with chip-select and reset on a TCA9535 IO expander at 0x20 (SDA39/
  SCL40; later batches carry an HT8574 at 0x39), the sequence Seeed's own
  firmware sends; the backlight is GPIO45. All of it is
  `components/frameos_display/lcd_st7701s_rgb.c`, a board table the preset
  selects (or, with no preset, the panel key: `test_fos_lcd_board.c`) — one
  entry per board: the Indicator's 480x480, the Guition ESP32-4848S040's (the
  same ST7701S glass, its chip-select GPIO39 instead of the expander's, no
  reset line and no expander, so the panel key alone is the Indicator's and
  the Guition needs its preset) and the Sunton
  ESP32-8048S070's 800x480 EK9716 (whose pins, framing and backlight GPIO2
  differ but which takes no SPI setup at all, so the same driver serves all three;
  the size is a runtime value, `fos_lcd_st7701s_size`, and `fos_display_init`
  refuses a panel table entry that disagrees with it) — and the panel is
  `LCD_ST7701S_480x480` (or `LCD_EK9716_800x480`) in a new pixel format,
  `FOS_PIXEL_RGB565` (one little-endian 5/6/5 word per pixel, pixie's
  `pfRgb565` layout; the canvas stores with pixie's per-pixel dither so a
  gradient does not step every eight levels, and the snapshot goes out as a
  24-bit BMP). The FocalTech FT6336U touch controller
  (0x48) sits on the expander's bus with its interrupt and reset lines on the
  expander, unwired to the chip: `fos_touch.c` joins the display's bus
  (`fos_display_shared_i2c_bus`) and polls it every 10 ms, from core 0 (the
  render's is the other). A press away from the edges is reported 20 ms after
  it lands, where the thumb has rolled to by then (read at once, a key tap
  "moved" 16 to 106 px and was a drag), or where it began when it slid
  sideways a tenth of the glass meanwhile: the FT6336U tracks one point and
  glides it from one thumb to the next (`fos_touch_glided`). The top button is
  GPIO38; held, it walks to the next scene. The glass sits upside down on
  the panel, so the driver mirrors both axes (`fos_board_touch_mirror`), and
  a finger's arrival is a `pointerMove` to where it landed before its
  `pointerDown`, as on a Pi. The TF socket, the buzzer and the
  CO2/VOC sensors are the RP2040's (UART 19/20 from the S3; not driven), so
  assets live on the state partition instead (`fos_assets_flash.c`, a VFS
  over `/state/a` at the assets path): a handful of photos in the 1 MB
  partition, names of 28 bytes at most (`photos/kitchen.jpg` fits; longer is
  refused, never truncated), and every write leaves 128 KB free for the
  scenes. `status` prints `assets_flash:` with what is left.

  **The internal storage beside a card** (PR #863): those same files are
  mounted at `/srv/internal` (`FOS_ASSETS_INTERNAL_PATH`) on every board with
  the state partition, card or none; `status` prints `internal:`. Where the
  card slot is off they are the assets folder as well. JS apps see the places
  as `app.frame.storages` ("TF card", "Internal storage"; the internal storage
  alone where it is the assets folder too) and reach one with the asset
  calls' `storage` option: Books and Files list both. The control planes
  browse both too: every device asset route takes a `storage` query
  parameter (`assets` by default, `internal`), every cloud asset command a
  `storage` field, echoed in its replies, and listings report `storages` and
  `storage`. A request or a cloud job runs in its storage through a per-task
  scope (`fos_assets_use_storage`; `fos_http.c`'s `IN_ASSET_STORAGE`,
  `fos_cloud.c`'s `ws_handle_asset_verb`), so the rest of `fos_assets.c` is
  unchanged; a storage the frame lacks is `storage_unavailable`.

The TRMNL X (10.3" 1872×1404 parallel e-ink over EPDIY/FastEPD) is not yet
supported — it needs a parallel display driver class this component does not
have. Of the boards TRMNL's firmware builds for the IT8951, the E1003
(`TRMNL_X_E1003`) is the `seeed_reterminal_e1003` preset; the TRMNL X, the M5
PaperS3, the LilyGO T5 Pro and the Sensoria boards drive their glass without a
controller, as does the original M5Paper's ESP32 (not an S3) with an IT8951.

## First boot and provisioning

Unprovisioned devices start a captive portal: join the `FrameOS-XXXX` Wi-Fi network
and any page redirects to the setup form (Wi-Fi, backend URL, frame ID/API key,
panel, render mode). A board flashed from a FrameOS backend or the cloud is
provisioned over the USB console instead (below) and never sees the portal;
the frame's HTTPS certificate — the same per-frame material the Linux
runtime serves with OpenSSL — arrives with its first `/embedded/settings` pull.

A **touch board** (a touch panel found at boot: the SenseCAP Indicator's and
the Sunton's LCDs, and the fast e-paper of the reTerminal Sticky and E1003,
`fos_wake_wifi_plan` in `fos_wake.c`, `touch_setup` in `main.c`) never opens
the portal and never holds its first picture for Wi-Fi: it starts its scenes
at once and joins the stored network in the background
(`fos_wifi_start_background`), retrying quickly and then every 30 s for as
long as it takes. What a boot that waited does once online (SNTP, log upload,
the `bootup` line, the OTA check) runs the first time the station gets an
address, and the scene renders again if it drew before the join (a join that
beats the first render costs no second refresh). The first render does not
wait for a cloud session's queued commands either: they render after. A deep
sleep waits up to 45 s after boot for that join (`sleep:held` `wifi`), so a
battery frame woken by a tap does not go back to sleep before its picture had
the network. A sleeping e-paper board's timer wake, which nobody tapped, holds
its one render for the join, up to that same 45 s after boot, while the
runtime and the scenes come up; a touch, a key or a console event ends the
wait (`wifi:wait`, with how it ended), and a join that does not come opens no
portal: the board draws without it and sleeps again (on 2026.11.14 a Sticky or
E1003 that could not reach its network waited 21 s and then sat on the portal
for good, no scene drawn, a battery board awake until its network came back).
The network is set on the screen: a swipe down from the top opens the
settings panel, whose gear opens the frame page with the Wi-Fi status, the
networks in range by name and a password field, the rotation, the scale, and
Render again and Reboot (`fos_frame_settings.c`, docs/scene-settings.md "The
frame page" and "A boot that does not wait for the network"). A frame no
plane holds, online, also offers Connect (docs/scene-settings.md "Connecting
the frame"): FrameOS Cloud (a link code, flow B below) or a backend (an
adoption code, the local network access ceremony's six digits in the `adopt`
scope), either shown on the page with a QR code, and while one is under way
the preview snapshot stays empty (`fos_frame_settings_code_pending`), so no
image carries it; the overlay draws only the local network access code. The
backend reads `GET /api/adopt` (whether a code shows, then the platform,
panel, preset and size) and posts `{code, backend, apiKey, frameId}` to
`POST /api/adopt`: no login (the code is the credential; a malformed body
costs no attempt, a frame with a backend or a cloud link answers
`409 managed`), and on the right code the three keys are saved and the board
restarts as that backend's frame. A board with no
network saved and no scene opens on that page; one off its network with no
scene shows the status screen, which says to swipe. The frame's control plane can
turn the page off (`frame_settings_on_screen`); `set settings_unlock 1` on this
console turns it back on whatever the plane says. Every other board keeps the
45 s wait and the portal, and so does a touch board's boot that was asked to
update (it joins first, then runs the updater).

The serial console (115200) is always available and quicker for development.
It answers on whichever USB port the board brings out: the chip's own
USB-Serial/JTAG device ("USB JTAG/serial debug unit" — XIAO ESP32-S3) and
UART0 behind an on-board USB-UART bridge ("USB Single Serial" — the Seeed
reTerminal E10xx wire USB-C to a CH340 on UART0 and leave the chip's USB pins
unconnected; the PhotoPainter 13.3" has both). `sdkconfig.defaults` makes
UART0 the primary console and USB-Serial/JTAG the secondary: stdout reaches
both, and `fos_console.c` reads commands from both drivers. GPIO 43/44 (U0TXD/
U0RXD) are therefore off-limits for panel or button pins.

The UART console runs without flow control, by decision rather than
omission: a CH340-only board wires neither RTS nor CTS, and no host tool the
firmware is driven by (the cloud flasher, the backend, `usb_api` scripts)
speaks XON/XOFF, so the driver's 8 KB receive ring is the whole buffer. Two
mitigations in `fos_console.c` stand in for it — the console task climbs
above the render task for as long as a `usb_api` payload is on the wire
(`FOS_CONSOLE_PAYLOAD_PRIORITY`), so the ring is drained the moment the ISR
posts even on the single-core C3, and the payload timeout scales with the
payload size and the channel's bit rate (`fos_upload_limits.h`) instead of
being a fixed wait. A host that floods faster than 115200 baud sustained is
not a case this can cover; the USB-Serial/JTAG channel has its own flow
control at the USB layer and does not need either.

A `usb_api` command may end in LF or in CR LF (a terminal, most serial
scripts). The console runs a line at either, so a CR-ended command's LF is
drained before `READY` (`usb_api_ready`): it used to be read as the payload's
first byte, leaving the last one on the wire, and an upload stored cut short
replaced the frame's scenes with one the runtime refused. The store now
refuses a payload that does not open and close as one JSON array or object
(`fos_json_whole`).

```
frameos> status
frameos> wifi MySSID MyPassword          # saves and reboots
frameos> set panel EPD_7in5_V2
frameos> set pins rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1
frameos> set render_mode local           # or: remote (rendered on the server)
frameos> set deep_sleep 1                # battery mode: deep sleep between refreshes
frameos> set wake_schedule 1             # align wake to wall-clock interval boundaries
frameos> set battery_pin 2               # ADC1 GPIO tapping VBAT (-1 = none)
frameos> set battery_divider 2.0         # Vbat = Vpin * divider
frameos> set frame_settings_on_screen 0 # hide the settings panel's frame page (the plane's switch)
frameos> set settings_unlock 1           # show it whatever the plane says, until set back to 0
frameos> set layout layout-reterminal-sticky # the frame's own layout (none: no layout, -: each scene's own), at the next start
frameos> render                          # render immediately
frameos> ota                             # check for an OTA update now
frameos> factory-reset
```

## Flashing from flash.frameos.net

`flash.frameos.net` (`cloud/docs/flasher.md`) flashes and provisions a board
with no account: a **standalone** ESP32-S3 (a hardware preset or a panel,
`hostname`, `time_zone` and the Wi-Fi over this console, and starter scenes
with `upload-scenes`; no `backend`, no `cloud_url`), a frame of a backend
reached over **plain http** (a page there has no Web Serial, so the backend
hands the flasher the frame in a window of its own), or a frame saved as a
**setup file**. It runs the same engine as the backend's buttons
(`frontend/src/scenes/workspace/embeddedFlashRun.ts`) and writes only images
the FrameOS release key signed for that release and layout. A standalone
board has no OTA source (the manifests are the planes' routes): its board
tools write a new release around the NVS partition over USB.

## Provisioning from a self-hosted backend

A self-hosted backend flashes a blank board exactly like the cloud does:
the deploy drawer's **Flash latest release** writes the published image for
the board's chip and flash layout
(`frameos-<version>-esp32-{s3,c3}-{generic,4mb,8mb,16mb,32mb}.bin`; the
generic pair is the 8 MB S3 / 4 MB C3 layout) and then sends this frame's
settings over the USB console. Nothing is compiled. **Apply frame settings**
under USB setup replays the same list on a board flashed by hand, and the
device pulls whatever a console line cannot carry (its HTTPS certificate and
key, the service API keys, the schedule) from `/embedded/settings` once it is
on Wi-Fi. A backend reached over plain http has no Web Serial in its page:
its USB card opens flash.frameos.net, which does the same over the cable
(above).

After a render the device posts the image its panel shows to
`/embedded/image` (the BMP `/image` serves, streamed off the packed snapshot;
an unchanged panel the backend already has is not sent again, and pushes
are at least 10 s apart). The backend cannot pull it reliably: the frame
deep-sleeps between renders and answers no mDNS, so its `frame<id>.local`
default never resolves. That name gives way to the address the frame boots
with. The cloud gets the same image with `image_get`.

### Commands and state across deep sleep

A battery frame is a fresh boot on every wake and gone again seconds later,
so the backend never pushes to it. What the workspace asks for — a scene
switch, a scene state, a render, a reboot, a firmware update, a deploy — is a
row on the frame's command queue (the backend's `frame_command` table, the
cloud's `frame_commands`; `docs/cloud-frames.md`, "Queue observability"),
and the frame drains it (`fos_commands.c`, firmware 2026.10.5 and later; the
backend keeps pushing to older firmware directly):

- Once per pass, after the scenes and settings pulls and before the render:
  `POST /api/frames/{id}/embedded/commands` with what it holds and shows
  (the cloud hello's `frameos_version`, `active_scene`, `states` and
  `scenes_checksum`, plus `settings_etag`), answered with the queue, oldest first, as the cloud's
  command frames (`{id, type, ...}`). Each runs through the same verb
  handlers a cloud verb takes (`fos_cloud.c`) and is answered with
  `POST .../commands/{id}/ack` `{ok, error?, active_scene?, states?}` the
  moment the handler acks, so a reboot's ack is on the wire before the chip
  goes down. A switch queued this way lands in the same pass's render.
- Whenever the backend nudges an awake frame: `POST /api/action/commands` on
  the local HTTP server (`?sync=1`, which a deploy sends, also forces the
  scenes and settings pulls) wakes the render task to pull at once, so a
  mains-powered frame takes a queued command within a second. A sleeping
  frame does not answer the nudge; its next wake pulls.
- A deploy is never a push. The backend records `set_scenes` and
  `set_settings` rows and acks them itself when the ETags the frame reports
  match what it serves — on the wake that applied it, never when it was
  queued. The frame's sleep line (`{"event":"sleep","wakeInSeconds":…}`)
  gives the backend the wake forecast the workspace shows and a queued
  command's TTL reaches past.
- A pass that outlasts its interval does not reboot straight into the next
  one. The interval counts from when the render was due, so a render and a
  panel refresh longer than it leave the next render already due, and a
  deep-sleeping frame slept the one-second minimum, rebooted and rendered
  again, without rest, on battery (a 13.3" rainbow clock: a 60 s interval,
  4.3 minute passes, 2026-10-27). It rests at least as long as the pass ran
  (`fos_wake_rest_ms`) and logs `{"event":"render:overrun","intervalSeconds",
  "passSeconds","restSeconds"}` saying so.

Scene state used to last one render on such a frame. The runtime keeps each
scene's public state (and its `persist: "disk"` fields) in a file per scene
under /state (`fos_scene_state.c`, `/state/st-<hash>.json`), writes it when
it changes and seeds the scene from it when the scene is next built — the
Linux runtime's `./state/scene-<id>.json`, for the chip. The name is 32 bits
of hash, and two ids can be made to share one, so the file's first member names
the id it belongs to (`{"__owner":"<id>", ...}`) and a scene is handed no file
that names another (a file from before 2026.11.15 has none: the scene that
reads it first takes it, and it is written again with one; firmware from
before reads a file with one as it always did). Only values off
their declared default are written (a default in the file would outlive the
redeploy that changes it), and the file carries a `"__persist": 2` marker: a
file without one was written by firmware that still pinned defaults and is
dropped the first time it is read, so the deployed defaults win. State for a scene
that is not resident (a wake-check pass, a switch carrying state) goes to the
file right away, so a deep sleep in between loses nothing. Writes go
behind: a change waits in RAM and reaches the flash after a minute, ten on
an RGB LCD (later changes ride along), before a deep sleep and before a
restart. A SPIFFS write that erases a block holds the flash cache off for
50-100 ms, which stalls both cores and makes an RGB LCD scan garbage, and the
touch test's taps are disk fields: one write per tap flickered the SenseCAP
Indicator. A slideshow's photo counter is one too: written every minute it
still erased a block every several minutes. Both control
planes get it: the cloud hello and the commands pull report the persisted
state even before the first render, keyed by scene id.

A scene switch outlives the sleep the same way. The render task applies a
queued selection (`set_scenes` with a scene to activate, `setCurrentScene`)
at the start of a pass, and a verb that lands while a pass is already
rendering used to sit in RAM until the deep sleep right after the render
dropped it: an "install and activate" reached an E1004 on a button wake, the
frame rendered the old scene, slept, and every later wake came up on the old
scene with the new one merely stored (2026-10-12). Now `fos_scenes_select`
writes the queued id to NVS (`pending_scene`), the boot restore prefers it
over `last_scene`, the pass that applies it erases it and writes
`last_scene` too — resident because of the pending key is not persisted,
and skipping that write sent the frame back to the old scene on the next
timer wake (2026-10-12). Both marks a switch makes on the render task (a tap
on the switcher, the apply) are owed, not written there: the state writer
puts them in one NVS commit when nobody taps, and a deep sleep or a restart
flushes them first (`fos_scenes_flush_marks`), as the scene state; each was a
flash write between a tap and the new scene's first picture. And a pass that
switched the scene — or applied a payload pushed since boot — renders even
when it woke only to check in (`fos_scenes_take_switched`). Work that lands
mid-render holds the deep sleep for one more pass (`sleep:held`, reason
`scenes`) so the switch shows on the same wake.

A `scene_event` (`setSceneState`, a button, a custom event) meets the same
timing: the cloud delivers it the moment the session is up, the wake's render
already holds the runtime, and the handler used to answer `busy` after three
seconds — an answer the hub never retries, so no state ever reached a
sleeping frame. Scene code also runs on the render task alone: a scene event
from HTTP, the cloud or the console is queued for it (`fos_events_defer`, 16
slots, a newer pointer move replacing a waiting one, `event:dropped` when
full), delivered at the start of a pass or in the idle wait, rendered by the
scene's own render rule, and counted as work that holds the deep sleep. The
first `/event/pointerMove` over HTTP had compiled the scene's JS on the 8 KB
HTTP task and crashed the frame (2026-10-26).

The cloud log tap only runs while the session is up, so the first ~15 s of a
wake (the wake cause, the scene load, the replayed button press) and
anything logged while the socket was down (the `ota:cloud error` of a
download that died in a socket flap, E1004 2026-10-12) used to stay on the
device. Every session_ready that carries logs now replays the lines the hub
has not had from the device ring as one `log_batch` with their own
timestamps (`ws_replay_missed_log`, by the ring sequence each line carries).

Every panel driver is compiled into every image and each frame value has a
`set` key here, so the command list — the backend's
`embedded_provisioning_plan` (`backend/app/tasks/embedded_firmware.py`) —
is the whole difference between a stock image and this frame. By hand it is:

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

Flow B, the link code, is the frame page's Link to cloud: the
cloud task POSTs `{provider}/api/device/start` (`cloud_url`, else
`https://cloud.frameos.net`; `client_kind: "frame"`, scopes `frame:link` and
`frame:managed`), the page shows the code and where to enter it, the task
polls `/api/device/poll` at the given interval, and on approval enrolls at
`/api/frames/enroll` with the device-flow token as its Bearer in place of a
claim token. That token is the frame's access token from then on, and a
default provider is written to `cloud_url`. Nothing of a pending link
outlives a reboot; a window that lapses unclaimed just ends, and a pending
one holds the deep sleep.

Expected `status` line while waiting for enrollment:

```
cloud:       pending url=https://cloud.frameos.net claim_token=(set) ws=off
```

and after enrollment (`GET /status` carries the same data under `"cloud"`):

```
cloud:       enrolled url=https://cloud.frameos.net claim_token=(none) frame=… ws=connected
```

A `set backend` on an enrolled frame (a bench setup) keeps the enrollment but
hands the content to that backend: the frame refuses the cloud's scenes,
settings and schedule (`backend_managed`) and reports the backend's origin as
`hardware.backend` on every hello, so the cloud says so on the frame's page.
`set backend` and `status` print a `note:` with the way back, and the first
hello without a backend gets the cloud's settings, schedule and scenes again:

```
frameos> set backend ""
frameos> set api_key ""
frameos> set frame_id 0
frameos> restart
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
actually hot-loaded the payload), `set_settings` (the `name`
subset), `image_get` (the packed framebuffer as BMP, built a row at a time
straight off the boot-time framebuffer reservation — since 2026.8.43 the
preview snapshot borrows that buffer instead of copying it, and the stream
allocates one 24 KiB chunk, so an 8 MB board with a 960 KB panel can finally
serve one; an `image_get` that arrives before the wake's render waits for it,
and the deep sleep holds while the stream goes out), and the full asset verb
set — `assets_list`,
`asset_get`, `asset_put`, `asset_mkdir`, `asset_delete`, `asset_rename` —
against the mounted SD card (shared implementation in `main/fos_assets.c`,
also behind the local HTTP asset API and `usb_api list-assets`).
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
rendering. `factory-reset` erases all cloud state, including the device key,
and wipes the `/state` partition (scenes with whatever secrets their node
fields carried, the schedule, cached payloads); the SD card is the owner's
and is left alone (`sd format` if it should go too).

A single management WebSocket message is capped at **512 KiB**: it is held
in memory whole, with its JSON tree beside it. Larger frames are dropped and
acked `message_too_large`. The cap is on one message, not on what the frame
stores ("How big a set may be" below): a set grows past it a `scenes_patch`
at a time, and the cloud sends a push that would be over it as several
(docs/cloud-frames.md "A set in parts": each patch against the checksum the
one before left, the next sent on this firmware's `scene_ack`, so
`base_checksum` and when `s_applied_scenes_checksum` moves are part of that
contract).

Secrets at rest: `cloud_sk` (the Ed25519 seed), `cloud_token`, the unspent
claim token and the WiFi PSK live in NVS in plaintext unless the board is
provisioned with ESP-IDF flash encryption. The firmware never prints or
echoes them, but physical access to an unencrypted module means physical
access to the link — see the "Secrets at rest on ESP32" note in
`docs/cloud-frames.md`.

## Local network access

While the frame is cloud-managed or renders cloud-pushed scenes, every scene
HTTP request and every redirect hop goes through `fos_netguard_check_url_pinned`
(`frameos_nim_glue.c`), and a private answer fails the node with

```
Local network access is off for this frame (homeassistant.local resolves to private address 192.168.1.5). Turn on local network access in the frame settings.
```

(`FOS_NETGUARD_BLOCK_FMT`: the prefix is what the SPA's logs panel matches,
and the error buffers always hold the whole sentence). The connect is pinned to
the address the check resolved: `fos_netguard_pin_for_task()` holds it for the
calling task across `esp_http_client_open()`, and
`lwip_hook_netconn_external_resolve` (`CONFIG_LWIP_HOOK_NETCONN_EXT_RESOLVE_CUSTOM`,
`sdkconfig.defaults`) answers that task's lookup of the name with it, so a
DNS-rebinding name cannot answer the connect's own query with a private
address. `docs/lan-access.md` is the cross-plane spec.

The switch is `config->allow_local_network`, NVS `allow_lan`, off when absent.
The USB console's `set allow_local_network 1` turns it on directly (the cable
is physical presence), and the cloud changes it with two verbs on its socket
(the backend's command queue does not carry them, `backend_verb_allowed`):

- `lan_access_challenge {}`: mints six digits (`fos_lan_access.c`, rejection
  sampled from `esp_random()`, 300 s, five tries, constant-time compare) and
  acks; `no_panel` on a headless board, `rate_limited` once ten wrong codes
  have been given within a window of the first of them, across challenges.
  The first window is an hour; each one that saw a wrong code makes the next
  twice as long, up to 128 hours, and thirty days without one make it an hour
  again (docs/lan-access.md says why). A right code does not reset it; the
  count lives in RTC memory and the clock is the RTC's own count since
  power-on (`esp_rtc_get_time_us`), not the time SNTP sets, so neither a
  `reboot`, a deep-sleep wake nor a time server that lies refills it, only a
  power cycle does. The render task picks it up within a
  second and renders: after the packed buffer is hashed, `render_once` saves
  the bytes under a centred box, draws "Local network access code" and the
  digits (`fos_panel_draw.c`, upright for the frame's `rotate`), blits, and
  puts the saved bytes back before `store_snapshot`, so `/image`, `image_get`
  and the image push never carry the code (with no memory for the copy the box
  is painted white instead). The display-state hash is forgotten, so the first
  render after the code ends refreshes the panel even when the scene did not
  change, and a pending code holds the deep sleep
  (`keep_awake_remaining_seconds`). Every end (the right code, the fifth
  wrong one, expiry, a new challenge) renders once more.
- `lan_access_set {enabled, code?}`: `invalid_lan_access` without a bool;
  `false` saves at once and takes a pending code off the panel; `true` needs
  the code (`code_required`, then `rate_limited` before the challenge is
  looked at, `code_expired`, `invalid_code`, `too_many_attempts`), then saves
  (`persist_failed`). A successful one is followed by a `state` message.

The cloud reads the value from `hardware.lanAccess` (hello and every
`state`). The code itself is in no ack and no log line: the log says
`lan_access:challenge`, `lan_access:shown`, `lan_access:refused` (with the
token), `lan_access:on` and `lan_access:off`.

## Power management (M4)

`deep_sleep` powers the chip down between refreshes; with a panel attached the
render task calls `esp_deep_sleep` and the device cold-boots for the next pass.

`wake_schedule` changes how the sleep duration is computed: with a synced clock
it aligns the wake to the local clock's interval boundaries (a 1h frame wakes at
the top of the hour, a 5-minute frame on :00/:05/..., a daily frame at local
midnight — in the frame's `time_zone`, else the provider's flat UTC offset, the
same clock the schedule reads; DST included, `fos_wake.c`), so clock faces
update on time. Without it (or before SNTP syncs) the time already spent awake this cycle
— boot, Wi-Fi, render — is subtracted from the interval so the cadence doesn't
drift by however long a render took.

`deep_sleep_on_battery` deep-sleeps between refreshes only while a battery is
detected on `battery_pin` (cell voltage above ~2.5 V — the best power-source
signal we have; no supported board exposes VBUS on a readable pin, so a
plugged-in-and-charging frame counts as "on battery" too, which just means it
sleeps while charging). Without a configured battery pin the flag never fires
and the frame stays connected. A board whose charger or fuel gauge says where
its power comes from (the reTerminal E-series, the Sticky) counts USB as not
on battery, and its idle wait looks every 5 s: USB pulled out makes a pass at
once, not the scene's next render an interval away. The cable coming out, and a
cold boot on the cell (the power key), count as a tap: someone has the frame
in hand, so it stays up `awake_input` before it sleeps.

A frame going to sleep on e-paper with a fast waveform (the reTerminal Sticky
and E1003) puts a small sleep mark in the scene's top-right corner first: a
crescent moon with a "z" on a white tile, drawn over a copy of the last
picture in the fast waveform (`draw_sleep_mark` in `fos_client.c`,
`fos_panel_draw_sleep_mark`), never into `/image` or a push. It is drawn once a
picture (a check-in wake that drew nothing leaves it there, `s_sleep_mark_on_glass`
in RTC memory), and the first render after a wake draws over it, an unchanged
scene included. An LCD goes dark asleep and a classic panel's full refresh
costs too much for a mark: neither draws it. A tap or a key that wakes a frame
asleep under its moon turns the moon into a loading ring at once
(`fos_client_wake_mark_begin`, `fos_panel_draw_wake_mark`, one update in the
fast waveform) and starts the quiet loading chirp (`touch_beep` on), until the
first render puts the scene up: the boot is seconds, and a frame that answers
nothing gets tapped again and again. Once, not a spinner: after a deep sleep
the glass outside the tile is unknown (both buffers say white there) and the
SSD1677 drives the whole panel on a partial update whatever its RAM window
says, so every frame greyed the picture, and a spinner left it grey by its end. How
long a tap keeps the frame up is `awake_input` below, on the frame page too.

`awake_input` (`awake_after_input_seconds` on the control planes, seconds, default
300, 0 = off) keeps a deep-sleeping frame up after a press or a tap, as an awake
frame with its interpreters and partial updates, so the next one is answered at
once, and sleeps when the window closes (not at the scene's next render); a
nearly flat cell still sleeps.

`wake_check` (seconds, 0 = off, floored to 60) makes a deep-sleeping frame
wake at least this often to check the control plane for queued commands. The
scheduled render's due time survives the reboot in RTC memory, so a check-in
wake connects, applies whatever is queued (`set_scenes`, `set_settings`,
schedules, OTA nudges — each arriving cloud verb holds the device awake for
15 s so a burst completes) and goes back to sleep **without** refreshing the
panel; an explicit `render` command still repaints immediately. It sleeps
until the render that was scheduled, not an interval from now: a pass that
renders nothing builds no scene, so the interval it could work out is the
frame's own or the scene's declared one, not the "Refresh interval" saved on
the frame nor a sleep the scene asked for itself, and sleeping the shorter of
the two moved a render a day away to five minutes after the first check-in
(a reTerminal E1002, 2026-11-18). Only a cell too low to render keeps its own
long sleep.
The due time is kept on a frame whose clock was never set too (a network
that answers no SNTP): it and "now" come off the same counter, which runs
through a deep sleep either way. Until 2026.11.12 such a frame kept none, so
every check-in wake rendered (its `sleep` line says `nextRenderAt=0`); a
plane is still told a date only off a clock that was set. Before any
deep sleep a cloud-enrolled frame also holds the boot open up to 20 s for the
management socket, so queued commands are not lost to a race with the sleep.

**Wake on button (2026.8.42).** Right before `esp_deep_sleep` every
registered `gpio_buttons` pin that sits on a wake-capable pad — an RTC IO
(GPIO 0-21) on the ESP32-S3, GPIO 0-5 on the ESP32-C3 — is armed as a wake
source (`ext1` any-low on the S3, `esp_deep_sleep_enable_gpio_wakeup` on the
C3; the RTC_PERIPH domain stays powered so the internal pull-ups hold), next
to the timer. A press brings the frame back early: the boot notes which pin
woke it (`fos_buttons_wake_boot`), hands that press to the scene as the usual
`button` edges (`"wake": true` on its `down`) on the first render pass, and that pass
renders instead of counting as a command check-in. A key still held at the
moment of sleep is skipped for that sleep only (any-low would wake the chip
instantly). `buttons:listening` lists `"wake"` per pin, the `sleep` line
lists `wakeButtons`, `status` prints `wake_on_button`, and the `metrics`
sample carries `wakeCause` (`timer` / `button` / `power_on` / `restart` /
`panic` / `watchdog` / `brownout`) so a battery graph can be read against
what actually woke the frame. The pure pin arithmetic is `fos_wake.c`, host
tested by `main/tests/test_fos_wake.c`; a button's debounce and press kinds
are `fos_button_timing.c`, host tested by `main/tests/test_button_timing.c`.

**Wake on touch.** A touch panel's interrupt line is armed beside the keys
(`ext0` on its RTC IO, `fos_touch_arm_wake`), on the level that leaves the
line's idle one, so a finger wakes the frame like a key. That needs the
controller powered and out of reset all through the sleep: its reset and
supply-switch lines are held (`gpio_hold_en`), and a held line keeps its
level only on a pad that keeps its supply. On the S3 GPIO26-37 and 47/48 may
run on VDD_SPI, the flash's supply, which every deep sleep switches off
(`FOS_WAKE_S3_UNHELD_PADS`); a controller reset from one of those is no wake
source (`fos_wake_touch_holds`, host tested): `touch:ready` says
`"wake": false` and the `sleep` line's `wakeButtons` leave its line out. The
reTerminal E1003's GT911 resets on GPIO48. Armed, its reset fell as the chip
slept, the controller let go of its line, the pad's pull-down took it low
and the frame woke at once with nobody at it, every time; with the line
pulled up instead it slept, and its GT911 came back at 0x14, the address the
chip takes when its reset rises over a high line (2026-11-24). So the
E1003's three keys wake it, and its glass sits in reset through the sleep,
which also draws the least. The Sticky's GT911 (reset GPIO41, supply switch
GPIO42) and the AMOLED 1.75's CST9217 (reset GPIO40) keep theirs. Asleep the
line belongs to the RTC mux, whose pull-down is on out of reset on GPIO2 and
GPIO21 and which has no pull at all on GPIO11: the line is pulled toward its
idle level instead, so a line the controller lets go of never reads as a
touch, one it drives high sinks nothing through a pull-down, and the
CST9217's open-drain line has the pull-up it needs.

**A press while awake.** The press cuts the render task's wait short
(`fos_client_wake_for_events`) so the scene hears the `gpio` edges and the
`button` they make within a poll, and a frame is drawn only when a scene listener took it or the scene
dispatched `render` — not for every press, which on a Spectra panel was half a
minute of refresh for a button nothing listens to. A scene's own
`setCurrentScene` dispatch switches scenes through the same queue the HTTP,
schedule and cloud paths use (`frameos_nim_set_scene_select_hook`).

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
  pool. An RGB LCD skips the wait on every boot, and renders again when the
  clock arrives.
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

**The reading itself** (`fos_battery_filter.c`, host-tested by
`main/tests/test_fos_battery_filter.c`) stopped being a mean. The old read
averaged 16 back-to-back samples, and two different faults both came out of
that as a confident, far-too-low number: a *minority* of samples returning
near zero (the mean is dragged down in proportion — four zeros in sixteen
turn a 4018 mV cell into 3013 mV), and the *whole* burst reading low because
the divider had not finished charging (16 samples span well under a
millisecond, so they all sit at the same point on the ramp and no average
recovers the truth). Across 2026-08-29..31, 20 of 293 on-battery samples on
E1002 and 44 of 396 on E1004 were wrong this way, the worst reading 1050 mV
against a true ~4018 mV. The read now takes rounds of 9 samples spread over
a few milliseconds, takes the **median** inside a round (killing the
dropouts) and the **highest** round across the read (killing the ramp) — the
maximum is the right estimator because every way this read goes wrong pulls
it down and none pushes it up, the same reasoning `fos_client.c` already
used when it kept the higher of two whole reads. A settled divider agrees
within 32 counts on the second round and stops there, so a healthy cell
costs about what it always did.

The `metrics` sample reports the **believed** millivolts, not the bare ADC
read: the hysteresis above already refused to act on an implausible drop, but
the metrics line went straight to the ADC, so a frame that correctly kept
rendering still told the cloud it was at 1 % and the battery graph grew a
cliff that never happened (E1004 reported 3062 mV at 16:38 and 3942 mV
fifteen minutes either side, 2026-08-31). When the two differ the raw sample
is reported alongside as `batteryRawMillivolts`, so a misbehaving divider
stays visible instead of being smoothed into silence.

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
but `ota:cloud downloading`. The OTA and the render pass take turns: a pass
that starts while the OTA is busy skips its render (`render:skipped
reason=ota`), and an OTA that arrives while a pass is rendering waits it out
(`ota:cloud waiting render`, up to 10 min) before touching the network — the
two shared one Wi-Fi link and three TLS contexts on ~80 KB of internal heap,
which is how E1004's download died at 1 MB of 3.2 MB (2026-10-12). The cloud
OTA logs `progress` every 512 KB,
names its failure (`download-failed:<err>@<bytes>/<expected>`,
`image-rejected:<err>`, `signature-rejected`), and after 3 consecutive
failures of one offered version stops re-downloading it (`gave-up`, kept in
RTC memory: a newer release or a power cycle resets it).

**Resumed downloads (2026-10-21).** Frame 70 (E1004) lost a backend OTA
12 KB into a 3.1 MB image, and the one line that survived the restart said
`download-failed:UNKNOWN ERROR@12420/3106000`: `CONFIG_ESP_ERR_TO_NAME_LOOKUP`
is off, so a timeout, a closed socket and a flash write error all printed
alike, and only the last of three attempts was kept. Three changes, both
planes:

- The slot is erased as the bytes arrive (`OTA_WITH_SEQUENTIAL_WRITES`, as
  `esp_https_ota` does by default). Passing the size to `esp_ota_begin` erased
  the whole image before the first read, seconds of flash work with the
  socket unread right after its headers.
- A connection that drops is resumed from the byte it stopped at
  (`Range: bytes=<written>-`, both planes answer 206; a 200 is read past),
  with the hash and the slot carried over. `main/fos_ota_download.c` keeps
  the budget (three connections in a row that add nothing, eight in all) and
  is host tested (`tests/test_fos_ota_download.c`). A resume logs nothing of
  its own (an `error` line would fail the deploy the resume is about to
  finish); the verdict carries it, `verified` as `rebooting (resumed after
  closed@12420)`. The manifest must carry `size` now (both planes always
  sent it): every length check reads it.
- Failures name themselves: `timeout`, `closed`, `read e<errno>`,
  `connect 0x<err>`, `http <status>`, `length <bytes>`, `short`, `write
  0x<err>`, `wifi`, each at the byte count it stopped at, and the verdict
  lists the run's tries:
  `download-failed:closed@12420/3106000 (3 tries: timeout@0, closed@12420, closed@12420)`.
  `image-rejected` and `set-boot-failed` carry the code in hex for the same
  reason. The serial console gets these lines through the log hook, so the
  download adds no `ESP_LOG` lines of its own.

The verdict the first pass replays after a restart (`replayed: true`) is now
only the early-boot updater's and `verified`; a line that left while the
uploads were live is not sent again on the next wake, where it would fail a
deploy started since.

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
- **Service settings survive a reboot.** Frames keep the six groups in NVS
  (`svc_cache` / `svc_etag` / `svc_at` / `svc_src`, same namespace as the
  bearer token; the keys typed on the frame page are `svc_typed` beside them,
  docs/scene-settings.md "Service keys") and apply them before the first render
  (`fos_settings_boot_apply_cache`, `settings:services origin=cache`). A
  deep-sleep cloud frame used to render its only pass with no service
  settings — `ready` asks for the pull after the pass has started, and the
  pass that would pull never comes — and every boot that did pull paid a
  full TLS handshake for a body that rarely changes. `ready` now skips the
  pull while the copy is under 6 h old; the queued `refresh_service_settings`
  nudge, a `403 insufficient_scope`, a demotion and `factory-reset` all clear
  or refresh it. The cache was cloud-only until 2026.10.10: a
  backend-managed frame whose backend was unreachable at wake (`settings:sync
  connect-failed`) rendered with no groups at all, and an Immich scene wrote
  "Please provide an Immich server URL in the settings" onto the panel. It
  now applies the cache too; its first pass still fetches (the backend poll
  also carries `frame` and the schedule) and a successful fetch replaces the
  groups and rewrites the cache, so the cache only decides what a pass
  renders with when the backend is down. `svc_src` names the source that
  wrote the blob; only a cloud ETag is seeded for a cloud frame.
- **`cloud:session_ready` says how the previous session ended**
  (`previousClose: {how, code}`, plus `session` count and `uptimeSeconds`):
  the E1004 redialed 17 s into some wakes with nothing logged between, and
  the close code only ever went to the USB console.
- **The emergency-reserve line names the request**: `a N-byte request with
  F bytes free, largest block L` — a shortage and a fragmentation dip look
  the same without it. The 1200×1600 Weather render dips every pass with
  2.3 MB free before it; the size is what identifies the allocation. A
  reserve that could not be armed again (`could not arm`, logged once) is
  tried after every pass until it is (`emergency heap reserve armed again`):
  left at the one try, the next failed allocation had nothing to release
  and aborted its render.
- **A script's "out of memory" says whose memory**: QuickJS has one message
  for a scene past its heap ceilings and for a heap with no free block of
  the size asked. The second now reads `out of memory (the frame's memory is
  short: no free block of N bytes, F free)`; the first keeps `(the scene's
  JS heap budget ...)` (`fos_js_take_refusal`, `describeJsError`).

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

Each deep sleep (firmware 2026.11.7+) also powers down what the sleep does
not need: right before `esp_deep_sleep` the firmware powers the ES8311 /
ES7210 down by register (analog sections, references, microphone bias),
holds the speaker amplifier's enable low, and on the Waveshare PhotoPainter
releases the panel's lines and switches its supply (the AXP2101's ALDO4,
EPD_VCC) off — the PMIC otherwise keeps every rail up through the ESP32's
sleep. It also stops the fast deep-sleep timer (~1%: a two-hour sleep woke
60-90 s early and booted twice) from costing a second boot: a wake up to 60 s
before the render renders, and a render wake sleeps 1/64 longer (at most
300 s). The next boot's normal init undoes all of it. A PhotoPainter running
a 2-hour scene went from ~40% of its cell a day (about 57 h from full) to
~3.6% a day. The GPIO button map
travels the same two ways since 2026-10-12: the backend's settings pull
carries `gpioButtons` (`[{pin, label}]`, present only when the backend holds
a map) and the cloud's `set_settings` carries `gpio_buttons`; the device
rebinds its buttons with a restart. Before that, a provisioned board's map
could only be changed over the console.

### Processor speed

The generic image boots every board at 160 MHz. `cpu_mode` decides whether
`main.c` moves it to 240 at boot: `battery` keeps 160, `performance` goes to
240, and `auto` (the default) goes to 240 on an RGB LCD or once a touch panel
answers, and stays at 160 on any other board. Set it with `set cpu_mode
battery|performance|auto` (next boot), "Processor speed" under the frame's
Power settings (`cpuMode` on the backend's settings pull, `cpu_mode` on the
cloud's `set_settings`, firmware 2026.11.7+; the device reboots to take it).
The console's `status` and the cloud's `hardware` (`cpuMode`, `cpuMhz`) say
what the chip runs at.

Why battery is the default on e-paper, the reTerminal E1002 being the case
that decided it: a wake is mostly waiting, not computing. The Spectra 6
refresh takes about 20 s, and Wi-Fi, the cloud round trips and the settle
before sleep add more, while the render and dither are a few seconds of real
work. The S3 idles through those waits at whatever clock it runs, and idling
at 240 MHz draws roughly 5 mA more than at 160 (the datasheet's modem-sleep
figures, about 33 against 28 mA with both cores waiting). At 240 the render
work itself is about a third shorter and costs a little less energy, which
wins back part of it. Put together, an estimate, not a measurement: a frame
that deep-sleeps and refreshes every 15 minutes loses roughly 5 to 10% of its
battery life at 240, and one that stays awake on battery more, closer to
15%. An LCD or a touch panel is a screen someone is looking at, where a
third off every render matters more, so `auto` gives those 240.

The same setting on a Raspberry Pi (2026.11.15+) picks the kernel's CPU
frequency governor instead, live and with no restart: `battery` is
`powersave`, `performance` is `performance`, `auto` is `ondemand` (a Pi frame
is on mains power). See `frameos/src/frameos/cpu_governor.nim` and
`docs/cloud-frames.md` "The processor speed on a Pi".

### Button beep

A press the button task registers clicks the board's buzzer (`fos_buzzer.c`,
a 14 ms square wave at 2 kHz through an LEDC PWM channel) and its release
clicks again at 0.7 of that pitch: the two clicks of a mechanical key, so a
tap and a one-second hold both sound right and nothing drones (until
2026.10.15 the press tone ran until the release, a second at most). Every
event a scene can hear sounds the instant it happens, played by the button
task when its timing (`fos_button_timing.c`, the dispatcher's rules on the
same stamps and the contract's numbers) says so:

| Event | Sound (pitch × `buzzer_tone_hz`, ms) |
| --- | --- |
| `gpio` `down` | 1× 14 |
| `gpio` `up` | 0.7× 14, every up: a tap's, a double press's, a long press's |
| `doublePress` | its second down is 1.5× 14 instead of 1× (a key the frame's map binds a double press of; any other key's quick second press clicks as a first, docs/buttons.md) |
| `triplePress` | its third down is 2× 14 instead of 1× (a key the frame's map binds three times) |
| a key held | 1× 8 then 0.5× 20 once, at 1 s, when its long press comes |
| `press` | none of its own: its clicks were the down and the up |
| refused | down 100 Hz 14, up 70 Hz 14 |

So a tap is "click, clack" and the scene hears `gpio` `down`, `up`, and the
`button` `press` 350 ms later; a double tap is 2000, 1400, 3000, 1400 Hz (the second down
higher); a 2.5 s hold is "click, dun, clack", and the scene
hears its one `longPress` at the dun, while the key is still down (the
dispatcher's tick, docs/events.md "Buttons"). Holding on sounds nothing more:
a dun a second (as until 2026.11) talked over what the long press started, a
scene loading's chirp. Until 2026.10.16 a hold
chirped at 0.5 s and then every second, which was too many sounds. The down click starts from the button task the
moment the edge is queued, so the feedback does not wait for a render that
may be 30 s into a panel refresh. A press that wakes the chip from deep sleep
clicks down as soon as the chip boots (`fos_buttons_wake_boot`) and is a press
like any other from then on: held, it duns each second and its up is a
`longPress`; a tap followed by a quick second tap is a second press (a `doublePress` on a key a rule binds one of). The
chip cannot see its keys while it boots: 0.75 s on the E1002 from the reset
to the button task's first look, 0.6 s of it the bootloader checking the
3 MB app. That first look decides the stamps. A key still down
began at the reset (`atMs` 0), so its hold counts from there and the first
dun can sound the moment the task starts. A key already up was a tap, its
`down` and `up` stamped then, which opens the double-press window. A second
tap made and let go entirely during the boot is not seen, so a double press
that wakes the frame needs its second tap after that first look. (Until
2026.10.16 the wake press was replayed as a plain `press` with no hold, so it
could be neither; before that it got a 60 ms chirp of its own and no release
click.) The PSRAM memory test is off at boot since 2026.10.16: it took
0.41 s of every boot, deep-sleep wakes included (the task started at 1.18 s).

Presses during a render are registered: the button task keeps polling, and
the render task drains the queue in one go before its next pass (one render
for the whole burst). Each queued edge carries when the button task saw it
(`atMs`, the esp_timer clock, which is also the Nim side's monotonic clock),
so the dispatcher measures a hold between the two edges and not from the
drain: a tap made 5 s into a 30 s refresh is a tap with its `durationMs`,
two taps in that time are two presses, and a hold that was long enough
is a `longPress` with its `up`. Until 2026.10.16 every edge was timed when it
was drained, so a tap during a render arrived as a 30 s hold.

A `press` is decided 350 ms after its `up`, and only a tick of the
dispatcher delivers it; so is a pair a `triplePress` rule holds back
(docs/events.md "Buttons"). So while a key is down, or a tap or a quick pair
is in its window
(`fos_buttons_busy`), the idle wait runs in 50 ms slices instead of 1 s ones,
and a frame about to deep-sleep waits, up to 10 s, until the decision is
delivered (and renders if the scene asked).

The debounce takes the first change of level as the edge (polled every
20 ms) and ignores changes for 30 ms after it, which is contact bounce. Until
2026.10.16 an edge needed the level settled for 80 ms first: that swallowed a
tap shorter than 80 ms and the second press of a quick double tap. The
queue holds 64 edges (12 bytes each), 32 press/release pairs, and a
press is accepted only when its release also fits, so the dispatcher never
sees a key that stays down. A press with no room is dropped, logged as
`button:dropped`, and gets the same two clicks from a 100 Hz base instead
(100 Hz down, 70 Hz up, 14 ms each, a dull "no" next to the bright "yes"):
it was not received.

The pitch is `buzzer_tone_hz` (100-10000, default 2000). The pin is
`buzzer_pin` (`-1` = none): the reTerminal E-series presets set GPIO 45 at
2000 Hz, the reTerminal Sticky GPIO 48 at 4000 Hz (its electromagnetic
buzzer's resonance). A board whose NVS predates the keys takes its preset's
(`fos_board_buzzer_pin` / `_tone_hz`), so these frames beep after the update
without being reprovisioned. The Waveshare PhotoPainter and 13.3E6 have a
speaker behind an ES8311 codec instead, which needs an I2S driver: not
supported yet. The firmware leaves a pin alone that is a display,
button, battery or SD pin. The firmware takes the pin at the start of every
boot and holds it low: a software reset (a panic, a restart) leaves the LEDC
running, and a tone sounding then went on through the boot. Console: `set buzzer_pin <gpio|-1>`,
`set buzzer_tone_hz <hz>` and `beep [hz] [ms]` to test it. Applied live on
every plane: the backend's settings pull carries `buzzerPin` /
`buzzerToneHz`, the cloud's `set_settings` carries `buzzer_pin` /
`buzzer_tone_hz` (firmware 2026.10.12+), and both show them as "Button beep
GPIO" and "Button beep tone" under the frame's GPIO buttons.

On e-paper the glass clicks too: the picture takes a moment to answer, the
click does not. When a press lands on something that takes it (an element
with a handler, a field, a box that scrolls, a scene listening for a press)
it plays the button's down click, and its up click when it lifts; a finger
added to one already on the glass plays the higher click of a double press.
A press on nothing is silent, and so is an LCD, whose picture answers at once.
The click is the touch task's, on core 0, the moment the finger lands: it
never waits for the render task to finish a render or a panel update. What
is taken is the press map of the picture showing, which the runtime leaves
after every render (`docs/server-rendering.md` "The click").
An edge swipe (the dispatcher's `edgeSwipe`: down within the contract's
`gestures.edgePx` of an edge, then `swipeMinPx` inward and more inward than
along) plays four clicks instead, stepping up, or down for a swipe down from
the top, the moment the finger has gone far enough, and its lift is silent.
The touch task mirrors the rule (`fos_touch_edge_at` / `fos_touch_edge_step`,
the distances generated into `fos_events_gen.h`); a press on the frame's
keyboard is a key, never a swipe (the press map marks it).
What such a press or a key starts, if it takes over 1.5 s to load, chirps
quietly on the buzzer until the picture lands (`docs/realtime-rendering.md`).
`set touch_beep 0` turns both off, or "Touch beep" in the frame's settings
(`touchBeep` on the backend's settings pull, `touch_beep` on the cloud's
`set_settings`, firmware 2026.11.6+). `fos_touch.c`, host-tested in
`test_fos_touch.c`.

### Tap and click sounds

`click_sounds` (NVS, `silent` or `normal`, default normal; `set
click_sounds silent|normal`, the frame page's "Tap and click sounds", a
backend's `clickSounds`, the cloud's `click_sounds`) gates every press sound
above and the loading chirp in one place, `clicks_heard` in `fos_buzzer.c`.
Silent leaves the voice chat's cues alone. Live, no restart; the plane's
`touch_beep` still switches the e-paper touch clicks under it. The hardware
report says `sounds` (a buzzer, a codec speaker or an LED that follows the
notes: `fos_buzzer_sounds`) and `clickSounds`.

### Brightness and dimming when idle

Where the display can set it (`fos_display_brightness`: the round AMOLED's
own register, CO5300 0x51, and a backlit SPI LCD's PWM on LEDC's second-last
timer and channel: the CrowPanel 2.01" watch's GPIO13, the CrowPanel 1.46"
rotary's GPIO46), `brightness` (NVS,
percent 5..100, default 100) is the glass's level, and after `dim_after`
seconds without a tap, a key or a turn of the crown (NVS, 0 = never, the
default) it goes down to `dim_brightness` (percent 0..100, default 10; 0 is
dark) until the next one, which brings it back at once and still does what it
does. The console's `set brightness|dim_after|dim_brightness <n>`, a backend's
`brightness` / `dimAfterSeconds` / `dimBrightness` (device_config, Power),
the cloud's `brightness` / `dim_after_seconds` / `dim_brightness`. Live, no
restart: the render task looks every wait slice (a second at most, and in an
animation's waits) and at every input, and sends the level only when it
changes (`fos_power_brightness`, host-tested), so dimming costs no render.
Screen off (`turnOff`, `toggleScreen`) still darkens the glass, and it comes
back at the level it should have. `status` prints the settings and the level
now. Other panels ignore it. The frame page has it too (Brightness, a bar to
drag and a step down and up: docs/scene-settings.md), set on the glass as the
finger moves and saved when it lifts (a Pi's page sets its backlight the same
way where it has levels, `/sys/class/backlight`).

### Before a restart

Every planned restart (the reboot and restart verbs, a firmware update and
its download, a setting that needs one, the frame page's rotation, the
console's `restart`) calls `fos_restart_notice` first (`fos_restart.h`):
"Restarting...", "Rebooting..." or "Updating..." in a band over the last
picture, drawn by the render task in the fast waveform
(`fos_display_quick_update`: an LCD at once, an e-paper with a partial
waveform, then the panel put to sleep so no restart cuts a waveform), and
the stored display hash forgotten so the first render after the boot draws.
A full-refresh-only panel draws nothing (seconds the restart would wait out),
and the caller waits 2 s at most. The log line `restart:notice` says what
became of it.

### The accelerometer

The reTerminal Sticky (LSM6DS3TR-C at 0x6a) and the AMOLED 1.75 (QMI8658 at
0x6b) are read by `fos_imu.c`'s task while the frame is awake, 50 times a
second while a scene reads `frameos.accelerometer()` and 25 otherwise, and
`fos_motion.c` makes the `tilt`, `flick`, `shake` and `orientation` events of
it (docs/accelerometer.md). `set auto_rotate 1` (`autoRotate` on a backend's
settings pull, `auto_rotate` on the cloud's, "Auto-rotate" on the frame page)
turns the picture to stand upright as the frame is turned, live, without the
restart a new rotation takes (`fos_rotation.c`). The console's `imu` prints
the chip's reading, gravity along the picture, the axis map, the position and
auto-rotate's reading; `set imu_axes x=-y,y=x,z=z` (or `default`) changes
which chip axis is which panel axis, live, should a board's map be wrong.

### Voice chat

Hold the voice key — the key whose long press the frame's event map binds
to `voiceChat`, REFRESH on the E1001/E1002 presets (`fos_board.c`) — for a
second and the frame listens (`docs/voice-chat.md` is the contract). The
button task reads the binding off `config->event_map` (`fos_voice_binding.c`,
cJSON, host tested by `main/tests/test_fos_voice_binding.c`; read again
whenever the map changes) and runs the key's hold (`fos_voice_hold.c`, pure,
`main/tests/test_fos_voice_hold.c`) before its per-key loop: the microphone
opens at the hold on the button task, sooner than a render task in a refresh
could, and the dispatcher leaves that key's `longPress` to its `up`
(`event_loop.bound`), so this is the one map rule the firmware carries out
itself. From the start
until the key is up it is *claimed*: no hold sound, no release click, and its
`up` edge carries `claimed: true`, which the Nim dispatcher takes as "deliver
the edge, make no `button` of the press". The buzzer plays a rising sparkle
(`fos_buzzer_voice_listening`), the microphone opens (`fos_mic.c`: I2S0 in
PDM RX mode with the hardware PDM-to-PCM filter, 16 kHz 16-bit mono, driven
on the HAL's register layer plus the GDMA driver the SPI already links —
ESP-IDF's I2S driver would cost ~14 KB of flash for one fixed clock) and
`fos_voice.c` runs the session on two tasks of its own: a capture
task drains the DMA into a PSRAM buffer (30 s at most, 960 KB), a relay task
POSTs it a second at a time to the frame's control plane —
`{backend}/api/frames/{id}/embedded/voice/{session}?seq=N&done=0|1` with the
frame's `server_api_key`, or `{cloud}/api/frames/{id}/voice/{session}` with
the enrollment token — on one kept-alive connection, and on the release
sends the rest with `done=1` and waits for the transcript and the reply,
drawing on an LCD or a partial-waveform e-paper what the plane says it is
doing meanwhile ("Transcribing…", the transcript, "Building the scene… 30 s":
the answer comes as NDJSON, docs/voice-chat.md "Progress on the panel") (the
plane's chat turn with six frame-scoped tools: switch a scene, set its state,
redraw, show a picture as a preview scene, rotate or re-time the frame —
`docs/voice-chat.md`; a spoken rotation's restart waits for the answer to
reach the panel, `fos_settings.c`). The answer is logged (`voice:reply`, next to `voice:listening`, `voice:sent`,
`voice:error`), sounded (every two seconds from the release until the answer
a tiny high tick while uploading, then a low bop while the plane thinks; then three
rising notes when a tool ran, two when the chat only answered, one low note
for nothing heard, two low for an error)
and **drawn on the panel**: `fos_client_show_notice` queues the transcript
and the reply (or the error in a sentence), and the render task draws them
as a word-wrapped box across the bottom of the next render
(`fos_panel_draw.c`'s notice box, `voice:shown` in the log). The panel
holds still for the session (`fos_client_hold_render`): the chat's switch
and the state for the new scene are applied as they arrive but drawn by the
one render after the release, with the notice — else the switch alone
started a 45 s render that the state waited out. An answer that changed
nothing is drawn over a copy of the last image, no scene render. Shown
once, restored before the snapshot like the local-network-access code box.
A tap on it takes it off and goes nowhere else (`fos_client_notice_takes`:
the touch task queues none of that finger's reports); a key takes it off
and still goes to the scene (`docs/voice-chat.md` "Taking the notice off").
The first 300 ms are dropped so the sparkle is not in the recording; deep
sleep is held off for the session.

The microphone is `mic_pins` (`clk=42,data=41,pwr=38` on the reTerminal
E1001/E1002, the MSM261 behind a TPS22916 load switch; `clk=19,data=20,pwr=38`
on the reTerminal Sticky, whose AI key held talks; NVS `mic_pins`, no
stored value → the board's own, `fos_board_mic_pins`) — or, on a board
without PDM pins, the I2S codec's ADC (`codec_pins`, the Waveshare
PhotoPainter and 13.3E6; `fos_codec.c`) — and the feature
`voice_chat` (default on; NVS `voice`; the backend settings pull's
`voiceChat`, the cloud's `set_settings` `voice_chat`, firmware 2026.10.20+).
The E1004 has **no** microphone — its schematic has none, and GPIO41/42 are
its J2 header UART — so its preset sets none; a PDM microphone on J2 works
with `set mic_pins clk=42,data=41,pwr=-1`. Console: `mic [seconds]` records
and prints the peak and mean level (a flat 0 is a microphone that is not wired or
not powered), `status` shows the pins and the switch.

### The scene store's host

The Scene store scene (`docs/scene-store.md`) is a JS app; what it asks of the
frame goes to `main/fos_store.c` through `frameos.store()` and
`frameos.storeAction()` (`embedded_runtime.nim`). The host does the work on a
task it makes for it (8 KB stack, gone when idle), its state in one PSRAM block
made when an app first asks: the store's listing as it came (the query string
the app handed over, `valid_params`), a change asked of the frame's plane
(`POST …/panel/scenes`, a backend first, then
`fos_client_request_commands_sync`), or, on a frame with no plane, the store's
`scenes.json` split into one slot file a scene by `main/fos_store_scan.c` (pure
C, host-tested: no JSON tree of the payload). What came from the store is each
slot's `origin`, read off the file by its keys and kept by the index's content
hash. When the work is done the scene that asked is drawn again if it still
shows (`fos_scenes_showing`).

The Code editor scene (`docs/code-editor.md`) has its host beside it,
`main/fos_code.c`, through `frameos.code()`: the same shape (one PSRAM block,
one action at a time on the request task, the asking scene drawn again) and
the same plane (`fos_store_plane`, at `…/panel/code`). A scene's source is its
file in the scene store (`fos_scenes_get_json`); `ask` waits up to 180 s for
the plane's AI and keeps its answer's scene, up to 1 MiB, as the draft in the
answer's own buffer; a save goes to the plane, or, with none, into the store
(`fos_scenes_put`; the app takes the `default` mark off a new scene).
No scene is made a JSON tree: the request is the app's arguments as they
come (the prelude puts the action in them), the answer is read by its keys
(`fos_store_find_key` in `fos_store_scan.c`, host-tested) and the draft's id,
name and summary are the answer's own JSON values. What the app and the plane
check already (an empty request, a scene's id, a compiled scene) is not
checked again here: flash is the budget. While an ask
waits, the request task does nothing else: a scene's `fetch` queues behind it.

## Rendering on the server

`render_mode remote` hands the frame's scenes to its control plane
(`docs/server-rendering.md` is the spec): the plane runs the scene in its wasm
runtime and the frame pulls the finished picture, packed in its panel's
format, at every render pass (`fetch_remote_bitmap` in `fos_client.c`, the
rules in `fos_render_pull.c`). A board without a runtime that fits its panel
(every ESP32-C3, an S3 whose panel outgrows its PSRAM) is always remote; on an
S3 it is the owner's choice: "Render scenes" under Power, `renderMode` in the
backend's settings pull, `render_mode` on the cloud's `set_settings` (firmware
2026.11.7+), `set render_mode remote` on the console. It applies live: the
next pass pulls, and a change asks for that pass now. The cloud's `hardware`
reports `renderMode` (`local` / `remote`, what the frame runs by its setting)
and `localRenderSupported` (whether it could run its scenes itself).

**The pull.** `GET {plane}/api/frames/{id}/embedded/render?width=&height=&format=&rotate=`
(a `POST` when the relay holds input, below):
a backend set on the frame (`backend_url`, its API key), else the cloud it is
enrolled with (`fos_cloud_api_access`: the provider URL, the frame's uuid,
its access token) — the order of the settings pull. The query is the panel
the picture is for (native size, `fos_pixel_format_t`, rotation); the backend
reads its own copy of the frame, the cloud draws to what it is told. No
`scene`: a frame in remote mode runs no scene choice of its own (below), so
the plane's active scene is the one drawn. The FOSB answer is checked against
the panel (size, format, length) before it goes up, as before.

**Unchanged pictures cost nothing.** A 200 carries an ETag. Once the panel
took that picture, the ETag is kept in RTC memory beside the hash of the
packed bytes it delivered (`fos_render_pull_shown_t`), so it survives a deep
sleep, and the next pull sends it as `If-None-Match` while the panel's stored
display hash still equals it — whoever drew those bytes, the ETag names them.
An e-paper fact, like the hash: an LCD keeps none, so it always downloads.
Anything else on the glass (a local render, an overlay, a refresh that
failed, the portal's screen or a console `display_test`, which now say so
through `fos_client_note_panel_drawn`) and it is not sent. A **304** downloads
nothing and refreshes nothing: the pass logs `render:device` `skipped` /
`unchanged` like an unchanged local render and counts as a good render. The
panel buffer is no longer cleared before the pull, so on a frame that stays
awake the preview snapshot is put back from the reservation after a 304 when
its bytes still hash to the picture shown. A reset forgets the ETag (RTC
memory); the stored display hash still skips the refresh then.

**When the next picture is due.** The scene runs on the plane, so the
plane says when it wants its next picture: `X-FrameOS-Next-Render: <seconds>`
on the 200 and the 304 (its `nextSleep`, else its `refreshInterval`; at least
10 s on a backend and the plan's floor on the cloud, at most 7 days;
`fos_render_pull_next_render_seconds`). The board takes it where its own
runtime's interval would go, so its next pass, its deep sleep and the
`nextRenderAt` it reports follow the scene; with no header (a scene with no
opinion, a pull nobody answered) 300 s (`FOS_PASS_DEFAULT_SECONDS`: a frame has
no interval of its own; an NVS `interval` from before is ignored). The idle runtime's
own interval and `nextSleep` are never read in remote mode: they belong to a
scene left from before.

**The cloud says no.** A cloud answers `403` when it does not render for the
frame (`not_server_rendered`: the plane's setting is not remote;
`cloud_rendered_frame_quota_exceeded`: the plan's cloud-rendered frames are
used up). A board with its own runtime then renders that pass itself, after
applying the scene store and any queued switch, and keeps rendering itself for
an hour (`FOS_RENDER_PULL_REFUSED_RETRY_S`, wall clock in RTC memory, so a
deep sleeper does not pay a refused handshake every wake) before it asks
again; any `render_mode` from the cloud clears it at once. Logged once per
refusal: `render:remote_refused` with the reason (the answer's `error`), and
reason `ended` when a picture comes again. Input held for the plane goes
(`event:dropped`, reason `refused`). A backend never refuses (it serves its
diagnostic card), and a C3 has nothing to fall back to: it logs
`render:error` and keeps its picture.

**What a remote frame does not run.** Everything that only a local render
needs waits on one test, `renders_locally` in `fos_client.c` (the frame's
setting, or a refusal on a board that can; `fos_client_renders_locally` for
other tasks): the scene store's apply and the backend scenes pull, the Nim
dispatcher and its tick, animation, the first pass's wait for the cloud's
queued commands. That keeps a wake to Wi-Fi, the cloud link, one request and
the refresh. The Nim runtime itself still starts at boot where it fits, so a
refusal or a switch back to local renders without a restart.

**Keys, touch and the schedule go to the plane** (`docs/server-rendering.md`
"Keys, touch and the schedule"). The producers keep running: the button task,
the touch glass, the schedule (ticked on the render task as before, and at
the start of every pass) and the frame's HTTP API. In remote mode
`fos_events_dispatch` does with the firmware's own events what it always did
(`render` asks for the pull; `reload`, `restart`, `reboot`, `uploadScenes`;
`turnOn` / `turnOff` / `toggleScreen` switch the backlight here as well) and
**relays** what a scene would have heard instead of handing it to the Nim
dispatcher: `gpio` edges (`wake`, `claimed` and `atMs` as the button task
stamps them), `pointerDown` / `pointerMove` / `pointerUp`, `setCurrentScene`
(with or without a `direction`), `setSceneState`, `button`, custom events,
from `driver`, `schedule`, `http:write` and `http:admin`. What the plane said
itself goes through `fos_events_dispatch_from_plane` (`fos_cloud.c`: a cloud
verb, or a backend command, whose origin is `http:admin` like the frame's
HTTP API's) and only asks for the pull; the console (`system`) is not
relayed (`event:unsupported`). This works on a C3 too: the relay needs no
runtime.

The relay (`fos_render_relay.c`, pure, `tests/test_fos_render_relay.c`) keeps
them in order behind a mutex in `fos_client.c` (`fos_client_relay_event`),
each kept as it goes on the wire, at most 32 events and 16 KiB of body (the
oldest go first, `event:dropped`); a payload that is not one JSON object
(`fos_json_whole`) is refused and its producer told (an HTTP 400). A finger
on the glass leaves its gesture in the touch queue until it lifts, its moves
folded to the newest there (`fos_touch_finger_down`), so the relay gets it
whole. Keys and the glass are sent once the input is decided: no key down,
no tap inside its double-press window (`fos_buttons_busy`), nothing left in
the queues; a
schedule entry or an HTTP event asks for the pull at once, and a pull that
is due anyway takes whatever is waiting, after waiting out a key or a finger
still being timed (10 s at the most), so a press never goes in two halves.
Then the pull is a `POST` with `Content-Type: application/json` and
`{"nowMs": <esp_timer ms>, "events": [{"origin", "name", "payload"}, …]}`,
the ETag rules unchanged. A `200` or a `304` empties what it carried; a
`400` or a `413` too (a body the plane cannot read is not sent again);
anything else, no answer included, keeps it for the next pull. One
`render:relay` line per pull that carried any: the count and the status. The
cloud's `403` drops it (above). A battery frame holds its sleep while the
relay holds anything or a report waits in a queue (`sleep:held`, reason
`input`): not on a critical battery, and three holds in a row at most
without a pull the plane answered; and the key that woke it goes with the
wake's first pull.

**`renderSceneMs`.** Every metrics sample carries how long the last good pass
took to produce its picture, without the panel refresh: the scene on the
frame, or the pull (a 304's included). Next to `renderLastMs` (the whole pass)
it is what the battery popover reads to say what rendering on the server
would take off a wake.

## Scene storage and memory (2026.8.13)

Scenes arrive as one combined `scenes.json` — from the USB upload, the
backend sync or the cloud's `set_scenes` — and that stays the wire format.
The device does **not** keep them that way. The payload is split into
`/state/scene-<slot>.json` plus `/state/scene-index.json`, the old set's
slots going first and the combined file last (an 8 MB board's `state`
partition is 1M and a payload held in memory may be 512K: the old set, the
new one and the combined file do not fit together), and only the **active**
scene is parsed and resident. A
push or an upload is stored by the task that received it (the cloud, HTTP or
the console) and split by the scene store's own task (`store_split_stored`),
paced around renders and taps like every write off the render task
(`store_pace_hook`); the render task's apply then reads the index and loads
one scene, and a switch asked for meanwhile waits for that apply
(`s_store_changing`). A backend sync's set is held whole by the runtime and
written by the store task when there is room for it (`runtime_room_for_whole`:
a largest PSRAM block of twice the set and four times the set free); without
it, or when the runtime refuses it, the set goes store-first like a push:
written by the store task as fast as flash goes, then applied one scene at a
time (the reTerminal E1004 could not copy a 378 KB set whole, 2026-11-16).
Its etag is the frame's from the moment it is taken, so a one-scene change
(a backend's patch against that etag, a put, a delete, the cloud's patch)
waits for the store task's write of it before it goes on the index
(`backend_set_written`, 90 s, then refused): applied first, the write of the
set undid it (the Code editor put on the reTerminal E1002 dropped by
"4 written at once, 0 kept, 1 dropped", 2026-11-20). A
backend's answer, a whole set or a `?patch=1` object, is read in pieces
(`fos_scene_pieces.c`, host-tested): each scene in a block of its own and the
rest (`[]`, or the patch with `"put":[]`, the one part parsed as a tree) in a
small one, so the largest block a set needs is its largest scene, where one
block of a 378-415 KB answer did not fit beside a photo on the reTerminal
E1004 (2026-11-16). The runtime, the store's puts and the combined file
(`fos_scene_store_write_set`) take the scenes as they are. Other bodies are
read into one buffer of their declared length (`fos_http_body.c`,
host-tested). A body that never got its buffer logs `no-memory`, one that is
not a scene answer `invalid`, one that broke off `read-failed`.

**On a frame that has a per-scene store, a whole set goes in as changes to
it, one scene at a time** (`fos_scene_store_apply_set`, called by
`store_set_as_changes_locked` for a push, an upload and a backend sync): a
scene whose bytes are stored already is kept (each index entry has the
`hash` of its file), the scenes the set drops go first, each new or changed
scene is written and committed by itself and the file it replaced emptied
before the next, and the set's order and source come last. `/state` never
holds more than the stored set and one scene, where the whole file beside
the old set needed room for both: the reTerminal E1002's 415 KB, 20-scene
set did not fit its 1 MB `/state` (`ENOSPC`, 2026-11-10). A push that
changed one scene of twenty writes one. It is not atomic: a failure or a
power cut leaves a set holding some of the new scenes, each whole, and the
producer sends the set again, since nothing acknowledged it. The combined
file and the split below are for a frame with no store yet (a first set, or
a whole payload a boot has not split). The
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
unsplittable payload, more scenes than a set holds, a full partition) falls
back to loading the combined file whole, so a frame cannot lose its scenes
to a failed optimization; the index of the set it had stays until that
payload has loaded, and one the runtime refuses too is dropped for the set
from before.

### How big a set may be (2026.11.12)

**As big as `/state` has room for, in up to 128 scenes**
(`FOS_SCENE_STORE_SCENES`: the index keeps an icon of up to a kilobyte for
each and is read whole for every catalog, which is what bounds the count).
The store has twice as many slot files (`FOS_SCENE_STORE_SLOTS`, 256), so a
change to every scene of a full set fits beside the set it replaces until
the index switches. Both planes send such a change as a patch to a board on
2026.11.12 and keep to the 32 slots of the firmware before it
(`esp32_scene_store_slots`, `esp32SceneStoreSlotsFor`). Until then a set was
512 KB and 32 scenes whatever the partition: a reTerminal Sticky refused
529 KB with 14 MB of its 24 MB `/state` free (`payload-too-large`, the
hardware bench, 2026-11-18). It holds 97 scenes and 2.3 MB now, and a
reTerminal E1002 17 scenes and 680 KB on its 1 MB `/state`.

What is **held in memory** is still bounded, at 512 KB
(`SCENES_HELD_MAX_BYTES`): a whole payload a producer hands over in one
block (a USB or HTTP upload, one cloud message: the per-scene routes below
and `scenes_patch` take a bigger set a scene at a time) and a backend's
answer read into blocks. **A backend's answer over that, or one there was no
block for, is read straight into the store** (`fos_scenes_backend_fetch`,
the `spool_*` sink):

- `fos_scene_pieces_read_to` hands each scene's bytes to a sink as they come
  off the socket, a read's worth at a time, and holds none.
- The store writes them to a slot file no index names
  (`fos_scene_store_stage_*`), with the file's hash and what the index keeps
  of the scene read off the bytes as they go by (`fos_scene_meta.c`: the
  top-level scalars and the settings' scalars as their own text, which cJSON
  then reads; host-tested against the whole parse of every repo sample).
- A scene that arrives as it is stored (the same hash and length) gives its
  file back and keeps its slot, so the scene on the panel reloads only if it
  changed.
- The render task switches the index to all of them in one change
  (`fos_scenes_take_backend_payload`), as a patch that names every scene.
  Nothing the index names changes before that.

Memory holds a read's worth of bytes throughout: the reTerminal E1004 had no
block for one scene of a 465 KB set while its 13.3" render had its PSRAM cut
up (`no-memory`), and that read is tried again this way. One staging at a
time: an answer waits in its socket for a set the store task is still
writing. `scenes:toStore` logs the scenes, the bytes and how long it took
(`detail`).

What the store cannot take is said once: `payload-too-large` (more than
`/state` has room for, nothing of it read), or the store's own words for it
(`no room on /state`, `no free scene slot`, `not one scene object with an
id`). That answer is not read again until its ETag changes, the frame
restarts or, where room was what it wanted, `/state` has that much: a
backend asks for a sync with every commands answer while the frame is
behind. On a small partition a set that replaces most of the one before has
no room beside it (a 1 MB `/state` holding 680 KB takes 120 KB more): where
`/state` could hold it and memory has twice its size, it is read once more,
held, and stored a scene at a time, the scenes it drops first.

**One index write for a set, where there is room.** A whole set held in
memory goes into a per-scene store as changes (above). With room on `/state`
for every changed scene beside the set as it is (`has_room`, and slots for
them), they are written to unnamed slots and the index is switched once
(`apply_set_at_once`); without it, one scene at a time as before. A step a
scene writes the index twice per scene: for 26 scenes that was three times
the bytes of the set, and a 525 KB set took 112 s on the Sticky. The store's
lock goes after every 16 KB written, so a render reads its scene file all
the while (held for the whole set it kept a render waiting 33 s). The files
a change stops naming are emptied by the store task, the lock let go after
each (`store_sweep_behind`): emptying is a flash write for every page, and
71 dropped scenes were a minute and a half of it.

**A set over USB** (`usb_api scenes-deflated <set|put> <inflated bytes>
<bytes>`, then a zlib stream of a JSON array of scenes). The browser flasher
and the backend's flasher (`uploadScenesOverUsbAfterFlash`) send a set in
batches of up to 512 KB of JSON, the most the board holds at once, each
deflated: the first (`set`) is what `upload-scenes` takes, the rest (`put`)
are added to it as one change each, written the way a whole set is
(`fos_scene_store_add_set`: unnamed slots, the index once). The board
inflates with the ROM's tinfl and the stream's Adler-32 checks what came
over the cable; firmware before it answers `unknown subcommand` before
READY, and the page sends `upload-scenes` and a `scene-put` a scene. Scene
JSON deflates to between a third and a quarter, and the console reads 11.5
KB a second at 115200 baud: every sample (105 scenes, 4.2 MB) went onto a
reTerminal Sticky in 302 s, 100 s of it on the cable and most of the rest
making slot files ("What still costs"), where the plain commands took 6
minutes on the wire alone (2026-11-25).

A change made while a whole set waits for the render task's apply (the
first batch, on a board that has no network yet: its render task holds its
passes for the Wi-Fi portal until the reboot that ends the setup) goes into
the index that set wrote, and the apply stays the set's own, which loads
that index whole (`ensure_split_locked`). Through 2026.11.14 such a change was
refused ("a scene upload is waiting to be applied"), so every scene after
the flasher's first upload was: the page now restarts such a board once and
sends the rest. A change also waits for the store task to split a whole
payload a producer stored (`producer_split_done`): the split lets the lock
go between files, and a put that came then split the same file again
beside it.

**No chore waits for input while the render task waits out the portal.** A
store write is paced around taps (`store_pace`, `fos_client_input_held`),
and input that is queued counts as a tap until the render task takes it.
Parked in the portal, it takes none (what came is kept for the pass after
it), so one tap or key there held every store write, and the console with
it, until a reset: a reTerminal Sticky on 2026.11.14, which still waited in
the portal on e-paper, froze after a tap during the flasher's setup.
`fos_client_input_held` is false while the render task is parked
(`s_render_parked`); a board of keys alone still waits there. (A touch board
never does: with no network saved it opens on its own screen, where the
frame page joins one.)

**The boot's sweep runs when the render task parks in the portal**, not
only after a first picture that will not come before the portal ends: a
setup's scenes come while it waits, and the slot files an earlier boot left
unnamed were no put's to take, so a board whose `/state` held an earlier set
ran out of slots part way. The spares a change makes before the store first
lists its directory are kept through that listing (`learn_slot_files`): the
slots the flasher's first set gave back by dropping the scenes before it
were forgotten, and its batches stopped at 54 of 105 with "no free scene
slot" (the reTerminal Sticky, 2026-11-26). With the old slot files spares,
the same 105 scenes took 203 s, no file made.

**Making room is one walk of the partition** (`fos_spiffs_gc.c`). Flash is
erased a 4 KB block at a time before it is written, and the blocks that hold
nothing but deleted pages are found by walking the partition's lookup
entries once, going on from where the last walk stopped. SPIFFS's own quick
collector starts at block 0 for every block it erases: on a 24 MB `/state`
that was 48 of the 71 s a 529 KB set took to store, and the same set takes
14 s now (8 s of erasing, 5 s of writing). The walk also spreads the erases:
in the host test's thirty uploads the most-erased block went from 52 erases
to 18. A file is written through an 8 KB buffer, because SPIFFS rewrites its
index header page at the end of every write call.

**What still costs.** A slot file's first creation is about a second on a
24 MB partition (SPIFFS walks it three times inside `open`: for the name,
and twice for a free object id), so the first set that needs 70 new slots
spends 75 s creating them; they are emptied and kept after that, and opening
one is milliseconds.

### One scene at a time

A scene can be read, added, replaced or removed on its own (`main/fos_scene_store.c`,
pure C, host-tested), without touching the others:

| Over | Read one | List, sizes, free space | Add or replace | Remove |
| --- | --- | --- | --- | --- |
| USB | `usb_api scene-get <id>` | `usb_api scene-list` | `usb_api scene-put <bytes> [activate]`, then the scene's JSON | `usb_api scene-delete <id>` |
| HTTP (admin login or the server key) | `GET /api/frames/<id>/scenes/<sceneId>` | `GET /api/frames/<id>/scenes` | `POST /api/frames/<id>/scenes`, the scene's JSON as the body (`?activate=1` shows it) | `POST /api/frames/<id>/scenes/delete?id=<sceneId>` |

A refused change answers 400 (not one scene with an id, the last scene, an
order naming a scene the frame does not hold), 404 (no such scene) or 500 (no
room, a file error), with the reason as the body.

A changed scene is written to a new slot file and the index is switched to it;
the old file goes at the next sweep. A whole payload is split by the same code,
so the index keeps `isLayout` and a scene's `default` mark however a scene
arrived. What the index keeps of a scene is bounded (`make_entry`: a name of
256 bytes or fewer, a `windowSize` of 32, an icon of 1024, a category and
`opens` of 128 each; a longer one is left out, the scene is kept), and a
change whose index would still pass the 512 KB every reader takes is refused
(400) with the set as it was: an index nobody can read is every scene gone. A
scene nested deeper than 32 levels is refused by every door, the store's and
the runtime's (a set a backend sends whole, a stored payload that could not be
split), and cJSON itself is built to stop there (`CJSON_NESTING_LIMIT`, the
project's `CMakeLists.txt`) for every parse in the image. A power cut, a full partition, or a scene
the runtime refuses (when it is the one on the panel) leaves the scene that
worked. Only the scene on the panel, or one it embeds as a split panel, is
reloaded; adding any other scene costs one file and no render. Deleting the
last scene is refused. The state a removed scene kept across deep sleep goes
with it. A control plane uses the same store: the cloud's `scenes_patch` verb
(`docs/cloud-frames.md`), and a backend answering `/embedded/scenes?patch=1`
with `{"patch":true,"base":"<etag>","order":[...],"put":[...]}` when it knows
what the frame holds. A forced pull (a deploy, "Push & activate", a preview:
the commands answer's `sync`) sends the frame's ETag too, unless it holds no
set, so a push that changed one scene downloads that scene; the backend also
says `sync` when it hands over a switch while the frame's scenes are behind,
so the switch never names a scene it has not pulled.

**Push and show.** A change that activates its scene (`scene-put … activate`,
`?activate=1`, a cloud push with `scene_id`: the workspace's "Push & activate"
and "Install & activate") is written as fast as flash goes, not paced around
renders and taps (`s_store_urgent`): somebody is waiting to see it, and paced
behind an e-paper render a 30 KB scene waited up to half a second for each
2 KB. A cloud push's `state` opens that scene with those values, through the
same switch `set_current_scene` makes (`select_pushed_scene`).

**Lookups by name are what a write costs on a big partition.** Every SPIFFS
`stat`, `open`, `remove` and `rename` walks the lookup page of every block:
about 25 ms on a 1 MB `/state`, about half a second on the 32 MB boards' 24 MB
one, where a one-scene put used to take 10 s with 0.3 s of it writing data
(the reTerminal Sticky, 2026-11-10). So the store asks flash as little as it
can (`fos_scene_store.h`): it lists the directory once, the first time it
needs to know which slot files there are (a boot's sweep, which empties
everything the index does not name: asked for by name, 256 slots were two
minutes of every boot, and the Sticky's bootup event came 2.5 s sooner with
97 scenes than it did with 26), a slot is written
straight to its own name (the index switch is the commit), and the index is
written as a copy (`scene-index.tmp`, kept) and then in place, readers taking
the copy when the index is torn; `fos_scenes.c` tracks whether a combined
payload is there instead of asking. Index and slots are removed only through
the store: a bare unlink of the index leaves its copy to come back.

**How much room there is.** `usb_api scene-list` and `GET .../scenes` report
`storage`: `stateTotalBytes` and `stateUsedBytes` (the SPIFFS partition,
`esp_spiffs_info`), `scenesBytes` and `sceneCount`, and `sceneBytes`, each
scene's footprint by id; the index keeps each file's own `bytes`. Every figure
is in SPIFFS's own units: the pages a file takes, data and index alike, at the
data a page carries (`fos_spiffs_footprint.c`, checked against IDF's SPIFFS in
`test_fos_spiffs_gc.c`), so the scenes and the used figure add up. On a 1 MB
partition (256-byte pages) a 30 KB scene takes about 31 KB; a scene that is
not split yet is reported at what its own file will take. The same report is
in the cloud `hardware.storage` (hello, and a `state` message whenever the
stored scenes changed since the last report: `ws_poll_active_scene`) and in
the backend's `embedded.storage` (check-in), which is what the workspace
draws: free space over the scene list, each scene's size on its tile.

## The render canvas is 16-bit (2026.8.31)

A sixteen-grey panel has a 4-bit canvas in its own buffer's layout, each
store dithered (docs/realtime-rendering.md); the other formats follow.
The canvas format is decided per board (`fos_render_canvas_bits_per_pixel`
in `components/frameos_display`): **16-bit RGB 5/6/5 on every colour panel,
whatever the PSRAM** (since 2026-11-21, docs/esp32-memory.md "Every colour
canvas is 565"). Until then a colour panel got RGBX where a full canvas took
at most half the module's PSRAM (the 800×480 boards, a 1200×1600 panel on
16 MB) and 565 only where it had to: 1200×1600 on an 8 MB module, where RGBA
is 7.3 MiB and does not fit and 565 is 3.7 MiB and does
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
block (`FOS_CLOUD_WS_MIN_INTERNAL_*` in `fos_cloud.h`, floors for starting a
session — the mbedTLS side is in PSRAM) and says so in `status` and the logs,
rather than failing inside esp-tls as a connection reset.
`frontend/src/utils/frameMemory.ts` mirrors these numbers for the workspace
banner; change both.

**"Internal free" counts memory malloc() cannot use.** Every internal figure
above — the floors, `freeHeapKB` in the metrics sample, `status` — is
`heap_caps_get_free_size(MALLOC_CAP_INTERNAL)`, which sums every heap
carrying the INTERNAL cap. That includes the
`CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL` pool (64 KB in sdkconfig.defaults):
ESP-IDF carves it out at boot as a DMA|INTERNAL region *without*
`MALLOC_CAP_DEFAULT` (`esp_psram_extram_reserve_dma_pool`), a last resort
for DMA-capable allocations once the main heap is full. `malloc()`, lwIP's
pbufs and the socket side of a TLS dial never see it, so the familiar number
overstates what a dial can get by up to 64 KB. `fos_mem_internal_malloc_free()`
/ `_largest()` (`fos_mem.h`) report the `INTERNAL | DEFAULT` subset; the
metrics sample carries them as `freeHeapMallocKB` /
`largestHeapMallocBlockKB` next to the old pair, `status` prints a
"malloc-able" line, and `heapinfo` has a matching section. The sample also
carries `renderStackFreeBytes` / `cloudStackFreeBytes` (FreeRTOS high-water
marks) so the 40 KB render stack's real use is visible in the cloud logs.

The floors were tuned on hardware against the inflated figure and still use
it — an E1002 at "78 KB free" dials fine, so the honest number it needs is
smaller than any floor written down so far. Once a few frames have reported
both pairs, recalibrate the floors on the malloc-able figures and switch
`ws_heap_ready()`, `https_heap_ready()`, `log_upload_heap_ready()` and the
banner over together. Candidate levers if the honest headroom turns out
thin: the reserve pool back to IDF's 32 KB default, and right-sizing task
stacks from the high-water marks.

**Wi-Fi and lwIP buffers come from PSRAM first, and TCP has a 64 KB receive
window** (2026-11-10, `sdkconfig.defaults` "TCP at the speed of the Wi-Fi";
`CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y`). IDF's 5,760-byte windows made the
network the slow part of a photo once the JPEG sink got fast: on a reTerminal
E1003 a Gallery photo spent 1.6 to 9.6 s on the socket, now 0.06 to 1.9 s
(its whole body 7.3 s median, now 5.3 s, of which 4 s is the decode), and
the 1.3 MB backend picture push went from 14.5 s to 8.8 s (medians). Idle
internal RAM went from 90 KB free with a 43 KB block to 103 KB with 55 KB.
The send side stays small on purpose: each frame in flight is a copy in
DMA-capable internal RAM, and a 64 KB send buffer with 64 TX buffers drained
the 64 KB DMA pool to 6 KB; 16 KB with IDF's 32 TX buffers kept it at 44 KB.
The C3 overlay (no PSRAM) keeps IDF's values. `test_esp32_network_buffers.py`
pins all three. What is left of a photo's network time is opening the
request: DNS, connect and the TLS handshake, 2.3 to 4 s to
gallery.frameos.net.

**A scene's HTTPS request resumes the TLS session of its host's last one.**
Most of opening a request is the handshake, and an ESP32-S3 has hardware for
RSA but verifies an ECDSA chain in software: a host whose certificates are
signed with P-384 (Let's Encrypt's ECDSA chain: Hacker News, Wikipedia;
GlobalSign's: CNN, the BBC) took 1.9 to 3.1 s to its first byte at every
request, against 0.55 s for an all-RSA chain (text.npr.org). The glue keeps
the session each connection ended with (`fos_tls_sessions.h`: six hosts, by
host and port, the one used longest ago first out, ten minutes unused at
most; a few hundred bytes to 2 KB each, in PSRAM) and offers it at the next
connect to that host and port, a redirect hop under its own. A server that
still knows it (its ticket, RFC 5077) skips its certificates and the key
exchange. No connection is kept open for it: an open one is ~40 KB of
internal RAM, a kept session none (12 bytes of statics; the internal
min-ever-free of the run below was 83 KB with it and 80 KB without).

First byte of a streamed fetch on a reTerminal E1003 (2026-11-24), the first
request to a host and the ones after it:

| Host | Before, every request | First | After it |
| --- | --- | --- | --- |
| news.ycombinator.com | 2.9 to 3.1 s | 3.0 s | 1.0 to 1.1 s |
| en.wikipedia.org | 2.0 to 2.1 s | 2.1 s | 0.18 to 0.24 s |
| lite.cnn.com | 2.1 to 2.2 s | 2.4 s | 0.13 s |
| www.bbc.com | 1.85 s | 1.8 s | 0.67 s |
| text.npr.org (RSA) | 0.55 s | 0.55 s | 0.10 to 0.22 s |
| github.com, lite.duckduckgo.com | 2.5 s, 1.3 s | as before | as before |

GitHub and DuckDuckGo answer an offered session with a full handshake; a
server that did so is not kept (its next connect offers none and is), so it
never puts a host that does resume out of the table.

How: mbedTLS hands a session over at `mbedtls_ssl_handshake`, and ESP-IDF
keeps one only inside an `esp_http_client`, of which the glue makes one a
request. So that function goes through a linker wrap
(`__wrap_mbedtls_ssl_handshake` in `frameos_nim_glue.c`), which is the real
call and nothing else for every connection of the firmware but one a task
marked in `http_open_request` (`tls_resume_begin` / `tls_resume_end` around
each connect). `sdkconfig` is as it was: mbedTLS's client asks for a ticket
by default. ESP-IDF's dynamic TLS buffers (`CONFIG_MBEDTLS_DYNAMIC_BUFFER`)
had to be worked around: they free the receive buffer of a handshake message
by "the state before the current one", which a resumed handshake skips
twice, after the server's hello and after its Finished. The next message was
then read into a block of the last one's size (the new ticket over the
hello's, the first of the answer over the Finished's), and the heap asserted
at its next call. A connection that offered a session is stepped by the glue
(`tls_handshake_resuming`), which frees those two buffers as that code does
where no state is skipped. +1.4 KB of flash; `test_esp32_tls_sessions.py`
runs the table's host test and pins the rest.

Two mbedTLS switches that would speed the first handshake were measured the
same day and left as they are. `CONFIG_MBEDTLS_ECP_FIXED_POINT_OPTIM`
(tables in flash for a curve's fixed point): 10 to 25 % off a full ECDSA
handshake (Hacker News 3.0 → 2.7 s, Wikipedia 2.1 → 1.6 s, lite.cnn.com
2.2 → 1.7 s, the BBC 1.85 → 1.6 s, GitHub 2.5 → 2.1 s) for +10.8 KB of
flash. `CONFIG_MBEDTLS_HARDWARE_MPI` off (big numbers multiplied in
software, on the guess that the RSA peripheral's set-up costs more than a
384-bit product): 3 to 9 % off an ECDSA host, an RSA one slower (text.npr.org
0.55 → 0.74 s, DuckDuckGo 1.3 → 1.4 s), 0.6 KB less flash. `ECP_NIST_OPTIM`
is on already.

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

What exists: `decodePngScaledInto` is a streamed scanline decode bounded by
pixie's own decode budget, and since #398 any image with a decode target is
decoded straight off the socket (`image:streamed` / `image:stream:fallback`
in the log). A progressive JPEG is read in strips when the budget cannot
hold its coefficients whole (`docs/esp32-progressive-jpeg.md`): off a socket
that means the body is buffered first, so a source that can serve baseline
JPEG or PNG still saves the 8 MB boards that copy. WebP does not stream.

**Wi-Fi drops during a render.** A streamed decode keeps its socket open for
the whole decode (about 30 s for a gallery JPEG on the E1004), so a short
Wi-Fi drop in that window used to fail the picture. Now a scene request that
finds the station without an address waits up to 20 s for it, within the
request's timeout and so within the render deadline; after a wait that ran
out the next requests fail at once until the station is back. A streamed
image whose body the network cut short is streamed once more before the
buffered path gets it (the `image:stream:fallback` line between the two says
"the download stopped partway" instead of "Invalid JPEG"). The metrics line
adds `wifiDrops`, `wifiDropReason` (the 802.11 reason code of the last drop:
200 beacon timeout, 2/4 the access point expired the frame, 15 a key
handshake timed out) and `wifiDownMs` once an established link went away
during a boot. Such a link keeps reconnecting every 30 s after its 12 quick
retries; it used to stop there until the next boot.

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
and `POST /api/action/render` / `POST /api/action/ota` on port 80. With
`tls_enable` on and certificate material present (`set tls_enable 1`, the
material from the settings pull), the same API is served over native
ESP-IDF HTTPS on `tls_port` (8443 by default) **instead**: once the TLS server
is up the plain one is stopped (firmware 2026.11.15+), which is what the frame
has always reported as `expose_only_port`, and what a Pi does by default. A
client that still tries port 80 is refused the connection, before it has sent
its key or its login in the clear. The plain server stays when TLS could not
start (no certificate, no memory: `https` in `/status` says which) and in the
setup hotspot, which never starts TLS.

Three rules guard that server, whichever port it is on:

- **A page that is not the frame's own may not change anything.** A browser
  that has logged in to the frame sends its remembered Basic login with every
  request to that address, another site's form included, and on the setup
  hotspot there is no login to ask. So a request that is not a `GET` or a
  `HEAD` and names an `Origin` other than `http(s)://<its own Host>` is
  answered 403 before any handler runs (`logged_dispatch` in `fos_http.c`,
  `fos_url_origin_is_host`). The frame's own page passes, by address, by name,
  and under a captive-portal probe's name. A request with no `Origin` is no
  browser's cross-site request and passes to the login as before: a backend,
  `curl`, the app.
- **Ten wrong device logins in five minutes, and none is looked at until the
  five minutes are over** (429; `fos_login_throttle.h`, the Pi's rule for its
  admin login). Counted for the whole device: there is no memory for a table
  of clients. A backend's `Authorization: Bearer` key is not counted and never
  locked out, so the frame's plane keeps working while somebody guesses. A
  browser tab left polling with an old password spends the ten too: close it.
- **JSON nested deeper than 32 levels is refused** (see "One scene at a time").

### Certificate dates

A certificate's validity dates are checked (`CONFIG_MBEDTLS_HAVE_TIME_DATE`,
firmware 2026.11.15+): one that has run out is refused, on the plane link, the
cloud socket, OTA, voice and a scene's own requests alike. Before, an expired
certificate was as good as a current one, so a key that leaked once never aged
out. All of those clients trust the certificate bundle, and `fos_tls.c` takes
the bundle's attach call at the link (`--wrap=esp_crt_bundle_attach`), so a
client added later cannot be written without the rule.

A frame may not know the time: switched on for the first time, or after its
battery was out, it counts from 1970 until SNTP answers, and SNTP may be
blocked on its network. It must still reach its plane and its update, so the
rule (`fos_tls_dates.c`, host-tested) goes by what the clock says:

- **At or past the month this firmware was released in** (a FrameOS version is
  a date: 2026.11.14 is November 2026), the clock is taken for the time and
  the dates stand as mbedTLS read them.
- **Before it**, the clock is known to be wrong. "Not valid yet" is dropped,
  and "expired" is asked of the release month instead: what had run out before
  this firmware was released has run out now, whatever the time is.

So a board with no clock behaves as every board did before, except for
certificates older than its firmware. Two things follow that are worth knowing
when a TLS error shows up in the logs (`esp-tls` prints the mbedTLS code, the
strings are not in the image): a clock set wrong but plausibly (by hand on the
frame page, or a clock chip years ahead) fails every handshake until SNTP or
the owner corrects it, and a server that still sends an expired cross-signed
certificate at the top of its chain is refused, as mbedTLS has no way to build
another path. SNTP is not authenticated: whoever answers for the time server
can still turn the clock back to make an old certificate current. That is the
Pico's position too.

## OTA

The default 8MB flash profile has an A/B OTA partition table: two 3520K app
slots (about 3.44MiB each) and a 1M `/state` SPIFFS partition at the end of
flash for scenes and other user data. The current size-tuned firmware fits in
either OTA slot, so devices update over the air instead of only USB/browser
flashing the merged image.

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
the app marks itself valid after its first successful render (or before an
orderly deep sleep — `fos_ota_mark_boot_valid`), otherwise the next reset rolls
back to the previous slot. "Reached Wi-Fi" used to be the mark, which let a
release that joined the network and then died in Nim or scene init boot-loop as
a valid image. One signed path serves both control planes
(`main/fos_ota.c`): a backend-managed device polls
`/api/frames/{id}/embedded/ota/manifest?platform=<its layout>` daily (or on
`ota`, or when the backend asks over `POST /api/action/ota`), a cloud-managed
one fetches `/api/frames/{id}/firmware/manifest` on `notify_update_available`.
Both answer `{platform, version, size, minisig, downloadUrl}` — the release
relayed, never a binary the control plane built — and the device streams the
image into the inactive slot, BLAKE2b-hashes it as it goes and verifies the
minisign signature against the release key baked into every image
(`fos_ota_pubkey.h`, from `release-assets/firmware-signing.pub`) before it
switches the boot slot. Before it downloads anything it also checks what the
image was signed AS: the `.minisig`'s trusted comment (covered by minisign's
global signature) must be `frameos frameos-<manifest version>-<this image's
platform>-app.bin`, so an older or other-layout image that was genuinely
signed once cannot be served as a new version (`fos_minisig_verify_binding`;
the log says `signature-for-another-release`). After the download, the
image's own app-descriptor version must be that same release, or the slot is
not switched (`image-version-mismatch`). `fos_ota_platform()` names the
layout this image was built for, so a 16 MB board asks for the 16 MB image. Progress is logged as
`ota:backend` / `ota:cloud` lines; three failures on one version stop the
retries until a newer release or a power cycle. The 4MB profile has no OTA
partition, so firmware updates must be flashed over USB.

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
(`EPD_7in5_V2_gray`, `EPD_4in2b_V2_old`, `EPD_7in5b_V2_old`), as is the
12.48" multi-controller stack; the IT8951's `EPD_10in3`, the SSD1306 OLED and
the two RGB LCDs (`LCD_ST7701S_480x480`, `LCD_EK9716_800x480`) are hand-written
drivers in the component (`EXTRA_PANELS` in the generator).
`FRAMEOS_SELECTED_PANEL` (backend builds
set it from the frame's device) only chooses the boot-time default panel.
Published release images remain per flash-size profile, but one generic image
now covers all panels.
