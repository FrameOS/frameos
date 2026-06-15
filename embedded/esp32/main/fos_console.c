#include "fos_console.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_console.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "fos_battery.h"
#include "fos_client.h"
#include "fos_config.h"
#include "fos_ota.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "frameos_display.h"
#include "frameos_nim.h"

static const char *TAG = "fos_console";

static const char *auth_mode_name(wifi_auth_mode_t authmode)
{
    switch (authmode) {
        case WIFI_AUTH_OPEN:
            return "open";
        case WIFI_AUTH_WEP:
            return "wep";
        case WIFI_AUTH_WPA_PSK:
            return "wpa";
        case WIFI_AUTH_WPA2_PSK:
            return "wpa2";
        case WIFI_AUTH_WPA_WPA2_PSK:
            return "wpa/wpa2";
        case WIFI_AUTH_WPA3_PSK:
            return "wpa3";
        case WIFI_AUTH_WPA2_WPA3_PSK:
            return "wpa2/wpa3";
        default:
            return "other";
    }
}

static int cmd_status(int argc, char **argv)
{
    fos_config_t *config = fos_config();
    char pins[FOS_STR_LEN];
    fos_config_format_pins(&config->pins, pins, sizeof(pins));
    printf("frame_id:    %lu\n", (unsigned long)config->frame_id);
    printf("wifi:        ssid=\"%s\" state=%d ip=%s rssi=%d\n",
           config->wifi_ssid, (int)fos_wifi_state(), fos_wifi_ip(), fos_wifi_rssi());
    printf("backend:     %s\n", config->backend_url[0] ? config->backend_url : "(unset)");
    printf("https:       %s port=%u cert=%s key=%s\n",
           config->tls_enable ? "enabled" : "disabled",
           (unsigned)config->tls_port,
           config->tls_server_cert[0] ? "yes" : "no",
           config->tls_server_key[0] ? "yes" : "no");
    printf("panel:       %s (%dx%d)\n", config->panel, fos_display_width(), fos_display_height());
    printf("pins:        %s\n", pins);
    printf("render_mode: %s\n", config->render_mode == FOS_RENDER_LOCAL ? "local" : "remote");
    printf("send_logs:   %d\n", (int)config->server_send_logs);
    printf("interval:    %lu s, deep_sleep=%d, wake_schedule=%d\n",
           (unsigned long)config->interval_sec, (int)config->deep_sleep,
           (int)config->wake_schedule);
    if (fos_battery_present()) {
        printf("battery:     %d mV (%d%%) on GPIO %d, divider %.2f\n",
               fos_battery_millivolts(), fos_battery_percent(),
               (int)config->battery_pin, config->battery_divider);
    } else {
        printf("battery:     not configured\n");
    }
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
        printf("usage: set <wifi_ssid|wifi_pass|backend|api_key|frame_id|panel|render_mode|"
               "interval|server_send_logs|deep_sleep|wake_schedule|battery_pin|battery_divider|pins> <value...>\n");
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
    else if (strcmp(key, "server_send_logs") == 0) config->server_send_logs = atoi(value) != 0;
    else if (strcmp(key, "deep_sleep") == 0) config->deep_sleep = atoi(value) != 0;
    else if (strcmp(key, "wake_schedule") == 0) config->wake_schedule = atoi(value) != 0;
    else if (strcmp(key, "battery_pin") == 0) config->battery_pin = (int8_t)atoi(value);
    else if (strcmp(key, "battery_divider") == 0) config->battery_divider = (float)atof(value);
    else if (strcmp(key, "pins") == 0) {
        if (fos_config_parse_pins(value, &config->pins) != ESP_OK) {
            printf("bad pin spec, want e.g. rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1\n");
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

static int cmd_wifi_scan(int argc, char **argv)
{
    wifi_mode_t mode = WIFI_MODE_NULL;
    esp_err_t err = esp_wifi_get_mode(&mode);
    if (err != ESP_OK) {
        printf("wifi-scan: get mode failed: %s\n", esp_err_to_name(err));
        return 1;
    }
    if (mode == WIFI_MODE_AP) {
        fos_wifi_set_scan_only(true);
        err = esp_wifi_set_mode(WIFI_MODE_APSTA);
        if (err != ESP_OK) {
            fos_wifi_set_scan_only(false);
            printf("wifi-scan: switch to APSTA failed: %s\n", esp_err_to_name(err));
            return 1;
        }
        vTaskDelay(pdMS_TO_TICKS(200));
    }
    esp_wifi_disconnect();
    vTaskDelay(pdMS_TO_TICKS(200));

    wifi_scan_config_t scan_config = {
        .show_hidden = true,
    };
    printf("wifi-scan: scanning...\n");
    err = esp_wifi_scan_start(&scan_config, true);
    fos_wifi_set_scan_only(false);
    if (err != ESP_OK) {
        printf("wifi-scan: scan failed: %s\n", esp_err_to_name(err));
        return 1;
    }

    uint16_t total = 0;
    esp_wifi_scan_get_ap_num(&total);
    uint16_t count = total > 20 ? 20 : total;
    wifi_ap_record_t records[20] = {0};
    err = esp_wifi_scan_get_ap_records(&count, records);
    if (err != ESP_OK) {
        esp_wifi_clear_ap_list();
        printf("wifi-scan: read results failed: %s\n", esp_err_to_name(err));
        return 1;
    }

    printf("wifi-scan: %u APs found", (unsigned)total);
    if (total > count) printf(" (showing strongest %u)", (unsigned)count);
    printf("\n");
    for (uint16_t i = 0; i < count; i++) {
        printf("%2u: ch=%2u rssi=%4d auth=%-9s ssid=\"%s\"\n",
               (unsigned)(i + 1),
               (unsigned)records[i].primary,
               (int)records[i].rssi,
               auth_mode_name(records[i].authmode),
               (char *)records[i].ssid);
    }
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
    esp_err_t err = fos_ota_request_check();
    printf("ota: %s\n", esp_err_to_name(err));
    return err == ESP_OK ? 0 : 1;
}

static int cmd_scenes(int argc, char **argv)
{
    printf("scenes: %d loaded, etag %s\n", fos_scenes_loaded(),
           fos_scenes_etag()[0] ? fos_scenes_etag() : "none");
    printf("%s\n", frameos_nim_scene_info_json());
    fos_scenes_request_sync();
    fos_client_render_now();
    printf("sync requested; the render task pulls from the backend next pass\n");
    return 0;
}

static int cmd_scene_state(int argc, char **argv)
{
    printf("%s\n", frameos_nim_scene_state_json());
    return 0;
}

static int cmd_scene(int argc, char **argv)
{
    if (argc < 2) {
        printf("usage: scene <scene-id>\n");
        printf("%s\n", frameos_nim_scene_info_json());
        return 1;
    }
    esp_err_t err = fos_scenes_select(argv[1]);
    if (err != ESP_OK) {
        printf("scene select failed: %s\n", esp_err_to_name(err));
        return 1;
    }
    fos_client_render_now();
    printf("scene queued: %s\n", argv[1]);
    return 0;
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

    esp_err_t err = ESP_OK;
#if CONFIG_ESP_CONSOLE_UART
    esp_console_dev_uart_config_t hw_config = ESP_CONSOLE_DEV_UART_CONFIG_DEFAULT();
    err = esp_console_new_repl_uart(&hw_config, &repl_config, &repl);
#elif CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
    esp_console_dev_usb_serial_jtag_config_t hw_config =
        ESP_CONSOLE_DEV_USB_SERIAL_JTAG_CONFIG_DEFAULT();
    err = esp_console_new_repl_usb_serial_jtag(&hw_config, &repl_config, &repl);
#else
    err = ESP_ERR_NOT_SUPPORTED;
#endif
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "console init failed: %s", esp_err_to_name(err));
        return err;
    }

    const esp_console_cmd_t commands[] = {
        {.command = "status", .help = "Show device status", .func = cmd_status},
        {.command = "set", .help = "set <key> <value> — persist a config value", .func = cmd_set},
        {.command = "wifi", .help = "wifi <ssid> [pass] — set Wi-Fi and restart", .func = cmd_wifi},
        {.command = "wifi-scan", .help = "Scan visible Wi-Fi networks", .func = cmd_wifi_scan},
        {.command = "render", .help = "Render now", .func = cmd_render},
        {.command = "ota", .help = "Check for OTA update now", .func = cmd_ota},
        {.command = "scenes", .help = "Show loaded scenes + sync from backend", .func = cmd_scenes},
        {.command = "scene_state", .help = "Show current interpreted scene state JSON", .func = cmd_scene_state},
        {.command = "scene", .help = "scene <id> — select a loaded scene and render", .func = cmd_scene},
        {.command = "restart", .help = "Reboot", .func = cmd_restart},
        {.command = "factory-reset", .help = "Erase config and reboot", .func = cmd_factory_reset},
    };
    for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); i++) {
        ESP_ERROR_CHECK(esp_console_cmd_register(&commands[i]));
    }
    ESP_ERROR_CHECK(esp_console_start_repl(repl));
    return ESP_OK;
}
