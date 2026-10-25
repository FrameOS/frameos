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
#include <stddef.h>
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
        /* The slot's power switch and card-detect contact (2026.10.20); a
         * spec without them leaves both as they were. */
        else if (strcmp(tok, "pwr") == 0) assets_sd->pwr = value;
        else if (strcmp(tok, "det") == 0) assets_sd->det = value;
        else return ESP_ERR_INVALID_ARG;
    }
    return ESP_OK;
}

void fos_config_format_assets_sd_pins(const fos_assets_sd_config_t *assets_sd, char *out, size_t out_len)
{
    /* The four bus pins always; the slot's power and detect pins only when
     * wired, so a board without them prints the spec it always did. */
    int used = snprintf(out, out_len, "cs=%d,sck=%d,miso=%d,mosi=%d",
                        assets_sd->cs, assets_sd->sck, assets_sd->miso, assets_sd->mosi);
    if (used < 0 || (size_t)used >= out_len) return;
    if (assets_sd->pwr >= 0) {
        int more = snprintf(out + used, out_len - (size_t)used, ",pwr=%d", assets_sd->pwr);
        if (more < 0 || (size_t)more >= out_len - (size_t)used) return;
        used += more;
    }
    if (assets_sd->det >= 0) {
        snprintf(out + used, out_len - (size_t)used, ",det=%d", assets_sd->det);
    }
}

esp_err_t fos_config_parse_mic_pins(const char *spec, fos_mic_pins_t *mic_pins)
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
        if (strcmp(tok, "clk") == 0) mic_pins->clk = value;
        else if (strcmp(tok, "data") == 0) mic_pins->data = value;
        else if (strcmp(tok, "pwr") == 0) mic_pins->pwr = value;
        else return ESP_ERR_INVALID_ARG;
    }
    return ESP_OK;
}

void fos_config_format_mic_pins(const fos_mic_pins_t *mic_pins, char *out, size_t out_len)
{
    snprintf(out, out_len, "clk=%d,data=%d,pwr=%d", mic_pins->clk, mic_pins->data, mic_pins->pwr);
}

/* One `name=gpio,...` spec onto a struct of int8_t slots: the shape every
 * peripheral spec here has (the touch panel, the codec). A name the table
 * does not know, a missing `=` or a value outside -1..48 refuses the whole
 * spec and leaves the struct untouched; a name left out keeps its slot. */
typedef struct {
    const char *name;
    size_t offset;
} fos_pin_slot_t;

static esp_err_t parse_pin_slots(const char *spec, const fos_pin_slot_t *slots, size_t slot_count,
                                 void *target, size_t target_len)
{
    char buf[FOS_STR_LEN];
    copy_bounded_cfg(buf, spec, sizeof(buf));
    uint8_t scratch[16];
    if (target_len > sizeof(scratch)) return ESP_ERR_INVALID_ARG;
    memcpy(scratch, target, target_len);
    char *save = NULL;
    for (char *tok = strtok_r(buf, ", ", &save); tok; tok = strtok_r(NULL, ", ", &save)) {
        char *eq = strchr(tok, '=');
        if (!eq) return ESP_ERR_INVALID_ARG;
        *eq = '\0';
        int value = atoi(eq + 1);
        if (value < -1 || value > 48) return ESP_ERR_INVALID_ARG;
        size_t i = 0;
        for (; i < slot_count; i++) {
            if (strcmp(tok, slots[i].name) == 0) break;
        }
        if (i == slot_count) return ESP_ERR_INVALID_ARG;
        scratch[slots[i].offset] = (uint8_t)(int8_t)value;
    }
    memcpy(target, scratch, target_len);
    return ESP_OK;
}

static void format_pin_slots(const fos_pin_slot_t *slots, size_t slot_count, const void *source,
                             char *out, size_t out_len)
{
    if (out_len == 0) return;
    out[0] = '\0';
    size_t used = 0;
    for (size_t i = 0; i < slot_count; i++) {
        int value = (int8_t)((const uint8_t *)source)[slots[i].offset];
        int n = snprintf(out + used, out_len - used, "%s%s=%d", i ? "," : "", slots[i].name, value);
        if (n < 0 || (size_t)n >= out_len - used) return;
        used += (size_t)n;
    }
}

static const fos_pin_slot_t k_touch_slots[] = {
    {"sda", offsetof(fos_touch_pins_t, sda)}, {"scl", offsetof(fos_touch_pins_t, scl)},
    {"int", offsetof(fos_touch_pins_t, irq)}, {"rst", offsetof(fos_touch_pins_t, rst)},
    {"en", offsetof(fos_touch_pins_t, en)},
};

esp_err_t fos_config_parse_touch_pins(const char *spec, fos_touch_pins_t *touch_pins)
{
    return parse_pin_slots(spec, k_touch_slots, sizeof(k_touch_slots) / sizeof(k_touch_slots[0]), touch_pins,
                           sizeof(*touch_pins));
}

void fos_config_format_touch_pins(const fos_touch_pins_t *touch_pins, char *out, size_t out_len)
{
    format_pin_slots(k_touch_slots, sizeof(k_touch_slots) / sizeof(k_touch_slots[0]), touch_pins, out, out_len);
}

static const fos_pin_slot_t k_codec_slots[] = {
    {"mclk", offsetof(fos_codec_pins_t, mclk)}, {"bclk", offsetof(fos_codec_pins_t, bclk)},
    {"ws", offsetof(fos_codec_pins_t, ws)},     {"din", offsetof(fos_codec_pins_t, din)},
    {"dout", offsetof(fos_codec_pins_t, dout)}, {"pa", offsetof(fos_codec_pins_t, pa)},
};

esp_err_t fos_config_parse_codec_pins(const char *spec, fos_codec_pins_t *codec_pins)
{
    return parse_pin_slots(spec, k_codec_slots, sizeof(k_codec_slots) / sizeof(k_codec_slots[0]), codec_pins,
                           sizeof(*codec_pins));
}

void fos_config_format_codec_pins(const fos_codec_pins_t *codec_pins, char *out, size_t out_len)
{
    format_pin_slots(k_codec_slots, sizeof(k_codec_slots) / sizeof(k_codec_slots[0]), codec_pins, out, out_len);
}

esp_err_t fos_config_parse_i2c_buses(const char *spec, fos_i2c_bus_t *buses, uint8_t *count)
{
    char buf[FOS_STR_LEN];
    copy_bounded_cfg(buf, spec, sizeof(buf));
    fos_i2c_bus_t parsed[FOS_I2C_BUSES_MAX];
    uint8_t n = 0;
    char *save_bus = NULL;
    for (char *bus = strtok_r(buf, ";", &save_bus); bus; bus = strtok_r(NULL, ";", &save_bus)) {
        while (*bus == ' ') bus++;
        if (!*bus) continue;
        if (n >= FOS_I2C_BUSES_MAX) return ESP_ERR_INVALID_ARG;
        int sda = -1, scl = -1;
        char *save_pin = NULL;
        for (char *tok = strtok_r(bus, ", ", &save_pin); tok; tok = strtok_r(NULL, ", ", &save_pin)) {
            char *eq = strchr(tok, '=');
            if (!eq) return ESP_ERR_INVALID_ARG;
            *eq = '\0';
            int value = atoi(eq + 1);
            if (value < 0 || value > 48) return ESP_ERR_INVALID_ARG;
            if (strcmp(tok, "sda") == 0) sda = value;
            else if (strcmp(tok, "scl") == 0) scl = value;
            else return ESP_ERR_INVALID_ARG;
        }
        /* A bus is two pins, and not the same one twice. */
        if (sda < 0 || scl < 0 || sda == scl) return ESP_ERR_INVALID_ARG;
        parsed[n].sda = (int8_t)sda;
        parsed[n].scl = (int8_t)scl;
        n++;
    }
    memcpy(buses, parsed, sizeof(parsed[0]) * n);
    *count = n;
    return ESP_OK;
}

void fos_config_format_i2c_buses(const fos_i2c_bus_t *buses, uint8_t count, char *out, size_t out_len)
{
    if (out_len == 0) return;
    out[0] = '\0';
    size_t used = 0;
    for (uint8_t i = 0; i < count && i < FOS_I2C_BUSES_MAX; i++) {
        int n = snprintf(out + used, out_len - used, "%ssda=%d,scl=%d", i ? ";" : "",
                         buses[i].sda, buses[i].scl);
        if (n < 0 || (size_t)n >= out_len - used) return;
        used += (size_t)n;
    }
}

static const char *const k_led_type_names[] = {"gpio", "gpio_inverted", "ws2812"};

bool fos_config_parse_led_type(const char *name, uint8_t *type)
{
    if (!name) return false;
    for (size_t i = 0; i < sizeof(k_led_type_names) / sizeof(k_led_type_names[0]); i++) {
        if (strcasecmp(name, k_led_type_names[i]) == 0) {
            *type = (uint8_t)i;
            return true;
        }
    }
    return false;
}

const char *fos_config_led_type_name(uint8_t type)
{
    if (type >= sizeof(k_led_type_names) / sizeof(k_led_type_names[0])) return k_led_type_names[0];
    return k_led_type_names[type];
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
