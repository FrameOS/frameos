/*
 * Compile-time config defaults for the generic image. Nothing per-frame is
 * ever compiled in: every value here is what a freshly flashed board starts
 * with, and provisioning (the USB console `set` verbs, the setup portal, the
 * backend's /embedded/settings pull, the cloud's set_settings verb) writes
 * the real ones into NVS, which always wins (fos_config.c).
 *
 * Default pins target the Seeed XIAO ESP32-S3 silk labels:
 *   D2=GPIO3 (CS), D3=GPIO4 (DC), D4=GPIO5 (RST), D5=GPIO6 (BUSY),
 *   D8=GPIO7 (SCK), D10=GPIO9 (MOSI). PWR unused.
 */
#pragma once

#ifndef FRAMEOS_DEFAULT_WIFI_SSID
#define FRAMEOS_DEFAULT_WIFI_SSID ""
#endif
#ifndef FRAMEOS_DEFAULT_WIFI_PASS
#define FRAMEOS_DEFAULT_WIFI_PASS ""
#endif
#ifndef FRAMEOS_DEFAULT_BACKEND_URL
#define FRAMEOS_DEFAULT_BACKEND_URL ""
#endif
#ifndef FRAMEOS_DEFAULT_API_KEY
#define FRAMEOS_DEFAULT_API_KEY ""
#endif
#ifndef FRAMEOS_DEFAULT_FRAME_ID
#define FRAMEOS_DEFAULT_FRAME_ID 0
#endif
#ifndef FRAMEOS_DEFAULT_HOSTNAME
#define FRAMEOS_DEFAULT_HOSTNAME "frameos"
#endif
#ifndef FRAMEOS_DEFAULT_GPIO_BUTTONS
#define FRAMEOS_DEFAULT_GPIO_BUTTONS ""
#endif
#ifndef FRAMEOS_DEFAULT_HARDWARE_PRESET
#define FRAMEOS_DEFAULT_HARDWARE_PRESET ""
#endif
#ifndef FRAMEOS_DEFAULT_PANEL
/* All panel drivers are always compiled in; FRAMEOS_SELECTED_PANEL only sets
 * the default the device boots with before `set panel` / portal / NVS
 * override it. */
#ifdef FRAMEOS_ENV_DEFAULT_PANEL
#define FRAMEOS_DEFAULT_PANEL FRAMEOS_ENV_DEFAULT_PANEL
#else
#define FRAMEOS_DEFAULT_PANEL "none"
#endif
#endif
#ifndef FRAMEOS_DEFAULT_RENDER_MODE
#define FRAMEOS_DEFAULT_RENDER_MODE 0 /* local */
#endif
#ifndef FRAMEOS_DEFAULT_ROTATE
#define FRAMEOS_DEFAULT_ROTATE 0
#endif
#ifndef FRAMEOS_DEFAULT_SCALING_MODE
/* "cover" matches what the embedded runtime always hardcoded; the Pi's
 * frame.json default is "contain" — divergence kept deliberately so shipping
 * this config path does not change how existing embedded frames render. */
#define FRAMEOS_DEFAULT_SCALING_MODE "cover"
#endif
#ifndef FRAMEOS_DEFAULT_TIME_ZONE
/* IANA name; "" keeps the pre-2026.8.34 behaviour (UTC). See fos_tz.h. */
#define FRAMEOS_DEFAULT_TIME_ZONE ""
#endif
#ifndef FRAMEOS_DEFAULT_INTERVAL_SEC
#define FRAMEOS_DEFAULT_INTERVAL_SEC 300
#endif
#ifndef FRAMEOS_DEFAULT_MAX_HTTP_RESPONSE_BYTES
#define FRAMEOS_DEFAULT_MAX_HTTP_RESPONSE_BYTES (4 * 1024 * 1024)
#endif
#ifndef FRAMEOS_DEFAULT_SERVER_SEND_LOGS
#define FRAMEOS_DEFAULT_SERVER_SEND_LOGS 1
#endif
#ifndef FRAMEOS_DEFAULT_TLS_ENABLE
#define FRAMEOS_DEFAULT_TLS_ENABLE 0
#endif
#ifndef FRAMEOS_DEFAULT_TLS_PORT
#define FRAMEOS_DEFAULT_TLS_PORT 8443
#endif
#ifndef FRAMEOS_DEFAULT_TLS_SERVER_CERT
#define FRAMEOS_DEFAULT_TLS_SERVER_CERT ""
#endif
#ifndef FRAMEOS_DEFAULT_TLS_SERVER_KEY
#define FRAMEOS_DEFAULT_TLS_SERVER_KEY ""
#endif
#ifndef FRAMEOS_DEFAULT_ADMIN_AUTH_ENABLE
#define FRAMEOS_DEFAULT_ADMIN_AUTH_ENABLE 0
#endif
#ifndef FRAMEOS_DEFAULT_ADMIN_AUTH_USER
#define FRAMEOS_DEFAULT_ADMIN_AUTH_USER ""
#endif
#ifndef FRAMEOS_DEFAULT_ADMIN_AUTH_PASS
#define FRAMEOS_DEFAULT_ADMIN_AUTH_PASS ""
#endif
/* The LAN access switch when NVS holds no `lan_access` key: on, because a
 * frame from before the switch existed must keep reaching its LAN. A new
 * frame gets what was chosen when it was set up (the flashers send
 * `set allow_local_network 0|1`). See docs/lan-access.md and fos_netguard.h. */
#ifndef FRAMEOS_DEFAULT_ALLOW_LOCAL_NETWORK
#define FRAMEOS_DEFAULT_ALLOW_LOCAL_NETWORK 1
#endif
#ifndef FRAMEOS_DEFAULT_ASSETS_PATH
#define FRAMEOS_DEFAULT_ASSETS_PATH "/srv/assets"
#endif
#ifndef FRAMEOS_DEFAULT_ASSETS_SD_ENABLE
#define FRAMEOS_DEFAULT_ASSETS_SD_ENABLE 0
#endif
/* Auto-format a card at boot only when the probe proves it empty; see
 * fos_sd_probe.h. On by default: a new card should just work. */
#ifndef FRAMEOS_DEFAULT_ASSETS_SD_AUTOFORMAT
#define FRAMEOS_DEFAULT_ASSETS_SD_AUTOFORMAT 1
#endif
#ifndef FRAMEOS_DEFAULT_ASSETS_SD_PIN_CS
#define FRAMEOS_DEFAULT_ASSETS_SD_PIN_CS -1
#endif
#ifndef FRAMEOS_DEFAULT_ASSETS_SD_PIN_SCK
#define FRAMEOS_DEFAULT_ASSETS_SD_PIN_SCK -1
#endif
#ifndef FRAMEOS_DEFAULT_ASSETS_SD_PIN_MISO
#define FRAMEOS_DEFAULT_ASSETS_SD_PIN_MISO -1
#endif
#ifndef FRAMEOS_DEFAULT_ASSETS_SD_PIN_MOSI
#define FRAMEOS_DEFAULT_ASSETS_SD_PIN_MOSI -1
#endif
#ifndef FRAMEOS_DEFAULT_ASSETS_SD_MAX_FREQ_KHZ
#define FRAMEOS_DEFAULT_ASSETS_SD_MAX_FREQ_KHZ 20000
#endif
#ifndef FRAMEOS_DEFAULT_DEEP_SLEEP
#define FRAMEOS_DEFAULT_DEEP_SLEEP 0
#endif
#ifndef FRAMEOS_DEFAULT_WAKE_SCHEDULE
#define FRAMEOS_DEFAULT_WAKE_SCHEDULE 0
#endif
#ifndef FRAMEOS_DEFAULT_DEEP_SLEEP_ON_BATTERY
#define FRAMEOS_DEFAULT_DEEP_SLEEP_ON_BATTERY 0
#endif
#ifndef FRAMEOS_DEFAULT_WAKE_CHECK_SEC
#define FRAMEOS_DEFAULT_WAKE_CHECK_SEC 0
#endif
#ifndef FRAMEOS_DEFAULT_BATTERY_PIN
#define FRAMEOS_DEFAULT_BATTERY_PIN -1
#endif
#ifndef FRAMEOS_DEFAULT_BATTERY_DIVIDER
#define FRAMEOS_DEFAULT_BATTERY_DIVIDER 2.0f
#endif
#ifndef FRAMEOS_DEFAULT_BATTERY_ENABLE_PIN
#define FRAMEOS_DEFAULT_BATTERY_ENABLE_PIN -1
#endif
#ifndef FRAMEOS_DEFAULT_BUZZER_PIN
#define FRAMEOS_DEFAULT_BUZZER_PIN -1
#endif
#ifndef FRAMEOS_DEFAULT_BUZZER_TONE_HZ
#define FRAMEOS_DEFAULT_BUZZER_TONE_HZ 2000
#endif
#ifndef FRAMEOS_DEFAULT_PIN_RST
#define FRAMEOS_DEFAULT_PIN_RST 5
#endif
#ifndef FRAMEOS_DEFAULT_PIN_DC
#define FRAMEOS_DEFAULT_PIN_DC 4
#endif
#ifndef FRAMEOS_DEFAULT_PIN_CS
#define FRAMEOS_DEFAULT_PIN_CS 3
#endif
#ifndef FRAMEOS_DEFAULT_PIN_CS2
#define FRAMEOS_DEFAULT_PIN_CS2 -1
#endif
#ifndef FRAMEOS_DEFAULT_PIN_BUSY
#define FRAMEOS_DEFAULT_PIN_BUSY 6
#endif
#ifndef FRAMEOS_DEFAULT_PIN_SCK
#define FRAMEOS_DEFAULT_PIN_SCK 7
#endif
#ifndef FRAMEOS_DEFAULT_PIN_MOSI
#define FRAMEOS_DEFAULT_PIN_MOSI 9
#endif
#ifndef FRAMEOS_DEFAULT_PIN_PWR
#define FRAMEOS_DEFAULT_PIN_PWR -1
#endif
