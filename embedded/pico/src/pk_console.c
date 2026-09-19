#include "pk_console.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pico/bootrom.h"
#include "pico/stdlib.h"

#include "pk_args.h"
#include "pk_config.h"
#include "pk_config_keys.h"
#include "pk_display.h"
#include "pk_json.h"
#include "pk_log.h"
#include "pk_platform.h"
#include "pk_render.h"
#include "pk_shiftreg.h"
#include "pk_status.h"
#include "pk_wifi.h"

#define PK_CONSOLE_LINE_MAX 512
#define PK_CONSOLE_MAX_ARGS 8

#define USB_API_OK "__FRAMEOS_USB_OK__"
#define USB_API_ERROR "__FRAMEOS_USB_ERROR__"
#define USB_API_BEGIN "__FRAMEOS_USB_BEGIN__"
#define USB_API_END "__FRAMEOS_USB_END__"

static char s_line[PK_CONSOLE_LINE_MAX];
static size_t s_line_len = 0;
static bool s_line_overflow = false;
static bool s_render_requested = false;
static uint32_t s_last_activity_ms = 0;

void pk_console_print_line(const char *line)
{
    printf("%s\n", line);
}

bool pk_console_take_render_request(void)
{
    bool requested = s_render_requested;
    s_render_requested = false;
    return requested;
}

uint32_t pk_console_last_activity_ms(void)
{
    return s_last_activity_ms;
}

// ------------------------------------------------------------- shared verbs

// argv[first..] joined with single spaces: a value typed without quotes.
static void join_args(char **argv, int first, int argc, char *dst, size_t cap)
{
    size_t len = 0;
    dst[0] = '\0';
    for (int i = first; i < argc && len + 1 < cap; i++) {
        len += (size_t)snprintf(dst + len, cap - len, "%s%s", i > first ? " " : "", argv[i]);
    }
}

static pk_set_result_t run_set(const char *key, const char *value, char *message, size_t message_cap)
{
    pk_set_result_t result =
        pk_config_set(pk_config(), key, value, pk_display_panel_known, message, message_cap);
    if (result == PK_SET_OK && !pk_config_save()) {
        snprintf(message, message_cap, "could not write the settings to flash");
        return PK_SET_INVALID;
    }
    return result;
}

static void store_wifi(const char *ssid, const char *password)
{
    pk_config_t *config = pk_config();
    snprintf(config->wifi_ssid, sizeof(config->wifi_ssid), "%s", ssid);
    snprintf(config->wifi_pass, sizeof(config->wifi_pass), "%s", password ? password : "");
    pk_config_save();
}

static const char *auth_name(uint8_t auth)
{
    if (auth == 0) return "open";
    if (auth & 4) return "wpa2";
    if (auth & 2) return "wpa";
    return "wep";
}

static void reboot_to_bootsel(void)
{
    stdio_flush();
    sleep_ms(100);
    reset_usb_boot(0, 0);
}

// ------------------------------------------------------------------ usb_api

static void usb_ok(const char *name)
{
    printf("%s %s\n", USB_API_OK, name);
    stdio_flush();
}

static void usb_error(const char *name, const char *code, const char *message)
{
    printf("%s %s %s %s\n", USB_API_ERROR, name, code, message ? message : "");
    stdio_flush();
}

static void usb_payload(const char *name, const char *text, size_t len)
{
    printf("%s %s %u text\n", USB_API_BEGIN, name, (unsigned)len);
    if (len > 0) fwrite(text, 1, len, stdout);
    printf("\n%s %s\n", USB_API_END, name);
    stdio_flush();
}

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} text_buffer_t;

static void text_append(void *arg, const char *data, size_t len)
{
    text_buffer_t *buffer = arg;
    if (buffer->len + len > buffer->cap) return;
    memcpy(buffer->data + buffer->len, data, len);
    buffer->len += len;
}

static void usb_wifi_scan(void)
{
    size_t count = 0;
    const pk_wifi_network_t *networks = pk_wifi_scan(&count);
    // An SSID is 32 bytes of whatever a stranger's radio sends; every one of
    // them can escape to six characters.
    size_t cap = 64 + count * (64 + 32 * 6);
    char *json = malloc(cap);
    if (json == NULL) {
        usb_error("wifi-scan", "ESP_ERR_NO_MEM", "out of memory");
        return;
    }
    size_t len = (size_t)snprintf(json, cap, "{\"networks\":[");
    for (size_t i = 0; i < count; i++) {
        char ssid[33 * 6];
        pk_json_escape(networks[i].ssid, ssid, sizeof(ssid));
        len += (size_t)snprintf(json + len, cap - len,
                                "%s{\"ssid\":\"%s\",\"rssi\":%d,\"channel\":%u,\"auth\":\"%s\"}",
                                i ? "," : "", ssid, networks[i].rssi, networks[i].channel,
                                auth_name(networks[i].auth));
    }
    len += (size_t)snprintf(json + len, cap - len, "],\"total\":%u}", (unsigned)count);
    usb_payload("wifi-scan", json, len);
    free(json);
}

static void handle_usb_api(int argc, char **argv)
{
    if (argc < 2) {
        usb_error("usb_api", "ESP_ERR_INVALID_ARG", "usage: usb_api <command>");
        return;
    }
    const char *name = argv[1];
    if (strcmp(name, "status") == 0) {
        static char json[PK_STATUS_JSON_MAX];
        size_t len = pk_status_json(json, sizeof(json));
        if (len == 0) usb_error(name, "ESP_ERR_NO_MEM", "status too large");
        else usb_payload(name, json, len);
    } else if (strcmp(name, "set") == 0) {
        if (argc < 4) {
            usb_error(name, "ESP_ERR_INVALID_ARG", "usage: usb_api set <key> <value>");
            return;
        }
        char value[PK_CONSOLE_LINE_MAX];
        char message[128];
        join_args(argv, 3, argc, value, sizeof(value));
        pk_set_result_t result = run_set(argv[2], value, message, sizeof(message));
        if (result == PK_SET_OK || result == PK_SET_IGNORED) usb_ok(name);
        else usb_error(name, result == PK_SET_UNKNOWN_KEY ? "ESP_ERR_NOT_FOUND" : "ESP_ERR_INVALID_ARG", message);
    } else if (strcmp(name, "wifi") == 0) {
        if (argc < 3) {
            usb_error(name, "ESP_ERR_INVALID_ARG", "usage: usb_api wifi <ssid> [password]");
            return;
        }
        store_wifi(argv[2], argc > 3 ? argv[3] : "");
        usb_ok(name);
        pk_reboot();
    } else if (strcmp(name, "wifi-scan") == 0) {
        if (pk_render_stats()->busy) usb_error(name, "ESP_ERR_INVALID_STATE", "busy rendering, try again");
        else usb_wifi_scan();
    } else if (strcmp(name, "render") == 0 || strcmp(name, "reload") == 0) {
        s_render_requested = true;
        usb_ok(name);
    } else if (strcmp(name, "logs") == 0) {
        text_buffer_t logs = {.data = malloc(PK_LOG_SLOTS * (PK_LOG_LINE_MAX + 16)), .len = 0,
                              .cap = PK_LOG_SLOTS * (PK_LOG_LINE_MAX + 16)};
        if (logs.data == NULL) {
            usb_error(name, "ESP_ERR_NO_MEM", "out of memory");
            return;
        }
        pk_log_dump(text_append, &logs);
        // The payload is framed by its own newline; drop the ring's last one.
        if (logs.len > 0 && logs.data[logs.len - 1] == '\n') logs.len--;
        usb_payload(name, logs.data, logs.len);
        free(logs.data);
    } else if (strcmp(name, "restart") == 0) {
        usb_ok(name);
        pk_reboot();
    } else if (strcmp(name, "factory-reset") == 0) {
        pk_config_factory_reset();
        usb_ok(name);
        pk_reboot();
    } else if (strcmp(name, "bootsel") == 0) {
        // The Pico's firmware update: the board comes back as a USB drive
        // (RPI-RP2 / RP2350) that takes the next .uf2.
        usb_ok(name);
        reboot_to_bootsel();
    } else {
        // image, scenes, OTA, assets, SD: all need an on-device renderer or
        // storage this board does not have.
        usb_error(name, "ESP_ERR_NOT_SUPPORTED", "not available on the Pico thin client");
    }
}

// ----------------------------------------------------------- human console

static void print_status(void)
{
    pk_config_t *config = pk_config();
    const pk_render_stats_t *render = pk_render_stats();
    char pins[160];
    pk_config_format_pins(&config->pins, pins, sizeof(pins));
    printf("frameos-pico %s (%s)\n", FRAMEOS_VERSION, pk_platform_name());
    if (pk_wifi_portal_active()) {
        printf("wifi:     setup hotspot \"%s\" password %s, http://%s/\n", pk_wifi_portal_ssid(),
               pk_wifi_portal_psk(), pk_wifi_ip());
    } else {
        printf("wifi:     %s%s%s\n", config->wifi_ssid[0] ? config->wifi_ssid : "(unset)",
               pk_wifi_connected() ? " connected, ip " : "", pk_wifi_connected() ? pk_wifi_ip() : "");
    }
    printf("hostname: %s.local\n", config->hostname);
    printf("backend:  %s\n", config->backend_url[0] ? config->backend_url : "(unset)");
    printf("frame_id: %lu\n", (unsigned long)config->frame_id);
    printf("api_key:  %s\n", config->api_key[0] ? "(set)" : "(unset)");
    printf("panel:    %s\n", config->panel[0] ? config->panel : "(unset)");
    printf("hardware: %s\n", config->hardware_preset[0] ? config->hardware_preset : "custom");
    printf("pins:     %s\n", pins);
    printf("interval: %lus, deep sleep: %s\n", (unsigned long)config->interval_seconds,
           config->deep_sleep ? "always" : config->deep_sleep_on_battery ? "on battery" : "off");
    printf("power:    %s\n", pk_usb_powered() ? "USB" : "battery");
    printf("login:    %s\n", config->admin_auth ? "enabled" : "off");
    printf("renders:  %lu%s%s\n", (unsigned long)render->count, render->last_error[0] ? ", last error: " : "",
           render->last_error);
    printf("heap:     %lu bytes free\n", (unsigned long)pk_free_heap());
}

static void log_line_to_stdout(void *arg, const char *data, size_t len)
{
    (void)arg;
    fwrite(data, 1, len, stdout);
}

static void handle_line(char *line)
{
    char *argv[PK_CONSOLE_MAX_ARGS];
    int argc = pk_args_split(line, argv, PK_CONSOLE_MAX_ARGS);
    if (argc < 0) {
        printf("error: unterminated quote\n");
        return;
    }
    if (argc == 0) return;
    const char *command = argv[0];

    if (strcmp(command, "usb_api") == 0) {
        handle_usb_api(argc, argv);
        return;
    }
    if (strcmp(command, "status") == 0) {
        print_status();
    } else if (strcmp(command, "wifi") == 0) {
        if (argc < 2) {
            printf("usage: wifi <ssid> [password]   (quote a name with spaces: wifi \"My Network\" pass)\n");
            return;
        }
        store_wifi(argv[1], argc > 2 ? argv[2] : "");
        printf("ok, rebooting to connect\n");
        pk_reboot();
    } else if (strcmp(command, "wifi-scan") == 0 && pk_render_stats()->busy) {
        printf("busy rendering, try again\n");
    } else if (strcmp(command, "wifi-scan") == 0) {
        size_t count = 0;
        const pk_wifi_network_t *networks = pk_wifi_scan(&count);
        for (size_t i = 0; i < count; i++) {
            printf("%4d dBm  ch %-2u  %-4s  %s\n", networks[i].rssi, networks[i].channel,
                   auth_name(networks[i].auth), networks[i].ssid);
        }
        printf("%u network(s)\n", (unsigned)count);
    } else if (strcmp(command, "set") == 0) {
        if (argc < 3) {
            printf("usage: set <key> <value>\n");
            return;
        }
        char value[PK_CONSOLE_LINE_MAX];
        char message[128];
        join_args(argv, 2, argc, value, sizeof(value));
        pk_set_result_t result = run_set(argv[1], value, message, sizeof(message));
        printf("%s%s\n", result == PK_SET_OK || result == PK_SET_IGNORED ? "" : "error: ", message);
    } else if (strcmp(command, "render") == 0) {
        s_render_requested = true;
        printf("ok\n");
    } else if (strcmp(command, "logs") == 0) {
        pk_log_dump(log_line_to_stdout, NULL);
    } else if (strcmp(command, "buttons") == 0) {
        printf("shift register: 0x%02x\n", pk_shiftreg_read(&pk_config()->pins));
    } else if (strcmp(command, "restart") == 0) {
        printf("restarting\n");
        pk_reboot();
    } else if (strcmp(command, "factory-reset") == 0) {
        pk_config_factory_reset();
        printf("configuration erased, restarting\n");
        pk_reboot();
    } else if (strcmp(command, "bootsel") == 0) {
        // Reboot into the UF2 bootloader so reflashing needs no BOOTSEL press.
        printf("rebooting into BOOTSEL mode\n");
        reboot_to_bootsel();
    } else {
        printf("commands: status, wifi <ssid> [pass], wifi-scan, set <key> <value>, render, logs, "
               "buttons, restart, bootsel, factory-reset\n");
    }
    printf("frameos> ");
    stdio_flush();
}

void pk_console_poll(void)
{
    for (;;) {
        int c = getchar_timeout_us(0);
        if (c == PICO_ERROR_TIMEOUT) break;
        if (c == '\r' || c == '\n') {
            if (s_line_overflow) {
                printf("error: line too long\n");
            } else if (s_line_len > 0) {
                s_line[s_line_len] = '\0';
                s_last_activity_ms = to_ms_since_boot(get_absolute_time());
                if (s_last_activity_ms == 0) s_last_activity_ms = 1;
                s_line_len = 0;
                handle_line(s_line);
            }
            s_line_len = 0;
            s_line_overflow = false;
            continue;
        }
        if (s_line_len + 1 < sizeof(s_line)) {
            s_line[s_line_len++] = (char)c;
        } else {
            s_line_overflow = true;
        }
    }
}
