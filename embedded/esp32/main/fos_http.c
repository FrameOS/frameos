#include "fos_http.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "fos_battery.h"
#include "fos_client.h"
#include "fos_config.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "frameos_display.h"

static const char *TAG = "fos_http";

static httpd_handle_t s_server = NULL;
static bool s_portal_mode = false;
static fos_action_cb s_render_cb = NULL;
static fos_action_cb s_ota_cb = NULL;

void fos_http_set_actions(fos_action_cb render_now, fos_action_cb ota_now)
{
    s_render_cb = render_now;
    s_ota_cb = ota_now;
}

/* ---------------------------------------------------------------- helpers */

static void url_decode(char *str)
{
    char *out = str;
    for (char *in = str; *in; in++) {
        if (*in == '+') {
            *out++ = ' ';
        } else if (*in == '%' && in[1] && in[2]) {
            char hex[3] = {in[1], in[2], 0};
            *out++ = (char)strtol(hex, NULL, 16);
            in += 2;
        } else {
            *out++ = *in;
        }
    }
    *out = '\0';
}

static bool form_value(const char *body, const char *key, char *out, size_t out_len)
{
    if (httpd_query_key_value(body, key, out, out_len) != ESP_OK) {
        return false;
    }
    url_decode(out);
    return true;
}

static esp_err_t sendstr(httpd_req_t *req, const char *value)
{
    return httpd_resp_sendstr_chunk(req, value);
}

static esp_err_t send_escaped_attr(httpd_req_t *req, const char *value)
{
    char buf[96];
    size_t used = 0;
    if (!value) value = "";
    for (const char *p = value; *p; p++) {
        const char *entity = NULL;
        switch (*p) {
            case '&': entity = "&amp;"; break;
            case '<': entity = "&lt;"; break;
            case '>': entity = "&gt;"; break;
            case '"': entity = "&quot;"; break;
            case '\'': entity = "&#39;"; break;
            default: break;
        }
        if (entity) {
            size_t len = strlen(entity);
            if (used + len >= sizeof(buf)) {
                if (httpd_resp_send_chunk(req, buf, used) != ESP_OK) return ESP_FAIL;
                used = 0;
            }
            memcpy(buf + used, entity, len);
            used += len;
        } else {
            if (used + 1 >= sizeof(buf)) {
                if (httpd_resp_send_chunk(req, buf, used) != ESP_OK) return ESP_FAIL;
                used = 0;
            }
            buf[used++] = *p;
        }
    }
    return used ? httpd_resp_send_chunk(req, buf, used) : ESP_OK;
}

static esp_err_t send_input(httpd_req_t *req, const char *label, const char *name,
                            const char *type, const char *value, const char *attrs)
{
    char prefix[192];
    snprintf(prefix, sizeof(prefix),
             "<label for='%s'>%s</label><input id='%s' name='%s' type='%s' value='",
             name, label, name, name, type);
    if (sendstr(req, prefix) != ESP_OK) return ESP_FAIL;
    if (send_escaped_attr(req, value) != ESP_OK) return ESP_FAIL;
    if (sendstr(req, "'") != ESP_OK) return ESP_FAIL;
    if (attrs && attrs[0] && sendstr(req, attrs) != ESP_OK) return ESP_FAIL;
    return sendstr(req, ">");
}

static esp_err_t send_option(httpd_req_t *req, const char *value, const char *label, bool selected)
{
    if (sendstr(req, "<option value='") != ESP_OK) return ESP_FAIL;
    if (send_escaped_attr(req, value) != ESP_OK) return ESP_FAIL;
    if (sendstr(req, selected ? "' selected>" : "'>") != ESP_OK) return ESP_FAIL;
    if (send_escaped_attr(req, label) != ESP_OK) return ESP_FAIL;
    return sendstr(req, "</option>");
}

/* ------------------------------------------------------------------ pages */

static const char *SETUP_PAGE_HEAD =
    "<!DOCTYPE html><html><head><meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>FrameOS setup</title>"
    "<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem}"
    "label{display:block;margin:.8rem 0 .2rem;font-weight:600}"
    "input,select{width:100%;padding:.5rem;box-sizing:border-box}"
    "button{margin-top:1.2rem;padding:.6rem 1.4rem;font-size:1rem}"
    ".row{display:flex;gap:.7rem;flex-wrap:wrap}.row>*{flex:1 1 10rem}"
    ".preview{margin:1.6rem 0;padding-top:1rem;border-top:1px solid #ddd}"
    ".preview img{display:block;max-width:100%;height:auto;border:1px solid #ddd;background:#fff}"
    ".muted{color:#666;font-size:.9rem}"
    "code{background:#eee;padding:0 .3rem}</style></head><body>"
    "<h1>FrameOS</h1><p>Configure this frame. It reboots and connects after saving.</p>";

static esp_err_t root_get_handler(httpd_req_t *req)
{
    fos_config_t *config = fos_config();
    char field[64];
    char pins[FOS_STR_LEN];
    char option_label[192];
    fos_config_format_pins(&config->pins, pins, sizeof(pins));

    httpd_resp_set_type(req, "text/html");
    if (httpd_resp_sendstr_chunk(req, SETUP_PAGE_HEAD) != ESP_OK) return ESP_FAIL;

    if (sendstr(req,
        "<section class='preview'><h2>Preview</h2>"
        "<p class='muted'>Last successful render from this device.</p>"
        "<img id='preview' src='/api/preview.bmp' alt='No rendered preview yet'>"
        "<div class='row'><button type='button' onclick='renderNow()'>Render now</button>"
        "<button type='button' onclick='refreshPreview()'>Refresh preview</button></div>"
        "</section>"
        "<form method='POST' action='/api/setup'>") != ESP_OK) return ESP_FAIL;

    if (send_input(req, "Wi-Fi network", "ssid", "text", config->wifi_ssid, " required") != ESP_OK) return ESP_FAIL;
    if (send_input(req, "Wi-Fi password", "pass", "password", config->wifi_pass, "") != ESP_OK) return ESP_FAIL;
    if (send_input(req, "Backend URL", "backend", "text", config->backend_url,
                   " placeholder='https://backend.example.com'") != ESP_OK) return ESP_FAIL;
    if (send_input(req, "Frame API key", "api_key", "text", config->api_key, "") != ESP_OK) return ESP_FAIL;
    snprintf(field, sizeof(field), "%lu", (unsigned long)config->frame_id);
    if (send_input(req, "Frame ID", "frame_id", "number", field, " min='0'") != ESP_OK) return ESP_FAIL;

    if (sendstr(req, "<label for='panel'>Panel</label><select id='panel' name='panel'>") != ESP_OK) return ESP_FAIL;
    bool panel_is_none = !config->panel[0] || strcmp(config->panel, "none") == 0;
    bool panel_seen = panel_is_none;
    if (send_option(req, "none", "None (headless)", panel_is_none) != ESP_OK) return ESP_FAIL;
    for (size_t i = 0; i < fos_display_panel_count(); i++) {
        const char *panel = fos_display_panel_name(i);
        bool selected = strcmp(config->panel, panel) == 0;
        panel_seen = panel_seen || selected;
        snprintf(option_label, sizeof(option_label),
                 "Waveshare %s (%dx%d, format %d)",
                 panel,
                 fos_display_panel_width(i),
                 fos_display_panel_height(i),
                 (int)fos_display_panel_format(i));
        if (send_option(req, panel, option_label, selected) != ESP_OK) return ESP_FAIL;
    }
    if (!panel_seen) {
        snprintf(option_label, sizeof(option_label), "%s (not compiled into this firmware)", config->panel);
        if (send_option(req, config->panel, option_label, true) != ESP_OK) return ESP_FAIL;
    }
    if (sendstr(req, "</select>") != ESP_OK) return ESP_FAIL;

    if (sendstr(req, "<label for='render_mode'>Render mode</label><select id='render_mode' name='render_mode'>") != ESP_OK) return ESP_FAIL;
    if (send_option(req, "0", "On device (Nim runtime)", config->render_mode == FOS_RENDER_LOCAL) != ESP_OK) return ESP_FAIL;
    if (send_option(req, "1", "Thin client (backend renders)", config->render_mode == FOS_RENDER_REMOTE) != ESP_OK) return ESP_FAIL;
    if (sendstr(req, "</select>") != ESP_OK) return ESP_FAIL;

    snprintf(field, sizeof(field), "%lu", (unsigned long)config->interval_sec);
    if (send_input(req, "Refresh interval (seconds)", "interval", "number", field, " min='5'") != ESP_OK) return ESP_FAIL;
    if (send_input(req, "Pins", "pins", "text", pins,
                   " placeholder='rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1'") != ESP_OK) {
        return ESP_FAIL;
    }
    if (sendstr(req,
        "<button type='submit'>Save and reboot</button></form>"
        "<p class='muted'><a href='/status'>Status JSON</a> | <a href='/api/preview.bmp'>Open preview image</a></p>"
        "<script>"
        "function refreshPreview(){const img=document.getElementById('preview');img.src='/api/preview.bmp?t='+Date.now();}"
        "function renderNow(){fetch('/api/action/render',{method:'POST'}).then(()=>{let n=0;"
        "const t=setInterval(()=>{refreshPreview();if(++n>=12)clearInterval(t);},2500);});}"
        "</script></body></html>") != ESP_OK) return ESP_FAIL;
    return httpd_resp_sendstr_chunk(req, NULL);
}

static esp_err_t status_get_handler(httpd_req_t *req)
{
    fos_config_t *config = fos_config();
    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();
    char pins[FOS_STR_LEN];
    fos_config_format_pins(&config->pins, pins, sizeof(pins));
    int preview_width = 0, preview_height = 0;
    fos_pixel_format_t preview_format = FOS_PIXEL_1BPP;
    size_t preview_len = 0;
    uint32_t preview_render_count = 0;
    uint32_t render_count = fos_client_render_count();
    int64_t render_ms = fos_client_last_render_ms();
    bool preview_ready = fos_client_snapshot_info(&preview_width, &preview_height, &preview_format,
                                                  &preview_len, &preview_render_count,
                                                  NULL);

    char *json = NULL;
    int len = asprintf(&json,
        "{\"app\":\"%s\",\"version\":\"%s\",\"idf\":\"%s\",\"partition\":\"%s\","
        "\"uptimeSec\":%lld,\"heapFree\":%u,\"psramFree\":%u,"
        "\"wifi\":{\"state\":%d,\"ip\":\"%s\",\"rssi\":%d,\"timeSynced\":%s},"
        "\"battery\":{\"present\":%s,\"millivolts\":%d,\"percent\":%d},"
        "\"render\":{\"count\":%lu,\"lastMs\":%lld,\"previewReady\":%s,\"previewRenderCount\":%lu,"
        "\"previewWidth\":%d,\"previewHeight\":%d,\"previewFormat\":%d,\"previewBytes\":%u},"
        "\"config\":{\"frameId\":%lu,\"panel\":\"%s\",\"renderMode\":\"%s\","
        "\"intervalSec\":%lu,\"deepSleep\":%s,\"wakeSchedule\":%s,\"pins\":\"%s\","
        "\"backendUrl\":\"%s\",\"wifiSsid\":\"%s\"}}",
        app->project_name, app->version, app->idf_ver, running ? running->label : "?",
        esp_timer_get_time() / 1000000,
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
        (int)fos_wifi_state(), fos_wifi_ip(), fos_wifi_rssi(),
        fos_wifi_time_synced() ? "true" : "false",
        fos_battery_present() ? "true" : "false",
        fos_battery_millivolts(), fos_battery_percent(),
        (unsigned long)render_count, render_ms, preview_ready ? "true" : "false",
        (unsigned long)preview_render_count,
        preview_width, preview_height, (int)preview_format, (unsigned)preview_len,
        (unsigned long)config->frame_id, config->panel,
        config->render_mode == FOS_RENDER_LOCAL ? "local" : "remote",
        (unsigned long)config->interval_sec, config->deep_sleep ? "true" : "false",
        config->wake_schedule ? "true" : "false",
        pins, config->backend_url, config->wifi_ssid);
    if (len < 0 || !json) {
        return httpd_resp_send_500(req);
    }
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send(req, json, len);
    free(json);
    return err;
}

static const uint8_t PREVIEW_PALETTE_4[] = {
    57, 48, 57, 255, 255, 255, 208, 190, 71, 156, 72, 75,
};

static const uint8_t PREVIEW_PALETTE_7[] = {
    57, 48, 57, 255, 255, 255, 58, 91, 70, 61, 59, 94,
    156, 72, 75, 208, 190, 71, 177, 106, 73,
};

static const uint8_t PREVIEW_PALETTE_SPECTRA6[] = {
    25, 20, 38, 178, 193, 192, 199, 187, 0, 107, 17, 25,
    255, 255, 255, 24, 83, 154, 42, 85, 49,
};

static void put_u16le(uint8_t *buf, uint16_t value)
{
    buf[0] = value & 0xFF;
    buf[1] = (value >> 8) & 0xFF;
}

static void put_u32le(uint8_t *buf, uint32_t value)
{
    buf[0] = value & 0xFF;
    buf[1] = (value >> 8) & 0xFF;
    buf[2] = (value >> 16) & 0xFF;
    buf[3] = (value >> 24) & 0xFF;
}

static uint8_t packed_nibble(const uint8_t *buf, int width, int x, int y)
{
    size_t row = ((size_t)width + 1u) / 2u;
    uint8_t value = buf[(size_t)y * row + (size_t)(x >> 1)];
    return (x & 1) ? (value & 0x0F) : (value >> 4);
}

static uint8_t packed_twobit(const uint8_t *buf, int width, int x, int y)
{
    size_t row = ((size_t)width + 3u) / 4u;
    uint8_t value = buf[(size_t)y * row + (size_t)(x >> 2)];
    return (value >> (6 - ((x & 3) * 2))) & 0x03;
}

static void palette_rgb(const uint8_t *palette, size_t colors, uint8_t index,
                        uint8_t *r, uint8_t *g, uint8_t *b)
{
    if (index >= colors) index = 1;
    *r = palette[(size_t)index * 3u];
    *g = palette[(size_t)index * 3u + 1u];
    *b = palette[(size_t)index * 3u + 2u];
}

static void preview_pixel_rgb(const uint8_t *buf, int width, int height,
                              fos_pixel_format_t format, int x, int y,
                              uint8_t *r, uint8_t *g, uint8_t *b)
{
    switch (format) {
        case FOS_PIXEL_1BPP: {
            size_t row = ((size_t)width + 7u) / 8u;
            uint8_t bit = 0x80 >> (x & 7);
            uint8_t white = (buf[(size_t)y * row + (size_t)(x >> 3)] & bit) ? 255 : 0;
            *r = white; *g = white; *b = white;
            break;
        }
        case FOS_PIXEL_DUAL_1BPP_RED:
        case FOS_PIXEL_DUAL_1BPP_YELLOW: {
            size_t row = ((size_t)width + 7u) / 8u;
            size_t plane = row * (size_t)height;
            size_t offset = (size_t)y * row + (size_t)(x >> 3);
            uint8_t bit = 0x80 >> (x & 7);
            bool black = (buf[offset] & bit) == 0;
            bool accent = (buf[plane + offset] & bit) == 0;
            if (black) {
                *r = 0; *g = 0; *b = 0;
            } else if (accent && format == FOS_PIXEL_DUAL_1BPP_RED) {
                *r = 255; *g = 0; *b = 0;
            } else if (accent) {
                *r = 255; *g = 255; *b = 0;
            } else {
                *r = 255; *g = 255; *b = 255;
            }
            break;
        }
        case FOS_PIXEL_2BPP_GRAY: {
            uint8_t gray = packed_twobit(buf, width, x, y) * 85u;
            *r = gray; *g = gray; *b = gray;
            break;
        }
        case FOS_PIXEL_2BPP_BWYR:
            palette_rgb(PREVIEW_PALETTE_4, 4, packed_twobit(buf, width, x, y), r, g, b);
            break;
        case FOS_PIXEL_4BPP_7COLOR:
            palette_rgb(PREVIEW_PALETTE_7, 7, packed_nibble(buf, width, x, y), r, g, b);
            break;
        case FOS_PIXEL_4BPP_SPECTRA6:
            palette_rgb(PREVIEW_PALETTE_SPECTRA6, 7, packed_nibble(buf, width, x, y), r, g, b);
            break;
        case FOS_PIXEL_4BPP_GRAY: {
            uint8_t gray = packed_nibble(buf, width, x, y) * 17u;
            *r = gray; *g = gray; *b = gray;
            break;
        }
        default:
            *r = 255; *g = 255; *b = 255;
            break;
    }
}

static esp_err_t preview_bmp_handler(httpd_req_t *req)
{
    int width = 0, height = 0;
    fos_pixel_format_t format = FOS_PIXEL_1BPP;
    size_t packed_len = 0;
    if (!fos_client_snapshot_info(&width, &height, &format, &packed_len, NULL, NULL)) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "no preview rendered yet");
    }
    if (width <= 0 || height <= 0 || packed_len == 0) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "no preview rendered yet");
    }

    uint8_t *packed = heap_caps_malloc(packed_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!packed) packed = malloc(packed_len);
    if (!packed) return httpd_resp_send_500(req);
    esp_err_t err = fos_client_snapshot_copy(packed, packed_len, &width, &height, &format, NULL, NULL);
    if (err != ESP_OK) {
        free(packed);
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "no preview rendered yet");
    }

    size_t row_stride = (((size_t)width * 3u) + 3u) & ~3u;
    size_t pixel_bytes = row_stride * (size_t)height;
    if (pixel_bytes > UINT32_MAX - 54u) {
        free(packed);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "preview too large");
    }

    uint8_t header[54] = {0};
    header[0] = 'B'; header[1] = 'M';
    put_u32le(&header[2], (uint32_t)(54u + pixel_bytes));
    put_u32le(&header[10], 54);
    put_u32le(&header[14], 40);
    put_u32le(&header[18], (uint32_t)width);
    put_u32le(&header[22], (uint32_t)height);
    put_u16le(&header[26], 1);
    put_u16le(&header[28], 24);
    put_u32le(&header[34], (uint32_t)pixel_bytes);

    uint8_t *row = heap_caps_calloc(1, row_stride, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!row) row = calloc(1, row_stride);
    if (!row) {
        free(packed);
        return httpd_resp_send_500(req);
    }

    httpd_resp_set_type(req, "image/bmp");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    err = httpd_resp_send_chunk(req, (const char *)header, sizeof(header));
    for (int y = height - 1; err == ESP_OK && y >= 0; y--) {
        memset(row, 0, row_stride);
        for (int x = 0; x < width; x++) {
            uint8_t r, g, b;
            preview_pixel_rgb(packed, width, height, format, x, y, &r, &g, &b);
            row[(size_t)x * 3u] = b;
            row[(size_t)x * 3u + 1u] = g;
            row[(size_t)x * 3u + 2u] = r;
        }
        err = httpd_resp_send_chunk(req, (const char *)row, row_stride);
    }

    free(row);
    free(packed);
    if (err != ESP_OK) return err;
    return httpd_resp_send_chunk(req, NULL, 0);
}

static esp_err_t setup_post_handler(httpd_req_t *req)
{
    int total = req->content_len;
    if (total <= 0 || total > 2048) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad length");
    }
    char *body = malloc(total + 1);
    if (!body) return httpd_resp_send_500(req);
    int received = 0;
    while (received < total) {
        int r = httpd_req_recv(req, body + received, total - received);
        if (r <= 0) {
            free(body);
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "recv failed");
        }
        received += r;
    }
    body[total] = '\0';

    fos_config_t *config = fos_config();
    char value[FOS_URL_LEN];
    if (form_value(body, "ssid", value, sizeof(value))) strlcpy(config->wifi_ssid, value, sizeof(config->wifi_ssid));
    if (form_value(body, "pass", value, sizeof(value))) strlcpy(config->wifi_pass, value, sizeof(config->wifi_pass));
    if (form_value(body, "backend", value, sizeof(value))) strlcpy(config->backend_url, value, sizeof(config->backend_url));
    if (form_value(body, "api_key", value, sizeof(value))) strlcpy(config->api_key, value, sizeof(config->api_key));
    if (form_value(body, "frame_id", value, sizeof(value))) config->frame_id = strtoul(value, NULL, 10);
    if (form_value(body, "panel", value, sizeof(value))) strlcpy(config->panel, value, sizeof(config->panel));
    if (form_value(body, "render_mode", value, sizeof(value))) config->render_mode = atoi(value) ? FOS_RENDER_REMOTE : FOS_RENDER_LOCAL;
    if (form_value(body, "interval", value, sizeof(value)) && atoi(value) >= 5) config->interval_sec = atoi(value);
    if (form_value(body, "pins", value, sizeof(value))) fos_config_parse_pins(value, &config->pins);
    free(body);

    esp_err_t err = fos_config_save();
    if (err != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "save failed");
    }
    httpd_resp_set_type(req, "text/html");
    httpd_resp_send(req, "<html><body><h1>Saved</h1><p>Rebooting…</p></body></html>", HTTPD_RESP_USE_STRLEN);
    ESP_LOGI(TAG, "configuration saved via portal, rebooting");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK;
}

static esp_err_t action_handler(httpd_req_t *req)
{
    fos_action_cb cb = (fos_action_cb)req->user_ctx;
    if (!cb) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "action not available");
    }
    cb();
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}

/* Local scene push (M3): accept a scenes.json array, persist it to /state
 * and apply it on the next render — hot scene update over the LAN without
 * touching the backend. */
static esp_err_t scenes_post_handler(httpd_req_t *req)
{
    int total = req->content_len;
    if (total <= 0 || total > 512 * 1024) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad length");
    }
    char *body = heap_caps_malloc(total + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!body) body = malloc(total + 1);
    if (!body) return httpd_resp_send_500(req);
    int received = 0;
    while (received < total) {
        int r = httpd_req_recv(req, body + received, total - received);
        if (r <= 0) {
            free(body);
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "recv failed");
        }
        received += r;
    }
    body[total] = '\0';

    esp_err_t err = fos_scenes_set_json(body, total);
    free(body);
    if (err != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "store failed");
    }
    if (s_render_cb) s_render_cb();
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}

/* Force a backend scenes sync on the next render pass. */
static esp_err_t scenes_sync_handler(httpd_req_t *req)
{
    fos_scenes_request_sync();
    if (s_render_cb) s_render_cb();
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}

/* Captive portal: any unknown URL (and the OS connectivity probes) redirect
 * to the setup page so phones pop the sign-in sheet. */
static esp_err_t portal_redirect_handler(httpd_req_t *req, httpd_err_code_t err)
{
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
    return httpd_resp_send(req, NULL, 0);
}

static esp_err_t probe_handler(httpd_req_t *req)
{
    return portal_redirect_handler(req, 0);
}

esp_err_t fos_http_start(bool portal_mode)
{
    if (s_server) return ESP_OK;
    s_portal_mode = portal_mode;

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_uri_handlers = 20;
    config.lru_purge_enable = true;
    config.stack_size = 8192;
    esp_err_t err = httpd_start(&s_server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed: %s", esp_err_to_name(err));
        return err;
    }

    const httpd_uri_t root = {.uri = "/", .method = HTTP_GET, .handler = root_get_handler};
    const httpd_uri_t status = {.uri = "/status", .method = HTTP_GET, .handler = status_get_handler};
    const httpd_uri_t preview = {.uri = "/api/preview.bmp", .method = HTTP_GET, .handler = preview_bmp_handler};
    const httpd_uri_t setup = {.uri = "/api/setup", .method = HTTP_POST, .handler = setup_post_handler};
    httpd_register_uri_handler(s_server, &root);
    httpd_register_uri_handler(s_server, &status);
    httpd_register_uri_handler(s_server, &preview);
    httpd_register_uri_handler(s_server, &setup);

    httpd_uri_t render = {.uri = "/api/action/render", .method = HTTP_POST, .handler = action_handler, .user_ctx = s_render_cb};
    httpd_uri_t ota = {.uri = "/api/action/ota", .method = HTTP_POST, .handler = action_handler, .user_ctx = s_ota_cb};
    httpd_register_uri_handler(s_server, &render);
    httpd_register_uri_handler(s_server, &ota);

    httpd_uri_t scenes = {.uri = "/api/scenes", .method = HTTP_POST, .handler = scenes_post_handler};
    httpd_uri_t scenes_sync = {.uri = "/api/action/scenes_sync", .method = HTTP_POST, .handler = scenes_sync_handler};
    httpd_register_uri_handler(s_server, &scenes);
    httpd_register_uri_handler(s_server, &scenes_sync);

    if (portal_mode) {
        static const char *probes[] = {
            "/generate_204", "/gen_204", "/hotspot-detect.html",
            "/connecttest.txt", "/ncsi.txt", "/redirect", "/success.txt",
        };
        for (size_t i = 0; i < sizeof(probes) / sizeof(probes[0]); i++) {
            httpd_uri_t probe = {.uri = probes[i], .method = HTTP_GET, .handler = probe_handler};
            httpd_register_uri_handler(s_server, &probe);
        }
        httpd_register_err_handler(s_server, HTTPD_404_NOT_FOUND, portal_redirect_handler);
    }

    ESP_LOGI(TAG, "http server up (%s mode)", portal_mode ? "portal" : "status");
    return ESP_OK;
}

void fos_http_stop(void)
{
    if (s_server) {
        httpd_stop(s_server);
        s_server = NULL;
    }
}
