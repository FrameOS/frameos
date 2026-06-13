#include "fos_console.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_console.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"

#include "fos_client.h"
#include "fos_config.h"
#include "fos_ota.h"
#include "fos_wifi.h"
#include "frameos_display.h"
#include "frameos_nim.h"

static const char *TAG = "fos_console";

static int cmd_status(int argc, char **argv)
{
    fos_config_t *config = fos_config();
    char pins[FOS_STR_LEN];
    fos_config_format_pins(&config->pins, pins, sizeof(pins));
    printf("frame_id:    %lu\n", (unsigned long)config->frame_id);
    printf("wifi:        ssid=\"%s\" state=%d ip=%s rssi=%d\n",
           config->wifi_ssid, (int)fos_wifi_state(), fos_wifi_ip(), fos_wifi_rssi());
    printf("backend:     %s\n", config->backend_url[0] ? config->backend_url : "(unset)");
    printf("panel:       %s (%dx%d)\n", config->panel, fos_display_width(), fos_display_height());
    printf("pins:        %s\n", pins);
    printf("render_mode: %s\n", config->render_mode == FOS_RENDER_LOCAL ? "local" : "remote");
    printf("interval:    %lu s, deep_sleep=%d\n",
           (unsigned long)config->interval_sec, (int)config->deep_sleep);
    printf("nim:         %s\n", frameos_nim_info());
    printf("renders:     %lu (last %lld ms)\n",
           (unsigned long)fos_client_render_count(), fos_client_last_render_ms());
    printf("heap:        internal %u free, psram %u free\n",
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    return 0;
}

static int cmd_set(int argc, char **argv)
{
    if (argc < 3) {
        printf("usage: set <wifi_ssid|wifi_pass|backend|api_key|frame_id|panel|render_mode|interval|deep_sleep|pins> <value...>\n");
        return 1;
    }
    fos_config_t *config = fos_config();
    const char *key = argv[1];
    /* join remaining args so values may contain spaces */
    char value[FOS_URL_LEN] = "";
    for (int i = 2; i < argc; i++) {
        if (i > 2) strlcat(value, " ", sizeof(value));
        strlcat(value, argv[i], sizeof(value));
    }

    if (strcmp(key, "wifi_ssid") == 0) strlcpy(config->wifi_ssid, value, sizeof(config->wifi_ssid));
    else if (strcmp(key, "wifi_pass") == 0) strlcpy(config->wifi_pass, value, sizeof(config->wifi_pass));
    else if (strcmp(key, "backend") == 0) strlcpy(config->backend_url, value, sizeof(config->backend_url));
    else if (strcmp(key, "api_key") == 0) strlcpy(config->api_key, value, sizeof(config->api_key));
    else if (strcmp(key, "frame_id") == 0) config->frame_id = strtoul(value, NULL, 10);
    else if (strcmp(key, "panel") == 0) strlcpy(config->panel, value, sizeof(config->panel));
    else if (strcmp(key, "render_mode") == 0)
        config->render_mode = (strcmp(value, "remote") == 0 || strcmp(value, "1") == 0)
            ? FOS_RENDER_REMOTE : FOS_RENDER_LOCAL;
    else if (strcmp(key, "interval") == 0) config->interval_sec = strtoul(value, NULL, 10);
    else if (strcmp(key, "deep_sleep") == 0) config->deep_sleep = atoi(value) != 0;
    else if (strcmp(key, "pins") == 0) {
        if (fos_config_parse_pins(value, &config->pins) != ESP_OK) {
            printf("bad pin spec, want e.g. rst=5,dc=4,cs=3,busy=6,sck=7,mosi=9,pwr=-1\n");
            return 1;
        }
    } else {
        printf("unknown key \"%s\"\n", key);
        return 1;
    }
    fos_config_save();
    printf("ok: %s set (some settings need `restart`)\n", key);
    return 0;
}

static int cmd_wifi(int argc, char **argv)
{
    if (argc < 2) {
        printf("usage: wifi <ssid> [password]\n");
        return 1;
    }
    fos_config_t *config = fos_config();
    strlcpy(config->wifi_ssid, argv[1], sizeof(config->wifi_ssid));
    strlcpy(config->wifi_pass, argc > 2 ? argv[2] : "", sizeof(config->wifi_pass));
    fos_config_save();
    printf("wifi credentials saved, restarting...\n");
    esp_restart();
    return 0;
}

static int cmd_render(int argc, char **argv)
{
    fos_client_render_now();
    printf("render triggered\n");
    return 0;
}

static int cmd_ota(int argc, char **argv)
{
    esp_err_t err = fos_ota_check_and_apply();
    printf("ota: %s\n", esp_err_to_name(err));
    return err == ESP_OK ? 0 : 1;
}

static int cmd_restart(int argc, char **argv)
{
    esp_restart();
    return 0;
}

static int cmd_factory_reset(int argc, char **argv)
{
    fos_config_erase();
    printf("config erased, restarting...\n");
    esp_restart();
    return 0;
}

esp_err_t fos_console_start(void)
{
    esp_console_repl_t *repl = NULL;
    esp_console_repl_config_t repl_config = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    repl_config.prompt = "frameos>";
    repl_config.max_cmdline_length = 512;
    repl_config.task_stack_size = 8192;

    esp_console_dev_usb_serial_jtag_config_t hw_config =
        ESP_CONSOLE_DEV_USB_SERIAL_JTAG_CONFIG_DEFAULT();
    esp_err_t err = esp_console_new_repl_usb_serial_jtag(&hw_config, &repl_config, &repl);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "console init failed: %s", esp_err_to_name(err));
        return err;
    }

    const esp_console_cmd_t commands[] = {
        {.command = "status", .help = "Show device status", .func = cmd_status},
        {.command = "set", .help = "set <key> <value> — persist a config value", .func = cmd_set},
        {.command = "wifi", .help = "wifi <ssid> [pass] — set Wi-Fi and restart", .func = cmd_wifi},
        {.command = "render", .help = "Render now", .func = cmd_render},
        {.command = "ota", .help = "Check for OTA update now", .func = cmd_ota},
        {.command = "restart", .help = "Reboot", .func = cmd_restart},
        {.command = "factory-reset", .help = "Erase config and reboot", .func = cmd_factory_reset},
    };
    for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); i++) {
        ESP_ERROR_CHECK(esp_console_cmd_register(&commands[i]));
    }
    ESP_ERROR_CHECK(esp_console_start_repl(repl));
    return ESP_OK;
}
