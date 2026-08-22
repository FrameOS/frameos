/*
 * Compile-time config defaults. The backend's per-frame build writes
 * generated_config.h (gitignored) next to this file; a plain checkout
 * builds a generic image that gets everything via provisioning.
 *
 * Default pins target the Seeed XIAO ESP32-S3 silk labels:
 *   D2=GPIO3 (CS), D3=GPIO4 (DC), D4=GPIO5 (RST), D5=GPIO6 (BUSY),
 *   D8=GPIO7 (SCK), D10=GPIO9 (MOSI). PWR unused.
 * All remappable at runtime: `set pins rst=...` on the serial console,
 * the setup portal, or NVS.
 */
#pragma once

#if defined(__has_include)
#if __has_include("generated_config.h")
#include "generated_config.h"
#define FRAMEOS_HAVE_GENERATED_CONFIG 1
#endif
#endif

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
 * override it. generated_config.h (backend builds) takes precedence. */
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
#ifndef FRAMEOS_DEFAULT_TZ_DATA
/* The tzdata slice for FRAMEOS_DEFAULT_TIME_ZONE (lib/tz.nim shape, ~1.5 KB),
 * baked by the backend (embedded_firmware.py); "" = fetch it from
 * tz.frameos.net on the first online render pass. See fos_tz.h. */
#define FRAMEOS_DEFAULT_TZ_DATA ""
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
/* Off: an enrolled frame's scenes come from the provider, so they do not get
 * to reach the owner's LAN. See fos_netguard.h and `set allow_local_network`. */
#ifndef FRAMEOS_DEFAULT_ALLOW_LOCAL_NETWORK
#define FRAMEOS_DEFAULT_ALLOW_LOCAL_NETWORK 0
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
