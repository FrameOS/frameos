idf_component_register(
    SRCS
        "main.c"
        "fos_cpu.c"
        "fos_board.c"
        "fos_buttons.c"
        "fos_button_timing.c"
        "fos_buzzer.c"
        "fos_restart.c"
        "fos_led.c"
        "fos_i2c.c"
        "fos_charger.c"
        "fos_climate.c"
        "fos_gauge.c"
        "fos_imu.c"
        "fos_motion.c"
        "fos_rotation.c"
        "fos_touch.c"
        "fos_usb_pads.c"
        "fos_usj_attach.c"
        "fos_codec.c"
        "fos_rtc.c"
        "fos_voice_binding.c"
        "fos_voice_hold.c"
        "fos_mic.c"
        "fos_voice.c"
        "fos_wake.c"
        "fos_power.c"
        "fos_config.c"
        "fos_config_parse.c"
        "fos_framebuffer.c"
        "fos_wifi.c"
        "fos_wifi_networks.c"
        "fos_frame_settings.c"
        "fos_store.c"
        "fos_code.c"
        "fos_store_scan.c"
        "fos_http_body.c"
        "fos_scene_meta.c"
        "fos_scene_pieces.c"
        "fos_http.c"
        "fos_animation.c"
        "fos_press.c"
        "fos_boot_scene.c"
        "fos_client.c"
        "fos_render_pull.c"
        "fos_render_relay.c"
        "fos_cloud.c"
        "fos_url_guard.c"
        "fos_cloud_contract.c"
        "fos_json_guard.c"
        "fos_ota.c"
        "fos_ota_download.c"
        "fos_minisig.c"
        "fos_status_screen.c"
        "fos_panel_draw.c"
        "fos_lan_access.c"
        "fos_console.c"
        "fos_scenes.c"
        "fos_scene_state.c"
        "fos_scene_store.c"
        "fos_slot_cache.c"
        "fos_commands.c"
        "fos_backend_http.c"
        "fos_tls.c"
        "fos_tls_dates.c"
        "fos_events.c"
        "fos_schedule.c"
        "fos_settings.c"
        "fos_tz.c"
        "fos_battery.c"
        "fos_battery_filter.c"
        "fos_assets.c"
        "fos_assets_path.c"
        "fos_assets_sd.c"
        "fos_assets_flash.c"
        "fos_spiffs_gc.c"
        "fos_spiffs_footprint.c"
        "fos_sd_probe.c"
        "fos_sscanf.c"
        "fos_printf.c"
        "fos_cxx_new.c"
    PRIV_REQUIRES
        nvs_flash
        esp_wifi
        esp_netif
        esp_event
        esp_timer
        esp_adc
        esp_http_server
        esp_https_server
        esp_http_client
        esp-tls
        app_update
        spi_flash
        json
        mbedtls
        console
        driver
        esp_driver_i2c
        esp_driver_gpio
        esp_hw_support
        hal
        soc
        spiffs
        vfs
        fatfs
        sdmmc
        frameos_display
        frameos_nim
        frameos_quickjs
        monocypher
)

# Calls to ROM and IRAM go through veneers in flash (fos_veneers.h): a
# CALL8 where a call was an L32R, a CALLX8 and a literal. Not from a file
# with IRAM code, which must not call flash: test_esp32_veneers.py holds
# every main/*.c that says IRAM_ATTR to this list.
if(CONFIG_IDF_TARGET_ARCH_XTENSA)
    get_target_property(fos_veneered_srcs ${COMPONENT_LIB} SOURCES)
    list(FILTER fos_veneered_srcs INCLUDE REGEX "\\.c$")
    list(FILTER fos_veneered_srcs EXCLUDE REGEX "/?(fos_led|fos_mic|fos_touch)\\.c$")
    set_source_files_properties(${fos_veneered_srcs} PROPERTIES
        COMPILE_OPTIONS "-include;${CMAKE_CURRENT_LIST_DIR}/fos_veneers.h")
endif()

# The setup page (fos_http.c's GET /) is setup_page.html gzipped here and
# served with Content-Encoding: gzip (tools/gzip_setup_page.py).
set(FOS_SETUP_PAGE_GZ "${CMAKE_CURRENT_BINARY_DIR}/setup_page.html.gz")
add_custom_command(
    OUTPUT "${FOS_SETUP_PAGE_GZ}"
    COMMAND ${python} "${CMAKE_CURRENT_LIST_DIR}/../tools/gzip_setup_page.py"
            "${CMAKE_CURRENT_LIST_DIR}/setup_page.html" "${FOS_SETUP_PAGE_GZ}"
    DEPENDS "${CMAKE_CURRENT_LIST_DIR}/setup_page.html" "${CMAKE_CURRENT_LIST_DIR}/../tools/gzip_setup_page.py"
    VERBATIM)
add_custom_target(fos_setup_page_gz DEPENDS "${FOS_SETUP_PAGE_GZ}")
add_dependencies(${COMPONENT_LIB} fos_setup_page_gz)
target_add_binary_data(${COMPONENT_LIB} "${FOS_SETUP_PAGE_GZ}" BINARY)

# esp_spiffs_gc's SPIFFS_gc goes through fos_spiffs_gc.c, which erases the
# blocks holding only deleted pages before SPIFFS collects by erase age. It
# reads the partition's counters, so it compiles against SPIFFS's own
# headers (private to the spiffs component).
idf_build_get_property(fos_idf_path IDF_PATH)
set_source_files_properties(fos_spiffs_gc.c PROPERTIES
    INCLUDE_DIRECTORIES "${fos_idf_path}/components/spiffs/spiffs/src")
# -u: the only reference is esp_spiffs.c's, which the archive scan can pass.
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=SPIFFS_gc" "-u __wrap_SPIFFS_gc")

# sscanf and siscanf go through fos_sscanf.c: cJSON's "%lg" read-back is
# strtod there and tzset's five TZ formats are read by its integer scanner,
# so neither of newlib's scanf engines (9.6 + 8.3 KB) is linked.
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=sscanf" "-Wl,--wrap=siscanf" "-u __wrap_sscanf")

# Every TLS client attaches the certificate bundle; the name goes to
# fos_tls.c, which attaches it and then puts the firmware's rule for
# certificate dates in front of its verify callback (fos_tls_dates.h). By the
# linker, so a client added later cannot be written without it.
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=esp_crt_bundle_attach"
    "-u __wrap_esp_crt_bundle_attach")

# The printf family goes through fos_printf.c's formatter (doubles by QuickJS's
# js_dtoa): newlib's two copies of its own (_vfprintf_r for FILEs,
# _svfprintf_r for strings, 11-13 KB each) and the dtoa behind them are never
# linked.
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=printf" "-Wl,--wrap=fprintf"
    "-Wl,--wrap=vprintf" "-Wl,--wrap=vfprintf" "-Wl,--wrap=snprintf" "-Wl,--wrap=vsnprintf"
    "-Wl,--wrap=sprintf" "-Wl,--wrap=asprintf" "-Wl,--wrap=vasprintf" "-u __wrap_vprintf")

# NVS's new[] (std::nothrow) and delete[] are fos_cxx_new.c's: libstdc++'s
# pull in the C++ exception runtime and type_info classes (1.5 KB) for a catch
# that cannot run. -u: NVS is linked after main, so the definitions must be in.
target_link_libraries(${COMPONENT_LIB} INTERFACE "-u _ZnajRKSt9nothrow_t")

# Default panel for a local development build. All panel drivers are
# compiled in regardless; this only picks the boot-time default before
# `set panel` / the setup portal / NVS override it. The published release
# images leave it unset ("none").
if(DEFINED ENV{FRAMEOS_SELECTED_PANEL}
   AND NOT "$ENV{FRAMEOS_SELECTED_PANEL}" STREQUAL ""
   AND NOT "$ENV{FRAMEOS_SELECTED_PANEL}" STREQUAL "none")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE
        "FRAMEOS_ENV_DEFAULT_PANEL=\"$ENV{FRAMEOS_SELECTED_PANEL}\"")
endif()

# Boot-time memory attribution (main.c BOOTMEM), the C-side companion to the
# Nim -d:memProbe. FRAMEOS_BOOTMEM=1 in the environment at configure time
# compiles the per-init-step PSRAM logging in.
if(DEFINED ENV{FRAMEOS_BOOTMEM} AND "$ENV{FRAMEOS_BOOTMEM}" STREQUAL "1")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "FRAMEOS_BOOTMEM=1")
endif()
