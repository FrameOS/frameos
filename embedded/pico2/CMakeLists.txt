cmake_minimum_required(VERSION 3.13)

set(PICO_BOARD pico2 CACHE STRING "Raspberry Pi Pico SDK board")

if(NOT DEFINED PICO_SDK_PATH AND DEFINED ENV{PICO_SDK_PATH})
    set(PICO_SDK_PATH "$ENV{PICO_SDK_PATH}")
endif()

if(NOT PICO_SDK_PATH)
    message(FATAL_ERROR "Set PICO_SDK_PATH to a Raspberry Pi Pico SDK checkout")
endif()

include("${PICO_SDK_PATH}/external/pico_sdk_import.cmake")

project(frameos_pico2 C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

pico_sdk_init()

add_executable(frameos_pico2
    main.c
)

target_include_directories(frameos_pico2 PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}
)

target_compile_definitions(frameos_pico2 PRIVATE
    FRAMEOS_PICO2_FIRMWARE=1
    FRAMEOS_PICO_BOARD_NAME=\"${PICO_BOARD}\"
)

target_link_libraries(frameos_pico2
    pico_stdlib
    hardware_spi
)

pico_enable_stdio_usb(frameos_pico2 1)
pico_enable_stdio_uart(frameos_pico2 0)
pico_add_extra_outputs(frameos_pico2)
