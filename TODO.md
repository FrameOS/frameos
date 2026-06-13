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

### M1 — thin client (shippable on its own)  ← done
- [x] Wi-Fi provisioning: SoftAP captive portal (`FrameOS-XXXX`, DNS hijack on :53, setup
      form) + serial-console provisioning (`wifi <ssid> [pass]`, `set <key> <value>`); config
      persisted in NVS, per-frame defaults baked by the backend into `generated_config.h`
- [x] Thin client: fetch backend bitmap over HTTP(S) (`esp_http_client` + cert bundle,
      "FOSB" 1bpp wire format), display, optional deep sleep between refreshes (`set deep_sleep 1`)
- [x] `DEV_Config` for ESP-IDF (`components/frameos_display`): hardware SPI + GPIO with
      runtime pin remapping; vendor `EPD_7in5_V2.c` compiles unmodified from the shared
      `frameos/src/drivers/waveshare/ePaper` tree. GPIO remap also added to the Pi build
      (`DEV_SetPinConfig` + `deviceConfig.pins` in frame.json, all platforms).
      Verified on the XIAO ESP32-S3 over serial; end-to-end panel test still needs a panel wired up.
- [x] OTA updates: A/B `ota_0`/`ota_1` partitions, manifest+download pull from the backend,
      `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` with mark-valid-after-healthy-boot
- [x] Backend: device-authed endpoints (Bearer `server_api_key`) — `/embedded/render`
      (stub placeholder card, dithered+packed; real scenes render on-device),
      `/embedded/ota/manifest`, `/embedded/ota/download`; panel picker in New Frame

### M2 — Nim core on the metal  ← done
- [x] Toolchain spike: `nim c --compileOnly --os:freertos --cpu:esp --mm:orc -d:useMalloc`
      → nimcache C compiled as IDF component (`build_nim.sh` + `components/frameos_nim`);
      gotchas: `-d:noSignalHandler`, `-Wno-error=incompatible-pointer-types` (GCC 14)
- [x] HAL split in `frameos/src/frameos/hal/`: files / clock / processes / net_client;
      config, logger, scenes, boot_guard, scheduler rewired; embedded build excludes
      process/net modules at compile time
- [x] Embedded runtime on FreeRTOS: render loop task (`fos_client`), Nim logging via C hook,
      interval scheduler + render-now triggers from console/HTTP
- [x] Server route layer on `esp_http_server`: `/` setup page, `/status` JSON,
      `POST /api/setup`, `POST /api/action/render|ota` (same layer serves the captive portal)
- [x] Pixie on PSRAM: 800×480 RGBA scene renders in ~400 ms + ~530 ms Floyd–Steinberg
      dither+pack to 1bpp on the S3 (8MB octal PSRAM via `SPIRAM_USE_MALLOC`)
- [x] Compiled-scene pipeline: backend firmware build runs the Nim cross-compile and bakes
      scene parameters (`-d:frameosSceneName/...Background` from the frame's first scene)
      into the OTA artifact (`...-ota.bin` + sha256 manifest). Full scene-graph → Nim
      codegen for Xtensa is the M3 follow-up.

### M3 — interpreted scenes (QuickJS)
- [x] QuickJS on Xtensa, JS heap in PSRAM: vendored engine compiled as the
      `frameos_quickjs` IDF component (no quickjs-libc); `fos_js_new_runtime()`
      allocates from PSRAM (`heap_caps_malloc`), 4MB memory limit, 20KB
      interpreter stack inside the 48KB render task
- [x] Bind `js_runtime`/`app_runtime` + standard app library (AOT) to the embedded
      build: full `interpreter.nim` + QuickJS bridge cross-compile under
      `-d:frameosEmbedded` (types/channels/burrito/http_client/image/tz gained
      embedded branches). App registry minus chromiumScreenshot + rstpSnapshot
      (child processes) and 6 apps that import std/httpclient directly; outbound
      HTTP for apps goes through esp_http_client + cert bundle (`fos_nim_http_request`)
- [x] Scene push without reflash: scenes live on the `state` SPIFFS partition
      (/state/scenes.json), hot-swapped into the running Nim runtime. Pull:
      device polls `GET /embedded/scenes` (sha256 ETag → 304) each render pass +
      `scenes` console cmd + `POST /api/action/scenes_sync`. Push: `POST /api/scenes`
      on the device takes a scenes.json payload directly (LAN)
- [ ] On-device verification: firmware built (2.95MB/3MB slot) and the same
      interpreter+scene JSON verified on host, but the XIAO stopped responding
      over USB (no REPL, no esptool download mode) before it could be flashed —
      needs a physical RESET/BOOT press, then:
      `python -m esptool --chip esp32s3 -p /dev/cu.usbmodem1101 --baud 460800 erase_region 0xf000 0x2000` (reset otadata, keeps NVS+Wi-Fi)
      `python -m esptool --chip esp32s3 -p /dev/cu.usbmodem1101 --baud 460800 write_flash 0x20000 embedded/esp32/build/frameos_esp32.bin`
      then over serial: `scenes` (backend sync) or
      `curl -X POST --data-binary @/tmp/esp32-test-scenes.json http://<device-ip>/api/scenes`

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
