/*
 * FrameOS embedded config store.
 *
 * One NVS namespace ("frameos") holding everything a frame needs to run.
 * Compile-time defaults come from generated_config.h when the backend bakes
 * a per-frame image, else from the neutral fallbacks below. NVS always wins,
 * so a device reconfigured in the field keeps its settings across OTA.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define FOS_STR_LEN 128
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
    uint32_t frame_id;
    char hostname[FOS_STR_LEN];    /* DHCP hostname, e.g. "kitchen" */
    char hardware_preset[FOS_STR_LEN]; /* e.g. waveshare_esp32_s3_photopainter */
    char panel[FOS_STR_LEN];       /* e.g. EPD_7in5_V2, or "none" */
    fos_render_mode_t render_mode;
    uint32_t interval_sec;         /* refresh interval */
    uint32_t max_http_response_bytes;
    bool server_send_logs;         /* upload runtime/render logs to backend */
    bool tls_enable;               /* serve the frame HTTP API over HTTPS too */
    uint16_t tls_port;             /* HTTPS port, default mirrors Pi Caddy proxy */
    char tls_server_cert[FOS_TLS_PEM_LEN];
    char tls_server_key[FOS_TLS_PEM_LEN];
    bool admin_auth_enabled;       /* protect setup/control routes outside hotspot mode */
    char admin_user[FOS_STR_LEN];
    char admin_pass[FOS_STR_LEN];
    char assets_path[FOS_ASSETS_PATH_LEN]; /* VFS mount point for local assets, default /srv/assets */
    fos_assets_sd_config_t assets_sd;
    bool deep_sleep;               /* deep sleep between refreshes */
    bool wake_schedule;            /* align deep-sleep wake to wall-clock interval boundaries */
    int8_t battery_pin;            /* ADC1 GPIO for battery voltage, -1 = none */
    float battery_divider;         /* Vbat = Vpin * divider (default 2.0) */
    size_t gpio_button_count;
    fos_gpio_button_t gpio_buttons[FOS_GPIO_BUTTONS_MAX];
    fos_pins_t pins;
} fos_config_t;

esp_err_t fos_config_init(void);
/* The live config; mutate + fos_config_save() to persist. */
fos_config_t *fos_config(void);
esp_err_t fos_config_save(void);
esp_err_t fos_config_erase(void);
bool fos_config_wifi_ready(void);
/* "rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1" (any subset) */
esp_err_t fos_config_parse_pins(const char *spec, fos_pins_t *pins);
void fos_config_format_pins(const fos_pins_t *pins, char *out, size_t out_len);
/* "cs=38,sck=39,miso=40,mosi=41" (any subset) */
esp_err_t fos_config_parse_assets_sd_pins(const char *spec, fos_assets_sd_config_t *assets_sd);
void fos_config_format_assets_sd_pins(const fos_assets_sd_config_t *assets_sd, char *out, size_t out_len);
/* "5:A\n6:B" */
esp_err_t fos_config_parse_gpio_buttons(const char *spec, fos_config_t *config);
void fos_config_format_gpio_buttons(const fos_config_t *config, char *out, size_t out_len);
