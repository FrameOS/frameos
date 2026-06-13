# The vendor Waveshare panel drivers are shared with the Raspberry Pi build
# (frameos/src/drivers/waveshare/ePaper). They're copied into the build dir so
# their `#include "DEV_Config.h"` resolves to this component's ESP-IDF
# implementation instead of the lgpio one sitting next to them in the repo
# (quoted includes search the source file's own directory first).
get_filename_component(FRAMEOS_EPAPER_DIR
    "${CMAKE_CURRENT_LIST_DIR}/../../../../frameos/src/drivers/waveshare/ePaper" REALPATH)
set(FRAMEOS_VENDOR_DIR "${CMAKE_CURRENT_BINARY_DIR}/vendor")

set(FRAMEOS_PANEL_SOURCES
    EPD_7in5_V2.c
    EPD_7in5_V2.h
)

set(vendor_srcs "")
foreach(panel_file ${FRAMEOS_PANEL_SOURCES})
    configure_file("${FRAMEOS_EPAPER_DIR}/${panel_file}"
                   "${FRAMEOS_VENDOR_DIR}/${panel_file}" COPYONLY)
    if(panel_file MATCHES "\\.c$")
        list(APPEND vendor_srcs "${FRAMEOS_VENDOR_DIR}/${panel_file}")
    endif()
endforeach()

idf_component_register(
    SRCS "DEV_Config_esp.c" "frameos_display.c" ${vendor_srcs}
    INCLUDE_DIRS "include" "${FRAMEOS_VENDOR_DIR}"
    PRIV_REQUIRES driver esp_timer
)
