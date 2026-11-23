#include "fos_config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_private/esp_gpio_reserve.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"
#include "soc/soc_caps.h"

#include "fos_board.h"
#include "fos_defaults.h"
#include "fos_mem.h"

/* The pure parsers/normalisers (`set pins`, `set rotate`, GPIO buttons …)
 * live in fos_config_parse.c so they can be host-tested; this file keeps
 * NVS, the defaults and the chip-specific pin table. */

static const char *TAG = "fos_config";
static const char *NVS_NS = "frameos";

/* 12 KB (the HTTPS certificate and key, the event map, the palette, …),
 * read now and then and never by an interrupt or a DMA: in PSRAM where the
 * board has some, so internal RAM keeps those 12 KB for what can live
 * nowhere else (DMA buffers, task stacks, Wi-Fi). As a static it sat in
 * internal .bss, the firmware's largest object there (2026-11-22). A board
 * without PSRAM gets it from internal RAM, as before. Allocated before
 * app_main by a constructor: IDF adds PSRAM to the heap in its core init,
 * which runs before the constructors, so nothing reads it unallocated. */
static fos_config_t *s_config_storage;

__attribute__((constructor)) static void allocate_config(void)
{
    s_config_storage = fos_cold_calloc(1, sizeof(fos_config_t));
    if (!s_config_storage) abort();
}

fos_config_t *fos_config(void) { return s_config_storage; }

static void load_defaults(void)
{
    fos_config_t *const cfg = s_config_storage;
    memset(cfg, 0, sizeof(*cfg));
    strlcpy(cfg->wifi_ssid, FRAMEOS_DEFAULT_WIFI_SSID, sizeof(cfg->wifi_ssid));
    strlcpy(cfg->wifi_pass, FRAMEOS_DEFAULT_WIFI_PASS, sizeof(cfg->wifi_pass));
    strlcpy(cfg->backend_url, FRAMEOS_DEFAULT_BACKEND_URL, sizeof(cfg->backend_url));
    strlcpy(cfg->api_key, FRAMEOS_DEFAULT_API_KEY, sizeof(cfg->api_key));
    cfg->frame_id = FRAMEOS_DEFAULT_FRAME_ID;
    strlcpy(cfg->hostname, FRAMEOS_DEFAULT_HOSTNAME, sizeof(cfg->hostname));
    strlcpy(cfg->hardware_preset, FRAMEOS_DEFAULT_HARDWARE_PRESET, sizeof(cfg->hardware_preset));
    strlcpy(cfg->panel, FRAMEOS_DEFAULT_PANEL, sizeof(cfg->panel));
    cfg->render_mode = (fos_render_mode_t)FRAMEOS_DEFAULT_RENDER_MODE;
    cfg->rotate = FRAMEOS_DEFAULT_ROTATE;
    strlcpy(cfg->scaling_mode, FRAMEOS_DEFAULT_SCALING_MODE, sizeof(cfg->scaling_mode));
    cfg->render_scale_milli = FRAMEOS_DEFAULT_RENDER_SCALE_MILLI;
    cfg->colors[0] = '\0';
    cfg->palette[0] = '\0';
    cfg->event_map[0] = '\0';
    strlcpy(cfg->time_zone, FRAMEOS_DEFAULT_TIME_ZONE, sizeof(cfg->time_zone));
    cfg->max_http_response_bytes = FRAMEOS_DEFAULT_MAX_HTTP_RESPONSE_BYTES;
    cfg->server_send_logs = FRAMEOS_DEFAULT_SERVER_SEND_LOGS;
    /* Fusion is the normal path; the flag exists so a render can be repeated
     * with every image edge materialized and the two panels compared. */
    cfg->image_fusion = true;
    cfg->allow_local_network = FRAMEOS_DEFAULT_ALLOW_LOCAL_NETWORK;
    cfg->frame_settings_on_screen = true;
    cfg->settings_unlock = false;
    cfg->tls_enable = FRAMEOS_DEFAULT_TLS_ENABLE;
    cfg->tls_port = FRAMEOS_DEFAULT_TLS_PORT;
    strlcpy(cfg->tls_server_cert, FRAMEOS_DEFAULT_TLS_SERVER_CERT, sizeof(cfg->tls_server_cert));
    strlcpy(cfg->tls_server_key, FRAMEOS_DEFAULT_TLS_SERVER_KEY, sizeof(cfg->tls_server_key));
    cfg->admin_auth_enabled = FRAMEOS_DEFAULT_ADMIN_AUTH_ENABLE;
    strlcpy(cfg->admin_user, FRAMEOS_DEFAULT_ADMIN_AUTH_USER, sizeof(cfg->admin_user));
    strlcpy(cfg->admin_pass, FRAMEOS_DEFAULT_ADMIN_AUTH_PASS, sizeof(cfg->admin_pass));
    strlcpy(cfg->assets_path, FRAMEOS_DEFAULT_ASSETS_PATH, sizeof(cfg->assets_path));
    cfg->assets_sd.enabled = FRAMEOS_DEFAULT_ASSETS_SD_ENABLE;
    cfg->assets_sd.autoformat = FRAMEOS_DEFAULT_ASSETS_SD_AUTOFORMAT;
    cfg->assets_sd.cs = FRAMEOS_DEFAULT_ASSETS_SD_PIN_CS;
    cfg->assets_sd.sck = FRAMEOS_DEFAULT_ASSETS_SD_PIN_SCK;
    cfg->assets_sd.miso = FRAMEOS_DEFAULT_ASSETS_SD_PIN_MISO;
    cfg->assets_sd.mosi = FRAMEOS_DEFAULT_ASSETS_SD_PIN_MOSI;
    cfg->assets_sd.pwr = -1;
    cfg->assets_sd.det = -1;
    cfg->assets_sd.max_freq_khz = FRAMEOS_DEFAULT_ASSETS_SD_MAX_FREQ_KHZ;
    cfg->deep_sleep = FRAMEOS_DEFAULT_DEEP_SLEEP;
    cfg->deep_sleep_on_battery = FRAMEOS_DEFAULT_DEEP_SLEEP_ON_BATTERY;
    cfg->wake_schedule = FRAMEOS_DEFAULT_WAKE_SCHEDULE;
    cfg->wake_check_sec = FRAMEOS_DEFAULT_WAKE_CHECK_SEC;
    cfg->awake_after_input_sec = FRAMEOS_DEFAULT_AWAKE_AFTER_INPUT_SEC;
    cfg->battery_pin = FRAMEOS_DEFAULT_BATTERY_PIN;
    cfg->battery_divider = FRAMEOS_DEFAULT_BATTERY_DIVIDER;
    cfg->battery_enable_pin = FRAMEOS_DEFAULT_BATTERY_ENABLE_PIN;
    cfg->buzzer_pin = FRAMEOS_DEFAULT_BUZZER_PIN;
    cfg->buzzer_tone_hz = FRAMEOS_DEFAULT_BUZZER_TONE_HZ;
    cfg->mic_pins.clk = -1;
    cfg->mic_pins.data = -1;
    cfg->mic_pins.pwr = -1;
    memset(&cfg->touch_pins, -1, sizeof(cfg->touch_pins));
    memset(&cfg->codec_pins, -1, sizeof(cfg->codec_pins));
    cfg->voice_chat = true;
    cfg->touch_beep = true;
    cfg->click_sounds = FOS_CLICK_SOUNDS_NORMAL;
    cfg->cpu_mode = FOS_CPU_AUTO;
    cfg->led_pin = -1;
    cfg->led_type = FOS_LED_GPIO;
    cfg->i2c_bus_count = 0;
    fos_config_parse_gpio_buttons(FRAMEOS_DEFAULT_GPIO_BUTTONS, cfg);
    cfg->pins.rst = FRAMEOS_DEFAULT_PIN_RST;
    cfg->pins.dc = FRAMEOS_DEFAULT_PIN_DC;
    cfg->pins.cs = FRAMEOS_DEFAULT_PIN_CS;
    cfg->pins.cs2 = FRAMEOS_DEFAULT_PIN_CS2;
    cfg->pins.busy = FRAMEOS_DEFAULT_PIN_BUSY;
    cfg->pins.sck = FRAMEOS_DEFAULT_PIN_SCK;
    cfg->pins.mosi = FRAMEOS_DEFAULT_PIN_MOSI;
    cfg->pins.pwr = FRAMEOS_DEFAULT_PIN_PWR;
}

static void nvs_get_string(nvs_handle_t nvs, const char *key, char *out, size_t out_len)
{
    size_t len = out_len;
    if (nvs_get_str(nvs, key, out, &len) != ESP_OK) {
        /* keep the default */
    }
}

/* PEM material lives in a blob: NVS strings top out at ~4000 bytes, and a
 * certificate chain can be longer than that. Absent or oversized keeps the
 * default (empty); the buffer is always NUL-terminated. */
static void nvs_get_pem(nvs_handle_t nvs, const char *key, char *out, size_t out_len)
{
    size_t len = out_len - 1;
    if (nvs_get_blob(nvs, key, out, &len) == ESP_OK) {
        out[len] = '\0';
    } else {
        out[0] = '\0';
    }
}

static esp_err_t nvs_set_pem(nvs_handle_t nvs, const char *key, const char *pem)
{
    if (pem[0]) {
        return nvs_set_blob(nvs, key, pem, strlen(pem));
    }
    esp_err_t err = nvs_erase_key(nvs, key);
    return err == ESP_ERR_NVS_NOT_FOUND ? ESP_OK : err;
}

esp_err_t fos_config_init(void)
{
    fos_config_t *const cfg = s_config_storage;
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS partition needs erase (%s)", esp_err_to_name(err));
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        return err;
    }

    load_defaults();

    nvs_handle_t nvs;
    err = nvs_open(NVS_NS, NVS_READONLY, &nvs);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGI(TAG, "no stored config, using generic defaults");
        return ESP_OK;
    }
    if (err != ESP_OK) {
        return err;
    }

    nvs_get_string(nvs, "wifi_ssid", cfg->wifi_ssid, sizeof(cfg->wifi_ssid));
    nvs_get_string(nvs, "wifi_pass", cfg->wifi_pass, sizeof(cfg->wifi_pass));
    nvs_get_string(nvs, "backend_url", cfg->backend_url, sizeof(cfg->backend_url));
    nvs_get_string(nvs, "api_key", cfg->api_key, sizeof(cfg->api_key));
    nvs_get_string(nvs, "cloud_url", cfg->cloud_url, sizeof(cfg->cloud_url));
    nvs_get_string(nvs, "claim_token", cfg->claim_token, sizeof(cfg->claim_token));
    nvs_get_string(nvs, "hostname", cfg->hostname, sizeof(cfg->hostname));
    nvs_get_string(nvs, "hardware", cfg->hardware_preset, sizeof(cfg->hardware_preset));
    nvs_get_string(nvs, "panel", cfg->panel, sizeof(cfg->panel));
    nvs_get_string(nvs, "assets_path", cfg->assets_path, sizeof(cfg->assets_path));
    nvs_get_string(nvs, "admin_user", cfg->admin_user, sizeof(cfg->admin_user));
    nvs_get_string(nvs, "admin_pass", cfg->admin_pass, sizeof(cfg->admin_pass));
    nvs_get_string(nvs, "ap_psk", cfg->ap_psk, sizeof(cfg->ap_psk));
    char gpio_buttons[FOS_GPIO_BUTTONS_SPEC_LEN] = "";
    size_t gpio_buttons_len = sizeof(gpio_buttons);
    esp_err_t buttons_err = nvs_get_str(nvs, "gpio_buttons", gpio_buttons, &gpio_buttons_len);
    if (buttons_err == ESP_OK) {
        buttons_err = fos_config_parse_gpio_buttons(gpio_buttons, cfg);
        if (buttons_err != ESP_OK) {
            ESP_LOGW(TAG, "stored GPIO button config invalid: %s", esp_err_to_name(buttons_err));
        }
    }
    uint32_t u32;
    if (nvs_get_u32(nvs, "frame_id", &u32) == ESP_OK) cfg->frame_id = u32;
    if (nvs_get_u32(nvs, "spill_force", &u32) == ESP_OK) cfg->http_spill_force_bytes = u32;
    uint16_t rotate_u16 = 0;
    if (nvs_get_u16(nvs, "rotate", &rotate_u16) == ESP_OK &&
        (rotate_u16 == 0 || rotate_u16 == 90 || rotate_u16 == 180 || rotate_u16 == 270)) {
        cfg->rotate = rotate_u16;
    }
    char scaling_raw[16];
    size_t scaling_len = sizeof(scaling_raw);
    if (nvs_get_str(nvs, "scaling", scaling_raw, &scaling_len) == ESP_OK) {
        /* Validated on read like rotate: a corrupt or legacy value falls back
         * to the baked default instead of poisoning every render. */
        char normalized[16];
        if (fos_config_normalize_scaling_mode(scaling_raw, normalized, sizeof(normalized))) {
            strlcpy(cfg->scaling_mode, normalized, sizeof(cfg->scaling_mode));
        }
    }
    /* Thousandths; validated on read the same way (absent or out of range =
     * the default, automatic). */
    uint16_t render_scale_milli = 0;
    if (nvs_get_u16(nvs, "render_scale_m", &render_scale_milli) == ESP_OK &&
        render_scale_milli <= FOS_RENDER_SCALE_MILLI_MAX) {
        cfg->render_scale_milli = render_scale_milli;
    }
    size_t tz_len = sizeof(cfg->time_zone);
    if (nvs_get_str(nvs, "time_zone", cfg->time_zone, &tz_len) != ESP_OK) {
        cfg->time_zone[0] = '\0';
    }
    size_t colors_len = sizeof(cfg->colors);
    if (nvs_get_str(nvs, "colors", cfg->colors, &colors_len) != ESP_OK) {
        cfg->colors[0] = '\0';
    }
    size_t palette_len = sizeof(cfg->palette);
    if (nvs_get_str(nvs, "palette", cfg->palette, &palette_len) != ESP_OK) {
        cfg->palette[0] = '\0';
    }
    /* No stored value: the board's own map (a reTerminal's arrows held are
     * the previous and the next scene). A frame provisioned with its preset
     * before this key existed gets the bindings with the update; a control
     * plane's push, an empty list included, stores what it runs with. Read
     * after `hardware`, which the board default keys on. */
    size_t event_map_len = sizeof(cfg->event_map);
    if (nvs_get_str(nvs, "event_map", cfg->event_map, &event_map_len) != ESP_OK) {
        fos_board_event_map(cfg->hardware_preset, cfg->event_map, sizeof(cfg->event_map));
    }
    if (nvs_get_u32(nvs, "max_http", &u32) == ESP_OK) cfg->max_http_response_bytes = u32;
    uint8_t u8;
    if (nvs_get_u8(nvs, "render_mode", &u8) == ESP_OK) cfg->render_mode = (fos_render_mode_t)u8;
    if (nvs_get_u8(nvs, "send_logs", &u8) == ESP_OK) cfg->server_send_logs = u8 != 0;
    if (nvs_get_u8(nvs, "debug", &u8) == ESP_OK) cfg->debug_logging = u8 != 0;
    if (nvs_get_u8(nvs, "fusion", &u8) == ESP_OK) cfg->image_fusion = u8 != 0;
    if (nvs_get_u8(nvs, "allow_lan", &u8) == ESP_OK) cfg->allow_local_network = u8 != 0;
    if (nvs_get_u8(nvs, "fs_on_screen", &u8) == ESP_OK) cfg->frame_settings_on_screen = u8 != 0;
    if (nvs_get_u8(nvs, "settings_unlock", &u8) == ESP_OK) cfg->settings_unlock = u8 != 0;
    if (nvs_get_u8(nvs, "tls_enable", &u8) == ESP_OK) cfg->tls_enable = u8 != 0;
    if (nvs_get_u8(nvs, "admin_auth", &u8) == ESP_OK) cfg->admin_auth_enabled = u8 != 0;
    if (nvs_get_u32(nvs, "tls_port", &u32) == ESP_OK) cfg->tls_port = (uint16_t)u32;
    nvs_get_pem(nvs, "tls_cert", cfg->tls_server_cert, sizeof(cfg->tls_server_cert));
    nvs_get_pem(nvs, "tls_key", cfg->tls_server_key, sizeof(cfg->tls_server_key));
    int8_t i8;
    if (nvs_get_u8(nvs, "assets_sd", &u8) == ESP_OK) cfg->assets_sd.enabled = u8 != 0;
    if (nvs_get_u8(nvs, "sd_autofmt", &u8) == ESP_OK) cfg->assets_sd.autoformat = u8 != 0;
    if (nvs_get_i8(nvs, "sd_cs", &i8) == ESP_OK) cfg->assets_sd.cs = i8;
    if (nvs_get_i8(nvs, "sd_sck", &i8) == ESP_OK) cfg->assets_sd.sck = i8;
    if (nvs_get_i8(nvs, "sd_miso", &i8) == ESP_OK) cfg->assets_sd.miso = i8;
    if (nvs_get_i8(nvs, "sd_mosi", &i8) == ESP_OK) cfg->assets_sd.mosi = i8;
    if (nvs_get_u32(nvs, "sd_freq", &u32) == ESP_OK) cfg->assets_sd.max_freq_khz = u32;
    /* The slot's power and detect pins arrived with the reTerminal E-series
     * slots (2026.10.20). No `sd_pwr` key means this firmware's first boot on
     * a board provisioned before then: if nobody ever named an SD pin on it
     * (all four -1, the socket off), the board's own slot applies, the way a
     * fresh `set hardware` would have — so an E1002 flashed last month gets
     * its card with the update. A board whose pins were set stays as set. */
    if (nvs_get_i8(nvs, "sd_pwr", &i8) == ESP_OK) {
        cfg->assets_sd.pwr = i8;
        if (nvs_get_i8(nvs, "sd_det", &i8) == ESP_OK) cfg->assets_sd.det = i8;
    } else if (cfg->assets_sd.cs < 0 && cfg->assets_sd.sck < 0 &&
               cfg->assets_sd.miso < 0 && cfg->assets_sd.mosi < 0 &&
               fos_board_sd_pins(cfg->hardware_preset)[0]) {
        fos_config_parse_assets_sd_pins(fos_board_sd_pins(cfg->hardware_preset), &cfg->assets_sd);
        cfg->assets_sd.enabled = true;
    }
    if (nvs_get_u8(nvs, "deep_sleep", &u8) == ESP_OK) cfg->deep_sleep = u8 != 0;
    if (nvs_get_u8(nvs, "sleep_batt", &u8) == ESP_OK) cfg->deep_sleep_on_battery = u8 != 0;
    if (nvs_get_u8(nvs, "wake_sched", &u8) == ESP_OK) cfg->wake_schedule = u8 != 0;
    if (nvs_get_u32(nvs, "wake_check", &u32) == ESP_OK) cfg->wake_check_sec = u32;
    if (nvs_get_u32(nvs, "awake_input", &u32) == ESP_OK) cfg->awake_after_input_sec = u32;
    if (nvs_get_i8(nvs, "batt_pin", &i8) == ESP_OK) cfg->battery_pin = i8;
    if (nvs_get_u32(nvs, "batt_div_m", &u32) == ESP_OK) cfg->battery_divider = (float)u32 / 1000.0f;
    if (nvs_get_i8(nvs, "batt_en", &i8) == ESP_OK) cfg->battery_enable_pin = i8;
    /* No stored value: the board's own buzzer. A frame provisioned with its
     * preset before this key existed chirps after the update, and every
     * save from then on stores what it runs with. */
    if (nvs_get_i8(nvs, "buzzer", &i8) == ESP_OK) cfg->buzzer_pin = i8;
    else cfg->buzzer_pin = (int8_t)fos_board_buzzer_pin(cfg->hardware_preset);
    /* The pitch the same way: stored, else the board's own (the Sticky's
     * buzzer resonates at 4 kHz), else the default. */
    uint16_t u16;
    int board_tone_hz = fos_board_buzzer_tone_hz(cfg->hardware_preset);
    if (nvs_get_u16(nvs, "buzzer_hz", &u16) == ESP_OK && u16 >= FOS_BUZZER_TONE_HZ_MIN &&
        u16 <= FOS_BUZZER_TONE_HZ_MAX) {
        cfg->buzzer_tone_hz = u16;
    } else if (board_tone_hz > 0) {
        cfg->buzzer_tone_hz = (uint16_t)board_tone_hz;
    }
    /* The microphone the same way: stored, else the board's own, so an
     * E1001/E1002 provisioned before the key existed can talk after the
     * update (docs/voice-chat.md). */
    char mic_pins[FOS_STR_LEN] = "";
    nvs_get_string(nvs, "mic_pins", mic_pins, sizeof(mic_pins));
    if (mic_pins[0]) {
        fos_config_parse_mic_pins(mic_pins, &cfg->mic_pins);
    } else {
        int clk, data, pwr;
        fos_board_mic_pins(cfg->hardware_preset, &clk, &data, &pwr);
        cfg->mic_pins.clk = (int8_t)clk;
        cfg->mic_pins.data = (int8_t)data;
        cfg->mic_pins.pwr = (int8_t)pwr;
    }
    if (nvs_get_u8(nvs, "voice", &u8) == ESP_OK) cfg->voice_chat = u8 != 0;
    if (nvs_get_u8(nvs, "touch_beep", &u8) == ESP_OK) cfg->touch_beep = u8 != 0;
    if (nvs_get_u8(nvs, "click_sounds", &u8) == ESP_OK && u8 <= FOS_CLICK_SOUNDS_LAST) cfg->click_sounds = u8;
    if (nvs_get_u8(nvs, "cpu_mode", &u8) == ESP_OK && u8 <= FOS_CPU_PERFORMANCE) cfg->cpu_mode = u8;
    /* The touch panel and the audio codec the same way: stored, else the
     * board's own (fos_board_touch_pins / fos_board_codec_pins), so a Sticky
     * or a PhotoPainter provisioned before the keys existed gets them with
     * the update. */
    char touch_pins[FOS_STR_LEN] = "";
    nvs_get_string(nvs, "touch_pins", touch_pins, sizeof(touch_pins));
    fos_config_parse_touch_pins(touch_pins[0] ? touch_pins : fos_board_touch_pins(cfg->hardware_preset),
                                &cfg->touch_pins);
    char codec_pins[FOS_STR_LEN] = "";
    nvs_get_string(nvs, "codec_pins", codec_pins, sizeof(codec_pins));
    fos_config_parse_codec_pins(codec_pins[0] ? codec_pins : fos_board_codec_pins(cfg->hardware_preset),
                                &cfg->codec_pins);
    /* The status LED the same way: stored, else the board's own (fos_led.c). */
    if (nvs_get_i8(nvs, "led", &i8) == ESP_OK) {
        cfg->led_pin = i8;
        if (nvs_get_u8(nvs, "led_type", &u8) == ESP_OK && u8 <= FOS_LED_WS2812) cfg->led_type = u8;
    } else {
        int led_pin, led_type;
        fos_board_led(cfg->hardware_preset, &led_pin, &led_type);
        cfg->led_pin = (int8_t)led_pin;
        cfg->led_type = (uint8_t)led_type;
    }
    /* And the I2C peripheral buses (fos_i2c.c): the clock, the charger and
     * the sensor a provisioned reTerminal gets with the update. */
    char i2c_buses[FOS_STR_LEN] = "";
    size_t i2c_buses_len = sizeof(i2c_buses);
    if (nvs_get_str(nvs, "i2c_buses", i2c_buses, &i2c_buses_len) != ESP_OK) {
        strlcpy(i2c_buses, fos_board_i2c_buses(cfg->hardware_preset), sizeof(i2c_buses));
    }
    if (fos_config_parse_i2c_buses(i2c_buses, cfg->i2c_buses, &cfg->i2c_bus_count) != ESP_OK) {
        cfg->i2c_bus_count = 0;
    }
    char pins[FOS_STR_LEN] = "";
    nvs_get_string(nvs, "pins", pins, sizeof(pins));
    if (pins[0]) fos_config_parse_pins(pins, &cfg->pins);
    nvs_close(nvs);

    ESP_LOGI(TAG, "config loaded: frame_id=%lu hostname=%s panel=%s mode=%s logs=%s tls=%s:%u admin=%s assets_sd=%s buttons=%u wifi=%s backend=%s",
             (unsigned long)cfg->frame_id, cfg->hostname[0] ? cfg->hostname : "(unset)", cfg->panel,
             cfg->render_mode == FOS_RENDER_LOCAL ? "local" : "remote",
             cfg->server_send_logs ? "on" : "off",
             cfg->tls_enable ? "on" : "off", (unsigned)cfg->tls_port,
             (cfg->admin_auth_enabled && cfg->admin_user[0] && cfg->admin_pass[0]) ? "on" : "off",
             cfg->assets_sd.enabled ? "on" : "off",
             (unsigned)cfg->gpio_button_count,
             cfg->wifi_ssid[0] ? cfg->wifi_ssid : "(unset)",
             cfg->backend_url[0] ? cfg->backend_url : "(unset)");
    if (cfg->cloud_url[0] || cfg->claim_token[0]) {
        /* never log the claim token itself */
        ESP_LOGI(TAG, "cloud config: url=%s claim_token=%s",
                 cfg->cloud_url[0] ? cfg->cloud_url : "(unset)",
                 cfg->claim_token[0] ? "(set)" : "(none)");
    }
    return ESP_OK;
}

esp_err_t fos_config_save(void)
{
    fos_config_t *const cfg = s_config_storage;
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;

    /* Every write is checked: a full partition fails a `set` with
     * ESP_ERR_NVS_NOT_ENOUGH_SPACE while the commit still succeeds, which
     * used to pass as a saved config (the board came back with its old
     * Wi-Fi network after `wifi <ssid>`; 4 MB C3 with a TLS pair in a 16 KB
     * NVS, 2026-09-05). The first failure is reported with its key; the
     * remaining keys are still attempted so an unrelated setting is not
     * lost to an earlier one. */
    esp_err_t first_err = ESP_OK;
    const char *first_key = NULL;
#define FOS_NVS_SET(call, key_name)                                           \
    do {                                                                      \
        esp_err_t set_err_ = (call);                                          \
        if (set_err_ != ESP_OK && first_err == ESP_OK) {                      \
            first_err = set_err_;                                             \
            first_key = (key_name);                                           \
        }                                                                     \
    } while (0)
    FOS_NVS_SET(nvs_set_str(nvs, "wifi_ssid", cfg->wifi_ssid), "wifi_ssid");
    FOS_NVS_SET(nvs_set_str(nvs, "wifi_pass", cfg->wifi_pass), "wifi_pass");
    FOS_NVS_SET(nvs_set_str(nvs, "backend_url", cfg->backend_url), "backend_url");
    FOS_NVS_SET(nvs_set_str(nvs, "api_key", cfg->api_key), "api_key");
    FOS_NVS_SET(nvs_set_str(nvs, "cloud_url", cfg->cloud_url), "cloud_url");
    /* The claim token is single use: once enrollment consumes it the struct
     * field is cleared and the NVS key must disappear, not persist as "". */
    if (cfg->claim_token[0]) {
        FOS_NVS_SET(nvs_set_str(nvs, "claim_token", cfg->claim_token), "claim_token");
    } else {
        nvs_erase_key(nvs, "claim_token");
    }
    FOS_NVS_SET(nvs_set_str(nvs, "hostname", cfg->hostname), "hostname");
    FOS_NVS_SET(nvs_set_str(nvs, "hardware", cfg->hardware_preset), "hardware");
    FOS_NVS_SET(nvs_set_str(nvs, "panel", cfg->panel), "panel");
    FOS_NVS_SET(nvs_set_str(nvs, "assets_path", cfg->assets_path), "assets_path");
    FOS_NVS_SET(nvs_set_str(nvs, "admin_user", cfg->admin_user), "admin_user");
    FOS_NVS_SET(nvs_set_str(nvs, "admin_pass", cfg->admin_pass), "admin_pass");
    FOS_NVS_SET(nvs_set_str(nvs, "ap_psk", cfg->ap_psk), "ap_psk");
    FOS_NVS_SET(nvs_set_u32(nvs, "frame_id", cfg->frame_id), "frame_id");
    FOS_NVS_SET(nvs_set_u16(nvs, "rotate", cfg->rotate), "rotate");
    FOS_NVS_SET(nvs_set_str(nvs, "scaling", cfg->scaling_mode), "scaling");
    FOS_NVS_SET(nvs_set_u16(nvs, "render_scale_m", cfg->render_scale_milli), "render_scale_m");
    FOS_NVS_SET(nvs_set_str(nvs, "colors", cfg->colors), "colors");
    FOS_NVS_SET(nvs_set_str(nvs, "palette", cfg->palette), "palette");
    FOS_NVS_SET(nvs_set_str(nvs, "event_map", cfg->event_map), "event_map");
    FOS_NVS_SET(nvs_set_str(nvs, "time_zone", cfg->time_zone), "time_zone");
    FOS_NVS_SET(nvs_set_u32(nvs, "max_http", cfg->max_http_response_bytes), "max_http");
    FOS_NVS_SET(nvs_set_u32(nvs, "spill_force", cfg->http_spill_force_bytes), "spill_force");
    FOS_NVS_SET(nvs_set_u8(nvs, "render_mode", (uint8_t)cfg->render_mode), "render_mode");
    FOS_NVS_SET(nvs_set_u8(nvs, "send_logs", cfg->server_send_logs ? 1 : 0), "send_logs");
    FOS_NVS_SET(nvs_set_u8(nvs, "debug", cfg->debug_logging ? 1 : 0), "debug");
    FOS_NVS_SET(nvs_set_u8(nvs, "fusion", cfg->image_fusion ? 1 : 0), "fusion");
    FOS_NVS_SET(nvs_set_u8(nvs, "allow_lan", cfg->allow_local_network ? 1 : 0), "allow_lan");
    FOS_NVS_SET(nvs_set_u8(nvs, "fs_on_screen", cfg->frame_settings_on_screen ? 1 : 0), "fs_on_screen");
    FOS_NVS_SET(nvs_set_u8(nvs, "settings_unlock", cfg->settings_unlock ? 1 : 0), "settings_unlock");
    FOS_NVS_SET(nvs_set_u8(nvs, "tls_enable", cfg->tls_enable ? 1 : 0), "tls_enable");
    FOS_NVS_SET(nvs_set_u8(nvs, "admin_auth", cfg->admin_auth_enabled ? 1 : 0), "admin_auth");
    FOS_NVS_SET(nvs_set_u32(nvs, "tls_port", cfg->tls_port), "tls_port");
    FOS_NVS_SET(nvs_set_pem(nvs, "tls_cert", cfg->tls_server_cert), "tls_cert");
    FOS_NVS_SET(nvs_set_pem(nvs, "tls_key", cfg->tls_server_key), "tls_key");
    FOS_NVS_SET(nvs_set_u8(nvs, "assets_sd", cfg->assets_sd.enabled ? 1 : 0), "assets_sd");
    FOS_NVS_SET(nvs_set_u8(nvs, "sd_autofmt", cfg->assets_sd.autoformat ? 1 : 0), "sd_autofmt");
    FOS_NVS_SET(nvs_set_i8(nvs, "sd_cs", cfg->assets_sd.cs), "sd_cs");
    FOS_NVS_SET(nvs_set_i8(nvs, "sd_sck", cfg->assets_sd.sck), "sd_sck");
    FOS_NVS_SET(nvs_set_i8(nvs, "sd_miso", cfg->assets_sd.miso), "sd_miso");
    FOS_NVS_SET(nvs_set_i8(nvs, "sd_mosi", cfg->assets_sd.mosi), "sd_mosi");
    FOS_NVS_SET(nvs_set_u32(nvs, "sd_freq", cfg->assets_sd.max_freq_khz), "sd_freq");
    FOS_NVS_SET(nvs_set_i8(nvs, "sd_pwr", cfg->assets_sd.pwr), "sd_pwr");
    FOS_NVS_SET(nvs_set_i8(nvs, "sd_det", cfg->assets_sd.det), "sd_det");
    FOS_NVS_SET(nvs_set_u8(nvs, "deep_sleep", cfg->deep_sleep ? 1 : 0), "deep_sleep");
    FOS_NVS_SET(nvs_set_u8(nvs, "sleep_batt", cfg->deep_sleep_on_battery ? 1 : 0), "sleep_batt");
    FOS_NVS_SET(nvs_set_u8(nvs, "wake_sched", cfg->wake_schedule ? 1 : 0), "wake_sched");
    FOS_NVS_SET(nvs_set_u32(nvs, "wake_check", cfg->wake_check_sec), "wake_check");
    FOS_NVS_SET(nvs_set_u32(nvs, "awake_input", cfg->awake_after_input_sec), "awake_input");
    FOS_NVS_SET(nvs_set_i8(nvs, "batt_pin", cfg->battery_pin), "batt_pin");
    FOS_NVS_SET(nvs_set_u32(nvs, "batt_div_m", (uint32_t)(cfg->battery_divider * 1000.0f)), "batt_div_m");
    FOS_NVS_SET(nvs_set_i8(nvs, "batt_en", cfg->battery_enable_pin), "batt_en");
    FOS_NVS_SET(nvs_set_i8(nvs, "buzzer", cfg->buzzer_pin), "buzzer");
    FOS_NVS_SET(nvs_set_u16(nvs, "buzzer_hz", cfg->buzzer_tone_hz), "buzzer_hz");
    char mic_pins[FOS_STR_LEN];
    fos_config_format_mic_pins(&cfg->mic_pins, mic_pins, sizeof(mic_pins));
    FOS_NVS_SET(nvs_set_str(nvs, "mic_pins", mic_pins), "mic_pins");
    FOS_NVS_SET(nvs_set_u8(nvs, "voice", cfg->voice_chat ? 1 : 0), "voice");
    FOS_NVS_SET(nvs_set_u8(nvs, "touch_beep", cfg->touch_beep ? 1 : 0), "touch_beep");
    FOS_NVS_SET(nvs_set_u8(nvs, "click_sounds", cfg->click_sounds), "click_sounds");
    FOS_NVS_SET(nvs_set_u8(nvs, "cpu_mode", cfg->cpu_mode), "cpu_mode");
    char touch_pins[FOS_STR_LEN];
    fos_config_format_touch_pins(&cfg->touch_pins, touch_pins, sizeof(touch_pins));
    FOS_NVS_SET(nvs_set_str(nvs, "touch_pins", touch_pins), "touch_pins");
    char codec_pins[FOS_STR_LEN];
    fos_config_format_codec_pins(&cfg->codec_pins, codec_pins, sizeof(codec_pins));
    FOS_NVS_SET(nvs_set_str(nvs, "codec_pins", codec_pins), "codec_pins");
    FOS_NVS_SET(nvs_set_i8(nvs, "led", cfg->led_pin), "led");
    FOS_NVS_SET(nvs_set_u8(nvs, "led_type", cfg->led_type), "led_type");
    char i2c_buses[FOS_STR_LEN];
    fos_config_format_i2c_buses(cfg->i2c_buses, cfg->i2c_bus_count, i2c_buses, sizeof(i2c_buses));
    FOS_NVS_SET(nvs_set_str(nvs, "i2c_buses", i2c_buses), "i2c_buses");
    char gpio_buttons[FOS_GPIO_BUTTONS_SPEC_LEN];
    fos_config_format_gpio_buttons(cfg, gpio_buttons, sizeof(gpio_buttons));
    FOS_NVS_SET(nvs_set_str(nvs, "gpio_buttons", gpio_buttons), "gpio_buttons");
    char pins[FOS_STR_LEN];
    fos_config_format_pins(&cfg->pins, pins, sizeof(pins));
    FOS_NVS_SET(nvs_set_str(nvs, "pins", pins), "pins");

    err = nvs_commit(nvs);
    nvs_close(nvs);
#undef FOS_NVS_SET
    if (first_err != ESP_OK) {
        nvs_stats_t stats = {0};
        nvs_get_stats(NULL, &stats);
        ESP_LOGW(TAG, "config save: %s not stored: %s (nvs %u/%u entries used, %u free)",
                 first_key, esp_err_to_name(first_err), (unsigned)stats.used_entries,
                 (unsigned)stats.total_entries, (unsigned)stats.free_entries);
        return first_err;
    }
    ESP_LOGI(TAG, "config saved");
    return err;
}

esp_err_t fos_config_nvs_stats(size_t *used_entries, size_t *free_entries, size_t *total_entries)
{
    nvs_stats_t stats = {0};
    esp_err_t err = nvs_get_stats(NULL, &stats);
    if (used_entries) *used_entries = stats.used_entries;
    if (free_entries) *free_entries = stats.free_entries;
    if (total_entries) *total_entries = stats.total_entries;
    return err;
}



esp_err_t fos_config_erase(void)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;
    err = nvs_erase_all(nvs);
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    load_defaults();
    return err;
}

bool fos_config_wifi_ready(void)
{
    fos_config_t *const cfg = s_config_storage;
    return cfg->wifi_ssid[0] != '\0';
}

bool fos_config_frame_page_offered(void)
{
    fos_config_t *const cfg = s_config_storage;
    return cfg->frame_settings_on_screen || cfg->settings_unlock;
}

/* The chip's SPI flash / PSRAM pads, by target. esp_gpio_is_reserved below
 * knows the same pins once the flash and PSRAM drivers have claimed them,
 * but this table does not depend on that having happened yet, and names the
 * reason. */
static bool gpio_pin_is_memory_pad(int pin)
{
#if CONFIG_IDF_TARGET_ESP32S3
    /* GPIO26-32: the in-package / module SPI flash (and a quad PSRAM).
     * GPIO33-37: the four extra data lines of octal PSRAM / octal flash. */
    if (pin >= 26 && pin <= 32) return true;
#if CONFIG_SPIRAM_MODE_OCT || CONFIG_ESPTOOLPY_OCT_FLASH
    if (pin >= 33 && pin <= 37) return true;
#endif
#elif CONFIG_IDF_TARGET_ESP32
    /* GPIO6-11: SPI flash. GPIO16/17: PSRAM CS / CLK on the WROVER modules. */
    if (pin >= 6 && pin <= 11) return true;
#if CONFIG_SPIRAM
    if (pin == 16 || pin == 17) return true;
#endif
#elif CONFIG_IDF_TARGET_ESP32C3
    /* GPIO12-17: the in-package SPI flash of the C3 modules FrameOS runs on. */
    if (pin >= 12 && pin <= 17) return true;
#endif
    return false;
}

const char *fos_config_gpio_pin_reserved(int pin)
{
    if (pin < 0 || pin >= SOC_GPIO_PIN_COUNT || !GPIO_IS_VALID_GPIO(pin)) {
        return "not a GPIO on this chip";
    }
    if (gpio_pin_is_memory_pad(pin)) return "SPI flash / PSRAM pad";
    if (esp_gpio_is_reserved(BIT64(pin))) return "claimed by a driver";
    return NULL;
}
