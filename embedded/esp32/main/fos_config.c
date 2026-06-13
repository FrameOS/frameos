#include "fos_config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "fos_defaults.h"

static const char *TAG = "fos_config";
static const char *NVS_NS = "frameos";

static fos_config_t s_config;

fos_config_t *fos_config(void) { return &s_config; }

static void load_defaults(void)
{
    memset(&s_config, 0, sizeof(s_config));
    strlcpy(s_config.wifi_ssid, FRAMEOS_DEFAULT_WIFI_SSID, sizeof(s_config.wifi_ssid));
    strlcpy(s_config.wifi_pass, FRAMEOS_DEFAULT_WIFI_PASS, sizeof(s_config.wifi_pass));
    strlcpy(s_config.backend_url, FRAMEOS_DEFAULT_BACKEND_URL, sizeof(s_config.backend_url));
    strlcpy(s_config.api_key, FRAMEOS_DEFAULT_API_KEY, sizeof(s_config.api_key));
    s_config.frame_id = FRAMEOS_DEFAULT_FRAME_ID;
    strlcpy(s_config.hostname, FRAMEOS_DEFAULT_HOSTNAME, sizeof(s_config.hostname));
    strlcpy(s_config.panel, FRAMEOS_DEFAULT_PANEL, sizeof(s_config.panel));
    s_config.render_mode = (fos_render_mode_t)FRAMEOS_DEFAULT_RENDER_MODE;
    s_config.interval_sec = FRAMEOS_DEFAULT_INTERVAL_SEC;
    s_config.deep_sleep = FRAMEOS_DEFAULT_DEEP_SLEEP;
    s_config.wake_schedule = FRAMEOS_DEFAULT_WAKE_SCHEDULE;
    s_config.battery_pin = FRAMEOS_DEFAULT_BATTERY_PIN;
    s_config.battery_divider = FRAMEOS_DEFAULT_BATTERY_DIVIDER;
    fos_config_parse_gpio_buttons(FRAMEOS_DEFAULT_GPIO_BUTTONS, &s_config);
    s_config.pins.rst = FRAMEOS_DEFAULT_PIN_RST;
    s_config.pins.dc = FRAMEOS_DEFAULT_PIN_DC;
    s_config.pins.cs = FRAMEOS_DEFAULT_PIN_CS;
    s_config.pins.cs2 = FRAMEOS_DEFAULT_PIN_CS2;
    s_config.pins.busy = FRAMEOS_DEFAULT_PIN_BUSY;
    s_config.pins.sck = FRAMEOS_DEFAULT_PIN_SCK;
    s_config.pins.mosi = FRAMEOS_DEFAULT_PIN_MOSI;
    s_config.pins.pwr = FRAMEOS_DEFAULT_PIN_PWR;
}

static void nvs_get_string(nvs_handle_t nvs, const char *key, char *out, size_t out_len)
{
    size_t len = out_len;
    if (nvs_get_str(nvs, key, out, &len) != ESP_OK) {
        /* keep the default */
    }
}

esp_err_t fos_config_init(void)
{
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
        ESP_LOGI(TAG, "no stored config, using %s defaults",
#ifdef FRAMEOS_HAVE_GENERATED_CONFIG
                 "frame-specific baked"
#else
                 "generic"
#endif
        );
        return ESP_OK;
    }
    if (err != ESP_OK) {
        return err;
    }

    nvs_get_string(nvs, "wifi_ssid", s_config.wifi_ssid, sizeof(s_config.wifi_ssid));
    nvs_get_string(nvs, "wifi_pass", s_config.wifi_pass, sizeof(s_config.wifi_pass));
    nvs_get_string(nvs, "backend_url", s_config.backend_url, sizeof(s_config.backend_url));
    nvs_get_string(nvs, "api_key", s_config.api_key, sizeof(s_config.api_key));
    nvs_get_string(nvs, "hostname", s_config.hostname, sizeof(s_config.hostname));
    nvs_get_string(nvs, "panel", s_config.panel, sizeof(s_config.panel));
    char gpio_buttons[FOS_GPIO_BUTTONS_SPEC_LEN] = "";
    size_t gpio_buttons_len = sizeof(gpio_buttons);
    esp_err_t buttons_err = nvs_get_str(nvs, "gpio_buttons", gpio_buttons, &gpio_buttons_len);
    if (buttons_err == ESP_OK) {
        buttons_err = fos_config_parse_gpio_buttons(gpio_buttons, &s_config);
        if (buttons_err != ESP_OK) {
            ESP_LOGW(TAG, "stored GPIO button config invalid: %s", esp_err_to_name(buttons_err));
        }
    }
    uint32_t u32;
    if (nvs_get_u32(nvs, "frame_id", &u32) == ESP_OK) s_config.frame_id = u32;
    if (nvs_get_u32(nvs, "interval", &u32) == ESP_OK) s_config.interval_sec = u32;
    uint8_t u8;
    if (nvs_get_u8(nvs, "render_mode", &u8) == ESP_OK) s_config.render_mode = (fos_render_mode_t)u8;
    if (nvs_get_u8(nvs, "deep_sleep", &u8) == ESP_OK) s_config.deep_sleep = u8 != 0;
    if (nvs_get_u8(nvs, "wake_sched", &u8) == ESP_OK) s_config.wake_schedule = u8 != 0;
    int8_t i8;
    if (nvs_get_i8(nvs, "batt_pin", &i8) == ESP_OK) s_config.battery_pin = i8;
    if (nvs_get_u32(nvs, "batt_div_m", &u32) == ESP_OK) s_config.battery_divider = (float)u32 / 1000.0f;
    char pins[FOS_STR_LEN] = "";
    nvs_get_string(nvs, "pins", pins, sizeof(pins));
    if (pins[0]) fos_config_parse_pins(pins, &s_config.pins);
    nvs_close(nvs);

    ESP_LOGI(TAG, "config loaded: frame_id=%lu hostname=%s panel=%s mode=%s interval=%lus buttons=%u wifi=%s backend=%s",
             (unsigned long)s_config.frame_id, s_config.hostname[0] ? s_config.hostname : "(unset)", s_config.panel,
             s_config.render_mode == FOS_RENDER_LOCAL ? "local" : "remote",
             (unsigned long)s_config.interval_sec, (unsigned)s_config.gpio_button_count,
             s_config.wifi_ssid[0] ? s_config.wifi_ssid : "(unset)",
             s_config.backend_url[0] ? s_config.backend_url : "(unset)");
    return ESP_OK;
}

esp_err_t fos_config_save(void)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;

    nvs_set_str(nvs, "wifi_ssid", s_config.wifi_ssid);
    nvs_set_str(nvs, "wifi_pass", s_config.wifi_pass);
    nvs_set_str(nvs, "backend_url", s_config.backend_url);
    nvs_set_str(nvs, "api_key", s_config.api_key);
    nvs_set_str(nvs, "hostname", s_config.hostname);
    nvs_set_str(nvs, "panel", s_config.panel);
    nvs_set_u32(nvs, "frame_id", s_config.frame_id);
    nvs_set_u32(nvs, "interval", s_config.interval_sec);
    nvs_set_u8(nvs, "render_mode", (uint8_t)s_config.render_mode);
    nvs_set_u8(nvs, "deep_sleep", s_config.deep_sleep ? 1 : 0);
    nvs_set_u8(nvs, "wake_sched", s_config.wake_schedule ? 1 : 0);
    nvs_set_i8(nvs, "batt_pin", s_config.battery_pin);
    nvs_set_u32(nvs, "batt_div_m", (uint32_t)(s_config.battery_divider * 1000.0f));
    char gpio_buttons[FOS_GPIO_BUTTONS_SPEC_LEN];
    fos_config_format_gpio_buttons(&s_config, gpio_buttons, sizeof(gpio_buttons));
    nvs_set_str(nvs, "gpio_buttons", gpio_buttons);
    char pins[FOS_STR_LEN];
    fos_config_format_pins(&s_config.pins, pins, sizeof(pins));
    nvs_set_str(nvs, "pins", pins);

    err = nvs_commit(nvs);
    nvs_close(nvs);
    ESP_LOGI(TAG, "config saved");
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
    return s_config.wifi_ssid[0] != '\0';
}

esp_err_t fos_config_parse_pins(const char *spec, fos_pins_t *pins)
{
    char buf[FOS_STR_LEN];
    strlcpy(buf, spec, sizeof(buf));
    char *save = NULL;
    for (char *tok = strtok_r(buf, ", ", &save); tok; tok = strtok_r(NULL, ", ", &save)) {
        char *eq = strchr(tok, '=');
        if (!eq) return ESP_ERR_INVALID_ARG;
        *eq = '\0';
        int value = atoi(eq + 1);
        if (value < -1 || value > 48) return ESP_ERR_INVALID_ARG;
        if (strcmp(tok, "rst") == 0) pins->rst = value;
        else if (strcmp(tok, "dc") == 0) pins->dc = value;
        else if (strcmp(tok, "cs") == 0) pins->cs = value;
        else if (strcmp(tok, "cs2") == 0) pins->cs2 = value;
        else if (strcmp(tok, "busy") == 0) pins->busy = value;
        else if (strcmp(tok, "sck") == 0) pins->sck = value;
        else if (strcmp(tok, "mosi") == 0) pins->mosi = value;
        else if (strcmp(tok, "pwr") == 0) pins->pwr = value;
        else return ESP_ERR_INVALID_ARG;
    }
    return ESP_OK;
}

void fos_config_format_pins(const fos_pins_t *pins, char *out, size_t out_len)
{
    snprintf(out, out_len, "rst=%d,dc=%d,cs=%d,cs2=%d,busy=%d,sck=%d,mosi=%d,pwr=%d",
             pins->rst, pins->dc, pins->cs, pins->cs2, pins->busy, pins->sck, pins->mosi, pins->pwr);
}

esp_err_t fos_config_parse_gpio_buttons(const char *spec, fos_config_t *config)
{
    if (!spec || !spec[0]) {
        config->gpio_button_count = 0;
        return ESP_OK;
    }

    fos_gpio_button_t buttons[FOS_GPIO_BUTTONS_MAX];
    size_t button_count = 0;
    char buf[FOS_GPIO_BUTTONS_SPEC_LEN];
    strlcpy(buf, spec, sizeof(buf));
    char *save = NULL;
    for (char *line = strtok_r(buf, "\n", &save);
         line && button_count < FOS_GPIO_BUTTONS_MAX;
         line = strtok_r(NULL, "\n", &save)) {
        while (*line == ' ' || *line == '\t' || *line == '\r') line++;
        if (!*line) continue;

        char *sep = strchr(line, ':');
        if (!sep) return ESP_ERR_INVALID_ARG;
        *sep = '\0';
        char *end = NULL;
        long pin = strtol(line, &end, 10);
        if (end == line || *end != '\0') return ESP_ERR_INVALID_ARG;
        if (pin < 0 || pin > 48) return ESP_ERR_INVALID_ARG;

        char *label = sep + 1;
        while (*label == ' ' || *label == '\t') label++;
        size_t label_len = strlen(label);
        while (label_len > 0 &&
               (label[label_len - 1] == ' ' || label[label_len - 1] == '\t' || label[label_len - 1] == '\r')) {
            label[--label_len] = '\0';
        }
        fos_gpio_button_t *button = &buttons[button_count++];
        button->pin = (int8_t)pin;
        strlcpy(button->label, label[0] ? label : "Button", sizeof(button->label));
    }
    memset(config->gpio_buttons, 0, sizeof(config->gpio_buttons));
    memcpy(config->gpio_buttons, buttons, button_count * sizeof(buttons[0]));
    config->gpio_button_count = button_count;
    return ESP_OK;
}

void fos_config_format_gpio_buttons(const fos_config_t *config, char *out, size_t out_len)
{
    if (!out_len) return;
    out[0] = '\0';
    size_t used = 0;
    for (size_t i = 0; i < config->gpio_button_count; i++) {
        const fos_gpio_button_t *button = &config->gpio_buttons[i];
        int written = snprintf(out + used, out_len - used, "%s%d:%s",
                               used ? "\n" : "", button->pin, button->label);
        if (written < 0) break;
        if ((size_t)written >= out_len - used) {
            out[out_len - 1] = '\0';
            break;
        }
        used += (size_t)written;
    }
}
