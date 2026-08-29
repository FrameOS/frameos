idf_component_register(
    SRCS
        "main.c"
        "fos_board.c"
        "fos_buttons.c"
        "fos_wake.c"
        "fos_power.c"
        "fos_config.c"
        "fos_framebuffer.c"
        "fos_wifi.c"
        "fos_http.c"
        "fos_client.c"
        "fos_cloud.c"
        "fos_cloud_verbs.c"
        "fos_ota.c"
        "fos_status_screen.c"
        "fos_console.c"
        "fos_scenes.c"
        "fos_schedule.c"
        "fos_settings.c"
        "fos_tz.c"
        "fos_battery.c"
        "fos_assets.c"
        "fos_assets_sd.c"
        "fos_sd_probe.c"
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
        esp_https_ota
        esp-tls
        app_update
        spi_flash
        json
        mbedtls
        console
        driver
        spiffs
        fatfs
        sdmmc
        frameos_display
        frameos_nim
        monocypher
)

# Default panel for images built without a backend-generated
# main/generated_config.h (e.g. the published generic release binary). All
# panel drivers are compiled in regardless; this only picks the boot-time
# default before `set panel` / the setup portal / NVS override it.
# generated_config.h wins when present (fos_defaults.h checks it first).
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
