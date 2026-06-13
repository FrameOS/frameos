# FrameOS ESP32 firmware

FrameOS for ESP32-S3 microcontrollers (milestones M1+M2 in the repo-root `TODO.md`).
The firmware provisions Wi-Fi over a captive portal or the serial console, renders
scenes **on-device** with the Nim runtime (pixie in PSRAM), drives Waveshare SPI
e-ink panels through the same vendor drivers the Raspberry Pi build uses, can
alternatively run as a thin client fetching backend-rendered bitmaps, and updates
itself over the air with A/B rollback.

Reference board: Seeed XIAO ESP32-S3 (8MB flash, 8MB octal PSRAM).

## Layout

```
main/                     boot orchestration + platform modules
  main.c                  app_main: config → display → wifi/portal → http → render loop
  fos_config.c            NVS config store (wifi, backend, panel, pins, intervals)
  fos_wifi.c              STA connect, SoftAP portal, DNS hijack, SNTP
  fos_http.c              esp_http_server route layer (portal + /status + actions)
  fos_client.c            render loop: Nim local render or thin-client fetch → blit
  fos_ota.c               OTA manifest check + esp_https_ota + rollback handling
  fos_console.c           USB-serial REPL: status / set / wifi / render / ota / ...
  fos_defaults.h          compile-time defaults; generated_config.h (from the
                          backend's per-frame build) overrides them
components/
  frameos_display/        DEV_Config on ESP-IDF (spi_master/gpio, runtime pin remap);
                          vendor EPD_*.c copied at configure time from
                          frameos/src/drivers/waveshare/ePaper
  frameos_nim/            the FrameOS Nim runtime compiled to C (see build_nim.sh);
                          builds a stub when nimcache/ is absent
partitions.csv            8MB: nvs + otadata + ota_0/ota_1 (3MB each) + state
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

## Build and flash by hand

```bash
. ~/esp/esp-idf/export.sh
./build_nim.sh             # compile the Nim runtime to C (optional but recommended)
idf.py set-target esp32s3
idf.py reconfigure build   # reconfigure picks up new nimcache/generated_config.h
idf.py -p /dev/tty.usbmodem* flash monitor
```

Or flash the single merged image produced by `idf.py merge-bin` (what the backend
serves and the browser flasher writes):

```bash
esptool.py --chip esp32s3 --port /dev/tty.usbmodem* --baud 460800 write_flash 0x0 merged-binary.bin
```

## First boot and provisioning

Unprovisioned devices start a captive portal: join the `FrameOS-XXXX` Wi-Fi network
and any page redirects to the setup form (Wi-Fi, backend URL, frame ID/API key,
panel, render mode). Backend-built images arrive fully provisioned via
`main/generated_config.h`, including Wi-Fi from the frame's per-frame `network`
settings (the same place the Pi flows keep it).

The USB serial console (115200) is always available and quicker for development:

```
frameos> status
frameos> wifi MySSID MyPassword          # saves and reboots
frameos> set panel EPD_7in5_V2
frameos> set pins rst=5,dc=4,cs=3,busy=6,sck=7,mosi=9,pwr=-1
frameos> set render_mode local           # or: remote (thin client)
frameos> set deep_sleep 1                # battery mode: deep sleep between refreshes
frameos> render                          # render immediately
frameos> ota                             # check for an OTA update now
frameos> factory-reset
```

Default pins target the XIAO ESP32-S3: CS=GPIO3 (D2), DC=GPIO4 (D3), RST=GPIO5 (D4),
BUSY=GPIO6 (D5), SCK=GPIO7 (D8), MOSI=GPIO9 (D10). Remap at runtime with `set pins`,
in the portal, or per-frame via `deviceConfig.pins` in the backend.

When connected, the device serves `GET /status` (heap/PSRAM/Wi-Fi/render stats JSON)
and `POST /api/action/render` / `POST /api/action/ota` on port 80.

## OTA

Images boot as "pending verify" (`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`); the app
marks itself valid once the network is up, otherwise the next reset rolls back to
the previous slot. The device polls `/api/frames/{id}/embedded/ota/manifest` daily
(or on `ota`) and applies new builds via `esp_https_ota`.

## Adding a panel

1. Add the vendor `EPD_*.c/h` filenames to `FRAMEOS_PANEL_SOURCES` in
   `components/frameos_display/CMakeLists.txt` (sources come from
   `frameos/src/drivers/waveshare/ePaper`).
2. Add an entry to the `PANELS` table in `components/frameos_display/frameos_display.c`.
3. Add it to `EMBEDDED_SUPPORTED_PANELS` in `backend/app/tasks/embedded_firmware.py`
   and the `embeddedDevices` list in `frontend/src/scenes/frames/NewFrame.tsx`.
4. Bump `EMBEDDED_FIRMWARE_VERSION`.

Buffer formats other than packed 1bpp (4-gray, Spectra 6) need a matching
`fos_pixel_format_t` and dither path — see `frameos/src/embedded/embedded_main.nim`
and `drivers/waveshare/waveshare.nim` for the Linux-side equivalents.
