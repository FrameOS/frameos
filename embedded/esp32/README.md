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
  fos_config_parse.c      the setting parsers/normalisers behind every writer (host-tested)
  fos_wifi.c              STA connect, SoftAP portal, DNS hijack, SNTP
  fos_http.c              esp_http_server route layer (portal + /status + actions)
  fos_client.c            render loop: Nim local render or thin-client fetch → blit
  fos_ota.c               signed release OTA (manifest + streaming verify) when an OTA partition exists
  fos_cloud.c             cloud-managed frames: claim-token enrollment + management WS
  fos_url_guard.c         provider URL rules: local-host exception for plain http/ws, ws_url
                          override guard, origin comparison for the OTA bearer (host-tested)
  fos_minisig.c           minisign .minisig parser + "signed as which release?" check gating every OTA image (host-tested)
  fos_console.c           serial REPL (UART0 + USB-Serial/JTAG): status / set / wifi / render / ota / ...
  fos_cloud_contract.c    the generated cloud verb/settings contract walker (fos_cloud_contract_gen.h)
  fos_json_guard.c        JSON depth pre-scan for the small-stack parser tasks
  fos_sscanf.c            sscanf for the linker's --wrap: cJSON's "%lg" read-back as strtod, so
                          newlib's floating-point scanf is never linked (host-tested)
  fos_settings.c          backend/cloud settings pull (TLS pair, admin login, service keys, schedule)
  fos_scenes.c            /state scene store: combined payload, per-scene split, OOM-restart mark, wipe
  fos_scene_state.c       scene state across deep sleep: one JSON file per scene under /state (host-tested)
  fos_commands.c          the backend's command queue: pulled once per pass and on a nudge, acked by id
  fos_backend_http.c      the one HTTP client for the small pulls and posts (settings, scenes, commands, tz, OTA manifest)
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
  fos_assets_flash.c      assets on the state partition for a board with no SD card the S3 reaches
  fos_sd_probe.c          SD presence probe used by the assets layer
  fos_framebuffer.c       canvas allocation (RGBX vs RGB565 by PSRAM) and dither/pack
  fos_status_screen.c     boot/status screen renderer (shared design with the Pi's)
  fos_panel_draw.c        5x7 font + rectangles straight into a packed panel buffer, rotation
                          aware: the status screen and the local network access code box (host-tested)
  fos_lan_access.c        the local network access code: mint, TTL, attempts, constant-time check (host-tested)
  fos_board.c             board table: pins, panel defaults, battery divider per board
  fos_buttons.c           GPIO button map → `gpio` edges (origin `driver`, via fos_events.c)
  fos_battery.c           battery ADC sampling; fos_battery_filter.c its outlier filter
  fos_power.c             deep sleep, wake-check render skip, VBUS truth
  fos_animation.c         animation mode: a scene below a 1 s interval on an LCD, paced in µs (host-tested)
  fos_wake.c              wake scheduling (next render / schedule event)
  fos_tz.c                IANA zone → POSIX TZ rule
  fos_defaults.h          compile-time defaults of the generic image (NVS wins)
components/
  frameos_display/        DEV_Config on ESP-IDF (spi_master/gpio, runtime pin remap);
                          every root Waveshare EPD_*.c compiled in, with a
                          runtime table from generate_panel_table.py picking
                          the configured panel (see "Every supported panel
                          driver is compiled into each firmware image")
  frameos_nim/            the FrameOS Nim runtime compiled to C (see build_nim.sh);
                          builds a stub when nimcache/ is absent. fos_rows.c shares a
                          pixel loop's rows with a helper on the other core (resample.nim)
partitions_4mb.csv        4MB: nvs + phy + factory app + 512K state; no OTA
partitions.csv            8MB: nvs + otadata + phy + ota_0/ota_1 (3520K each) + 1M state
partitions_ota_16mb.csv   16MB: nvs + otadata + ota_0/ota_1 (4032K each) + 8M state
partitions_ota_32mb.csv   32MB: nvs + otadata + ota_0/ota_1 (4032K each) + 24M state
build_nim.sh              nim c --compileOnly --os:freertos --cpu:esp → nimcache/, then
                          tools/fold_nim_inlines.py: one copy of each Nim inline helper
                          instead of one per C file (~30 KB; docs/esp32-image-size.md)
main/tests/               host tests for the IDF-free modules (plain `cc`, no IDF; each file's
                          header carries its command line). The netguard, local network access code
                          (test_esp32_lan_access.py: fos_lan_access + fos_panel_draw), SD probe, board,
                          power, wake, battery-filter, version, OTA download, LCD splash and loading mark
                          (lcd_loading.c) and scene-event (contract table +
                          fos_events.c dispatch) tests run from the backend's
                          pytest suite (backend/app/tasks/tests/test_esp32_*.py, which also
                          checks that every frameos_nim.h function has a frameos_nim_stub.c
                          twin: the C3 thin client links the stub, and only a release builds
                          it); the contract
                          walker, JSON guard, sscanf, upload limits, assets-path, URL guard, minisig,
                          config-parse, schedule catch-up and console-line tests run in the ESP32 job of
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
- **Seeed reTerminal E-series (E1001/E1002/E1003/E1004)** — the TF socket shares
  the panel's SPI bus: `assets_sd_pins` names the panel's SCK7/MOSI9, so
  `fos_assets_sd.c` joins the display's bus instead of opening SPI3
  (`fos_display_spi_bus_share`), the panel holds the bus for each refresh
  (`DEV_SPI_Acquire`) and the sdspi driver takes its turns between. The
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
  `0x103`) until a bus re-init happened to win the pads back. `fos_i2c_init`
  detaches the PHY (`usb_serial_jtag_ll_phy_enable_pad(false)`) when a bus
  uses 19 or 20, and the console then skips its USB-Serial/JTAG channel —
  the E-series' USB is a CH340 on UART0 anyway.
| `seeed_reterminal_sticky` | S3 | EPD_3in97 3.97" four-grey | reTerminal Sticky, 32MB flash, 8MB PSRAM (renders on-device); panel power GPIO47; keys AI (GPIO4), UP (5), DOWN (6): UP/DOWN held walk the scenes, AI held talks; 4 kHz buzzer GPIO48; PDM mic 19/20/38; GT911 touch panel (`touch_pins`); I2C 1/0 with the PCF8563 clock, SHT40, LSM6DS3TR-C IMU and the BQ27220 fuel gauge (no battery divider); TF socket on the panel bus (CS8, MISO12, power 10, detect 11); deep-sleeps on battery |
| `seeed_reterminal_e1001` | S3 | EPD_7in5_V2 7.5" mono | reTerminal E1001, 32MB flash; battery GPIO1 ÷2, switch GPIO21; TF socket on the panel bus (MISO8, CS14, detect 15, power 16); green LED GPIO6 (lit low); I2C 19/20 (PCF8563 clock, SHT40) + 39/40 (SY6974B charger); PDM mic 42/41/38 |
| `seeed_reterminal_e1002` | S3 | EPD_7in3e 7.3" Spectra | reTerminal E1002, 32MB flash; the same peripherals as the E1001 |
| `seeed_reterminal_e1003` | S3 | EPD_10in3 10.3" sixteen greys (IT8951, E1003 tuning) | reTerminal E1003, 32MB flash, 8MB PSRAM — renders on-device on an 8-bit luma canvas (2.5 MiB); the IT8951 answers on MISO GPIO8 (`dc` slot), panel power GPIO11 (`pwr`), controller power GPIO21 (`cs2`); battery GPIO1 ÷2, switch GPIO40; TF socket on the panel bus (power 39); green LED GPIO16 (lit low); I2C 19/20 with the clock, the SHT40, the charger and the GT911 touch panel (INT 2, reset 48); PDM mic 42/41/38; deep-sleeps on battery |
| `seeed_reterminal_e1004` | S3 | EPD_13in3e 13.3" Spectra (T133A01 tuning) | reTerminal E1004, 32MB flash, 8MB PSRAM — renders on-device on the 16-bit canvas; TF socket as the E1001/E1002; green LED GPIO48 (lit high); I2C 19/20 carries the clock, the sensor AND the charger (39/40 is its J2 header); no microphone |
| `elecrow_crowpanel_5in79` | S3 | EPD_5in79 5.79" 4-gray | CrowPanel, dual SSD1683 |
| `seeed_sensecap_indicator_d1` | S3 | LCD_ST7701S_480x480 4" IPS LCD (RGB, 16-bit colour) | SenseCAP Indicator D1/D1S/D1L/D1Pro, 8MB flash, 8MB PSRAM (renders on-device); the LCD's wiring is the driver's board table, no EPD pins; top button GPIO38 (pressed: the screen off or on, twice: the next scene, held: the previous one; a swipe in from the right or left edge: the next or previous scene, up from the bottom: the scene switcher); FT6336U touch on the LCD's I2C 39/40, polled; the TF socket, buzzer and sensors are the RP2040's |

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
  IO); the controller is held powered through the sleep for it (a few mA).
  The PDM microphone sits on GPIO19/20, the S3's native USB pads: the board's
  USB is a CH343 on UART0, so `fos_mic.c` detaches the USB-Serial/JTAG PHY
  from them when it opens the microphone (the console loses nothing). The
  cell has no divider: the BQ27220 fuel gauge (0x55 on the sensor bus)
  answers `fos_battery_read` with its own voltage and state of charge, and
  its discharge flag is the power decision's "on battery" (`fos_gauge.c`),
  so the frame deep-sleeps on the cell and stays awake on USB like the
  E-series with their charger. The LSM6DS3TR-C IMU (0x6a) and the SHT40 are
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
  it); HRDY is the busy pin, and the bus runs at 20 MHz for this panel
  (FastEPD's clock for the E1003; the write-only panels keep 8 MHz). The
  first refresh of a boot resets the controller, reads its info (a panel
  that is not 1872×1404 fails the init with the size it reported) and
  writes VCOM only when the controller holds another value (it tries the
  setter Waveshare's examples use, then Seeed's, and reads back). Between
  refreshes the controller waits in **standby, which keeps its picture**,
  so a refresh wakes it, sends only the rows whose 64-bit digest changed
  (4-bit big-endian loads straight from the packed buffer, four rows to a
  DMA transfer, runs of changed rows merged over gaps of two), runs GC16
  over the band they span and waits for `LUTAFSR` to clear before standby;
  a frame with no changed row is no refresh at all. A whole frame is 1.25 MiB
  on the wire, about half a second; a clock's digits, a few milliseconds. A
  failed step, a clear (the INIT waveform) or a boot sends the next picture
  whole. The console prints `it8951: N of 1404 rows up in … ms, GC16 over
  rows a-b in … ms` per refresh. The
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
  Indicator's edge swipes besides the keys: in from the right the next scene,
  from the left the previous, up from the bottom the scene switcher
  (`fos_board.c` `TOUCH_EDGE_SWIPES`). The 8 MB module renders
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
  after a reboot anyway). Any other flash write (a settings save, a scene
  download, an OTA) still costs one disturbed frame. `lcd` on the console
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
  An LCD board runs its CPU at 240 MHz (the generic image boots at 160 for
  the battery frames; `status` prints `cpu:`). The scene canvas is the
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
  selects, and the panel is `LCD_ST7701S_480x480` in a new pixel format,
  `FOS_PIXEL_RGB565` (one little-endian 5/6/5 word per pixel, pixie's
  `pfRgb565` layout; the canvas stores with pixie's per-pixel dither so a
  gradient does not step every eight levels, and the snapshot goes out as a
  24-bit BMP). The FocalTech FT6336U touch controller
  (0x48) sits on the expander's bus with its interrupt and reset lines on the
  expander, unwired to the chip: `fos_touch.c` joins the display's bus
  (`fos_display_shared_i2c_bus`) and polls it every 30 ms. The top button is
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
on Wi-Fi.

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
Linux runtime's `./state/scene-<id>.json`, for the chip. Only values off
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
timer wake (2026-10-12) — and a pass that
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

A single management WebSocket message is capped at **512 KiB** (the same
ceiling as the on-device scene store); larger frames are dropped and acked
`message_too_large`.

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
  have been given within an hour of the first of them, across challenges (a
  right code does not reset that; the count lives in RTC memory and the
  clock is system time, so neither a `reboot` nor a deep-sleep wake refills
  it, only a power cycle does). The render task picks it up within a
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
  bearer token) and apply them before the first render
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
surfaced as the frame's "Power" settings section. The GPIO button map
travels the same two ways since 2026-10-12: the backend's settings pull
carries `gpioButtons` (`[{pin, label}]`, present only when the backend holds
a map) and the cloud's `set_settings` carries `gpio_buttons`; the device
rebinds its buttons with a restart. Before that, a provisioned board's map
could only be changed over the console.

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
| `doublePress` | its second down is 1.5× 14 instead of 1× |
| a key held | 1× 8 then 0.5× 20 at every whole second it stays down |
| `press` | none of its own: its clicks were the down and the up |
| refused | down 100 Hz 14, up 70 Hz 14 |

So a tap is "click, clack" and the scene hears `gpio` `down`, `up`, and the
`button` `press` 350 ms later; a double tap is 2000, 1400, 3000, 1400 Hz (the second down
higher); a 2.5 s hold is "click, dun, dun, clack", and the scene
hears its one `longPress` with the `up`: the duns count the hold out loud, they
are not events. Until 2026.10.16 a hold
chirped at 0.5 s and then every second, which was too many sounds. The down click starts from the button task the
moment the edge is queued, so the feedback does not wait for a render that
may be 30 s into a panel refresh. A press that wakes the chip from deep sleep
clicks down as soon as the chip boots (`fos_buttons_wake_boot`) and is a press
like any other from then on: held, it duns each second and its up is a
`longPress`; a tap followed by a quick second tap is a `doublePress`. The
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
two taps in that time are a `doublePress`, and a hold that was long enough
is a `longPress` with its `up`. Until 2026.10.16 every edge was timed when it
was drained, so a tap during a render arrived as a 30 s hold.

A `press` is decided 350 ms after its `up`, and only a tick of the
dispatcher delivers it. So while a key is down or a tap is in its window
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
button, battery or SD pin. Console: `set buzzer_pin <gpio|-1>`,
`set buzzer_tone_hz <hz>` and `beep [hz] [ms]` to test it. Applied live on
every plane: the backend's settings pull carries `buzzerPin` /
`buzzerToneHz`, the cloud's `set_settings` carries `buzzer_pin` /
`buzzer_tone_hz` (firmware 2026.10.12+), and both show them as "Button beep
GPIO" and "Button beep tone" under the frame's GPIO buttons.

### Voice chat

Hold the voice key — the key whose long press the frame's event map binds
to `voiceChat`, REFRESH on the E1001/E1002 presets (`fos_board.c`) — for a
second and the frame listens (`docs/voice-chat.md` is the contract). The
button task reads the binding off `config->event_map` (`fos_voice_binding.c`,
cJSON, host tested by `main/tests/test_fos_voice_binding.c`; read again
whenever the map changes) and runs the key's hold (`fos_voice_hold.c`, pure,
`main/tests/test_fos_voice_hold.c`) before its per-key loop: the dispatcher
would make the `longPress` only at the release, too late to hear a sentence,
so this is the one map rule the firmware carries out itself. From the start
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
sends the rest with `done=1` and waits for the transcript and the reply (the
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
thin: `CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y` (Wi-Fi/lwIP dynamic buffers
PSRAM-first, internal fallback), the reserve pool back to IDF's 32 KB
default, and right-sizing task stacks from the high-water marks.

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
material from the settings pull), the same API is also served over native
ESP-IDF HTTPS on `tls_port` (8443 by default).

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
12.48" multi-controller stack; the IT8951's `EPD_10in3` and the SSD1306 OLED
are hand-written drivers in the component (`EXTRA_PANELS` in the generator).
`FRAMEOS_SELECTED_PANEL` (backend builds
set it from the frame's device) only chooses the boot-time default panel.
Published release images remain per flash-size profile, but one generic image
now covers all panels.
