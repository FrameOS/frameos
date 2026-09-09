/*
 * The pure half of fos_config: string parsers and normalisers behind every
 * writer of a setting (the USB console `set`, the backend settings poll, the
 * cloud set_settings verb). No NVS, no drivers, so they can be argued about
 * on a laptop (main/tests/test_fos_config_parse.c). The one chip-specific
 * dependency, fos_config_gpio_pin_reserved(), stays in fos_config.c; the
 * host test supplies its own.
 */

/* glibc hides strtok_r / strcasecmp behind feature macros under -std=c11
 * (the host tests build with it); harmless under the IDF's gnu17. */
#if defined(__STRICT_ANSI__) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200112L
#endif

#include "fos_config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#ifdef ESP_PLATFORM
#include "esp_log.h"
#else
#define ESP_LOGW(tag, fmt, ...) ((void)(tag))
#endif

static const char *TAG = "fos_config";

/* strlcpy's contract without strlcpy: not declared under strict C11 on
 * glibc, where the host tests build. */
static void copy_bounded_cfg(char *dst, const char *src, size_t dst_len)
{
    if (dst_len == 0) return;
    size_t n = strlen(src);
    if (n >= dst_len) n = dst_len - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

bool fos_config_normalize_rotate(double value, uint16_t *out)
{
    if (!(value >= -100000.0 && value <= 100000.0)) return false; /* NaN too */
    int rot = (((int)value % 360) + 360) % 360;
    if (rot != 0 && rot != 90 && rot != 180 && rot != 270) return false;
    if (out != NULL) *out = (uint16_t)rot;
    return true;
}

bool fos_config_normalize_scaling_mode(const char *value, char *out, size_t out_len)
{
    static const char *modes[] = { "contain", "cover", "stretch", "center" };
    if (value == NULL || out == NULL || out_len == 0) return false;
    for (size_t i = 0; i < sizeof(modes) / sizeof(modes[0]); i++) {
        if (strcasecmp(value, modes[i]) == 0) {
            copy_bounded_cfg(out, modes[i], out_len);
            return true;
        }
    }
    return false;
}

esp_err_t fos_config_parse_pins(const char *spec, fos_pins_t *pins)
{
    char buf[FOS_STR_LEN];
    copy_bounded_cfg(buf, spec, sizeof(buf));
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

esp_err_t fos_config_parse_assets_sd_pins(const char *spec, fos_assets_sd_config_t *assets_sd)
{
    char buf[FOS_STR_LEN];
    copy_bounded_cfg(buf, spec, sizeof(buf));
    char *save = NULL;
    for (char *tok = strtok_r(buf, ", ", &save); tok; tok = strtok_r(NULL, ", ", &save)) {
        char *eq = strchr(tok, '=');
        if (!eq) return ESP_ERR_INVALID_ARG;
        *eq = '\0';
        int value = atoi(eq + 1);
        if (value < -1 || value > 48) return ESP_ERR_INVALID_ARG;
        if (strcmp(tok, "cs") == 0) assets_sd->cs = value;
        else if (strcmp(tok, "sck") == 0) assets_sd->sck = value;
        else if (strcmp(tok, "miso") == 0) assets_sd->miso = value;
        else if (strcmp(tok, "mosi") == 0) assets_sd->mosi = value;
        else return ESP_ERR_INVALID_ARG;
    }
    return ESP_OK;
}

void fos_config_format_assets_sd_pins(const fos_assets_sd_config_t *assets_sd, char *out, size_t out_len)
{
    snprintf(out, out_len, "cs=%d,sck=%d,miso=%d,mosi=%d",
             assets_sd->cs, assets_sd->sck, assets_sd->miso, assets_sd->mosi);
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
    copy_bounded_cfg(buf, spec, sizeof(buf));
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
        const char *reserved = fos_config_gpio_pin_reserved((int)pin);
        if (reserved != NULL) {
            /* Every writer lands here — NVS at boot, the USB console, the
             * cloud set_settings verb — so the refusal is logged once, here. */
            ESP_LOGW(TAG, "GPIO %ld refused for a button: %s", pin, reserved);
            return ESP_ERR_INVALID_ARG;
        }

        char *label = sep + 1;
        while (*label == ' ' || *label == '\t') label++;
        size_t label_len = strlen(label);
        while (label_len > 0 &&
               (label[label_len - 1] == ' ' || label[label_len - 1] == '\t' || label[label_len - 1] == '\r')) {
            label[--label_len] = '\0';
        }
        fos_gpio_button_t *button = &buttons[button_count++];
        button->pin = (int8_t)pin;
        copy_bounded_cfg(button->label, label[0] ? label : "Button", sizeof(button->label));
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
