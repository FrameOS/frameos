# FrameOS thin-client firmware for Raspberry Pi Pico W / Pico 2 W.
#
# A deliberately small sibling of embedded/esp32: no on-device renderer at
# all. 264KB of SRAM on the Pico W rules it out, and so do the Pico 2 W's
# 520KB — the Inky Frame's 8MB PSRAM hangs off a plain SPI bus and cannot be
# memory-mapped, so there is nowhere to put an 800x480 canvas, let alone
# QuickJS. The backend renders scenes server-side
# (backend/app/utils/embedded_render.py) and this firmware pulls the packed
# panel payload and drives the display; everything else an ESP32 frame does
# (USB provisioning from the browser, setup hotspot, settings pull, device
# HTTP API, logs, battery sleep) it does too.
#
# Build (pico-sdk 2.x):
#   cmake -B build -DPICO_BOARD=pico_w  -DPICO_SDK_PATH=$HOME/pico-sdk -G Ninja
#   cmake --build build
# For the Pico 2 W use -DPICO_BOARD=pico2_w. Output: build/frameos_pico.uf2
#
# Host tests for the portable modules (no SDK, no hardware): make -C tests
cmake_minimum_required(VERSION 3.13)

include(pico_sdk_import.cmake)

project(frameos_pico C CXX ASM)
set(CMAKE_C_STANDARD 11)

pico_sdk_init()

# Portable modules: no pico-sdk includes, each with a host test in tests/.
set(FRAMEOS_PICO_PORTABLE_SOURCES
    src/pk_args.c
    src/pk_bmp.c
    src/pk_config_keys.c
    src/pk_fosb.c
    src/pk_hotspot.c
    src/pk_http_response.c
    src/pk_httpd_parse.c
    src/pk_json.c
    src/pk_log.c
    src/pk_settings_parse.c
    src/pk_state.c
    src/pk_status_screen.c
)

add_executable(frameos_pico
    src/main.c
    src/pk_config.c
    src/pk_console.c
    src/pk_display.c
    src/pk_http.c
    src/pk_httpd.c
    src/pk_leds.c
    src/pk_platform.c
    src/pk_render.c
    src/pk_rtc.c
    src/pk_shiftreg.c
    src/pk_status.c
    src/pk_time.c
    src/pk_wifi.c
    src/drivers/panel_uc8159.c
    src/drivers/panel_ac073tc1a.c
    src/drivers/panel_el673.c
    ${FRAMEOS_PICO_PORTABLE_SOURCES}
)

target_include_directories(frameos_pico PRIVATE
    src
    # The status screen's 5x7 font and the FrameOS mark are the ESP32's.
    ${CMAKE_CURRENT_LIST_DIR}/../esp32/main
)

target_compile_options(frameos_pico PRIVATE -Wall -Wextra -Wno-unused-parameter)

target_link_libraries(frameos_pico
    pico_stdlib
    pico_rand
    pico_cyw43_arch_lwip_poll
    pico_lwip_sntp
    pico_lwip_mdns
    pico_lwip_mbedtls
    pico_mbedtls
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
target_compile_definitions(frameos_pico PRIVATE
    FRAMEOS_VERSION="${FRAMEOS_VERSION}"
    # One core, one stack: the render pass, mbedTLS's handshake and a console
    # command can all be on it at once. The default 2KB is not a plan.
    PICO_STACK_SIZE=0x4000
    # Boot without waiting for a terminal to open the port. (The SDK's
    # 1200-baud "touch" reset into BOOTSEL stays on: it is the way back in
    # when a firmware's console does not answer.)
    PICO_STDIO_USB_CONNECT_WAIT_TIMEOUT_MS=0
)
