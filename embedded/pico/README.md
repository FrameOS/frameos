# FrameOS Pico thin client

FrameOS for the Raspberry Pi Pico W (RP2040) and Pico 2 W (RP2350) — most
notably the Pimoroni Inky Frame family, which carries a Pico W (originals)
or Pico 2 W (2025 refresh) on the back of the panel.

Unlike the ESP32-S3 firmware there is **no on-device renderer**: 2MB of
flash and 264KB of SRAM (Pico W) cannot hold the Nim/pixie/QuickJS stack.
Instead the backend renders the frame's scenes server-side in the wasm scene
runtime (`backend/app/utils/embedded_render.py`) and this firmware streams
the packed panel payload from `/api/frames/{id}/embedded/render` straight
into the e-paper controller — no framebuffer, so a 192KB 7-color payload
fits fine next to the WiFi stack. This resolves the flash-size blocker in
[issue #208](https://github.com/FrameOS/frameos/issues/208).

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

## Build

Requires [pico-sdk](https://github.com/raspberrypi/pico-sdk) 2.x, CMake,
Ninja, and an `arm-none-eabi` GCC with newlib (the official Arm GNU
toolchain; Homebrew's bare `arm-none-eabi-gcc` formula lacks `nosys.specs`):

```bash
cmake -B build -DPICO_BOARD=pico_w -DPICO_SDK_PATH=$HOME/pico-sdk -G Ninja
cmake --build build
# → build/frameos_pico.uf2   (use -DPICO_BOARD=pico2_w for the Pico 2 W)
```

## Flash and provision

1. Hold BOOTSEL while plugging in USB; copy `frameos_pico.uf2` onto the
   `RPI-RP2` (or `RP2350`) mass-storage drive. The board reboots into
   FrameOS.
2. Open the USB serial console (115200) and provision — the same command
   surface as the ESP32 firmware:

```
frameos> set hardware pimoroni_inky_frame_5_7
frameos> set backend http://192.168.1.10:8989
frameos> set frame_id 42
frameos> set api_key <the frame's server_api_key>
frameos> wifi MySSID MyPassword          # saves and reboots
frameos> status
frameos> render                          # fetch + refresh now
```

The frame in the FrameOS backend should be created with mode "embedded" and
the matching Inky Frame hardware preset, which points its device at the
matching panel so the server-side render arrives in the right size and
pixel format.

## Battery mode

`set deep_sleep 1` powers the board off completely after each render via
the Inky Frame's PCF85063A RTC + HOLD_VSYS latch (~20µA), cold-booting on
the next interval or on any front button. On USB power the latch cannot cut
VSYS, so the firmware sleeps in place instead — behaviour stays equivalent.

## TLS

`https://` backends work: TLS 1.2 via pico-sdk's mbedTLS behind lwIP altcp,
with hostname verification against an embedded bundle of the major public
CA roots (`src/certs/pk_ca_roots.h` — ISRG, DigiCert, Amazon, GlobalSign,
USERTrust, GoDaddy; swap in your own root for a private CA). Certificate
validity periods check against SNTP time, falling back to a build-time
floor when NTP is unreachable.

## Limitations (v1)

- No cloud enrollment yet: the cloud link additionally needs a WebSocket
  client and a cloud-side render source for thin clients.
- Front buttons trigger an immediate render (and wake from deep sleep in
  hardware); per-button scene actions need a device-event backend endpoint.
- The Inky 4.0" panel's scan orientation may need a PSR tweak vs the
  Waveshare 4.01" reference init; needs validation on glass.
