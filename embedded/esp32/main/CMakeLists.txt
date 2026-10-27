idf_component_register(
    SRCS
        "main.c"
        "fos_board.c"
        "fos_buttons.c"
        "fos_button_timing.c"
        "fos_buzzer.c"
        "fos_led.c"
        "fos_i2c.c"
        "fos_charger.c"
        "fos_climate.c"
        "fos_gauge.c"
        "fos_touch.c"
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
        "fos_http.c"
        "fos_animation.c"
        "fos_client.c"
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
        "fos_commands.c"
        "fos_backend_http.c"
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
        "fos_sd_probe.c"
        "fos_sscanf.c"
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
        monocypher
)

# esp_spiffs_gc's SPIFFS_gc goes through fos_spiffs_gc.c, which erases the
# blocks holding only deleted pages before SPIFFS collects by erase age. It
# reads the partition's counters, so it compiles against SPIFFS's own
# headers (private to the spiffs component).
idf_build_get_property(fos_idf_path IDF_PATH)
set_source_files_properties(fos_spiffs_gc.c PROPERTIES
    INCLUDE_DIRECTORIES "${fos_idf_path}/components/spiffs/spiffs/src")
# -u: the only reference is esp_spiffs.c's, which the archive scan can pass.
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=SPIFFS_gc" "-u __wrap_SPIFFS_gc")

# sscanf goes through fos_sscanf.c: cJSON's "%lg" read-back is strtod there,
# so newlib's floating-point scanf (9.6 KB) is never linked.
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=sscanf" "-u __wrap_sscanf")

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
