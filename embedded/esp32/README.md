# FrameOS ESP32 firmware

Stub firmware for the ESP32-S3 (milestone M0 in the repo-root `TODO.md`): blinks the
onboard WS2812 LED and prints a heartbeat over USB serial. No FrameOS runtime yet —
this exists to prove the toolchain and the backend build/flash pipeline.

## Toolchain

Requires [ESP-IDF](https://docs.espressif.com/projects/esp-idf/) v5.5.x:

```bash
mkdir -p ~/esp && cd ~/esp
git clone --depth 1 --branch v5.5.4 --recursive --shallow-submodules \
  https://github.com/espressif/esp-idf.git
cd esp-idf && ./install.sh esp32s3
```

The backend finds the toolchain via the `IDF_PATH` env var, falling back to `~/esp/esp-idf`.

## Build and flash by hand

```bash
. ~/esp/esp-idf/export.sh
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/tty.usbmodem* flash monitor
```

Or flash the single merged image produced by `idf.py merge-bin` (what the backend serves):

```bash
esptool.py --chip esp32s3 --port /dev/tty.usbmodem* --baud 460800 write_flash 0x0 merged-binary.bin
```

The stub blinks every known onboard LED so it works across boards without configuration:
WS2812 on GPIO 48 and 38 (ESP32-S3-DevKitC-1 rev v1.0/v1.1) and the plain active-low user
LED on GPIO 21 (Seeed XIAO ESP32-S3). For other boards, add the pin to the tables at the
top of `main/main.c` and bump `EMBEDDED_FIRMWARE_VERSION` in
`backend/app/tasks/embedded_firmware.py` so existing images rebuild.

A healthy board prints `frameos: alive, N blinks` every 10 seconds on the USB serial
console: `screen /dev/cu.usbmodem* 115200` (quit with ctrl-a k).
