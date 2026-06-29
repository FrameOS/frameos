get_filename_component(FRAMEOS_REPO_ROOT
    "${CMAKE_CURRENT_LIST_DIR}/../../../.." REALPATH)

if(DEFINED ENV{FRAMEOS_SELECTED_PANEL})
    set(FRAMEOS_SELECTED_PANEL "$ENV{FRAMEOS_SELECTED_PANEL}" CACHE STRING
        "Waveshare panel compiled into this firmware" FORCE)
elseif(NOT DEFINED FRAMEOS_SELECTED_PANEL)
    set(FRAMEOS_SELECTED_PANEL "none" CACHE STRING
        "Waveshare panel compiled into this firmware")
endif()

if(NOT DEFINED PYTHON)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(PYTHON "${Python3_EXECUTABLE}")
endif()

set(FRAMEOS_GENERATED_DIR "${CMAKE_CURRENT_BINARY_DIR}/generated")
execute_process(
    COMMAND "${PYTHON}" "${CMAKE_CURRENT_LIST_DIR}/generate_selected_panel.py"
            --repo-root "${FRAMEOS_REPO_ROOT}"
            --panel "${FRAMEOS_SELECTED_PANEL}"
            --out-dir "${FRAMEOS_GENERATED_DIR}"
    RESULT_VARIABLE FRAMEOS_PANEL_GENERATOR_RESULT
    OUTPUT_VARIABLE FRAMEOS_PANEL_GENERATOR_STDOUT
    ERROR_VARIABLE FRAMEOS_PANEL_GENERATOR_STDERR
)
if(NOT FRAMEOS_PANEL_GENERATOR_RESULT EQUAL 0)
    message(FATAL_ERROR
        "Failed to generate selected Waveshare panel ${FRAMEOS_SELECTED_PANEL}: "
        "${FRAMEOS_PANEL_GENERATOR_STDERR}${FRAMEOS_PANEL_GENERATOR_STDOUT}")
endif()

include("${FRAMEOS_GENERATED_DIR}/selected_panel.cmake")

set(FRAMEOS_VENDOR_DIR "${CMAKE_CURRENT_BINARY_DIR}/vendor")
set(vendor_srcs "")
if(FRAMEOS_SELECTED_PANEL_SOURCE)
    file(MAKE_DIRECTORY "${FRAMEOS_VENDOR_DIR}")
    file(CREATE_LINK "${FRAMEOS_SELECTED_PANEL_SOURCE}"
                     "${FRAMEOS_VENDOR_DIR}/${FRAMEOS_SELECTED_PANEL_SOURCE_BASENAME}"
                     SYMBOLIC COPY_ON_ERROR)
    file(CREATE_LINK "${FRAMEOS_SELECTED_PANEL_HEADER}"
                     "${FRAMEOS_VENDOR_DIR}/${FRAMEOS_SELECTED_PANEL_HEADER_BASENAME}"
                     SYMBOLIC COPY_ON_ERROR)
    list(APPEND vendor_srcs "${FRAMEOS_VENDOR_DIR}/${FRAMEOS_SELECTED_PANEL_SOURCE_BASENAME}")
endif()

idf_component_register(
    SRCS
        "DEV_Config_esp.c"
        "frameos_display.c"
        "photo_painter_pmic.c"
        "${FRAMEOS_GENERATED_DIR}/frameos_selected_panel.c"
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
