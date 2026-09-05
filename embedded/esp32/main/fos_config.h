/*
 * FrameOS embedded config store.
 *
 * One NVS namespace ("frameos") holding everything a frame needs to run.
 * Compile-time defaults are the neutral fallbacks in fos_defaults.h; NVS
 * always wins, so a device provisioned in the field keeps its settings
 * across OTA. The TLS server certificate and key are stored as NVS blobs
 * (a PEM exceeds the NVS string limit); everything else is a string or a
 * scalar under a short key.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define FOS_STR_LEN 128
#define FOS_AP_PSK_LEN 64          /* WPA2 passphrases are 8-63 characters */
#define FOS_URL_LEN 256
#define FOS_TLS_PEM_LEN 4096
#define FOS_GPIO_BUTTONS_MAX 8
#define FOS_GPIO_BUTTON_LABEL_LEN 32
#define FOS_GPIO_BUTTONS_SPEC_LEN 384
#define FOS_ASSETS_PATH_LEN 128

typedef enum {
    FOS_RENDER_LOCAL = 0,  /* render scenes on-device with the Nim runtime */
    FOS_RENDER_REMOTE = 1, /* thin client: fetch prerendered bitmap from backend */
} fos_render_mode_t;

typedef struct {
    int8_t rst;
    int8_t dc;
    int8_t cs;
    int8_t cs2; /* second CS for dual-controller panels, -1 = not wired */
    int8_t busy;
    int8_t sck;
    int8_t mosi;
    int8_t pwr; /* -1 = not wired */
} fos_pins_t;

typedef struct {
    int8_t pin;
    char label[FOS_GPIO_BUTTON_LABEL_LEN];
} fos_gpio_button_t;

typedef struct {
    bool enabled;
    /* Format a card at boot when — and only when — the probe in fos_sd_probe.c
     * can prove it holds nothing (no filesystem at all, or an exFAT volume with
     * an empty root directory). Anything it cannot prove empty is left
     * untouched. On by default so a brand-new card just works; turn it off with
     * `set assets_sd_autoformat 0` to require the explicit `sd format`. */
    bool autoformat;
    int8_t cs;
    int8_t sck;
    int8_t miso;
    int8_t mosi;
    uint32_t max_freq_khz;
} fos_assets_sd_config_t;

typedef struct {
    char wifi_ssid[FOS_STR_LEN];
    char wifi_pass[FOS_STR_LEN];
    char backend_url[FOS_URL_LEN]; /* e.g. http://192.168.1.10:8989 */
    char api_key[FOS_STR_LEN];     /* frame server_api_key */
    /* Cloud-managed frames (docs/cloud-frames.md): provider base URL and the
     * single-use enrollment claim token. The claim token lives in NVS only
     * until enrollment succeeds or permanently fails, then it is erased.
     * Long-lived cloud credentials (Ed25519 seed, access token) are NVS-only
     * and managed by fos_cloud.c — they never enter this struct. */
    char cloud_url[FOS_URL_LEN];   /* e.g. https://cloud.frameos.net */
    char claim_token[FOS_STR_LEN]; /* FRCT_…, single use, short lived */
    uint32_t frame_id;
    char hostname[FOS_STR_LEN];    /* DHCP hostname, e.g. "kitchen" */
    char hardware_preset[FOS_STR_LEN]; /* e.g. waveshare_esp32_s3_photopainter */
    char panel[FOS_STR_LEN];       /* e.g. EPD_7in5_V2, or "none" */
    char time_zone[FOS_STR_LEN];   /* IANA name, e.g. Europe/Brussels; "" = UTC (fos_tz.h) */
    fos_render_mode_t render_mode;
    uint32_t interval_sec;         /* refresh interval */
    uint16_t rotate;               /* 0/90/180/270 — scenes render rotated, packers map to panel */
    char scaling_mode[16];         /* contain/cover/stretch/center — the FALLBACK
                                    * fit for image consumers that do not place
                                    * the image themselves (since #321 a node's
                                    * own placement wins); "cover" by default */
    uint32_t max_http_response_bytes;
    uint32_t http_spill_force_bytes; /* debug: HTTP bodies over this many buffered
                                      * bytes spill to storage even with PSRAM
                                      * free (0 = off, spill on pressure only) */
    bool image_fusion;             /* debug: 0 materializes every image edge so
                                    * the panel can be compared against the
                                    * fused render (docs/value-pipeline.md) */
    bool debug_logging;            /* debug: per-node memory profile from the
                                    * interpreter (value bytes, heap delta,
                                    * fusion tier) — see docs/value-pipeline.md */
    bool server_send_logs;         /* upload runtime/render logs to backend */
    /* Escape hatch for the cloud-managed private-network deny
     * (components/frameos_nim/include/fos_netguard.h), matching
     * `network.allowLocalNetworkAccess` in the native build's frame.json: 1
     * lets scenes on an enrolled frame keep talking to the LAN.
     *
     * Local-only on purpose. It is reachable from the USB console and nowhere
     * else — not in the cloud `set_settings` allowlist, not in the backend
     * settings poll, not in the local HTTP API — because a provider that could
     * flip its own leash would not have one. */
    bool allow_local_network;
    bool tls_enable;               /* serve the frame HTTP API over HTTPS too */
    uint16_t tls_port;             /* HTTPS port, default mirrors Pi Caddy proxy */
    char tls_server_cert[FOS_TLS_PEM_LEN];
    char tls_server_key[FOS_TLS_PEM_LEN];
    bool admin_auth_enabled;       /* protect setup/control routes outside hotspot mode */
    char admin_user[FOS_STR_LEN];
    char admin_pass[FOS_STR_LEN];
    /* WPA2 passphrase of the provisioning AP (FrameOS-XXXX). Minted from
     * hardware entropy the first time the portal starts and kept in NVS, so
     * a fresh device is not provisioned by whoever is nearest; shown on the
     * status screen and over the console (`config`), settable with
     * `set ap_psk`. */
    char ap_psk[FOS_AP_PSK_LEN];
    char assets_path[FOS_ASSETS_PATH_LEN]; /* VFS mount point for local assets, default /srv/assets */
    fos_assets_sd_config_t assets_sd;
    bool deep_sleep;               /* deep sleep between refreshes */
    bool deep_sleep_on_battery;    /* deep sleep between refreshes, but only while running on battery */
    bool wake_schedule;            /* align deep-sleep wake to wall-clock interval boundaries */
    uint32_t wake_check_sec;       /* while deep sleeping, wake at least this often to check the
                                    * control plane for commands (0 = only wake to render) */
    int8_t battery_pin;            /* ADC1 GPIO for battery voltage, -1 = none */
    float battery_divider;         /* Vbat = Vpin * divider (default 2.0) */
    int8_t battery_enable_pin;     /* GPIO driven high to enable the battery
                                    * divider (Seeed reTerminal E10xx: GPIO21),
                                    * -1 = always-on divider */
    size_t gpio_button_count;
    fos_gpio_button_t gpio_buttons[FOS_GPIO_BUTTONS_MAX];
    fos_pins_t pins;
} fos_config_t;

esp_err_t fos_config_init(void);
/* The live config; mutate + fos_config_save() to persist. */
fos_config_t *fos_config(void);
esp_err_t fos_config_save(void);
/* NVS occupancy (32-byte entries) for the `status` line: a partition near
 * full is why a setting "took" on the console and was gone after a reboot. */
esp_err_t fos_config_nvs_stats(size_t *used_entries, size_t *free_entries, size_t *total_entries);
esp_err_t fos_config_erase(void);
bool fos_config_wifi_ready(void);
/* Normalize a rotation onto the four the renderer supports. Any equivalent
 * angle is accepted (mod 360, negatives included); anything that is not a
 * right angle is refused. Every writer of `rotate` — the USB console, the
 * backend settings poll and the cloud set_settings verb — goes through this
 * so they cannot drift apart. */
bool fos_config_normalize_rotate(double value, uint16_t *out);
/* Normalize a scaling mode onto the four the renderer supports
 * (contain/cover/stretch/center, case-insensitive). Same contract as
 * normalize_rotate: every writer — USB console, backend settings poll,
 * cloud set_settings — goes through this so they cannot drift apart. */
bool fos_config_normalize_scaling_mode(const char *value, char *out, size_t out_len);
/* "rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1" (any subset) */
esp_err_t fos_config_parse_pins(const char *spec, fos_pins_t *pins);
void fos_config_format_pins(const fos_pins_t *pins, char *out, size_t out_len);
/* "cs=38,sck=39,miso=40,mosi=41" (any subset) */
esp_err_t fos_config_parse_assets_sd_pins(const char *spec, fos_assets_sd_config_t *assets_sd);
void fos_config_format_assets_sd_pins(const fos_assets_sd_config_t *assets_sd, char *out, size_t out_len);
/* Pins the firmware refuses to hand to a button, the battery ADC read or the
 * divider's enable switch: outside the chip's GPIO range, an SPI flash /
 * PSRAM pad (an input pull-up or an output level on one of those wedges the
 * next boot, which a cloud `set_settings` push could otherwise cause), or a
 * pin a driver already claimed through esp_gpio_reserve. Returns NULL when
 * the pin is usable, else a short reason for the log line. -1 ("none") is
 * the caller's business, not this function's. */
const char *fos_config_gpio_pin_reserved(int pin);
/* "5:A\n6:B" — refuses a reserved pin (see above) as ESP_ERR_INVALID_ARG,
 * leaving `config` untouched. */
esp_err_t fos_config_parse_gpio_buttons(const char *spec, fos_config_t *config);
void fos_config_format_gpio_buttons(const fos_config_t *config, char *out, size_t out_len);
