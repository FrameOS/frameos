#include "pk_config_keys.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Inky Frame wiring from Pimoroni's own sources (pimoroni-pico
// libraries/inky_frame/inky_frame.hpp, identical across all sizes): SPI0 on
// SCK18/MOSI19, CS17, DC28, RST27; BUSY + buttons through the shift register
// on CLOCK8/LATCH9/DATA10 (busy = bit 7, active low); HOLD_VSYS_EN on GP2
// keeps the regulator alive on battery.
#define INKY_FRAME_PINS \
    { .sck = 18, .mosi = 19, .cs = 17, .dc = 28, .rst = 27, \
      .busy = -1, .sr_clock = 8, .sr_latch = 9, .sr_data = 10, .busy_bit = 7, \
      .hold_vsys = 2 }

// Hardware presets: keep in sync with EMBEDDED_HARDWARE_PRESETS in
// backend/app/tasks/embedded_firmware.py (pico entries).
static const pk_preset_t s_presets[] = {
    {"pimoroni_inky_frame_4", "EPD_4in01f", INKY_FRAME_PINS},
    {"pimoroni_inky_frame_5_7", "EPD_5in65f", INKY_FRAME_PINS},
    {"pimoroni_inky_frame_7_3", "EPD_7in3f", INKY_FRAME_PINS},
    // Dec 2024 refresh: Pico 2 W with the same ACeP panel.
    {"pimoroni_inky_frame_7_3_pico2", "EPD_7in3f", INKY_FRAME_PINS},
    // Aug 2025 refresh: Pico 2 W with the Spectra 6 panel (black top border).
    {"pimoroni_inky_frame_7_3_spectra", "EPD_7in3e", INKY_FRAME_PINS},
};

// Keys the ESP32 console stores that mean nothing without an on-device
// renderer, SD assets, an ADC battery divider or a TLS listener. The shared
// provisioning plan sends several of them to every embedded board.
static const char *const s_ignored_keys[] = {
    "rotate", "scaling_mode", "scaling", "max_http_response_bytes", "max_http",
    "gpio_buttons", "assets_sd", "assets_sd_pins", "assets_sd_freq", "assets_sd_autoformat",
    "assets_path", "wake_schedule", "wake_check", "battery_pin", "battery_divider",
    "battery_enable_pin", "time_zone", "fusion", "allow_lan", "spill_force",
    "tls_enable", "tls_port",
};

const pk_preset_t *pk_config_presets(size_t *count)
{
    if (count) *count = sizeof(s_presets) / sizeof(s_presets[0]);
    return s_presets;
}

const pk_preset_t *pk_config_find_preset(const char *name)
{
    if (name == NULL) return NULL;
    for (size_t i = 0; i < sizeof(s_presets) / sizeof(s_presets[0]); i++) {
        if (strcmp(name, s_presets[i].name) == 0) return &s_presets[i];
    }
    return NULL;
}

void pk_config_defaults(pk_config_t *config)
{
    memset(config, 0, sizeof(*config));
    config->interval_seconds = PK_INTERVAL_DEFAULT_SECONDS;
    config->send_logs = 1;
    pk_pins_t unset = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
    config->pins = unset;
    snprintf(config->hostname, sizeof(config->hostname), "frameos");
}

bool pk_config_url_is_supported(const char *url)
{
    if (url == NULL) return false;
    const char *host = NULL;
    if (strncmp(url, "http://", 7) == 0) host = url + 7;
    else if (strncmp(url, "https://", 8) == 0) host = url + 8;
    return host != NULL && host[0] != '\0' && host[0] != '/' && host[0] != ':';
}

bool pk_config_hostname_is_valid(const char *hostname)
{
    size_t len = hostname ? strlen(hostname) : 0;
    if (len == 0 || len > 63) return false;
    if (hostname[0] == '-' || hostname[len - 1] == '-') return false;
    for (size_t i = 0; i < len; i++) {
        char c = hostname[i];
        bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
        if (!ok) return false;
    }
    return true;
}

static int8_t *pin_slot(pk_pins_t *pins, const char *key)
{
    if (strcmp(key, "sck") == 0) return &pins->sck;
    if (strcmp(key, "mosi") == 0) return &pins->mosi;
    if (strcmp(key, "cs") == 0) return &pins->cs;
    if (strcmp(key, "dc") == 0) return &pins->dc;
    if (strcmp(key, "rst") == 0) return &pins->rst;
    if (strcmp(key, "busy") == 0) return &pins->busy;
    if (strcmp(key, "sr_clock") == 0) return &pins->sr_clock;
    if (strcmp(key, "sr_latch") == 0) return &pins->sr_latch;
    if (strcmp(key, "sr_data") == 0) return &pins->sr_data;
    if (strcmp(key, "busy_bit") == 0) return &pins->busy_bit;
    if (strcmp(key, "hold_vsys") == 0) return &pins->hold_vsys;
    return NULL;
}

bool pk_config_parse_pins(const char *spec, pk_pins_t *pins)
{
    if (spec == NULL || pins == NULL) return false;
    pk_pins_t next = *pins;
    char buffer[192];
    if (strlen(spec) >= sizeof(buffer)) return false;
    snprintf(buffer, sizeof(buffer), "%s", spec);
    char *save = NULL;
    for (char *token = strtok_r(buffer, ", ", &save); token; token = strtok_r(NULL, ", ", &save)) {
        char *eq = strchr(token, '=');
        if (!eq) return false;
        *eq = '\0';
        char *end = NULL;
        long pin = strtol(eq + 1, &end, 10);
        if (end == eq + 1 || *end != '\0') return false;
        if (pin < -1 || pin > 47) return false; // RP2350B tops out at GPIO47
        // The shared plan names the ESP32's second chip select and panel
        // power pin; no Pico panel has either.
        if (strcmp(token, "cs2") == 0 || strcmp(token, "pwr") == 0) continue;
        int8_t *slot = pin_slot(&next, token);
        if (slot == NULL) return false;
        if (slot == &next.busy_bit && pin > 7) return false;
        *slot = (int8_t)pin;
    }
    *pins = next;
    return true;
}

void pk_config_format_pins(const pk_pins_t *pins, char *dst, size_t cap)
{
    snprintf(dst, cap,
             "sck=%d,mosi=%d,cs=%d,dc=%d,rst=%d,busy=%d,sr_clock=%d,sr_latch=%d,sr_data=%d,"
             "busy_bit=%d,hold_vsys=%d",
             pins->sck, pins->mosi, pins->cs, pins->dc, pins->rst, pins->busy, pins->sr_clock,
             pins->sr_latch, pins->sr_data, pins->busy_bit, pins->hold_vsys);
}

static bool parse_flag(const char *value, uint8_t *out)
{
    if (strcmp(value, "1") == 0 || strcmp(value, "true") == 0 || strcmp(value, "on") == 0) {
        *out = 1;
        return true;
    }
    if (strcmp(value, "0") == 0 || strcmp(value, "false") == 0 || strcmp(value, "off") == 0) {
        *out = 0;
        return true;
    }
    return false;
}

static bool parse_unsigned(const char *value, unsigned long *out)
{
    if (value[0] < '0' || value[0] > '9') return false;
    char *end = NULL;
    unsigned long parsed = strtoul(value, &end, 10);
    if (*end != '\0') return false;
    *out = parsed;
    return true;
}

static pk_set_result_t reply(pk_set_result_t result, char *message, size_t cap, const char *text)
{
    if (message && cap) snprintf(message, cap, "%s", text);
    return result;
}

#define STORE_STRING(field, value)                                                   \
    do {                                                                             \
        if (strlen(value) >= sizeof(field)) {                                        \
            return reply(PK_SET_INVALID, message, message_cap, "value is too long"); \
        }                                                                            \
        snprintf(field, sizeof(field), "%s", value);                                 \
    } while (0)

pk_set_result_t pk_config_set(pk_config_t *config, const char *key, const char *value,
                              pk_panel_known_fn panel_known, char *message, size_t message_cap)
{
    if (config == NULL || key == NULL) {
        return reply(PK_SET_UNKNOWN_KEY, message, message_cap, "no key");
    }
    if (value == NULL) value = "";

    if (strcmp(key, "backend") == 0 || strcmp(key, "backend_url") == 0) {
        if (value[0] && !pk_config_url_is_supported(value)) {
            return reply(PK_SET_INVALID, message, message_cap,
                         "backend must be an http:// or https:// URL");
        }
        size_t len = strlen(value);
        if (len >= sizeof(config->backend_url)) {
            return reply(PK_SET_INVALID, message, message_cap, "value is too long");
        }
        snprintf(config->backend_url, sizeof(config->backend_url), "%s", value);
        // "http://host/" + "/api/…" must not become "//api".
        while (len > 0 && config->backend_url[len - 1] == '/') config->backend_url[--len] = '\0';
    } else if (strcmp(key, "api_key") == 0) {
        STORE_STRING(config->api_key, value);
    } else if (strcmp(key, "wifi_ssid") == 0) {
        STORE_STRING(config->wifi_ssid, value);
    } else if (strcmp(key, "wifi_pass") == 0) {
        STORE_STRING(config->wifi_pass, value);
    } else if (strcmp(key, "name") == 0) {
        STORE_STRING(config->name, value);
    } else if (strcmp(key, "frame_id") == 0) {
        unsigned long id = 0;
        if (!parse_unsigned(value, &id)) {
            return reply(PK_SET_INVALID, message, message_cap, "frame_id must be a number");
        }
        config->frame_id = (uint32_t)id;
    } else if (strcmp(key, "interval") == 0) {
        unsigned long seconds = 0;
        if (!parse_unsigned(value, &seconds)) {
            return reply(PK_SET_INVALID, message, message_cap, "interval must be seconds");
        }
        config->interval_seconds =
            seconds < PK_INTERVAL_MIN_SECONDS ? PK_INTERVAL_MIN_SECONDS : (uint32_t)seconds;
    } else if (strcmp(key, "deep_sleep") == 0) {
        if (!parse_flag(value, &config->deep_sleep)) {
            return reply(PK_SET_INVALID, message, message_cap, "want 0 or 1");
        }
    } else if (strcmp(key, "deep_sleep_on_battery") == 0 || strcmp(key, "sleep_batt") == 0) {
        if (!parse_flag(value, &config->deep_sleep_on_battery)) {
            return reply(PK_SET_INVALID, message, message_cap, "want 0 or 1");
        }
    } else if (strcmp(key, "server_send_logs") == 0 || strcmp(key, "send_logs") == 0) {
        if (!parse_flag(value, &config->send_logs)) {
            return reply(PK_SET_INVALID, message, message_cap, "want 0 or 1");
        }
    } else if (strcmp(key, "debug") == 0) {
        if (!parse_flag(value, &config->debug)) {
            return reply(PK_SET_INVALID, message, message_cap, "want 0 or 1");
        }
    } else if (strcmp(key, "hostname") == 0) {
        char lowered[PK_NAME_LEN];
        if (strlen(value) >= sizeof(lowered)) {
            return reply(PK_SET_INVALID, message, message_cap, "value is too long");
        }
        size_t i = 0;
        for (; value[i]; i++) {
            lowered[i] = (value[i] >= 'A' && value[i] <= 'Z') ? (char)(value[i] + 32) : value[i];
        }
        lowered[i] = '\0';
        if (!pk_config_hostname_is_valid(lowered)) {
            return reply(PK_SET_INVALID, message, message_cap,
                         "hostname must be letters, digits and dashes (no dots)");
        }
        snprintf(config->hostname, sizeof(config->hostname), "%s", lowered);
    } else if (strcmp(key, "admin_user") == 0) {
        if (strchr(value, ':')) {
            return reply(PK_SET_INVALID, message, message_cap,
                         "admin_user cannot contain ':' (HTTP Basic)");
        }
        STORE_STRING(config->admin_user, value);
    } else if (strcmp(key, "admin_pass") == 0) {
        STORE_STRING(config->admin_pass, value);
    } else if (strcmp(key, "admin_auth") == 0) {
        uint8_t enabled = 0;
        if (!parse_flag(value, &enabled)) {
            return reply(PK_SET_INVALID, message, message_cap, "want 0 or 1");
        }
        if (enabled && (!config->admin_user[0] || !config->admin_pass[0])) {
            return reply(PK_SET_INVALID, message, message_cap,
                         "set admin_user and admin_pass first");
        }
        config->admin_auth = enabled;
    } else if (strcmp(key, "ap_psk") == 0) {
        size_t len = strlen(value);
        // Empty re-mints on the next portal start; WPA2 wants 8..63.
        if (len != 0 && (len < 8 || len > 63)) {
            return reply(PK_SET_INVALID, message, message_cap, "ap_psk must be 8-63 characters");
        }
        STORE_STRING(config->ap_psk, value);
    } else if (strcmp(key, "panel") == 0) {
        if (strcmp(value, "none") != 0 && panel_known != NULL && !panel_known(value)) {
            return reply(PK_SET_INVALID, message, message_cap,
                         "this firmware has no driver for that panel");
        }
        STORE_STRING(config->panel, value);
    } else if (strcmp(key, "pins") == 0) {
        if (!pk_config_parse_pins(value, &config->pins)) {
            return reply(PK_SET_INVALID, message, message_cap,
                         "bad pin spec, want e.g. sck=18,mosi=19,cs=17,dc=28,rst=27,"
                         "sr_clock=8,sr_latch=9,sr_data=10,busy_bit=7");
        }
    } else if (strcmp(key, "hardware") == 0 || strcmp(key, "hardware_preset") == 0) {
        // An unknown name is stored as is: a label from a newer control plane
        // must not fail provisioning, the explicit panel/pins that follow it
        // still describe the board.
        STORE_STRING(config->hardware_preset, value);
        const pk_preset_t *preset = pk_config_find_preset(value);
        if (preset == NULL) {
            return reply(PK_SET_OK, message, message_cap,
                         "stored; not a preset this firmware knows, set panel and pins");
        }
        snprintf(config->panel, sizeof(config->panel), "%s", preset->panel);
        config->pins = preset->pins;
        if (message && message_cap) {
            snprintf(message, message_cap, "applied %s: panel=%s", preset->name, preset->panel);
        }
        return PK_SET_OK;
    } else if (strcmp(key, "render_mode") == 0) {
        if (strcmp(value, "remote") != 0) {
            return reply(PK_SET_INVALID, message, message_cap,
                         "this board has no on-device renderer; render_mode is always remote");
        }
        return reply(PK_SET_IGNORED, message, message_cap, "always remote on this board");
    } else if (strcmp(key, "cloud_url") == 0 || strcmp(key, "claim_token") == 0) {
        return reply(PK_SET_INVALID, message, message_cap,
                     "this firmware has no FrameOS Cloud link yet; use a self-hosted backend");
    } else {
        for (size_t i = 0; i < sizeof(s_ignored_keys) / sizeof(s_ignored_keys[0]); i++) {
            if (strcmp(key, s_ignored_keys[i]) == 0) {
                return reply(PK_SET_IGNORED, message, message_cap, "not used by this firmware");
            }
        }
        return reply(PK_SET_UNKNOWN_KEY, message, message_cap, "unknown key");
    }
    return reply(PK_SET_OK, message, message_cap, "ok");
}
