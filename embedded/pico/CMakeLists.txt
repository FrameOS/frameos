# FrameOS thin-client firmware for Raspberry Pi Pico W / Pico 2 W.
#
# A deliberately small sibling of embedded/esp32: no on-device renderer at
# all (2MB flash / 264KB SRAM on the Pico W rule it out) — the backend
# renders scenes server-side (backend/app/utils/embedded_render.py) and this
# firmware streams the packed panel payload straight from the HTTP response
# to the display, no full framebuffer needed.
#
# Build (pico-sdk 2.x):
#   cmake -B build -DPICO_BOARD=pico_w  -DPICO_SDK_PATH=$HOME/pico-sdk -G Ninja
#   cmake --build build
# For the Pico 2 W use -DPICO_BOARD=pico2_w. Output: build/frameos_pico.uf2
cmake_minimum_required(VERSION 3.13)

include(pico_sdk_import.cmake)

project(frameos_pico C CXX ASM)
set(CMAKE_C_STANDARD 11)

pico_sdk_init()

add_executable(frameos_pico
    src/main.c
    src/pk_config.c
    src/pk_console.c
    src/pk_wifi.c
    src/pk_http.c
    src/pk_display.c
    src/pk_shiftreg.c
    src/drivers/panel_uc8159.c
    src/drivers/panel_ac073tc1a.c
    src/drivers/panel_el673.c
)

target_include_directories(frameos_pico PRIVATE src)

target_link_libraries(frameos_pico
    pico_stdlib
    pico_cyw43_arch_lwip_poll
    hardware_spi
    hardware_i2c
    hardware_flash
    hardware_sync
    hardware_adc
    hardware_watchdog
)

# Console + provisioning over USB CDC (same surface as the ESP32 serial
# console); UART stays available for debug probes.
pico_enable_stdio_usb(frameos_pico 1)
pico_enable_stdio_uart(frameos_pico 0)

pico_add_extra_outputs(frameos_pico)

# Version string baked into `status` output and the enrollment user agent.
if(NOT DEFINED FRAMEOS_VERSION)
    set(FRAMEOS_VERSION "dev")
endif()
target_compile_definitions(frameos_pico PRIVATE FRAMEOS_VERSION="${FRAMEOS_VERSION}")
