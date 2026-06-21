# FrameOS Pico firmware

FrameOS firmware target for Raspberry Pi Pico 2 and Pico 2 W / RP2350 boards
with 4MB flash.

This target produces a UF2 image that boots a USB serial FrameOS runtime shell
with frame identity, backend URL, API key, panel, and GPIO defaults baked in.
Pico 2 W builds use the Pico SDK `pico2_w` board so wireless-capable hardware is
selected and Wi-Fi credentials can be baked into the frame settings. HTTP
polling, local Nim rendering, and OTA updates remain ESP32-S3 features until a
Pico network transport is added.

## Build prerequisites

- Raspberry Pi Pico SDK checkout
- CMake
- `arm-none-eabi-gcc/g++` with the ARM newlib C++ headers

Example:

```bash
export PICO_SDK_PATH=$HOME/pico/pico-sdk
cmake -S embedded/pico2 -B embedded/pico2/build -DPICO_BOARD=pico2
cmake --build embedded/pico2/build
```

Use `-DPICO_BOARD=pico2_w` for Pico 2 W. The backend firmware builder writes
`generated_config.h` before configuring the project and stores the resulting UF2
as the downloadable image.

The FrameOS Docker image includes the Pico SDK at `/opt/pico/pico-sdk`,
`arm-none-eabi-gcc/g++`, and the ARM newlib C++ headers, so backend firmware
builds run inside the packaged container without mounting host tooling. CI uses
the same image and helper for both boards:

```bash
bash embedded/pico2/ci_build_image.sh
FRAMEOS_PICO_PLATFORM=pico2w bash embedded/pico2/ci_build_image.sh
```

When running the backend directly on a development machine, FrameOS first uses a
local `PICO_SDK_PATH` if available. If the Pico SDK/toolchain is not installed
locally, Pico firmware builds fall back to the selected build environment
(Docker by default, or a configured build host/Modal sandbox). Setting the build
environment to `none` disables that fallback and requires the local SDK.

## Flashing

Hold `BOOTSEL` while plugging in the Pico board, then copy the generated `.uf2`
file to the mounted `RPI-RP2` drive. After reboot, open the USB serial port at
any baud rate and send `help` or `status`.
