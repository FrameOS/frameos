// USB CDC console: the same provisioning surface as the ESP32 firmware's
// serial console (status / set <key> <value> / wifi / render / factory-reset),
// so the frontends' WebSerial provisioning flow speaks one protocol.
#include "pk_console.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "hardware/watchdog.h"
#include "pico/bootrom.h"
#include "pico/stdlib.h"

#include "pk_config.h"
#include "pk_display.h"
#include "pk_http.h"
#include "pk_shiftreg.h"
#include "pk_wifi.h"

#define PK_CONSOLE_LINE_MAX 512

static char s_line[PK_CONSOLE_LINE_MAX];
static size_t s_line_len = 0;
static bool s_render_requested = false;

// Hardware presets: keep in sync with EMBEDDED_HARDWARE_PRESETS in
// backend/app/tasks/embedded_firmware.py (pico entries).
typedef struct {
    const char *name;
    const char *panel;
    pk_pins_t pins;
} pk_preset_t;

// Inky Frame wiring from Pimoroni's own sources (pimoroni-pico
// libraries/inky_frame/inky_frame.hpp, identical across all sizes): SPI0 on
// SCK18/MOSI19, CS17, DC28, RST27; BUSY + buttons through the shift register
// on CLOCK8/LATCH9/DATA10 (busy = bit 7, active low); HOLD_VSYS_EN on GP2
// keeps the regulator alive on battery.
#define INKY_FRAME_PINS \
    { .sck = 18, .mosi = 19, .cs = 17, .dc = 28, .rst = 27, \
      .busy = -1, .sr_clock = 8, .sr_latch = 9, .sr_data = 10, .busy_bit = 7, \
      .hold_vsys = 2 }

static const pk_preset_t s_presets[] = {
    {"pimoroni_inky_frame_4", "EPD_4in01f", INKY_FRAME_PINS},
    {"pimoroni_inky_frame_5_7", "EPD_5in65f", INKY_FRAME_PINS},
    {"pimoroni_inky_frame_7_3", "EPD_7in3f", INKY_FRAME_PINS},
    // Dec 2024 refresh: Pico 2 W with the same ACeP panel.
    {"pimoroni_inky_frame_7_3_pico2", "EPD_7in3f", INKY_FRAME_PINS},
    // Aug 2025 refresh: Pico 2 W with the Spectra 6 panel (black top border).
    {"pimoroni_inky_frame_7_3_spectra", "EPD_7in3e", INKY_FRAME_PINS},
};

static void print_status(void)
{
    pk_config_t *config = pk_config();
    printf("frameos-pico %s\n", FRAMEOS_VERSION);
    printf("wifi:     %s%s\n", config->wifi_ssid[0] ? config->wifi_ssid : "(unset)",
           pk_wifi_connected() ? " (connected)" : "");
    printf("backend:  %s\n", config->backend_url[0] ? config->backend_url : "(unset)");
    printf("frame_id: %lu\n", (unsigned long)config->frame_id);
    printf("api_key:  %s\n", config->api_key[0] ? "(set)" : "(unset)");
    printf("panel:    %s\n", config->panel[0] ? config->panel : "(unset)");
    printf("hardware: %s\n", config->hardware_preset[0] ? config->hardware_preset : "custom");
    printf("pins:     sck=%d mosi=%d cs=%d dc=%d rst=%d busy=%d sr=%d/%d/%d busy_bit=%d\n",
           config->pins.sck, config->pins.mosi, config->pins.cs, config->pins.dc,
           config->pins.rst, config->pins.busy, config->pins.sr_clock,
           config->pins.sr_latch, config->pins.sr_data, config->pins.busy_bit);
    printf("interval: %lus%s\n", (unsigned long)config->interval_seconds,
           config->deep_sleep ? " (deep sleep)" : "");
}

static bool parse_pins(const char *value, pk_pins_t *pins)
{
    // Same spec style as the ESP32 console: comma-separated key=gpio pairs.
    pk_pins_t next = *pins;
    char buffer[192];
    snprintf(buffer, sizeof(buffer), "%s", value);
    char *save = NULL;
    for (char *token = strtok_r(buffer, ", ", &save); token;
         token = strtok_r(NULL, ", ", &save)) {
        char *eq = strchr(token, '=');
        if (!eq) return false;
        *eq = '\0';
        int pin = atoi(eq + 1);
        if (pin < -1 || pin > 47) return false; // RP2350B tops out at GPIO47
        if (strcmp(token, "sck") == 0) next.sck = (int8_t)pin;
        else if (strcmp(token, "mosi") == 0) next.mosi = (int8_t)pin;
        else if (strcmp(token, "cs") == 0) next.cs = (int8_t)pin;
        else if (strcmp(token, "dc") == 0) next.dc = (int8_t)pin;
        else if (strcmp(token, "rst") == 0) next.rst = (int8_t)pin;
        else if (strcmp(token, "busy") == 0) next.busy = (int8_t)pin;
        else if (strcmp(token, "sr_clock") == 0) next.sr_clock = (int8_t)pin;
        else if (strcmp(token, "sr_latch") == 0) next.sr_latch = (int8_t)pin;
        else if (strcmp(token, "sr_data") == 0) next.sr_data = (int8_t)pin;
        else if (strcmp(token, "busy_bit") == 0) next.busy_bit = (int8_t)pin;
        else if (strcmp(token, "hold_vsys") == 0) next.hold_vsys = (int8_t)pin;
        else return false;
    }
    *pins = next;
    return true;
}

static void handle_set(char *key, char *value)
{
    pk_config_t *config = pk_config();
    if (strcmp(key, "backend") == 0) {
        if (value[0] && !pk_http_url_is_supported(value)) {
            printf("error: backend must be an http:// or https:// URL\n");
            return;
        }
        snprintf(config->backend_url, sizeof(config->backend_url), "%s", value);
    } else if (strcmp(key, "api_key") == 0) {
        snprintf(config->api_key, sizeof(config->api_key), "%s", value);
    } else if (strcmp(key, "frame_id") == 0) {
        config->frame_id = (uint32_t)strtoul(value, NULL, 10);
    } else if (strcmp(key, "interval") == 0) {
        unsigned long seconds = strtoul(value, NULL, 10);
        config->interval_seconds = seconds < 15 ? 15 : (uint32_t)seconds;
    } else if (strcmp(key, "deep_sleep") == 0) {
        config->deep_sleep = (uint8_t)(atoi(value) != 0);
    } else if (strcmp(key, "panel") == 0) {
        if (strcmp(value, "none") != 0 && pk_display_find(value) == NULL) {
            size_t count = 0;
            pk_display_panels(&count);
            printf("unknown panel \"%s\" — this firmware compiles in %u panels\n",
                   value, (unsigned)count);
            return;
        }
        snprintf(config->panel, sizeof(config->panel), "%s", value);
    } else if (strcmp(key, "pins") == 0) {
        if (!parse_pins(value, &config->pins)) {
            printf("bad pin spec, want e.g. sck=18,mosi=19,cs=17,dc=28,rst=27,"
                   "sr_clock=8,sr_latch=9,sr_data=10,busy_bit=7\n");
            return;
        }
    } else if (strcmp(key, "hardware") == 0 || strcmp(key, "hardware_preset") == 0) {
        snprintf(config->hardware_preset, sizeof(config->hardware_preset), "%s", value);
        for (size_t i = 0; i < sizeof(s_presets) / sizeof(s_presets[0]); i++) {
            if (strcmp(value, s_presets[i].name) != 0) continue;
            snprintf(config->panel, sizeof(config->panel), "%s", s_presets[i].panel);
            config->pins = s_presets[i].pins;
            printf("applied %s: panel=%s\n", s_presets[i].name, s_presets[i].panel);
            break;
        }
    } else {
        printf("unknown key \"%s\"\n", key);
        return;
    }
    pk_config_save();
    printf("ok\n");
}

static void handle_line(char *line)
{
    char *save = NULL;
    char *command = strtok_r(line, " ", &save);
    if (command == NULL) return;
    if (strcmp(command, "status") == 0) {
        print_status();
    } else if (strcmp(command, "wifi") == 0) {
        char *ssid = strtok_r(NULL, " ", &save);
        char *pass = strtok_r(NULL, "", &save);
        if (!ssid) {
            printf("usage: wifi <ssid> [password]\n");
            return;
        }
        pk_config_t *config = pk_config();
        snprintf(config->wifi_ssid, sizeof(config->wifi_ssid), "%s", ssid);
        snprintf(config->wifi_pass, sizeof(config->wifi_pass), "%s", pass ? pass : "");
        pk_config_save();
        printf("ok, rebooting to connect\n");
        sleep_ms(100);
        // Watchdog reboot re-runs the whole boot sequence; works on both
        // RP2040 and RP2350, unlike a raw AIRCR write.
        watchdog_reboot(0, 0, 0);
    } else if (strcmp(command, "set") == 0) {
        char *key = strtok_r(NULL, " ", &save);
        char *value = strtok_r(NULL, "", &save);
        if (!key) {
            printf("usage: set <key> <value>\n");
            return;
        }
        handle_set(key, value ? value : "");
    } else if (strcmp(command, "render") == 0) {
        s_render_requested = true;
        printf("ok\n");
    } else if (strcmp(command, "buttons") == 0) {
        printf("shift register: 0x%02x\n", pk_shiftreg_read(&pk_config()->pins));
    } else if (strcmp(command, "factory-reset") == 0) {
        pk_config_factory_reset();
        printf("configuration erased\n");
    } else if (strcmp(command, "bootsel") == 0) {
        // Reboot into the UF2 bootloader so reflashing needs no BOOTSEL press.
        printf("rebooting into BOOTSEL mode\n");
        sleep_ms(100);
        reset_usb_boot(0, 0);
    } else {
        printf("commands: status, wifi <ssid> [pass], set <key> <value>, "
               "render, buttons, bootsel, factory-reset\n");
    }
}

bool pk_console_poll(void)
{
    s_render_requested = false;
    for (;;) {
        int c = getchar_timeout_us(0);
        if (c == PICO_ERROR_TIMEOUT) break;
        if (c == '\r' || c == '\n') {
            if (s_line_len > 0) {
                s_line[s_line_len] = '\0';
                s_line_len = 0;
                handle_line(s_line);
                printf("frameos> ");
            }
            continue;
        }
        if (s_line_len + 1 < sizeof(s_line)) {
            s_line[s_line_len++] = (char)c;
        }
    }
    return s_render_requested;
}
