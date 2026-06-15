# FrameOS ESP32 firmware

FrameOS for ESP32-S3 microcontrollers. The firmware provisions Wi-Fi over a
captive portal or the serial console, renders scenes **on-device** with the Nim
runtime (pixie in PSRAM), drives Waveshare SPI e-ink panels through the same
vendor drivers the Raspberry Pi build uses, and can alternatively run as a thin
client fetching backend-rendered bitmaps.

Reference hardware: ESP32-S3 module with 8MB flash and 8MB+ octal PSRAM.
The default 8MB profile supports OTA updates with two 3520K app slots and a
1M SPIFFS state partition for scenes/user data. Production 16MB modules can
use the optional OTA profile with two 7872K app slots and 512K state.

## Layout

```
main/                     boot orchestration + platform modules
  main.c                  app_main: config → display → wifi/portal → http → render loop
  fos_config.c            NVS config store (wifi, backend, panel, pins, intervals)
  fos_wifi.c              STA connect, SoftAP portal, DNS hijack, SNTP
  fos_http.c              esp_http_server route layer (portal + /status + actions)
  fos_client.c            render loop: Nim local render or thin-client fetch → blit
  fos_ota.c               OTA manifest check + esp_https_ota when an OTA partition exists
  fos_console.c           USB-serial REPL: status / set / wifi / render / ota / ...
  fos_defaults.h          compile-time defaults; generated_config.h (from the
                          backend's per-frame build) overrides them
components/
  frameos_display/        DEV_Config on ESP-IDF (spi_master/gpio, runtime pin remap);
                          one selected root Waveshare EPD_*.c symlinked at
                          configure time and wrapped from generated metadata
  frameos_nim/            the FrameOS Nim runtime compiled to C (see build_nim.sh);
                          builds a stub when nimcache/ is absent
partitions.csv            8MB: nvs + otadata + phy + ota_0/ota_1 (3520K each) + 1M state
partitions_ota_16mb.csv   16MB: nvs + otadata + ota_0/ota_1 (7872K each) + state
build_nim.sh              nim c --compileOnly --os:freertos --cpu:esp → nimcache/
```

## Toolchain

Requires [ESP-IDF](https://docs.espressif.com/projects/esp-idf/) v5.5.x:

```bash
mkdir -p ~/esp && cd ~/esp
git clone --depth 1 --branch v5.5.4 --recursive --shallow-submodules \
  https://github.com/espressif/esp-idf.git
cd esp-idf && ./install.sh esp32s3
```

The backend finds the toolchain via the `IDF_PATH` env var, falling back to
`~/esp/esp-idf`. The on-device Nim runtime additionally needs `nim` (>= 2.2) on
the worker's PATH; without it the firmware builds in thin-client-only mode.

The FrameOS Docker image includes ESP-IDF at `/opt/esp/esp-idf`, native ESP-IDF
host tools under `/opt/esp/idf-tools`, and the Nim toolchain, so firmware builds
started from the packaged backend run inside the container without mounting a
separate host toolchain.

## Build and flash by hand

```bash
. ~/esp/esp-idf/export.sh
./build_nim.sh             # compile the Nim runtime to C (optional but recommended)
idf.py set-target esp32s3
FRAMEOS_SELECTED_PANEL=EPD_7in5_V2 idf.py reconfigure build
# reconfigure picks up new nimcache/generated_config.h and the selected panel
idf.py -p /dev/tty.usbmodem* flash monitor
```

Or flash the single merged image produced by `idf.py merge-bin` (what the backend
serves and the browser flasher writes):

```bash
esptool.py --chip esp32s3 --port /dev/tty.usbmodem* --baud 460800 --flash_size 8MB write_flash 0x0 merged-binary.bin
```

CI uses the same full-image path, including Nim runtime generation, ESP-IDF
`build merge-bin`, partition/size checks, and an optional QEMU boot smoke:

```bash
FRAMEOS_ESP32_QEMU=1 bash embedded/esp32/ci_build_image.sh
```

With `FRAMEOS_ESP32_QEMU=1`, the script adds `sdkconfig.qemu.defaults` to route
logs to UART0 and avoid QEMU's PSRAM path; the default build profile remains
USB Serial/JTAG with octal PSRAM enabled. The QEMU smoke verifies that the
bootloader selects `ota_0` and ESP-IDF starts the `frameos_esp32` app image;
when QEMU reaches `app_main`, the script reports that stronger signal too.

## First boot and provisioning

Unprovisioned devices start a captive portal: join the `FrameOS-XXXX` Wi-Fi network
and any page redirects to the setup form (Wi-Fi, backend URL, frame ID/API key,
panel, render mode). Backend-built images arrive fully provisioned via
`main/generated_config.h`, including Wi-Fi from the frame's per-frame `network`
settings (the same place the Pi flows keep it) and optional native HTTPS using
the same per-frame certificate material as Raspberry Pi Caddy proxies.

The USB serial console (115200) is always available and quicker for development:

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

## Power management (M4)

`deep_sleep` powers the chip down between refreshes; with a panel attached the
render task calls `esp_deep_sleep` and the device cold-boots for the next pass.

`wake_schedule` changes how the sleep duration is computed: with a synced clock
it aligns the wake to wall-clock interval boundaries (a 1h frame wakes at the
top of the hour, a 5-minute frame on :00/:05/...), so clock faces update on
time. Without it (or before SNTP syncs) the time already spent awake this cycle
— boot, Wi-Fi, render — is subtracted from the interval so the cadence doesn't
drift by however long a render took.

`battery_pin` enables battery sensing on an **ADC1** GPIO (ADC2 conflicts with
Wi-Fi). The reading is divider-corrected (`battery_divider`, default 2.0 for a
100k/100k tap), mapped to a percentage via a Li-ion curve, and reported in
`status` and `GET /status`. Below 3% the render + panel refresh is skipped and
the device sleeps 6h to keep a low cell from being cycled down to damage. The
backend can bake these in per-frame via `device_config`:
`deepSleep`, `wakeSchedule`, `batteryPin`, `batteryDivider`.

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

Default pins target the XIAO ESP32-S3: CS=GPIO3 (D2), DC=GPIO4 (D3), RST=GPIO5 (D4),
BUSY=GPIO6 (D5), SCK=GPIO7 (D8), MOSI=GPIO9 (D10). Remap at runtime with `set pins`,
in the portal, or per-frame via `deviceConfig.pins` in the backend. The 13.3-inch
Spectra 6 panel (`EPD_13in3e`) has two controllers and requires `cs2`.

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

For production 16MB flash, build with the optional larger OTA defaults:

```bash
SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.16mb-ota" \
  FRAMEOS_SELECTED_PANEL=EPD_7in5_V2 idf.py reconfigure build
```

That profile boots new images as "pending verify" (`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`);
the app marks itself valid once the network is up, otherwise the next reset rolls
back to the previous slot. The device polls `/api/frames/{id}/embedded/ota/manifest`
daily (or on `ota`) and applies new builds via `esp_https_ota`.

## Adding a panel

1. Add or update the root Waveshare driver wrapper under
   `frameos/src/drivers/waveshare/...`. The ESP32 generator reads that metadata
   (`init`, `clear`, `display`, dimensions, color option) and symlinks only the
   selected root C source/header into the IDF build tree.
2. If the wrapper is a native Nim port with a separate C fallback, add the source
   mapping to `components/frameos_display/generate_selected_panel.py`.
3. If it introduces a new packed pixel layout, add the matching
   `fos_pixel_format_t`, backend FOSB packer, and Nim dither/pack path.
4. Bump `EMBEDDED_FIRMWARE_VERSION`.

The ESP32 component intentionally compiles only one selected display driver per
firmware image. Backend builds set `FRAMEOS_SELECTED_PANEL` from the frame's
device, so changing panel families means rebuilding firmware for that frame.
