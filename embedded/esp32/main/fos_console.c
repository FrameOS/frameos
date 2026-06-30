#include "fos_console.h"

#include <ctype.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
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
#include "fos_http.h"
#include "fos_ota.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "frameos_display.h"
#include "frameos_nim.h"

static const char *TAG = "fos_console";

#define FOS_USB_API_MAX_UPLOAD (512 * 1024)
#define FOS_USB_API_MAX_SCENE_ID 256
#define FOS_USB_API_RAW_CHUNK 384
#define FOS_USB_API_PAYLOAD_TIMEOUT_MS 180000
#define FOS_CONSOLE_MAX_CMDLINE_LENGTH 512
#define FOS_CONSOLE_TASK_STACK_SIZE 8192

static const char *USB_API_OK = "__FRAMEOS_USB_OK__";
static const char *USB_API_ERROR = "__FRAMEOS_USB_ERROR__";
static const char *USB_API_READY = "__FRAMEOS_USB_READY__";
static const char *USB_API_BEGIN = "__FRAMEOS_USB_BEGIN__";
static const char *USB_API_END = "__FRAMEOS_USB_END__";

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
    char sd_pins[FOS_STR_LEN];
    fos_config_format_pins(&config->pins, pins, sizeof(pins));
    fos_config_format_assets_sd_pins(&config->assets_sd, sd_pins, sizeof(sd_pins));
    printf("frame_id:    %lu\n", (unsigned long)config->frame_id);
    printf("wifi:        ssid=\"%s\" state=%d ip=%s rssi=%d\n",
           config->wifi_ssid, (int)fos_wifi_state(), fos_wifi_ip(), fos_wifi_rssi());
    printf("backend:     %s\n", config->backend_url[0] ? config->backend_url : "(unset)");
    printf("https:       %s port=%u cert=%s key=%s\n",
           config->tls_enable ? "enabled" : "disabled",
           (unsigned)config->tls_port,
           config->tls_server_cert[0] ? "yes" : "no",
           config->tls_server_key[0] ? "yes" : "no");
    printf("admin_auth:  %s user=%s\n",
           (config->admin_auth_enabled && config->admin_user[0] && config->admin_pass[0]) ? "enabled" : "disabled",
           config->admin_user[0] ? config->admin_user : "(unset)");
    printf("hardware:    %s\n", config->hardware_preset[0] ? config->hardware_preset : "(custom)");
    printf("panel:       %s (%dx%d)\n", config->panel, fos_display_width(), fos_display_height());
    printf("pins:        %s\n", pins);
    printf("render_mode: %s\n", config->render_mode == FOS_RENDER_LOCAL ? "local" : "remote");
    printf("send_logs:   %d\n", (int)config->server_send_logs);
    printf("assets:      path=%s sd=%d pins=%s freq=%lu kHz\n",
           config->assets_path, (int)config->assets_sd.enabled, sd_pins,
           (unsigned long)config->assets_sd.max_freq_khz);
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
        printf("usage: set <wifi_ssid|wifi_pass|backend|api_key|frame_id|hardware|panel|render_mode|"
               "interval|server_send_logs|assets_path|assets_sd|assets_sd_pins|assets_sd_freq|"
               "deep_sleep|wake_schedule|battery_pin|battery_divider|pins> <value...>\n");
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
    else if (strcmp(key, "hardware") == 0 || strcmp(key, "hardware_preset") == 0)
        strlcpy(config->hardware_preset, value, sizeof(config->hardware_preset));
    else if (strcmp(key, "panel") == 0) strlcpy(config->panel, value, sizeof(config->panel));
    else if (strcmp(key, "render_mode") == 0)
        config->render_mode = (strcmp(value, "remote") == 0 || strcmp(value, "1") == 0)
            ? FOS_RENDER_REMOTE : FOS_RENDER_LOCAL;
    else if (strcmp(key, "interval") == 0) config->interval_sec = strtoul(value, NULL, 10);
    else if (strcmp(key, "server_send_logs") == 0) config->server_send_logs = atoi(value) != 0;
    else if (strcmp(key, "assets_path") == 0) strlcpy(config->assets_path, value, sizeof(config->assets_path));
    else if (strcmp(key, "assets_sd") == 0) config->assets_sd.enabled = atoi(value) != 0;
    else if (strcmp(key, "assets_sd_freq") == 0) config->assets_sd.max_freq_khz = strtoul(value, NULL, 10);
    else if (strcmp(key, "assets_sd_pins") == 0) {
        if (fos_config_parse_assets_sd_pins(value, &config->assets_sd) != ESP_OK) {
            printf("bad SD pin spec, want e.g. cs=38,sck=39,miso=40,mosi=41\n");
            return 1;
        }
    }
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

static void display_test_set_4bpp(uint8_t *buf, int width, int x, int y, uint8_t color)
{
    size_t row_bytes = ((size_t)width + 1u) / 2u;
    size_t offset = (size_t)y * row_bytes + (size_t)x / 2u;
    if ((x & 1) == 0) {
        buf[offset] = (uint8_t)((buf[offset] & 0x0F) | ((color & 0x0F) << 4));
    } else {
        buf[offset] = (uint8_t)((buf[offset] & 0xF0) | (color & 0x0F));
    }
}

static uint8_t display_test_color_4bpp(const char *name)
{
    if (strcmp(name, "black") == 0) return 0x0;
    if (strcmp(name, "yellow") == 0) return 0x2;
    if (strcmp(name, "red") == 0) return 0x3;
    if (strcmp(name, "blue") == 0) return 0x5;
    if (strcmp(name, "green") == 0) return 0x6;
    return 0x1; /* white */
}

static int cmd_display_test(int argc, char **argv)
{
    const char *mode = argc >= 2 ? argv[1] : "bands";
    int width = fos_display_width();
    int height = fos_display_height();
    fos_pixel_format_t format = fos_display_format();
    size_t len = fos_display_buffer_size();
    if (!fos_display_present() || width <= 0 || height <= 0 || len == 0) {
        printf("display_test: no display configured\n");
        return 1;
    }

    uint8_t *buf = heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!buf) buf = malloc(len);
    if (!buf) {
        printf("display_test: allocation failed (%u bytes)\n", (unsigned)len);
        return 1;
    }

    if (format == FOS_PIXEL_4BPP_SPECTRA6 || format == FOS_PIXEL_4BPP_7COLOR ||
        format == FOS_PIXEL_4BPP_GRAY) {
        memset(buf, 0x11, len);
        if (strcmp(mode, "bands") == 0) {
            static const uint8_t colors[] = {0x0, 0x3, 0x6, 0x5, 0x2, 0x1};
            int color_count = (int)(sizeof(colors) / sizeof(colors[0]));
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    int band = (x * color_count) / width;
                    if (band < 0) band = 0;
                    if (band >= color_count) band = color_count - 1;
                    display_test_set_4bpp(buf, width, x, y, colors[band]);
                }
            }
        } else {
            uint8_t color = display_test_color_4bpp(mode);
            uint8_t packed = (uint8_t)((color << 4) | color);
            memset(buf, packed, len);
        }
    } else {
        memset(buf, 0x00, len);
    }

    printf("display_test: mode=%s panel=%s %dx%d format=%d bytes=%u\n",
           mode, fos_display_panel_name(0), width, height, (int)format, (unsigned)len);
    esp_err_t err = fos_display_blit(buf, len);
    free(buf);
    printf("display_test: %s (%d)\n", err == ESP_OK ? "ESP_OK" : esp_err_to_name(err), (int)err);
    return err == ESP_OK ? 0 : 1;
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

static void usb_api_ok(const char *name)
{
    printf("%s %s\n", USB_API_OK, name);
    fflush(stdout);
}

static void usb_api_error(const char *name, esp_err_t err, const char *message)
{
    printf("%s %s %s %s\n", USB_API_ERROR, name, esp_err_to_name(err), message ? message : "");
    fflush(stdout);
}

static void usb_api_ready(const char *name)
{
    printf("%s %s\n", USB_API_READY, name);
    fflush(stdout);
}

static bool usb_api_read_exact(uint8_t *buf, size_t len, TickType_t timeout_ticks)
{
    size_t off = 0;
    TickType_t start = xTaskGetTickCount();
    while (off < len) {
        int ch = fgetc(stdin);
        if (ch == EOF) {
            if ((xTaskGetTickCount() - start) >= timeout_ticks) {
                return false;
            }
            vTaskDelay(pdMS_TO_TICKS(1));
            continue;
        }
        buf[off++] = (uint8_t)ch;
    }
    return true;
}

static void usb_api_payload_text(const char *name, const char *text)
{
    size_t len = text ? strlen(text) : 0;
    printf("%s %s %u text\n", USB_API_BEGIN, name, (unsigned)len);
    if (len > 0) {
        fwrite(text, 1, len, stdout);
    }
    printf("\n%s %s\n", USB_API_END, name);
    fflush(stdout);
}

static size_t usb_api_base64_encode(const uint8_t *src, size_t len, char *dst)
{
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t out = 0;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = (uint32_t)src[i] << 16;
        bool has_b = i + 1 < len;
        bool has_c = i + 2 < len;
        if (has_b) v |= (uint32_t)src[i + 1] << 8;
        if (has_c) v |= src[i + 2];
        dst[out++] = alphabet[(v >> 18) & 0x3F];
        dst[out++] = alphabet[(v >> 12) & 0x3F];
        dst[out++] = has_b ? alphabet[(v >> 6) & 0x3F] : '=';
        dst[out++] = has_c ? alphabet[v & 0x3F] : '=';
    }
    dst[out] = '\0';
    return out;
}

static void usb_api_payload_base64(const char *name, const uint8_t *data, size_t len,
                                   const char *metadata)
{
    char encoded[((FOS_USB_API_RAW_CHUNK + 2) / 3) * 4 + 1];
    printf("%s %s %u base64%s%s\n", USB_API_BEGIN, name, (unsigned)len,
           metadata && metadata[0] ? " " : "", metadata && metadata[0] ? metadata : "");
    for (size_t off = 0; off < len; off += FOS_USB_API_RAW_CHUNK) {
        size_t chunk = len - off;
        if (chunk > FOS_USB_API_RAW_CHUNK) chunk = FOS_USB_API_RAW_CHUNK;
        size_t encoded_len = usb_api_base64_encode(data + off, chunk, encoded);
        fwrite(encoded, 1, encoded_len, stdout);
        fputc('\n', stdout);
    }
    printf("%s %s\n", USB_API_END, name);
    fflush(stdout);
}

static int cmd_usb_api(int argc, char **argv)
{
    if (argc < 2) {
        printf("usage: usb_api <status|image|render|reload|scenes-sync|upload-scenes|scene|scene-payload|ota|scene-state> ...\n");
        return 1;
    }

    const char *subcommand = argv[1];
    if (strcmp(subcommand, "status") == 0) {
        char *json = fos_http_status_json();
        if (!json) {
            usb_api_error(subcommand, ESP_ERR_NO_MEM, "status json allocation failed");
            return 1;
        }
        usb_api_payload_text(subcommand, json);
        free(json);
        return 0;
    }

    if (strcmp(subcommand, "scene-state") == 0) {
        usb_api_payload_text(subcommand, frameos_nim_scene_state_json());
        return 0;
    }

    if (strcmp(subcommand, "image") == 0) {
        uint8_t *bmp = NULL;
        size_t bmp_len = 0;
        char scene_id[128];
        scene_id[0] = '\0';
        esp_err_t err = fos_http_preview_bmp_alloc(&bmp, &bmp_len, scene_id, sizeof(scene_id));
        if (err != ESP_OK) {
            usb_api_error(subcommand, err, err == ESP_ERR_NOT_FOUND ? "no preview rendered yet" : "image unavailable");
            return 1;
        }
        char metadata[160];
        snprintf(metadata, sizeof(metadata), "scene=%s", scene_id);
        usb_api_payload_base64(subcommand, bmp, bmp_len, metadata);
        free(bmp);
        return 0;
    }

    if (strcmp(subcommand, "render") == 0) {
        fos_client_render_now();
        usb_api_ok(subcommand);
        return 0;
    }

    if (strcmp(subcommand, "reload") == 0 || strcmp(subcommand, "scenes-sync") == 0) {
        fos_scenes_request_sync();
        fos_client_render_now();
        usb_api_ok(subcommand);
        return 0;
    }

    if (strcmp(subcommand, "ota") == 0) {
        esp_err_t err = fos_ota_request_check();
        if (err == ESP_OK) {
            usb_api_ok(subcommand);
            return 0;
        }
        usb_api_error(subcommand, err, "ota request failed");
        return 1;
    }

    if (strcmp(subcommand, "scene") == 0) {
        if (argc < 3) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "missing scene id");
            return 1;
        }
        esp_err_t err = fos_scenes_select(argv[2]);
        if (err != ESP_OK) {
            usb_api_error(subcommand, err, "scene select failed");
            return 1;
        }
        fos_client_render_now();
        usb_api_ok(subcommand);
        return 0;
    }

    if (strcmp(subcommand, "scene-payload") == 0) {
        if (argc < 3) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "missing byte length");
            return 1;
        }
        size_t len = (size_t)strtoul(argv[2], NULL, 10);
        if (len == 0 || len >= FOS_USB_API_MAX_SCENE_ID) {
            usb_api_error(subcommand, ESP_ERR_INVALID_SIZE, "bad scene id length");
            return 1;
        }
        char scene_id[FOS_USB_API_MAX_SCENE_ID];
        usb_api_ready(subcommand);
        if (!usb_api_read_exact((uint8_t *)scene_id, len, pdMS_TO_TICKS(FOS_USB_API_PAYLOAD_TIMEOUT_MS))) {
            usb_api_error(subcommand, ESP_ERR_TIMEOUT, "payload read timed out");
            return 1;
        }
        scene_id[len] = '\0';
        esp_err_t err = fos_scenes_select(scene_id);
        if (err != ESP_OK) {
            usb_api_error(subcommand, err, "scene select failed");
            return 1;
        }
        fos_client_render_now();
        usb_api_ok(subcommand);
        return 0;
    }

    if (strcmp(subcommand, "upload-scenes") == 0) {
        if (argc < 3) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "missing byte length");
            return 1;
        }
        size_t len = (size_t)strtoul(argv[2], NULL, 10);
        if (len == 0 || len > FOS_USB_API_MAX_UPLOAD) {
            usb_api_error(subcommand, ESP_ERR_INVALID_SIZE, "bad upload length");
            return 1;
        }
        uint8_t *body = heap_caps_malloc(len + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!body) body = malloc(len + 1);
        if (!body) {
            usb_api_error(subcommand, ESP_ERR_NO_MEM, "upload allocation failed");
            return 1;
        }
        usb_api_ready(subcommand);
        if (!usb_api_read_exact(body, len, pdMS_TO_TICKS(FOS_USB_API_PAYLOAD_TIMEOUT_MS))) {
            free(body);
            usb_api_error(subcommand, ESP_ERR_TIMEOUT, "payload read timed out");
            return 1;
        }
        body[len] = '\0';
        esp_err_t err = fos_http_store_uploaded_scenes_payload((const char *)body, len);
        free(body);
        if (err != ESP_OK) {
            const char *detail = fos_scenes_last_error();
            usb_api_error(subcommand, err, (detail && detail[0]) ? detail : "scene upload failed");
            return 1;
        }
        fos_client_render_now();
        usb_api_ok(subcommand);
        return 0;
    }

    usb_api_error(subcommand, ESP_ERR_NOT_SUPPORTED, "unknown subcommand");
    return 1;
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

static esp_err_t register_frameos_console_commands(void)
{
    const esp_console_cmd_t commands[] = {
        {.command = "status", .help = "Show device status", .func = cmd_status},
        {.command = "set", .help = "set <key> <value> — persist a config value", .func = cmd_set},
        {.command = "wifi", .help = "wifi <ssid> [pass] — set Wi-Fi and restart", .func = cmd_wifi},
        {.command = "wifi-scan", .help = "Scan visible Wi-Fi networks", .func = cmd_wifi_scan},
        {.command = "render", .help = "Render now", .func = cmd_render},
        {.command = "display_test", .help = "display_test [bands|black|white|red|green|blue|yellow] — draw direct panel test", .func = cmd_display_test},
        {.command = "ota", .help = "Check for OTA update now", .func = cmd_ota},
        {.command = "scenes", .help = "Show loaded scenes + sync from backend", .func = cmd_scenes},
        {.command = "scene_state", .help = "Show current interpreted scene state JSON", .func = cmd_scene_state},
        {.command = "scene", .help = "scene <id> — select a loaded scene and render", .func = cmd_scene},
        {.command = "usb_api", .help = "USB API bridge for the browser", .func = cmd_usb_api},
        {.command = "restart", .help = "Reboot", .func = cmd_restart},
        {.command = "factory-reset", .help = "Erase config and reboot", .func = cmd_factory_reset},
    };
    for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); i++) {
        ESP_ERROR_CHECK(esp_console_cmd_register(&commands[i]));
    }
    return ESP_OK;
}

#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
static void console_prompt(void)
{
    printf("frameos>");
    fflush(stdout);
}

static void run_console_line(char *line)
{
    char *start = line;
    while (*start && isspace((unsigned char)*start)) start++;
    if (!*start) return;

    int cmd_ret = 0;
    esp_err_t err = esp_console_run(start, &cmd_ret);
    if (err == ESP_ERR_NOT_FOUND) {
        printf("unknown command: %s\n", start);
    } else if (err == ESP_ERR_INVALID_ARG) {
        /* Empty/whitespace lines are filtered above; treat the rest as parse errors. */
        printf("invalid command: %s\n", start);
    } else if (err != ESP_OK) {
        printf("command failed: %s\n", esp_err_to_name(err));
    } else if (cmd_ret != 0 && strncmp(start, "usb_api", 7) != 0) {
        printf("command returned %d\n", cmd_ret);
    }
    fflush(stdout);
}

static void fos_console_usb_task(void *arg)
{
    (void)arg;
    char line[FOS_CONSOLE_MAX_CMDLINE_LENGTH];
    size_t len = 0;

    console_prompt();
    while (true) {
        int ch = fgetc(stdin);
        if (ch == EOF) {
            vTaskDelay(pdMS_TO_TICKS(1));
            continue;
        }

        if (ch == '\r' || ch == '\n') {
            line[len] = '\0';
            run_console_line(line);
            len = 0;
            console_prompt();
            continue;
        }

        if (ch == 0x08 || ch == 0x7f) {
            if (len > 0) len--;
            continue;
        }

        if (len < sizeof(line) - 1) {
            line[len++] = (char)ch;
        } else {
            line[sizeof(line) - 1] = '\0';
            printf("command too long\n");
            len = 0;
            console_prompt();
        }
    }
}

static esp_err_t fos_console_start_usb_serial_jtag(void)
{
    usb_serial_jtag_vfs_set_rx_line_endings(ESP_LINE_ENDINGS_CRLF);
    usb_serial_jtag_vfs_set_tx_line_endings(ESP_LINE_ENDINGS_CRLF);

    fcntl(fileno(stdout), F_SETFL, 0);
    fcntl(fileno(stdin), F_SETFL, 0);

    usb_serial_jtag_driver_config_t usb_serial_jtag_config = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    esp_err_t err = usb_serial_jtag_driver_install(&usb_serial_jtag_config);
    if (err != ESP_OK) return err;
    usb_serial_jtag_vfs_use_driver();

    esp_console_config_t console_config = ESP_CONSOLE_CONFIG_DEFAULT();
    console_config.max_cmdline_length = FOS_CONSOLE_MAX_CMDLINE_LENGTH;
    err = esp_console_init(&console_config);
    if (err != ESP_OK) return err;
    ESP_ERROR_CHECK(esp_console_register_help_command());
    ESP_ERROR_CHECK(register_frameos_console_commands());

    if (xTaskCreate(fos_console_usb_task, "console_usb", FOS_CONSOLE_TASK_STACK_SIZE, NULL, 2, NULL) != pdTRUE) {
        return ESP_FAIL;
    }
    return ESP_OK;
}
#endif

esp_err_t fos_console_start(void)
{
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
    esp_err_t err = fos_console_start_usb_serial_jtag();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "console init failed: %s", esp_err_to_name(err));
    }
    return err;
#else
    esp_console_repl_t *repl = NULL;
    esp_console_repl_config_t repl_config = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    repl_config.prompt = "frameos>";
    repl_config.max_cmdline_length = FOS_CONSOLE_MAX_CMDLINE_LENGTH;
    repl_config.task_stack_size = FOS_CONSOLE_TASK_STACK_SIZE;

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

    ESP_ERROR_CHECK(register_frameos_console_commands());
    ESP_ERROR_CHECK(esp_console_start_repl(repl));
    return ESP_OK;
#endif
}
