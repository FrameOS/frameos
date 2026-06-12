# FrameOS on ESP32 — port plan

Target: **ESP32-S3** (dual-core Xtensa @ 240MHz, ~512KB SRAM, 8–16MB PSRAM, 8–16MB flash, Wi-Fi).
Goal: FrameOS frames running on $5 microcontrollers — battery-friendly (deep sleep between
e-ink refreshes), instant boot, no SD card to corrupt. A port, not a recompile: everything
that assumes Linux gets replaced; everything that's pure Nim or vendor C comes along.

## Why this is feasible

- **Nim compiles to C.** Proven route to ESP-IDF/FreeRTOS (`--os:freertos --cpu:esp`, or emit
  C into an IDF component — see `nesper`). ARC/ORC works on embedded, no GC thread.
- **Panel drivers mostly come for free.** `frameos/src/drivers/waveshare/ePaper/` talks to
  hardware only through `DEV_Config.c`; Waveshare ships ESP32 variants of it. Reimplement
  `DEV_Config` on ESP-IDF SPI/GPIO and the whole panel family follows.
- **Pixie is pure Nim** (SIMD optional, scalar fallback). Compiles for Xtensa; the constraint
  is RAM, not portability.
- **QuickJS is portable C** and known to run on ESP32-S3 with PSRAM. Our interpreted scene
  mode (`js_runtime/`) is the key to shipping scenes without reflashing firmware.

## Hard constraints

- **RAM is the wall.** Pixie images are RGBA (4B/px):
  - 800×480 (7.5"): 1.5MB — comfortable in 8MB PSRAM
  - 1200×825 (10.2"): 4MB — OK with care
  - 1600×1200 (13.3" Spectra 6): 7.7MB — needs 16MB PSRAM or an 8-bit internal format
  - PSRAM is ~5-10× slower than SRAM; large per-pixel ops will be slow.
- **Flash is fine.** Core runtime + trimmed admin UI + QuickJS (~400KB) fits 16MB with OTA A/B.

## What we give up / replace

| Today (Linux) | ESP32-S3 |
|---|---|
| mummy HTTP server (epoll, threads) | `esp_http_server` behind the same route layer |
| OpenSSL (`-d:ssl`) | mbedTLS / `esp_tls` / `esp_http_client` |
| `utils/process.nim`, child processes | gone entirely |
| `tls_proxy`, `setup_proxy`, `samba_mounts`, `timezone_updater`, `device_setup`, `watchdog` | gone, or IDF equivalents (SNTP, task watchdog, OTA rollback) |
| `evdev`, linuxfb, `inkyPython`, `inkyHyperPixel2r` | gone — SPI panels only; no HDMI/DPI/Python |
| OS threads + Nim channels (runner/scheduler/logger/server) | a handful of FreeRTOS tasks or one event loop |
| `frame.json` / `scenes.json` on disk | LittleFS/FAT partition on flash |
| Decode-anything image pipeline | streaming decode and/or backend-prerendered bitmaps |

## Compiled vs. interpreted scenes

- **Compiled (AOT Nim):** scenes baked into the firmware image. No dynamic loading on ESP32,
  so every scene edit = backend cross-compile (Xtensa) + OTA + reboot. Works — backend already
  owns cross-compilation — but slow loop; needs A/B rollback to be safe.
- **Interpreted (QuickJS):** firmware is a stable "player" (core + pixie + drivers + standard
  app library AOT-compiled in), scenes ship as JS over the existing backend channel. Hot scene
  updates exactly like today. Interpretation overhead is irrelevant for scene glue; pixie calls
  stay native. **This is the recommended primary mode for ESP32.**

## Milestones

### M0 — toolchain + stub firmware via New Frame flow  ← (this PR)
- [x] TODO.md (this file)
- [x] ESP-IDF v5.5.4 toolchain installed and documented (`~/esp/esp-idf`, `./install.sh esp32s3`)
- [x] `embedded/esp32/` ESP-IDF stub project: blinks the onboard WS2812 LED, prints a
      heartbeat on serial. No FrameOS runtime yet.
- [x] Backend: `embedded` frame mode + `esp32-s3` platform; arq build task (`embedded_firmware`)
      that runs `idf.py build merge-bin` and serves a single image flashable at offset `0x0`
- [x] Frontend: New frame → "Flash embedded device" → platform ESP32-S3 → create → build →
      download `.bin` + esptool flash instructions over USB serial
- [x] End-to-end verified locally (worker build → 254KB merged image → download endpoint;
      backend tests in `app/api/tests/test_embedded_firmware.py`)
- [x] Flash a physical ESP32-S3 board and watch it blink (verified on a Seeed XIAO ESP32-S3;
      the stub drives WS2812 on GPIO 48/38 and the XIAO's plain LED on GPIO 21)
- [x] Flash directly from the browser via Web Serial (esptool-js) in the firmware drawer —
      builds on demand, streams progress, hard-resets the board after flashing

### M1 — thin client (shippable on its own)
- [ ] Wi-Fi provisioning (captive portal, like today's hotspot setup flow)
- [ ] Fetch backend-prerendered bitmap over HTTPS (`esp_http_client` + mbedTLS), display, deep-sleep
- [ ] `DEV_Config` for ESP-IDF → bring up one Waveshare SPI e-ink panel end to end
- [ ] OTA updates (A/B partitions, rollback on boot failure)
- [ ] Backend: per-frame render endpoint (dithered to panel palette), device type plumbing

### M2 — Nim core on the metal
- [ ] Toolchain spike: Nim → C → IDF component; ARC, stdlib subset, PSRAM allocator
- [ ] HAL split in `frameos/src`: isolate files/net/time/threads/process behind interfaces
      (valuable refactor even for Linux)
- [ ] Port logger/scheduler/runner onto FreeRTOS tasks; channels → queues
- [ ] Server route layer on `esp_http_server` (trimmed admin UI or none)
- [ ] Pixie on PSRAM; optional 8-bit palette/gray internal format; banded rendering
- [ ] Compiled-scene pipeline: backend Xtensa target → OTA artifact

### M3 — interpreted scenes (QuickJS)
- [ ] QuickJS on Xtensa, JS heap in PSRAM
- [ ] Bind `js_runtime`/`app_runtime` API surface + standard app library (AOT) to embedded build
- [ ] Scene push as JS over the backend channel — hot updates without reflash

### M4 — make it a product
- [ ] Battery/deep-sleep modes, wake-on-schedule
- [ ] Panel matrix beyond the first one; SPI LCDs
- [ ] Memory guardrails per panel size (refuse panels that don't fit the module's PSRAM)

## M0 implementation notes

- Firmware project: `embedded/esp32/` (standard ESP-IDF layout: `CMakeLists.txt`,
  `main/`, `sdkconfig.defaults`). Blink uses the `espressif/led_strip` managed component —
  ESP32-S3 devkits route the onboard LED as an addressable WS2812 (default GPIO 48).
- Build: `idf.py -B <artifact_dir> build merge-bin` → single `merged-binary.bin` flashed at
  `0x0`. Backend wraps this in an arq task (`embedded_firmware`), mirroring
  `buildroot_image.py` (status JSON on the frame, download endpoint, websocket updates).
- Flash command surfaced in the UI:
  `esptool.py --chip esp32s3 --port /dev/tty.usbmodem* --baud 460800 write_flash 0x0 frameos-<name>.bin`
- Toolchain discovery: `IDF_PATH` env var or `~/esp/esp-idf` fallback; builds run with the
  IDF export environment sourced.
