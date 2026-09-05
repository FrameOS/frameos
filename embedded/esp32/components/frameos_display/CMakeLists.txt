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

# The root sources are symlinked into one flat vendor dir so their
# #include "DEV_Config.h" resolves against this component's ESP-IDF
# DEV_Config instead of the Raspberry Pi lgpio one next to them.
set(FRAMEOS_VENDOR_DIR "${CMAKE_CURRENT_BINARY_DIR}/vendor")
file(MAKE_DIRECTORY "${FRAMEOS_VENDOR_DIR}")
set(vendor_srcs "")
foreach(panel_source IN LISTS FRAMEOS_PANEL_SOURCES)
    get_filename_component(panel_basename "${panel_source}" NAME)
    file(CREATE_LINK "${panel_source}"
                     "${FRAMEOS_VENDOR_DIR}/${panel_basename}"
                     SYMBOLIC COPY_ON_ERROR)
    list(APPEND vendor_srcs "${FRAMEOS_VENDOR_DIR}/${panel_basename}")
endforeach()
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
        "photo_painter_pmic.c"
        "oled_ssd1306.c"
        "${FRAMEOS_GENERATED_DIR}/frameos_panel_table.c"
        ${vendor_srcs}
    INCLUDE_DIRS
        "include"
        "${FRAMEOS_GENERATED_DIR}"
        "${FRAMEOS_VENDOR_DIR}"
    PRIV_REQUIRES driver esp_timer
)

if(NOT CMAKE_SCRIPT_MODE_FILE AND vendor_srcs)
    set_source_files_properties(${vendor_srcs}
        PROPERTIES COMPILE_OPTIONS "-Wno-error=format")
endif()
