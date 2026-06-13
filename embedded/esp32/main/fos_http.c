#include "fos_http.h"

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

/* ------------------------------------------------------------------ pages */

static const char *SETUP_PAGE_HEAD =
    "<!DOCTYPE html><html><head><meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>FrameOS setup</title>"
    "<style>body{font-family:system-ui,sans-serif;max-width:26rem;margin:2rem auto;padding:0 1rem}"
    "label{display:block;margin:.8rem 0 .2rem;font-weight:600}"
    "input,select{width:100%;padding:.5rem;box-sizing:border-box}"
    "button{margin-top:1.2rem;padding:.6rem 1.4rem;font-size:1rem}"
    "code{background:#eee;padding:0 .3rem}</style></head><body>"
    "<h1>FrameOS</h1><p>Configure this frame. It reboots and connects after saving.</p>"
    "<form method='POST' action='/api/setup'>"
    "<label>Wi-Fi network</label><input name='ssid' required>"
    "<label>Wi-Fi password</label><input name='pass' type='password'>"
    "<label>Backend URL</label><input name='backend' placeholder='https://backend.example.com'>"
    "<label>Frame API key</label><input name='api_key'>"
    "<label>Frame ID</label><input name='frame_id' type='number' min='0'>"
    "<label>Panel</label><select name='panel'>"
    "<option value='none'>None (headless)</option>";

static const char *SETUP_PAGE_TAIL =
    "</select>"
    "<label>Render mode</label><select name='render_mode'>"
    "<option value='0'>On device (Nim runtime)</option>"
    "<option value='1'>Thin client (backend renders)</option></select>"
    "<label>Refresh interval (seconds)</label><input name='interval' type='number' value='300' min='5'>"
    "<label>Pins</label><input name='pins' placeholder='rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1'>"
    "<button type='submit'>Save and reboot</button></form></body></html>";

static esp_err_t root_get_handler(httpd_req_t *req)
{
    char option[192];
    httpd_resp_set_type(req, "text/html");
    if (httpd_resp_sendstr_chunk(req, SETUP_PAGE_HEAD) != ESP_OK) return ESP_FAIL;
    for (size_t i = 0; i < fos_display_panel_count(); i++) {
        snprintf(option, sizeof(option),
                 "<option value='%s'>Waveshare %s (%dx%d, format %d)</option>",
                 fos_display_panel_name(i),
                 fos_display_panel_name(i),
                 fos_display_panel_width(i),
                 fos_display_panel_height(i),
                 (int)fos_display_panel_format(i));
        if (httpd_resp_sendstr_chunk(req, option) != ESP_OK) return ESP_FAIL;
    }
    if (httpd_resp_sendstr_chunk(req, SETUP_PAGE_TAIL) != ESP_OK) return ESP_FAIL;
    return httpd_resp_sendstr_chunk(req, NULL);
}

static esp_err_t status_get_handler(httpd_req_t *req)
{
    fos_config_t *config = fos_config();
    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();
    char pins[FOS_STR_LEN];
    fos_config_format_pins(&config->pins, pins, sizeof(pins));

    char *json = NULL;
    int len = asprintf(&json,
        "{\"app\":\"%s\",\"version\":\"%s\",\"idf\":\"%s\",\"partition\":\"%s\","
        "\"uptimeSec\":%lld,\"heapFree\":%u,\"psramFree\":%u,"
        "\"wifi\":{\"state\":%d,\"ip\":\"%s\",\"rssi\":%d,\"timeSynced\":%s},"
        "\"battery\":{\"present\":%s,\"millivolts\":%d,\"percent\":%d},"
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
    config.max_uri_handlers = 16;
    config.lru_purge_enable = true;
    config.stack_size = 8192;
    esp_err_t err = httpd_start(&s_server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed: %s", esp_err_to_name(err));
        return err;
    }

    const httpd_uri_t root = {.uri = "/", .method = HTTP_GET, .handler = root_get_handler};
    const httpd_uri_t status = {.uri = "/status", .method = HTTP_GET, .handler = status_get_handler};
    const httpd_uri_t setup = {.uri = "/api/setup", .method = HTTP_POST, .handler = setup_post_handler};
    httpd_register_uri_handler(s_server, &root);
    httpd_register_uri_handler(s_server, &status);
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
