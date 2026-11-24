get_filename_component(FRAMEOS_REPO_ROOT
    "${CMAKE_CURRENT_LIST_DIR}/../../../.." REALPATH)

# Every supported Waveshare panel driver is compiled into the firmware; the
# active panel is chosen at runtime from the configured panel name (NVS
# "panel" key). FRAMEOS_SELECTED_PANEL no longer limits what is compiled —
# it only sets the default panel baked into main/ (see main/CMakeLists.txt).

if(NOT DEFINED PYTHON)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(PYTHON "${Python3_EXECUTABLE}")
endif()

set(FRAMEOS_GENERATED_DIR "${CMAKE_CURRENT_BINARY_DIR}/generated")
execute_process(
    COMMAND "${PYTHON}" "${CMAKE_CURRENT_LIST_DIR}/generate_panel_table.py"
            --repo-root "${FRAMEOS_REPO_ROOT}"
            --out-dir "${FRAMEOS_GENERATED_DIR}"
    RESULT_VARIABLE FRAMEOS_PANEL_GENERATOR_RESULT
    OUTPUT_VARIABLE FRAMEOS_PANEL_GENERATOR_STDOUT
    ERROR_VARIABLE FRAMEOS_PANEL_GENERATOR_STDERR
)
if(NOT FRAMEOS_PANEL_GENERATOR_RESULT EQUAL 0)
    message(FATAL_ERROR
        "Failed to generate the Waveshare panel table: "
        "${FRAMEOS_PANEL_GENERATOR_STDERR}${FRAMEOS_PANEL_GENERATOR_STDOUT}")
endif()

include("${FRAMEOS_GENERATED_DIR}/panel_sources.cmake")

# The root sources go into one flat vendor dir so their #include
# "DEV_Config.h" resolves against this component's ESP-IDF DEV_Config instead
# of the Raspberry Pi lgpio one next to them. The headers are symlinks; the
# sources are copies written by fold_panel_helpers.py, in which the static
# helpers several drivers write the same (SendCommand, SendData, the resets)
# call one shared definition, fos_epd_folded.inc, which DEV_Config_esp.c
# includes (about 6 KB; the vendor files stay as they are for the Pi).
set(FRAMEOS_VENDOR_DIR "${CMAKE_CURRENT_BINARY_DIR}/vendor")
file(MAKE_DIRECTORY "${FRAMEOS_VENDOR_DIR}")
set(vendor_srcs "")
foreach(panel_source IN LISTS FRAMEOS_PANEL_SOURCES)
    get_filename_component(panel_basename "${panel_source}" NAME)
    list(APPEND vendor_srcs "${FRAMEOS_VENDOR_DIR}/${panel_basename}")
endforeach()
if(FRAMEOS_PANEL_SOURCES)
    execute_process(
        COMMAND "${PYTHON}" "${CMAKE_CURRENT_LIST_DIR}/fold_panel_helpers.py"
                --include-dir "${CMAKE_CURRENT_LIST_DIR}/include"
                --host "${CMAKE_CURRENT_LIST_DIR}/DEV_Config_esp.c"
                --out-dir "${FRAMEOS_VENDOR_DIR}"
                ${FRAMEOS_PANEL_SOURCES}
        RESULT_VARIABLE FRAMEOS_PANEL_FOLD_RESULT
        OUTPUT_VARIABLE FRAMEOS_PANEL_FOLD_STDOUT
        ERROR_VARIABLE FRAMEOS_PANEL_FOLD_STDERR
    )
    if(NOT FRAMEOS_PANEL_FOLD_RESULT EQUAL 0)
        message(FATAL_ERROR
            "Failed to write the panel drivers' sources: "
            "${FRAMEOS_PANEL_FOLD_STDERR}${FRAMEOS_PANEL_FOLD_STDOUT}")
    endif()
    if(NOT CMAKE_SCRIPT_MODE_FILE)
        # A changed driver writes its copy again.
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
            ${FRAMEOS_PANEL_SOURCES} "${CMAKE_CURRENT_LIST_DIR}/fold_panel_helpers.py"
            "${CMAKE_CURRENT_LIST_DIR}/DEV_Config_esp.c"
            "${CMAKE_CURRENT_LIST_DIR}/include/DEV_Config.h" "${CMAKE_CURRENT_LIST_DIR}/include/Debug.h")
    endif()
endif()
foreach(panel_header IN LISTS FRAMEOS_PANEL_HEADERS)
    get_filename_component(panel_basename "${panel_header}" NAME)
    file(CREATE_LINK "${panel_header}"
                     "${FRAMEOS_VENDOR_DIR}/${panel_basename}"
                     SYMBOLIC COPY_ON_ERROR)
endforeach()

idf_component_register(
    SRCS
        "DEV_Config_esp.c"
        "frameos_display.c"
        "fos_partial_refresh.c"
        "fos_refresh_queue.c"
        "photo_painter_pmic.c"
        "oled_ssd1306.c"
        "it8951.c"
        "lcd_st7701s_rgb.c"
        "lcd_qspi_amoled.c"
        "lcd_qspi_box.c"
        "lcd_splash.c"
        "lcd_loading.c"
        "${FRAMEOS_GENERATED_DIR}/frameos_panel_table.c"
        ${vendor_srcs}
    INCLUDE_DIRS
        "include"
        "${FRAMEOS_GENERATED_DIR}"
        "${FRAMEOS_VENDOR_DIR}"
    PRIV_REQUIRES driver esp_timer esp_lcd esp_driver_i2c esp_driver_gpio esp_driver_spi
)

if(NOT CMAKE_SCRIPT_MODE_FILE AND vendor_srcs)
    set_source_files_properties(${vendor_srcs}
        PROPERTIES COMPILE_OPTIONS "-Wno-error=format")
endif()

# The display layer's C that stands among the shell's objects (link_order.txt)
# calls ROM and IRAM through the shell's veneers (main/fos_veneers.h,
# test_esp32_veneers.py). Neither file has IRAM code: the RGB panel's
# frame-done callback runs in an interrupt that is not IRAM-safe, so it is
# masked whenever the flash is busy.
if(NOT CMAKE_SCRIPT_MODE_FILE AND CONFIG_IDF_TARGET_ARCH_XTENSA)
    set_property(SOURCE "frameos_display.c" "lcd_st7701s_rgb.c"
        APPEND PROPERTY COMPILE_OPTIONS "-include" "${CMAKE_CURRENT_LIST_DIR}/../../main/fos_veneers.h")
endif()
