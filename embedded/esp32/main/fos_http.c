#include "fos_http.h"

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_app_desc.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_https_server.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "mbedtls/base64.h"

#include "cJSON.h"
#include "fos_assets.h"
#include "fos_assets_sd.h"
#include "fos_battery.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_mem.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "frameos_display.h"
#include "frameos_nim.h"

static const char *TAG = "fos_http";

#define FOS_HTTPS_MAX_OPEN_SOCKETS 1
#define FOS_HTTPS_BACKLOG_CONN 1
#define FOS_HTTPS_WARN_INTERNAL_FREE (96 * 1024)
#define FOS_HTTPS_MIN_INTERNAL_FREE (48 * 1024)
#define FOS_HTTPS_MIN_INTERNAL_BLOCK (40 * 1024)
#define FOS_HTTP_MUTATION_KEEP_AWAKE_MS (3 * 60 * 1000u)
#define FOS_HTTP_UPLOAD_SCENE_ID_LEN 128

static httpd_handle_t s_http_server = NULL;
static httpd_handle_t s_https_server = NULL;
static bool s_portal_mode = false;
static fos_action_cb s_render_cb = NULL;
static fos_action_cb s_ota_cb = NULL;

static esp_err_t scenes_post_handler(httpd_req_t *req);
static void log_http_command(httpd_req_t *req, const char *event_name, size_t body_len);
static void log_http_command_from_path(httpd_req_t *req, size_t body_len);

static void keep_awake_for_http_mutation(void)
{
    fos_client_keep_awake_ms(FOS_HTTP_MUTATION_KEEP_AWAKE_MS);
}

void fos_http_set_actions(fos_action_cb render_now, fos_action_cb ota_now)
{
    s_render_cb = render_now;
    s_ota_cb = ota_now;
}

static bool https_heap_ready(void)
{
    size_t free_internal = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    size_t largest_internal = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (free_internal < FOS_HTTPS_MIN_INTERNAL_FREE ||
        largest_internal < FOS_HTTPS_MIN_INTERNAL_BLOCK) {
        ESP_LOGW(TAG, "https server skipped: internal=%u largest=%u min_internal=%u min_largest=%u",
                 (unsigned)free_internal, (unsigned)largest_internal,
                 (unsigned)FOS_HTTPS_MIN_INTERNAL_FREE,
                 (unsigned)FOS_HTTPS_MIN_INTERNAL_BLOCK);
        return false;
    }
    if (free_internal < FOS_HTTPS_WARN_INTERNAL_FREE) {
        ESP_LOGW(TAG, "starting https server with low internal heap: internal=%u largest=%u",
                 (unsigned)free_internal, (unsigned)largest_internal);
    }
    return true;
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

static char *json_escape_dup(const char *value)
{
    if (!value) value = "";
    size_t len = strlen(value);
    char *out = malloc(len * 6 + 1);
    if (!out) return NULL;
    char *dst = out;
    for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        switch (*p) {
            case '\\': *dst++ = '\\'; *dst++ = '\\'; break;
            case '"': *dst++ = '\\'; *dst++ = '"'; break;
            case '\b': *dst++ = '\\'; *dst++ = 'b'; break;
            case '\f': *dst++ = '\\'; *dst++ = 'f'; break;
            case '\n': *dst++ = '\\'; *dst++ = 'n'; break;
            case '\r': *dst++ = '\\'; *dst++ = 'r'; break;
            case '\t': *dst++ = '\\'; *dst++ = 't'; break;
            default:
                if (*p < 0x20) {
                    snprintf(dst, 7, "\\u%04x", *p);
                    dst += 6;
                } else {
                    *dst++ = (char)*p;
                }
                break;
        }
    }
    *dst = '\0';
    return out;
}

static bool copy_request_path(httpd_req_t *req, char *out, size_t out_len)
{
    if (!req || !out || out_len == 0) return false;
    const char *uri = req->uri;
    const char *query = strchr(uri, '?');
    size_t len = query ? (size_t)(query - uri) : strlen(uri);
    if (len >= out_len) return false;
    memcpy(out, uri, len);
    out[len] = '\0';
    return true;
}

static bool json_string_value(const char *json, const char *key, char *out, size_t out_len)
{
    if (!json || !key || !out || out_len == 0) return false;
    out[0] = '\0';

    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return false;
    p = strchr(p + strlen(pattern), ':');
    if (!p) return false;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != '"') return false;
    p++;

    size_t used = 0;
    while (*p && *p != '"' && used + 1 < out_len) {
        if (*p == '\\' && p[1]) p++;
        out[used++] = *p++;
    }
    out[used] = '\0';
    return used > 0;
}

static void current_scene_id(char *out, size_t out_len)
{
    if (!out || out_len == 0) return;
    out[0] = '\0';
    json_string_value(frameos_nim_scene_info_json(), "currentSceneId", out, out_len);
}

static esp_err_t read_request_body(httpd_req_t *req, size_t max_len, bool allow_empty, char **out)
{
    if (!out) return ESP_ERR_INVALID_ARG;
    *out = NULL;
    int total = req->content_len;
    if (total < 0 || (total == 0 && !allow_empty) || (size_t)total > max_len) {
        return ESP_ERR_INVALID_SIZE;
    }
    char *body = fos_big_malloc((size_t)total + 1);
    if (!body) body = malloc((size_t)total + 1);
    if (!body) return ESP_ERR_NO_MEM;
    int received = 0;
    while (received < total) {
        int r = httpd_req_recv(req, body + received, total - received);
        if (r <= 0) {
            free(body);
            return ESP_FAIL;
        }
        received += r;
    }
    body[total] = '\0';
    *out = body;
    return ESP_OK;
}

static bool request_auth_header(httpd_req_t *req, char *out, size_t out_len)
{
    size_t len = httpd_req_get_hdr_value_len(req, "Authorization");
    if (!len || len >= out_len) return false;
    return httpd_req_get_hdr_value_str(req, "Authorization", out, out_len) == ESP_OK;
}

static bool admin_auth_configured(const fos_config_t *config)
{
    return config->admin_auth_enabled && config->admin_user[0] && config->admin_pass[0];
}

static bool request_bearer_matches(httpd_req_t *req, const fos_config_t *config)
{
    if (!config->api_key[0]) return false;
    char auth[FOS_STR_LEN + 16];
    if (!request_auth_header(req, auth, sizeof(auth))) return false;
    const char *prefix = "Bearer ";
    size_t prefix_len = strlen(prefix);
    return strncmp(auth, prefix, prefix_len) == 0 && strcmp(auth + prefix_len, config->api_key) == 0;
}

static bool request_basic_matches(httpd_req_t *req, const fos_config_t *config)
{
    if (!admin_auth_configured(config)) return false;

    char auth[384];
    if (!request_auth_header(req, auth, sizeof(auth))) return false;

    char raw[FOS_STR_LEN * 2 + 2];
    snprintf(raw, sizeof(raw), "%s:%s", config->admin_user, config->admin_pass);

    unsigned char encoded[384];
    size_t encoded_len = 0;
    int rc = mbedtls_base64_encode(
        encoded,
        sizeof(encoded) - 1,
        &encoded_len,
        (const unsigned char *)raw,
        strlen(raw));
    if (rc != 0 || encoded_len >= sizeof(encoded)) return false;
    encoded[encoded_len] = '\0';

    const char *prefix = "Basic ";
    size_t prefix_len = strlen(prefix);
    return strncmp(auth, prefix, prefix_len) == 0 && strcmp(auth + prefix_len, (const char *)encoded) == 0;
}

static const char *http_method_name(int method)
{
    switch (method) {
        case HTTP_GET: return "GET";
        case HTTP_POST: return "POST";
        case HTTP_PUT: return "PUT";
        case HTTP_DELETE: return "DELETE";
        case HTTP_HEAD: return "HEAD";
        case HTTP_OPTIONS: return "OPTIONS";
        case HTTP_PATCH: return "PATCH";
        default: return "OTHER";
    }
}

static void log_http_denied(httpd_req_t *req, int status)
{
    /* A client polling with stale credentials (a backend or cloud UI retries
     * /logs every few seconds) would otherwise fill the 128-line ring with
     * denials; one line per window is enough to see it happening. */
    static int64_t s_last_denied_us = 0;
    int64_t now_us = esp_timer_get_time();
    if (s_last_denied_us != 0 && now_us - s_last_denied_us < 10 * 1000 * 1000) {
        return;
    }
    s_last_denied_us = now_us;

    char path[272];
    if (!copy_request_path(req, path, sizeof(path))) {
        strlcpy(path, req->uri, sizeof(path));
    }
    char *escaped_path = json_escape_dup(path);
    if (!escaped_path) return;

    char log_line[640];
    snprintf(log_line, sizeof(log_line),
             "{\"event\":\"http:denied\",\"source\":\"esp32\",\"method\":\"%s\","
             "\"path\":\"%s\",\"status\":%d}",
             http_method_name(req->method), escaped_path, status);
    free(escaped_path);
    frameos_nim_log_hook(log_line);
}

static esp_err_t require_protected_access(httpd_req_t *req)
{
    if (s_portal_mode) return ESP_OK;

    fos_config_t *config = fos_config();
    if (request_bearer_matches(req, config) || request_basic_matches(req, config)) {
        return ESP_OK;
    }

    if (!admin_auth_configured(config)) {
        log_http_denied(req, 403);
        httpd_resp_set_type(req, "text/plain");
        return httpd_resp_send_err(
            req,
            HTTPD_403_FORBIDDEN,
            "FrameOS setup is locked because admin credentials are not configured. "
            "Connect through the FrameOS hotspot, or set frame admin auth in the backend and redeploy.");
    }

    log_http_denied(req, 401);
    httpd_resp_set_hdr(req, "WWW-Authenticate", "Basic realm=\"FrameOS\"");
    return httpd_resp_send_err(req, HTTPD_401_UNAUTHORIZED, "Authentication required");
}

#define REQUIRE_PROTECTED_ACCESS() do { \
        esp_err_t auth_err = require_protected_access(req); \
        if (auth_err != ESP_OK) return auth_err; \
    } while (0)

esp_err_t fos_http_store_uploaded_scenes_payload(const char *body, size_t len)
{
    const char *payload = body;
    size_t payload_len = len;
    char requested_scene_id[FOS_HTTP_UPLOAD_SCENE_ID_LEN] = "";
    char *owned_payload = NULL;
    cJSON *root = NULL;

    if (body != NULL) {
        const char *first = body;
        while (*first == ' ' || *first == '\n' || *first == '\r' || *first == '\t') {
            first++;
        }
        if (*first == '{') {
            root = cJSON_Parse(body);
        }
    }

    if (root != NULL && cJSON_IsObject(root)) {
        cJSON *scenes = cJSON_GetObjectItem(root, "scenes");
        if (cJSON_IsArray(scenes)) {
            owned_payload = cJSON_PrintUnformatted(scenes);
            if (!owned_payload) {
                cJSON_Delete(root);
                return ESP_ERR_NO_MEM;
            }
            payload = owned_payload;
            payload_len = strlen(owned_payload);
        }

        cJSON *scene_id = cJSON_GetObjectItem(root, "sceneId");
        if (cJSON_IsString(scene_id) && scene_id->valuestring && scene_id->valuestring[0]) {
            if (strlen(scene_id->valuestring) >= sizeof(requested_scene_id)) {
                if (owned_payload) cJSON_free(owned_payload);
                cJSON_Delete(root);
                return ESP_ERR_INVALID_ARG;
            }
            strlcpy(requested_scene_id, scene_id->valuestring, sizeof(requested_scene_id));
        }
    }

    cJSON_Delete(root);
    esp_err_t err = fos_scenes_set_json(payload, payload_len);
    if (err == ESP_OK && requested_scene_id[0]) {
        err = fos_scenes_select(requested_scene_id);
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "uploaded scenes requested scene: %s", requested_scene_id);
        }
    }
    if (owned_payload) cJSON_free(owned_payload);
    return err;
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

typedef struct {
    uint32_t flash_bytes;
    uint32_t nvs_bytes;
    uint32_t otadata_bytes;
    uint32_t phy_bytes;
    uint32_t factory_slot_bytes;
    uint32_t ota_slots;
    uint32_t ota_slot_bytes;
    uint32_t ota_bytes;
    uint32_t state_bytes;
} fos_storage_info_t;

static uint32_t partition_size(esp_partition_type_t type, esp_partition_subtype_t subtype,
                               const char *label)
{
    const esp_partition_t *partition = esp_partition_find_first(type, subtype, label);
    return partition ? partition->size : 0;
}

static void collect_storage_info(fos_storage_info_t *info)
{
    memset(info, 0, sizeof(*info));
    if (esp_flash_get_size(NULL, &info->flash_bytes) != ESP_OK) {
        info->flash_bytes = 0;
    }
    info->nvs_bytes = partition_size(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, NULL);
    info->otadata_bytes = partition_size(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_OTA, NULL);
    info->phy_bytes = partition_size(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_PHY, NULL);
    info->state_bytes = partition_size(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "state");
    info->factory_slot_bytes = partition_size(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_FACTORY, NULL);

    for (int i = 0; ESP_PARTITION_SUBTYPE_APP_OTA_MIN + i < ESP_PARTITION_SUBTYPE_APP_OTA_MAX; i++) {
        const esp_partition_t *partition = esp_partition_find_first(
            ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_OTA(i), NULL);
        if (!partition) {
            continue;
        }
        info->ota_slots++;
        info->ota_bytes += partition->size;
        if (info->ota_slot_bytes == 0 || partition->size < info->ota_slot_bytes) {
            info->ota_slot_bytes = partition->size;
        }
    }
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
    ".preview,.panel{margin:1.6rem 0;padding-top:1rem;border-top:1px solid #ddd}"
    ".preview img{display:block;max-width:100%;height:auto;border:1px solid #ddd;background:#fff}"
    ".muted{color:#666;font-size:.9rem}"
    ".warn{background:#fff8dc;border:1px solid #e5c25a;padding:.7rem;margin:.9rem 0}"
    ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.6rem}"
    ".metric{background:#f6f6f6;border:1px solid #ddd;padding:.5rem}.metric b{display:block}"
    "code{background:#eee;padding:0 .3rem}</style></head><body>"
    "<h1>FrameOS</h1><p>Configure this frame. It reboots and connects after saving.</p>";

static esp_err_t root_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    fos_config_t *config = fos_config();
    char field[64];
    char pins[FOS_STR_LEN];
    char sd_pins[FOS_STR_LEN];
    char option_label[192];
    fos_config_format_pins(&config->pins, pins, sizeof(pins));
    fos_config_format_assets_sd_pins(&config->assets_sd, sd_pins, sizeof(sd_pins));

    httpd_resp_set_type(req, "text/html");
    if (httpd_resp_sendstr_chunk(req, SETUP_PAGE_HEAD) != ESP_OK) return ESP_FAIL;

    if (sendstr(req,
        "<section class='preview'><h2>Preview</h2>"
        "<p class='muted'>Last successful render from this device.</p>"
        "<img id='preview' alt='No rendered preview yet'>"
        "<div class='row'><button type='button' onclick='renderNow()'>Render now</button>"
        "<button type='button' onclick='refreshPreview()'>Refresh preview</button></div>"
        "</section>"
        "<section class='panel'><h2>Scenes</h2>"
        "<select id='scene_select'></select>"
        "<div class='row'><button type='button' onclick='showScene()'>Show scene</button>"
        "<button type='button' onclick='syncScenes()'>Sync from backend</button></div>"
        "<p id='scene_status' class='muted'></p>"
        "</section>"
        "<section class='panel'><h2>Board</h2><div id='board_metrics' class='grid'></div>"
        "</section>"
        "<form method='POST' action='/api/setup'>") != ESP_OK) return ESP_FAIL;

    if (send_input(req, "Wi-Fi network", "ssid", "text", config->wifi_ssid, " required") != ESP_OK) return ESP_FAIL;
    if (send_input(req, "Wi-Fi password", "pass", "password", "",
                   " autocomplete='new-password' placeholder='Leave blank to keep current password'") != ESP_OK) {
        return ESP_FAIL;
    }
    if (send_input(req, "Backend URL", "backend", "text", config->backend_url,
                   " placeholder='https://backend.example.com'") != ESP_OK) return ESP_FAIL;
    if (sendstr(req, "<label for='tls_enable'>HTTPS API</label><select id='tls_enable' name='tls_enable'>") != ESP_OK) return ESP_FAIL;
    if (send_option(req, "1", "Enabled (using backend-provisioned certificate)", config->tls_enable) != ESP_OK) return ESP_FAIL;
    if (send_option(req, "0", "Disabled", !config->tls_enable) != ESP_OK) return ESP_FAIL;
    if (sendstr(req, "</select>") != ESP_OK) return ESP_FAIL;
    snprintf(field, sizeof(field), "%u", (unsigned)config->tls_port);
    if (send_input(req, "HTTPS port", "tls_port", "number", field, " min='1' max='65535'") != ESP_OK) return ESP_FAIL;
    if (config->tls_enable && (!config->tls_server_cert[0] || !config->tls_server_key[0])) {
        if (sendstr(req, "<p class='muted'>HTTPS is enabled but no certificate is stored. Generate TLS material in the backend and flash a frame-specific build.</p>") != ESP_OK) {
            return ESP_FAIL;
        }
    }
    if (send_input(req, "Frame API key", "api_key", "password", "",
                   " autocomplete='off' placeholder='Leave blank to keep current key'") != ESP_OK) {
        return ESP_FAIL;
    }

    bool has_admin_auth = admin_auth_configured(config);
    if (!has_admin_auth) {
        if (sendstr(req, "<p class='warn'>Set an admin username and password before joining normal Wi-Fi. Without them, setup and control routes stay locked outside hotspot mode.</p>") != ESP_OK) {
            return ESP_FAIL;
        }
    }
    if (sendstr(req, "<label for='admin_auth'>Setup/control protection</label><select id='admin_auth' name='admin_auth'>") != ESP_OK) return ESP_FAIL;
    bool protect_setup = config->admin_auth_enabled || !has_admin_auth;
    if (send_option(req, "1", "Enabled with admin username/password", protect_setup) != ESP_OK) return ESP_FAIL;
    if (send_option(req, "0", "Disabled (locked outside hotspot unless backend token is used)", !protect_setup) != ESP_OK) return ESP_FAIL;
    if (sendstr(req, "</select>") != ESP_OK) return ESP_FAIL;
    if (send_input(req, "Admin username", "admin_user", "text",
                   config->admin_user[0] ? config->admin_user : "admin", " autocomplete='username'") != ESP_OK) {
        return ESP_FAIL;
    }
    if (send_input(req, "Admin password", "admin_pass", "password", "",
                   " autocomplete='new-password' placeholder='Leave blank to keep current password'") != ESP_OK) {
        return ESP_FAIL;
    }

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

    if (sendstr(req, "<label for='server_send_logs'>Backend logs</label><select id='server_send_logs' name='server_send_logs'>") != ESP_OK) return ESP_FAIL;
    if (send_option(req, "1", "Send render/runtime logs", config->server_send_logs) != ESP_OK) return ESP_FAIL;
    if (send_option(req, "0", "Serial only", !config->server_send_logs) != ESP_OK) return ESP_FAIL;
    if (sendstr(req, "</select>") != ESP_OK) return ESP_FAIL;

    snprintf(field, sizeof(field), "%lu", (unsigned long)config->interval_sec);
    if (send_input(req, "Refresh interval (seconds)", "interval", "number", field, " min='5'") != ESP_OK) return ESP_FAIL;
    if (send_input(req, "Pins", "pins", "text", pins,
                   " placeholder='rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1'") != ESP_OK) {
        return ESP_FAIL;
    }
    if (send_input(req, "Assets path", "assets_path", "text", config->assets_path,
                   " placeholder='/srv/assets'") != ESP_OK) {
        return ESP_FAIL;
    }
    if (sendstr(req, "<label for='assets_sd_enable'>SD card assets</label><select id='assets_sd_enable' name='assets_sd_enable'>") != ESP_OK) return ESP_FAIL;
    if (send_option(req, "1", "Enabled (mount FAT32 card at assets path)", config->assets_sd.enabled) != ESP_OK) return ESP_FAIL;
    if (send_option(req, "0", "Disabled", !config->assets_sd.enabled) != ESP_OK) return ESP_FAIL;
    if (sendstr(req, "</select>") != ESP_OK) return ESP_FAIL;
    if (send_input(req, "SD card pins", "assets_sd_pins", "text", sd_pins,
                   " placeholder='cs=38,sck=39,miso=40,mosi=41'") != ESP_OK) {
        return ESP_FAIL;
    }
    snprintf(field, sizeof(field), "%lu", (unsigned long)config->assets_sd.max_freq_khz);
    if (send_input(req, "SD max frequency (kHz)", "assets_sd_freq", "number", field,
                   " min='400' max='40000'") != ESP_OK) return ESP_FAIL;
    if (sendstr(req,
        "<button type='submit'>Save and reboot</button></form>"
        "<p class='muted'><a href='/status'>Status JSON</a> | <a href='/api/scenes'>Scenes JSON</a> | "
        "<a href='/state'>Scene state JSON</a> | <a href='/image'>Open frame image</a></p>"
        "<script>"
        "async function loadStatus(){const res=await fetch('/status');const s=await res.json();"
        "const scenes=s.scenes&&s.scenes.scenes?s.scenes.scenes:[];const sel=document.getElementById('scene_select');"
        "sel.innerHTML='';for(const scene of scenes){const o=document.createElement('option');o.value=scene.id;"
        "o.textContent=scene.name||scene.id;if(scene.id===(s.scenes&&s.scenes.currentSceneId))o.selected=true;sel.appendChild(o);}"
        "document.getElementById('scene_status').textContent=scenes.length?`Loaded ${s.scenes.loaded} scene(s); current: ${s.scenes.currentSceneName||s.scenes.currentSceneId||'none'}`:'No scenes loaded yet';"
        "const b=s.board||{},m=s.memory||{},st=s.storage||{};"
        "const fl=st.otaSlots?`${st.otaSlots}x ${Math.round((st.otaSlotBytes||0)/1024)}K OTA + ${Math.round((st.stateBytes||0)/1024)}K state`:"
        "`${Math.round((st.factorySlotBytes||0)/1024)}K app + ${Math.round((st.stateBytes||0)/1024)}K state (no OTA)`;"
        "document.getElementById('board_metrics').innerHTML="
        "`<div class='metric'><b>Board</b>${b.target||'ESP32-S3'}</div>`+"
        "`<div class='metric'><b>Flash</b>${Math.round((st.flashBytes||0)/1024)}K: ${fl}</div>`+"
        "`<div class='metric'><b>PSRAM</b>${Math.round((m.psramFree||0)/1024)}K free / ${Math.round((m.psramTotal||0)/1024)}K</div>`+"
        "`<div class='metric'><b>Wi-Fi</b>${s.wifi?s.wifi.rssi:'?'} dBm</div>`+"
        "`<div class='metric'><b>Assets</b>${s.assets&&s.assets.sdMounted?'SD mounted':(s.assets&&s.assets.sdEnabled?'SD unavailable':'SD off')}</div>`+"
        "(s.assets&&s.assets.sdError?`<div class='metric'><b>SD error</b>${s.assets.sdError}</div>`:'');"
        "const img=document.getElementById('preview');if(s.render&&s.render.previewReady&&!img.getAttribute('src'))refreshPreview();}"
        "function refreshPreview(){const img=document.getElementById('preview');img.src='/image?t='+Date.now();}"
        "function renderNow(){fetch('/reload',{method:'POST'}).then(()=>{let n=0;"
        "const t=setInterval(()=>{refreshPreview();if(++n>=12)clearInterval(t);},2500);});}"
        "function syncScenes(){fetch('/api/action/scenes_sync',{method:'POST'}).then(()=>setTimeout(loadStatus,1500));}"
        "function showScene(){const id=document.getElementById('scene_select').value;if(!id)return;"
        "fetch('/api/action/scene',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'scene_id='+encodeURIComponent(id)})"
        ".then(()=>{loadStatus();renderNow();});}"
        "loadStatus().catch(()=>{});"
        "</script></body></html>") != ESP_OK) return ESP_FAIL;
    return httpd_resp_sendstr_chunk(req, NULL);
}

char *fos_http_status_json(void)
{
    fos_config_t *config = fos_config();
    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();
    char elf_sha[80];
    elf_sha[0] = '\0';
    esp_app_get_elf_sha256(elf_sha, sizeof(elf_sha));
    char pins[FOS_STR_LEN];
    char sd_pins[FOS_STR_LEN];
    fos_config_format_pins(&config->pins, pins, sizeof(pins));
    fos_config_format_assets_sd_pins(&config->assets_sd, sd_pins, sizeof(sd_pins));
    int preview_width = 0, preview_height = 0;
    fos_pixel_format_t preview_format = FOS_PIXEL_1BPP;
    size_t preview_len = 0;
    uint32_t preview_render_count = 0;
    uint32_t render_count = fos_client_render_count();
    int64_t render_ms = fos_client_last_render_ms();
    bool preview_ready = fos_client_snapshot_info(&preview_width, &preview_height, &preview_format,
                                                  &preview_len, &preview_render_count,
                                                  NULL);
    const char *snapshot_mode = fos_client_snapshot_mode();
    bool display_state_ready = fos_client_display_state_ready();
    size_t internal_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    size_t psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    size_t psram_total = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
    const char *scene_json = frameos_nim_scene_info_json();
    if (!scene_json || !scene_json[0]) scene_json = "{\"loaded\":0,\"available\":0,\"hasScene\":false,\"scenes\":[]}";
    fos_storage_info_t storage;
    collect_storage_info(&storage);

    char *cloud_url = json_escape_dup(config->cloud_url);
    char *cloud_frame_id = json_escape_dup(fos_cloud_frame_id());
    char *cloud_error = json_escape_dup(fos_cloud_last_error());
    char *app_name = json_escape_dup(app->project_name);
    char *app_version = json_escape_dup(app->version);
    char *idf_version = json_escape_dup(app->idf_ver);
    char *partition = json_escape_dup(running ? running->label : "?");
    char *ip = json_escape_dup(fos_wifi_ip());
    char *panel = json_escape_dup(config->panel);
    char *pins_json = json_escape_dup(pins);
    char *sd_pins_json = json_escape_dup(sd_pins);
    char *assets_path = json_escape_dup(config->assets_path);
    char *backend = json_escape_dup(config->backend_url);
    char *ssid = json_escape_dup(config->wifi_ssid);
    char *nim_info = json_escape_dup(frameos_nim_info());
    /* Why the card is not mounted, verbatim — "0 assets" with no reason is
     * what makes SD problems unanswerable from the panel. */
    char *sd_error = json_escape_dup(fos_assets_sd_last_error());
    if (!app_name || !app_version || !idf_version || !partition || !ip ||
        !panel || !pins_json || !sd_pins_json || !assets_path || !backend || !ssid || !nim_info ||
        !sd_error || !cloud_url || !cloud_frame_id || !cloud_error) {
        free(app_name); free(app_version); free(idf_version); free(partition); free(ip);
        free(panel); free(pins_json); free(sd_pins_json); free(assets_path); free(backend); free(ssid); free(nim_info);
        free(sd_error);
        free(cloud_url); free(cloud_frame_id); free(cloud_error);
        return NULL;
    }

    char *json = NULL;
    int len = asprintf(&json,
        "{\"app\":\"%s\",\"version\":\"%s\",\"elfSha256\":\"%s\",\"idf\":\"%s\",\"partition\":\"%s\","
        "\"uptimeSec\":%lld,"
        "\"board\":{\"target\":\"esp32-s3\",\"module\":\"Seeed XIAO ESP32-S3 class\",\"display\":\"%s\"},"
        "\"memory\":{\"internalFree\":%u,\"psramFree\":%u,\"psramTotal\":%u},"
        "\"storage\":{\"flashBytes\":%u,\"nvsBytes\":%u,\"otadataBytes\":%u,\"phyBytes\":%u,"
        "\"factorySlotBytes\":%u,\"otaSlots\":%u,\"otaSlotBytes\":%u,\"otaBytes\":%u,"
        "\"stateBytes\":%u},"
        "\"assets\":{\"path\":\"%s\",\"sdEnabled\":%s,\"sdMounted\":%s,\"sdPins\":\"%s\","
        "\"sdMaxFrequencyKHz\":%lu,\"sdCapacityBytes\":%llu,"
        "\"sdErrorCode\":\"%s\",\"sdError\":\"%s\"},"
        "\"ota\":{\"supported\":%s,\"slotBytes\":%u,\"retryAttempts\":64,\"requestMode\":\"early-reboot\","
        "\"resumable\":true,\"bootRequestSupported\":true,"
        "\"partialRequestBytes\":524288,\"wifiSettleMs\":3000},"
        "\"wifi\":{\"state\":%d,\"ip\":\"%s\",\"rssi\":%d,\"timeSynced\":%s},"
        "\"battery\":{\"present\":%s,\"millivolts\":%d,\"percent\":%d},"
        "\"render\":{\"count\":%lu,\"lastMs\":%lld,\"previewReady\":%s,\"previewRenderCount\":%lu,"
        "\"previewWidth\":%d,\"previewHeight\":%d,\"previewFormat\":%d,\"previewBytes\":%u,"
        "\"lastRefreshSkipped\":%s,\"snapshotMode\":\"%s\","
        "\"displayStateReady\":%s,\"panelImageReady\":%s},"
        "\"nim\":{\"info\":\"%s\"},\"scenes\":%s,"
        /* enrollment state only — no claim token, access token, or key */
        "\"cloud\":{\"state\":\"%s\",\"url\":\"%s\",\"frameId\":\"%s\","
        "\"wsConnected\":%s,\"error\":\"%s\"},"
        "\"config\":{\"frameId\":%lu,\"panel\":\"%s\",\"renderMode\":\"%s\","
        "\"intervalSec\":%lu,\"maxHttpResponseBytes\":%lu,"
        "\"serverSendLogs\":%s,\"tlsEnabled\":%s,\"tlsActive\":%s,\"tlsPort\":%u,"
        "\"deepSleep\":%s,\"wakeSchedule\":%s,\"pins\":\"%s\","
        "\"backendUrl\":\"%s\",\"wifiSsid\":\"%s\"}}",
        app_name, app_version, elf_sha, idf_version, partition,
        esp_timer_get_time() / 1000000,
        panel,
        (unsigned)internal_free, (unsigned)psram_free, (unsigned)psram_total,
        (unsigned)storage.flash_bytes, (unsigned)storage.nvs_bytes,
        (unsigned)storage.otadata_bytes, (unsigned)storage.phy_bytes,
        (unsigned)storage.factory_slot_bytes, (unsigned)storage.ota_slots,
        (unsigned)storage.ota_slot_bytes, (unsigned)storage.ota_bytes,
        (unsigned)storage.state_bytes,
        assets_path, config->assets_sd.enabled ? "true" : "false",
        fos_assets_sd_mounted() ? "true" : "false", sd_pins_json,
        (unsigned long)config->assets_sd.max_freq_khz,
        (unsigned long long)fos_assets_sd_capacity_bytes(),
        fos_assets_sd_last_error_code(), sd_error,
        storage.ota_slots > 0 ? "true" : "false", (unsigned)storage.ota_slot_bytes,
        (int)fos_wifi_state(), ip, fos_wifi_rssi(),
        fos_wifi_time_synced() ? "true" : "false",
        fos_battery_present() ? "true" : "false",
        fos_battery_millivolts(), fos_battery_percent(),
        (unsigned long)render_count, render_ms, preview_ready ? "true" : "false",
        (unsigned long)preview_render_count,
        preview_width, preview_height, (int)preview_format, (unsigned)preview_len,
        fos_client_last_refresh_skipped() ? "true" : "false",
        snapshot_mode,
        display_state_ready ? "true" : "false",
        (render_count > 0 || display_state_ready) ? "true" : "false",
        nim_info, scene_json,
        fos_cloud_state_name(), cloud_url, cloud_frame_id,
        fos_cloud_ws_connected() ? "true" : "false", cloud_error,
        (unsigned long)config->frame_id, panel,
        config->render_mode == FOS_RENDER_LOCAL ? "local" : "remote",
        (unsigned long)config->interval_sec,
        (unsigned long)config->max_http_response_bytes,
        config->server_send_logs ? "true" : "false",
        config->tls_enable ? "true" : "false", s_https_server ? "true" : "false", (unsigned)config->tls_port,
        config->deep_sleep ? "true" : "false",
        config->wake_schedule ? "true" : "false",
        pins_json, backend, ssid);
    free(app_name); free(app_version); free(idf_version); free(partition); free(ip);
    free(panel); free(pins_json); free(sd_pins_json); free(assets_path); free(backend); free(ssid); free(nim_info);
    free(sd_error);
    free(cloud_url); free(cloud_frame_id); free(cloud_error);
    if (len < 0 || !json) {
        free(json);
        return NULL;
    }
    return json;
}

static esp_err_t status_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    char *json = fos_http_status_json();
    if (!json) {
        return httpd_resp_send_500(req);
    }
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
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

static const uint8_t PREVIEW_PALETTE_BW[] = {
    0, 0, 0, 255, 255, 255,
};

static const uint8_t PREVIEW_PALETTE_BWR[] = {
    0, 0, 0, 255, 255, 255, 156, 72, 75,
};

static const uint8_t PREVIEW_PALETTE_BWY[] = {
    0, 0, 0, 255, 255, 255, 208, 190, 71,
};

static const uint8_t PREVIEW_PALETTE_GRAY4[] = {
    0, 0, 0, 85, 85, 85, 170, 170, 170, 255, 255, 255,
};

static const uint8_t PREVIEW_PALETTE_GRAY16[] = {
    0, 0, 0, 17, 17, 17, 34, 34, 34, 51, 51, 51,
    68, 68, 68, 85, 85, 85, 102, 102, 102, 119, 119, 119,
    136, 136, 136, 153, 153, 153, 170, 170, 170, 187, 187, 187,
    204, 204, 204, 221, 221, 221, 238, 238, 238, 255, 255, 255,
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

static const uint8_t *preview_palette(fos_pixel_format_t format, size_t *colors)
{
    switch (format) {
        case FOS_PIXEL_1BPP:
            *colors = 2;
            return PREVIEW_PALETTE_BW;
        case FOS_PIXEL_DUAL_1BPP_RED:
            *colors = 3;
            return PREVIEW_PALETTE_BWR;
        case FOS_PIXEL_DUAL_1BPP_YELLOW:
            *colors = 3;
            return PREVIEW_PALETTE_BWY;
        case FOS_PIXEL_2BPP_GRAY:
            *colors = 4;
            return PREVIEW_PALETTE_GRAY4;
        case FOS_PIXEL_2BPP_BWYR:
            *colors = 4;
            return PREVIEW_PALETTE_4;
        case FOS_PIXEL_4BPP_7COLOR:
            *colors = 7;
            return PREVIEW_PALETTE_7;
        case FOS_PIXEL_4BPP_SPECTRA6:
            *colors = 7;
            return PREVIEW_PALETTE_SPECTRA6;
        case FOS_PIXEL_4BPP_GRAY:
            *colors = 16;
            return PREVIEW_PALETTE_GRAY16;
        default:
            *colors = 2;
            return PREVIEW_PALETTE_BW;
    }
}

static uint8_t preview_palette_index(const uint8_t *buf, int width, int height,
                                     fos_pixel_format_t format, int x, int y)
{
    switch (format) {
        case FOS_PIXEL_1BPP: {
            size_t row = ((size_t)width + 7u) / 8u;
            uint8_t bit = 0x80 >> (x & 7);
            return (buf[(size_t)y * row + (size_t)(x >> 3)] & bit) ? 1 : 0;
        }
        case FOS_PIXEL_DUAL_1BPP_RED:
        case FOS_PIXEL_DUAL_1BPP_YELLOW: {
            size_t row = ((size_t)width + 7u) / 8u;
            size_t plane = row * (size_t)y;
            size_t accent_plane = row * (size_t)height;
            size_t offset = plane + (size_t)(x >> 3);
            uint8_t bit = 0x80 >> (x & 7);
            bool black = (buf[offset] & bit) == 0;
            bool accent = (buf[accent_plane + offset] & bit) == 0;
            if (black) return 0;
            return accent ? 2 : 1;
        }
        case FOS_PIXEL_2BPP_GRAY:
        case FOS_PIXEL_2BPP_BWYR:
            return packed_twobit(buf, width, x, y);
        case FOS_PIXEL_4BPP_7COLOR:
        case FOS_PIXEL_4BPP_SPECTRA6:
        case FOS_PIXEL_4BPP_GRAY:
            return packed_nibble(buf, width, x, y);
        default:
            return 1;
    }
}

esp_err_t fos_http_preview_bmp_alloc(uint8_t **out, size_t *out_len, char *scene_id, size_t scene_id_len)
{
    if (out) *out = NULL;
    if (out_len) *out_len = 0;
    if (!out || !out_len) return ESP_ERR_INVALID_ARG;

    int width = 0, height = 0;
    fos_pixel_format_t format = FOS_PIXEL_1BPP;
    size_t packed_len = 0;
    if (!fos_client_snapshot_info(&width, &height, &format, &packed_len, NULL, NULL)) {
        return ESP_ERR_NOT_FOUND;
    }
    if (width <= 0 || height <= 0 || packed_len == 0) {
        return ESP_ERR_NOT_FOUND;
    }

    uint8_t *packed = fos_big_malloc(packed_len);
    if (!packed) packed = malloc(packed_len);
    if (!packed) return ESP_ERR_NO_MEM;
    esp_err_t err = fos_client_snapshot_copy(packed, packed_len, &width, &height, &format, NULL, NULL);
    if (err != ESP_OK) {
        free(packed);
        return ESP_ERR_NOT_FOUND;
    }

    /* The packed snapshot is in PANEL orientation (the packers rotate while
     * packing); previews are served in SCENE orientation like the Pi's, so
     * the UI never shows a sideways image on rotated frames. */
    int rotate = fos_config()->rotate;
    int out_width = (rotate == 90 || rotate == 270) ? height : width;
    int out_height = (rotate == 90 || rotate == 270) ? width : height;

    uint16_t bit_count = format == FOS_PIXEL_1BPP ? 1 : 4;
    size_t palette_entries = bit_count == 1 ? 2 : 16;
    size_t row_payload = (((size_t)out_width * bit_count) + 7u) / 8u;
    size_t row_stride = (row_payload + 3u) & ~3u;
    size_t pixel_bytes = row_stride * (size_t)out_height;
    size_t palette_bytes = palette_entries * 4u;
    if (pixel_bytes > UINT32_MAX - 54u - palette_bytes) {
        free(packed);
        return ESP_ERR_INVALID_SIZE;
    }
    size_t bmp_len = 54u + palette_bytes + pixel_bytes;
    uint8_t *bmp = fos_big_malloc(bmp_len);
    if (!bmp) bmp = malloc(bmp_len);
    if (!bmp) {
        free(packed);
        return ESP_ERR_NO_MEM;
    }
    memset(bmp, 0, bmp_len);

    bmp[0] = 'B'; bmp[1] = 'M';
    put_u32le(&bmp[2], (uint32_t)bmp_len);
    put_u32le(&bmp[10], (uint32_t)(54u + palette_bytes));
    put_u32le(&bmp[14], 40);
    put_u32le(&bmp[18], (uint32_t)out_width);
    put_u32le(&bmp[22], (uint32_t)out_height);
    put_u16le(&bmp[26], 1);
    put_u16le(&bmp[28], bit_count);
    put_u32le(&bmp[34], (uint32_t)pixel_bytes);
    put_u32le(&bmp[46], (uint32_t)palette_entries);
    put_u32le(&bmp[50], (uint32_t)palette_entries);

    uint8_t *palette = bmp + 54u;
    memset(palette, 255, palette_bytes);
    size_t colors = 0;
    const uint8_t *rgb = preview_palette(format, &colors);
    for (size_t i = 0; i < palette_entries; i++) {
        size_t src = i < colors ? i : 1;
        palette[i * 4u] = rgb[src * 3u + 2u];
        palette[i * 4u + 1u] = rgb[src * 3u + 1u];
        palette[i * 4u + 2u] = rgb[src * 3u];
        palette[i * 4u + 3u] = 0;
    }

    if (scene_id && scene_id_len > 0) {
        current_scene_id(scene_id, scene_id_len);
    }
    uint8_t *pixels = bmp + 54u + palette_bytes;
    size_t row_index = 0;
    for (int y = out_height - 1; y >= 0; y--) {
        uint8_t *row = pixels + row_index * row_stride;
        memset(row, 0, row_stride);
        for (int x = 0; x < out_width; x++) {
            /* Scene (x,y) → the panel position the packer put it at (the
             * same mapping embedded_main.panelCoords applies). */
            int px = x, py = y;
            switch (rotate) {
                case 90: px = out_height - 1 - y; py = x; break;
                case 180: px = out_width - 1 - x; py = out_height - 1 - y; break;
                case 270: px = y; py = out_width - 1 - x; break;
                default: break;
            }
            uint8_t index = preview_palette_index(packed, width, height, format, px, py);
            if (bit_count == 1) {
                if (index & 1u) row[(size_t)x >> 3] |= 0x80 >> (x & 7);
            } else if (x & 1) {
                row[(size_t)x >> 1] |= index & 0x0F;
            } else {
                row[(size_t)x >> 1] |= (index & 0x0F) << 4;
            }
        }
        row_index++;
    }

    free(packed);
    *out = bmp;
    *out_len = bmp_len;
    return ESP_OK;
}

static esp_err_t preview_bmp_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    uint8_t *bmp = NULL;
    size_t bmp_len = 0;
    char scene_id[128];
    scene_id[0] = '\0';
    esp_err_t err = fos_http_preview_bmp_alloc(&bmp, &bmp_len, scene_id, sizeof(scene_id));
    if (err == ESP_ERR_NOT_FOUND) {
        const char *reason = strcmp(fos_client_snapshot_mode(), "hash-only") == 0
            ? "panel image is rendered, but preview snapshot was not retained"
            : "no preview rendered yet";
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, reason);
    }
    if (err == ESP_ERR_INVALID_SIZE) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "preview too large");
    }
    if (err != ESP_OK) {
        return httpd_resp_send_500(req);
    }
    httpd_resp_set_type(req, "image/bmp");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    if (scene_id[0]) {
        httpd_resp_set_hdr(req, "X-Scene-Id", scene_id);
    }
    err = httpd_resp_send(req, (const char *)bmp, bmp_len);
    free(bmp);
    return err;
}

static esp_err_t setup_post_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

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
    bool next_admin_auth_enabled = config->admin_auth_enabled;
    char next_admin_user[FOS_STR_LEN];
    char next_admin_pass[FOS_STR_LEN];
    strlcpy(next_admin_user, config->admin_user, sizeof(next_admin_user));
    strlcpy(next_admin_pass, config->admin_pass, sizeof(next_admin_pass));
    if (form_value(body, "admin_auth", value, sizeof(value))) next_admin_auth_enabled = atoi(value) != 0;
    if (form_value(body, "admin_user", value, sizeof(value))) strlcpy(next_admin_user, value, sizeof(next_admin_user));
    if (form_value(body, "admin_pass", value, sizeof(value)) && value[0]) {
        strlcpy(next_admin_pass, value, sizeof(next_admin_pass));
    }
    if (next_admin_auth_enabled && (!next_admin_user[0] || !next_admin_pass[0])) {
        free(body);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "admin username and password required");
    }

    if (form_value(body, "ssid", value, sizeof(value))) strlcpy(config->wifi_ssid, value, sizeof(config->wifi_ssid));
    if (form_value(body, "pass", value, sizeof(value)) && value[0]) {
        strlcpy(config->wifi_pass, value, sizeof(config->wifi_pass));
    }
    if (form_value(body, "backend", value, sizeof(value))) strlcpy(config->backend_url, value, sizeof(config->backend_url));
    if (form_value(body, "tls_enable", value, sizeof(value))) config->tls_enable = atoi(value) != 0;
    if (form_value(body, "tls_port", value, sizeof(value))) {
        long port = strtol(value, NULL, 10);
        if (port >= 1 && port <= 65535) config->tls_port = (uint16_t)port;
    }
    if (form_value(body, "api_key", value, sizeof(value)) && value[0]) {
        strlcpy(config->api_key, value, sizeof(config->api_key));
    }
    config->admin_auth_enabled = next_admin_auth_enabled;
    strlcpy(config->admin_user, next_admin_user, sizeof(config->admin_user));
    strlcpy(config->admin_pass, next_admin_pass, sizeof(config->admin_pass));
    if (form_value(body, "frame_id", value, sizeof(value))) config->frame_id = strtoul(value, NULL, 10);
    if (form_value(body, "panel", value, sizeof(value))) strlcpy(config->panel, value, sizeof(config->panel));
    if (form_value(body, "render_mode", value, sizeof(value))) config->render_mode = atoi(value) ? FOS_RENDER_REMOTE : FOS_RENDER_LOCAL;
    if (form_value(body, "server_send_logs", value, sizeof(value))) config->server_send_logs = atoi(value) != 0;
    if (form_value(body, "interval", value, sizeof(value)) && atoi(value) >= 5) config->interval_sec = atoi(value);
    if (form_value(body, "pins", value, sizeof(value))) fos_config_parse_pins(value, &config->pins);
    if (form_value(body, "assets_path", value, sizeof(value))) strlcpy(config->assets_path, value, sizeof(config->assets_path));
    if (form_value(body, "assets_sd_enable", value, sizeof(value))) config->assets_sd.enabled = atoi(value) != 0;
    if (form_value(body, "assets_sd_pins", value, sizeof(value))) fos_config_parse_assets_sd_pins(value, &config->assets_sd);
    if (form_value(body, "assets_sd_freq", value, sizeof(value))) {
        uint32_t freq = strtoul(value, NULL, 10);
        if (freq >= 400 && freq <= 40000) config->assets_sd.max_freq_khz = freq;
    }
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
    REQUIRE_PROTECTED_ACCESS();
    keep_awake_for_http_mutation();

    fos_action_cb cb = (fos_action_cb)req->user_ctx;
    if (!cb) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "action not available");
    }
    log_http_command_from_path(req, 0);
    cb();
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}

static esp_err_t scenes_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    const char *json = frameos_nim_scene_info_json();
    if (!json || !json[0]) {
        json = "{\"loaded\":0,\"available\":0,\"hasScene\":false,\"scenes\":[]}";
    }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, json);
}

static esp_err_t scene_state_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    const char *json = frameos_nim_scene_state_json();
    if (!json || !json[0]) {
        json = "{}";
    }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, json);
}

static esp_err_t state_alias_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    const char *state_json = frameos_nim_scene_state_json();
    if (!state_json || !state_json[0]) state_json = "{}";
    char scene_id[128];
    current_scene_id(scene_id, sizeof(scene_id));
    char *scene = json_escape_dup(scene_id);
    if (!scene) return httpd_resp_send_500(req);

    char *json = NULL;
    int len = asprintf(&json, "{\"sceneId\":\"%s\",\"state\":%s}", scene, state_json);
    free(scene);
    if (len < 0 || !json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send(req, json, len);
    free(json);
    return err;
}

static esp_err_t states_alias_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    const char *state_json = frameos_nim_scene_state_json();
    if (!state_json || !state_json[0]) state_json = "{}";
    char scene_id[128];
    current_scene_id(scene_id, sizeof(scene_id));
    char *scene = json_escape_dup(scene_id);
    if (!scene) return httpd_resp_send_500(req);

    char *json = NULL;
    int len;
    if (scene_id[0]) {
        len = asprintf(&json, "{\"sceneId\":\"%s\",\"states\":{\"%s\":%s}}",
                       scene, scene, state_json);
    } else {
        len = asprintf(&json, "{\"sceneId\":\"\",\"states\":{}}");
    }
    free(scene);
    if (len < 0 || !json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send(req, json, len);
    free(json);
    return err;
}

static esp_err_t uploaded_scenes_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    const char *json = frameos_nim_scene_info_json();
    if (!json || !json[0]) {
        json = "{\"loaded\":0,\"available\":0,\"hasScene\":false,\"scenes\":[]}";
    }
    char *payload = NULL;
    int len = asprintf(&payload, "{\"scenes\":%s}", json);
    if (len < 0 || !payload) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send(req, payload, len);
    free(payload);
    return err;
}

static esp_err_t ping_get_handler(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_send(req, "pong", HTTPD_RESP_USE_STRLEN);
}

static esp_err_t api_apps_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"apps\":[]}", HTTPD_RESP_USE_STRLEN);
}

static esp_err_t frame_api_ping_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req,
        "{\"ok\":true,\"mode\":\"http\",\"target\":\"frame\","
        "\"elapsed_ms\":0,\"status\":200,\"message\":\"pong\"}",
        HTTPD_RESP_USE_STRLEN);
}

static esp_err_t send_cjson_response(httpd_req_t *req, cJSON *root)
{
    char *json = cJSON_PrintUnformatted(root);
    if (!json) {
        return httpd_resp_send_500(req);
    }
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
    cJSON_free(json);
    return err;
}

static cJSON *frame_api_stored_scenes_json(void)
{
    size_t len = 0;
    char *stored = fos_scenes_json_copy(&len);
    cJSON *scenes = stored ? cJSON_Parse(stored) : NULL;
    free(stored);
    if (!cJSON_IsArray(scenes)) {
        cJSON_Delete(scenes);
        scenes = cJSON_CreateArray();
    }
    return scenes;
}

static cJSON *frame_api_frame_json(void)
{
    fos_config_t *config = fos_config();
    cJSON *frame = cJSON_CreateObject();
    if (!frame) return NULL;

    char fallback_name[32];
    snprintf(fallback_name, sizeof(fallback_name), "frame %lu", (unsigned long)config->frame_id);
    char device[160];
    snprintf(device, sizeof(device), "waveshare.%s", config->panel[0] ? config->panel : "none");
    int width = fos_display_present() ? fos_display_width() : 800;
    int height = fos_display_present() ? fos_display_height() : 480;

    cJSON_AddNumberToObject(frame, "id", config->frame_id);
    cJSON_AddNumberToObject(frame, "project_id", 0);
    cJSON_AddStringToObject(frame, "name", config->hostname[0] ? config->hostname : fallback_name);
    cJSON_AddStringToObject(frame, "mode", "embedded");
    cJSON_AddStringToObject(frame, "frame_host", fos_wifi_ip());
    cJSON_AddNumberToObject(frame, "frame_port", 80);
    cJSON_AddStringToObject(frame, "frame_access_key", "");
    cJSON_AddStringToObject(frame, "frame_access", "private");

    cJSON *admin = cJSON_CreateObject();
    cJSON_AddBoolToObject(admin, "enabled", config->admin_auth_enabled);
    cJSON_AddStringToObject(admin, "user", config->admin_user);
    cJSON_AddStringToObject(admin, "pass", config->admin_pass);
    cJSON_AddItemToObject(frame, "frame_admin_auth", admin);

    cJSON *https = cJSON_CreateObject();
    cJSON_AddBoolToObject(https, "enable", config->tls_enable);
    cJSON_AddNumberToObject(https, "port", config->tls_port ? config->tls_port : 8443);
    cJSON_AddBoolToObject(https, "expose_only_port", true);
    cJSON *certs = cJSON_CreateObject();
    cJSON_AddStringToObject(certs, "server", config->tls_server_cert);
    cJSON_AddStringToObject(certs, "server_key", config->tls_server_key);
    cJSON_AddStringToObject(certs, "client_ca", "");
    cJSON_AddItemToObject(https, "certs", certs);
    cJSON_AddNullToObject(https, "server_cert_not_valid_after");
    cJSON_AddNullToObject(https, "client_ca_cert_not_valid_after");
    cJSON_AddItemToObject(frame, "https_proxy", https);

    cJSON_AddStringToObject(frame, "ssh_user", "");
    cJSON_AddStringToObject(frame, "ssh_pass", "");
    cJSON_AddNumberToObject(frame, "ssh_port", 22);
    cJSON_AddItemToObject(frame, "ssh_keys", cJSON_CreateArray());
    cJSON_AddStringToObject(frame, "server_host", config->backend_url);
    cJSON_AddNumberToObject(frame, "server_port", 0);
    cJSON_AddStringToObject(frame, "server_api_key", config->api_key);
    cJSON_AddBoolToObject(frame, "server_send_logs", config->server_send_logs);
    cJSON_AddStringToObject(frame, "status", "online");
    cJSON_AddBoolToObject(frame, "archived", false);
    cJSON_AddNullToObject(frame, "version");
    cJSON_AddNumberToObject(frame, "width", width);
    cJSON_AddNumberToObject(frame, "height", height);
    cJSON_AddStringToObject(frame, "device", device);

    cJSON *device_config = cJSON_CreateObject();
    cJSON_AddStringToObject(device_config, "renderMode",
                            config->render_mode == FOS_RENDER_REMOTE ? "remote" : "local");
    cJSON_AddItemToObject(frame, "device_config", device_config);

    cJSON_AddNullToObject(frame, "color");
    cJSON_AddNullToObject(frame, "timezone");
    cJSON_AddNullToObject(frame, "timezone_updater");
    cJSON_AddNumberToObject(frame, "interval", config->interval_sec);
    cJSON_AddNumberToObject(frame, "metrics_interval", 60);
    cJSON_AddNumberToObject(frame, "max_http_response_bytes", config->max_http_response_bytes);
    cJSON_AddStringToObject(frame, "scaling_mode", "contain");
    cJSON_AddStringToObject(frame, "image_engine", "");
    cJSON_AddNumberToObject(frame, "rotate", fos_config()->rotate);
    cJSON_AddStringToObject(frame, "flip", "");
    cJSON_AddStringToObject(frame, "background_color", "#000000");
    cJSON_AddItemToObject(frame, "scenes", frame_api_stored_scenes_json());
    cJSON_AddBoolToObject(frame, "debug", false);
    cJSON_AddNullToObject(frame, "last_log_at");
    cJSON_AddStringToObject(frame, "log_to_file", "");
    cJSON_AddStringToObject(frame, "assets_path", config->assets_path);
    cJSON_AddBoolToObject(frame, "save_assets", false);
    cJSON_AddStringToObject(frame, "upload_fonts", "");
    cJSON_AddNullToObject(frame, "reboot");

    cJSON *schedule = cJSON_CreateObject();
    cJSON_AddItemToObject(schedule, "events", cJSON_CreateArray());
    cJSON_AddItemToObject(frame, "schedule", schedule);

    cJSON *buttons = cJSON_CreateArray();
    for (size_t i = 0; i < config->gpio_button_count; i++) {
        cJSON *button = cJSON_CreateObject();
        cJSON_AddNumberToObject(button, "pin", config->gpio_buttons[i].pin);
        cJSON_AddStringToObject(button, "label", config->gpio_buttons[i].label);
        cJSON_AddItemToArray(buttons, button);
    }
    cJSON_AddItemToObject(frame, "gpio_buttons", buttons);

    cJSON *network = cJSON_CreateObject();
    cJSON_AddStringToObject(network, "wifiSSID", config->wifi_ssid);
    cJSON_AddStringToObject(network, "wifiPassword", config->wifi_pass);
    cJSON_AddItemToObject(frame, "network", network);

    cJSON_AddItemToObject(frame, "agent", cJSON_CreateObject());
    cJSON_AddItemToObject(frame, "mountpoints", cJSON_CreateObject());
    cJSON_AddItemToObject(frame, "error_behavior", cJSON_CreateObject());
    cJSON_AddItemToObject(frame, "palette", cJSON_CreateObject());
    cJSON_AddNullToObject(frame, "buildroot");
    cJSON_AddItemToObject(frame, "embedded", cJSON_CreateObject());
    cJSON_AddNullToObject(frame, "rpios");
    cJSON_AddItemToObject(frame, "terminal_history", cJSON_CreateArray());
    cJSON_AddNullToObject(frame, "last_successful_deploy");
    cJSON_AddNullToObject(frame, "last_successful_deploy_at");
    return frame;
}

static esp_err_t frame_api_frame_payload(httpd_req_t *req, bool list)
{
    cJSON *root = cJSON_CreateObject();
    if (!root) return httpd_resp_send_500(req);
    cJSON *frame = frame_api_frame_json();
    if (!frame) {
        cJSON_Delete(root);
        return httpd_resp_send_500(req);
    }
    if (list) {
        cJSON *frames = cJSON_CreateArray();
        cJSON_AddItemToArray(frames, frame);
        cJSON_AddItemToObject(root, "frames", frames);
    } else {
        cJSON_AddItemToObject(root, "frame", frame);
    }
    esp_err_t err = send_cjson_response(req, root);
    cJSON_Delete(root);
    return err;
}

static esp_err_t frames_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    return frame_api_frame_payload(req, true);
}

static esp_err_t frame_detail_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    return frame_api_frame_payload(req, false);
}

static bool json_bool_item(const cJSON *item, bool fallback)
{
    if (cJSON_IsBool(item)) return cJSON_IsTrue(item);
    if (cJSON_IsNumber(item)) return item->valueint != 0;
    return fallback;
}

static bool json_copy_string_item(const cJSON *object, const char *key, char *out, size_t out_len)
{
    const cJSON *item = cJSON_GetObjectItem(object, key);
    if (!cJSON_IsString(item) || !item->valuestring) return false;
    strlcpy(out, item->valuestring, out_len);
    return true;
}

static bool json_u32_item(const cJSON *object, const char *key, uint32_t *out)
{
    const cJSON *item = cJSON_GetObjectItem(object, key);
    if (!cJSON_IsNumber(item) || item->valuedouble < 0) return false;
    *out = (uint32_t)item->valuedouble;
    return true;
}

static void update_backend_url_from_frame_payload(fos_config_t *config, const cJSON *root)
{
    const cJSON *server_host = cJSON_GetObjectItem(root, "server_host");
    if (!cJSON_IsString(server_host) || !server_host->valuestring || !server_host->valuestring[0]) return;

    if (strstr(server_host->valuestring, "://")) {
        strlcpy(config->backend_url, server_host->valuestring, sizeof(config->backend_url));
        return;
    }

    uint32_t port = 8989;
    json_u32_item(root, "server_port", &port);
    snprintf(config->backend_url, sizeof(config->backend_url), "http://%s:%lu",
             server_host->valuestring, (unsigned long)port);
}

static esp_err_t frame_update_post_handler(httpd_req_t *req)
{
    keep_awake_for_http_mutation();

    char *body = NULL;
    esp_err_t read_err = read_request_body(req, 512 * 1024, true, &body);
    if (read_err == ESP_ERR_INVALID_SIZE) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad length");
    }
    if (read_err != ESP_OK) return httpd_resp_send_500(req);

    cJSON *root = body && body[0] ? cJSON_Parse(body) : cJSON_CreateObject();
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        free(body);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid json");
    }

    fos_config_t *config = fos_config();
    uint32_t value = 0;
    if (json_u32_item(root, "interval", &value) && value >= 5) config->interval_sec = value;
    if (json_u32_item(root, "max_http_response_bytes", &value) && value >= 1024) {
        config->max_http_response_bytes = value;
    }
    json_copy_string_item(root, "server_api_key", config->api_key, sizeof(config->api_key));
    update_backend_url_from_frame_payload(config, root);

    const cJSON *send_logs = cJSON_GetObjectItem(root, "server_send_logs");
    if (send_logs != NULL) config->server_send_logs = json_bool_item(send_logs, config->server_send_logs);

    const cJSON *network = cJSON_GetObjectItem(root, "network");
    if (cJSON_IsObject(network)) {
        json_copy_string_item(network, "wifiSSID", config->wifi_ssid, sizeof(config->wifi_ssid));
        json_copy_string_item(network, "wifiPassword", config->wifi_pass, sizeof(config->wifi_pass));
    }

    const cJSON *device_config = cJSON_GetObjectItem(root, "device_config");
    if (cJSON_IsObject(device_config)) {
        const cJSON *render_mode = cJSON_GetObjectItem(device_config, "renderMode");
        if (cJSON_IsString(render_mode) && render_mode->valuestring) {
            config->render_mode = strcmp(render_mode->valuestring, "remote") == 0 ? FOS_RENDER_REMOTE : FOS_RENDER_LOCAL;
        }
    }

    const cJSON *admin = cJSON_GetObjectItem(root, "frame_admin_auth");
    if (cJSON_IsObject(admin)) {
        bool next_enabled = config->admin_auth_enabled;
        const cJSON *enabled = cJSON_GetObjectItem(admin, "enabled");
        if (enabled != NULL) next_enabled = json_bool_item(enabled, next_enabled);
        char next_user[FOS_STR_LEN];
        char next_pass[FOS_STR_LEN];
        strlcpy(next_user, config->admin_user, sizeof(next_user));
        strlcpy(next_pass, config->admin_pass, sizeof(next_pass));
        json_copy_string_item(admin, "user", next_user, sizeof(next_user));
        json_copy_string_item(admin, "pass", next_pass, sizeof(next_pass));
        if (next_enabled && (!next_user[0] || !next_pass[0])) {
            cJSON_Delete(root);
            free(body);
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "admin username and password required");
        }
        config->admin_auth_enabled = next_enabled;
        strlcpy(config->admin_user, next_user, sizeof(config->admin_user));
        strlcpy(config->admin_pass, next_pass, sizeof(config->admin_pass));
    }

    const cJSON *https = cJSON_GetObjectItem(root, "https_proxy");
    if (cJSON_IsObject(https)) {
        const cJSON *enabled = cJSON_GetObjectItem(https, "enable");
        if (enabled != NULL) config->tls_enable = json_bool_item(enabled, config->tls_enable);
        if (json_u32_item(https, "port", &value) && value >= 1 && value <= 65535) {
            config->tls_port = (uint16_t)value;
        }
        const cJSON *certs = cJSON_GetObjectItem(https, "certs");
        if (cJSON_IsObject(certs)) {
            json_copy_string_item(certs, "server", config->tls_server_cert, sizeof(config->tls_server_cert));
            json_copy_string_item(certs, "server_key", config->tls_server_key, sizeof(config->tls_server_key));
        }
    }

    bool scenes_updated = false;
    const cJSON *scenes = cJSON_GetObjectItem(root, "scenes");
    if (cJSON_IsArray(scenes)) {
        char *scenes_json = cJSON_PrintUnformatted((cJSON *)scenes);
        if (!scenes_json) {
            cJSON_Delete(root);
            free(body);
            return httpd_resp_send_500(req);
        }
        esp_err_t scenes_err = fos_scenes_set_json(scenes_json, strlen(scenes_json));
        cJSON_free(scenes_json);
        if (scenes_err != ESP_OK) {
            cJSON_Delete(root);
            free(body);
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "store scenes failed");
        }
        scenes_updated = true;
    }

    esp_err_t save_err = fos_config_save();
    if (save_err != ESP_OK) {
        cJSON_Delete(root);
        free(body);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "save failed");
    }

    const cJSON *next_action = cJSON_GetObjectItem(root, "next_action");
    bool render = scenes_updated || (cJSON_IsString(next_action) && strcmp(next_action->valuestring, "render") == 0);
    log_http_command(req, "frameUpdate", strlen(body ? body : ""));
    cJSON_Delete(root);
    free(body);

    if (render && s_render_cb) s_render_cb();

    cJSON *response = cJSON_CreateObject();
    if (!response) return httpd_resp_send_500(req);
    cJSON_AddStringToObject(response, "message", "Frame updated successfully");
    cJSON *frame = frame_api_frame_json();
    if (!frame) {
        cJSON_Delete(response);
        return httpd_resp_send_500(req);
    }
    cJSON_AddItemToObject(response, "frame", frame);
    esp_err_t err = send_cjson_response(req, response);
    cJSON_Delete(response);
    return err;
}

static esp_err_t reload_post_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();
    keep_awake_for_http_mutation();

    log_http_command(req, "reload", 0);
    fos_scenes_request_sync();
    if (s_render_cb) s_render_cb();
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"status\":\"ok\",\"queued\":true}", HTTPD_RESP_USE_STRLEN);
}

static void log_http_command(httpd_req_t *req, const char *event_name, size_t body_len)
{
    char path[256];
    if (!copy_request_path(req, path, sizeof(path))) {
        strlcpy(path, req->uri, sizeof(path));
    }
    char *escaped_path = json_escape_dup(path);
    char *escaped_event = json_escape_dup(event_name);
    if (!escaped_path || !escaped_event) {
        free(escaped_path);
        free(escaped_event);
        return;
    }

    char log_line[640];
    snprintf(log_line, sizeof(log_line),
             "{\"event\":\"http:command\",\"source\":\"esp32\",\"method\":\"POST\","
             "\"path\":\"%s\",\"command\":\"%s\",\"bodyBytes\":%u}",
             escaped_path, escaped_event, (unsigned)body_len);
    free(escaped_path);
    free(escaped_event);
    frameos_nim_log_hook(log_line);
}

static void log_http_command_from_path(httpd_req_t *req, size_t body_len)
{
    char path[256];
    if (!copy_request_path(req, path, sizeof(path))) {
        log_http_command(req, "http", body_len);
        return;
    }
    const char *slash = strrchr(path, '/');
    log_http_command(req, slash && slash[1] ? slash + 1 : path, body_len);
}

static esp_err_t handle_event_post(httpd_req_t *req, const char *event_name)
{
    if (!event_name || !event_name[0]) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing event");
    }
    keep_awake_for_http_mutation();

    char *body = NULL;
    esp_err_t err = read_request_body(req, 64 * 1024, true, &body);
    if (err == ESP_ERR_INVALID_SIZE) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad length");
    }
    if (err != ESP_OK) return httpd_resp_send_500(req);
    const char *payload = body && body[0] ? body : "{}";
    log_http_command(req, event_name, body ? strlen(body) : 0);

    bool ok = true;
    if (strcmp(event_name, "render") == 0) {
        if (s_render_cb) s_render_cb();
    } else if (strcmp(event_name, "reload") == 0) {
        fos_scenes_request_sync();
        if (s_render_cb) s_render_cb();
    } else if (strcmp(event_name, "uploadScenes") == 0) {
        ok = fos_http_store_uploaded_scenes_payload(payload, strlen(payload)) == ESP_OK;
        if (ok && s_render_cb) s_render_cb();
    } else if (strcmp(event_name, "setCurrentScene") == 0) {
        char scene_id[128];
        if (json_string_value(payload, "sceneId", scene_id, sizeof(scene_id)) ||
            json_string_value(payload, "scene_id", scene_id, sizeof(scene_id))) {
            ok = fos_scenes_select(scene_id) == ESP_OK;
            if (ok && s_render_cb) s_render_cb();
        } else {
            ok = false;
        }
    } else if (frameos_nim_available()) {
        ok = frameos_nim_send_event(event_name, payload);
        if (frameos_nim_render_requested() && s_render_cb) s_render_cb();
    } else {
        ok = false;
    }
    free(body);
    if (!ok) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "event rejected");
    }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"status\":\"ok\"}", HTTPD_RESP_USE_STRLEN);
}

static esp_err_t event_post_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    char path[256];
    if (!copy_request_path(req, path, sizeof(path))) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "URI too long");
    }
    const char *prefix = "/event/";
    if (strncmp(path, prefix, strlen(prefix)) != 0) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
    }
    char event_name[96];
    strlcpy(event_name, path + strlen(prefix), sizeof(event_name));
    url_decode(event_name);
    return handle_event_post(req, event_name);
}

/* ------------------------------------------------------- logs + metrics */

/* {"logs":[{"timestamp":…,"type":"webhook","line":"<raw json>"}…]} — the
 * same row shape the backend serves, so the standalone/frame-admin Logs
 * panel renders these identically. */
static esp_err_t logs_get_handler(httpd_req_t *req)
{
    frameos_log_entry_t *entries = calloc(FOS_NIM_LOG_RING_CAP, sizeof(*entries));
    if (!entries) return httpd_resp_send_500(req);
    size_t count = frameos_nim_log_recent(entries, FOS_NIM_LOG_RING_CAP);
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send_chunk(req, "{\"logs\":[", 9);
    for (size_t i = 0; i < count && err == ESP_OK; i++) {
        char *escaped = json_escape_dup(entries[i].line);
        if (!escaped) break;
        char head[64];
        int head_len;
        if (entries[i].timestamp > 1e9) {
            head_len = snprintf(head, sizeof(head), "%s{\"timestamp\":%.0f,",
                                i ? "," : "", entries[i].timestamp);
        } else {
            head_len = snprintf(head, sizeof(head), "%s{", i ? "," : "");
        }
        err = httpd_resp_send_chunk(req, head, head_len);
        if (err == ESP_OK) err = httpd_resp_send_chunk(req, "\"type\":\"webhook\",\"line\":\"", 25);
        if (err == ESP_OK) err = httpd_resp_send_chunk(req, escaped, strlen(escaped));
        if (err == ESP_OK) err = httpd_resp_send_chunk(req, "\"}", 2);
        free(escaped);
    }
    for (size_t i = 0; i < count; i++) free(entries[i].line);
    free(entries);
    if (err == ESP_OK) err = httpd_resp_send_chunk(req, "]}", 2);
    if (err == ESP_OK) err = httpd_resp_send_chunk(req, NULL, 0);
    return err;
}

static esp_err_t metrics_get_handler(httpd_req_t *req)
{
    fos_metrics_sample_t *samples = calloc(32, sizeof(*samples));
    if (!samples) return httpd_resp_send_500(req);
    size_t count = fos_client_metrics_recent(samples, 32);
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send_chunk(req, "{\"metrics\":[", 12);
    for (size_t i = 0; i < count && err == ESP_OK; i++) {
        char head[64];
        int head_len = snprintf(head, sizeof(head), "%s{%s",
                                i ? "," : "",
                                samples[i].timestamp > 1e9 ? "" : "\"timestamp\":null,");
        if (samples[i].timestamp > 1e9) {
            head_len = snprintf(head, sizeof(head), "%s{\"timestamp\":%.0f,",
                                i ? "," : "", samples[i].timestamp);
        }
        err = httpd_resp_send_chunk(req, head, head_len);
        if (err == ESP_OK) err = httpd_resp_send_chunk(req, "\"metrics\":", 10);
        if (err == ESP_OK) err = httpd_resp_send_chunk(req, samples[i].json, strlen(samples[i].json));
        if (err == ESP_OK) err = httpd_resp_send_chunk(req, "}", 1);
    }
    for (size_t i = 0; i < count; i++) free(samples[i].json);
    free(samples);
    if (err == ESP_OK) err = httpd_resp_send_chunk(req, "]}", 2);
    if (err == ESP_OK) err = httpd_resp_send_chunk(req, NULL, 0);
    return err;
}

/* --------------------------------------------------------- restart action */

static void restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(750)); /* let the HTTP response flush first */
    esp_restart();
}

/* POST /api/action/restart and /api/action/reboot: on ESP32 the runtime is
 * the firmware, so both are a chip reset. The backend's restart/reboot
 * tasks call these instead of systemd-over-SSH. */
static esp_err_t restart_post_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();
    log_http_command_from_path(req, 0);
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
    if (xTaskCreate(restart_task, "fos_restart", 2048, NULL, 5, NULL) != pdPASS) {
        esp_restart();
    }
    return err;
}

/* ---------------------------------------------------------- asset routes */

/* Query strings on asset routes carry the (url-encoded) path plus, for
 * chunked uploads, upload_id/offset/complete. */
#define FOS_ASSETS_QUERY_MAX (FOS_ASSETS_PATH_MAX + 192)

/* Pull one url-decoded query parameter; false when absent or truncated. */
static bool asset_query_param(httpd_req_t *req, const char *key, char *out, size_t out_len)
{
    char query[FOS_ASSETS_QUERY_MAX];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) return false;
    if (httpd_query_key_value(query, key, out, out_len) != ESP_OK) return false;
    url_decode(out);
    return true;
}

/* Pull a sanitized asset path out of the request's query string. */
static bool asset_query_path(httpd_req_t *req, bool write_rule, char *out, size_t out_len)
{
    char raw[FOS_ASSETS_PATH_MAX];
    if (!asset_query_param(req, "path", raw, sizeof(raw))) return false;
    return write_rule ? fos_assets_sanitize_write_path(raw, out, out_len)
                      : fos_assets_sanitize_path(raw, out, out_len);
}

static esp_err_t assets_list_get_handler(httpd_req_t *req)
{
    cJSON *msg = cJSON_CreateObject();
    if (!msg) return httpd_resp_send_500(req);
    cJSON *assets = cJSON_AddArrayToObject(msg, "assets");
    bool truncated = false;
    bool ok = assets && fos_assets_list_json(assets, &truncated);
    if (truncated) cJSON_AddBoolToObject(msg, "truncated", true);
    cJSON_AddBoolToObject(msg, "mounted", fos_assets_available());
    char *body = ok ? cJSON_PrintUnformatted(msg) : NULL;
    cJSON_Delete(msg);
    if (!body) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_sendstr(req, body);
    cJSON_free(body);
    return err;
}

static esp_err_t asset_file_get_handler(httpd_req_t *req)
{
    char rel[FOS_ASSETS_PATH_MAX];
    if (!asset_query_path(req, false, rel, sizeof(rel))) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid path");
    }
    struct stat st;
    if (fos_assets_stat(rel, &st) != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
    }
    if (S_ISDIR(st.st_mode)) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "is a directory");
    }
    char full[FOS_ASSETS_FULL_PATH_MAX];
    fos_assets_full_path(full, sizeof(full), rel);
    FILE *file = fopen(full, "rb");
    if (!file) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
    }
    httpd_resp_set_type(req, fos_assets_content_type(rel));
    size_t cap = 16 * 1024;
    char *chunk = fos_big_malloc(cap);
    if (!chunk) {
        cap = 4096;
        chunk = malloc(cap);
    }
    if (!chunk) {
        fclose(file);
        return httpd_resp_send_500(req);
    }
    esp_err_t err = ESP_OK;
    while (err == ESP_OK) {
        size_t r = fread(chunk, 1, cap, file);
        if (ferror(file)) {
            err = ESP_FAIL;
            break;
        }
        err = httpd_resp_send_chunk(req, chunk, r);
        if (r == 0) break; /* final zero-length chunk ends the response */
    }
    free(chunk);
    fclose(file);
    return err;
}

/* How many consecutive soft recv timeouts (recv_wait_timeout, 5s each) to
 * ride out before giving up on an upload chunk. Slow links stall; a stall
 * is only fatal once it outlives ~30s. */
#define FOS_UPLOAD_RECV_STALL_LIMIT 6

static esp_err_t asset_upload_post_handler(httpd_req_t *req)
{
    keep_awake_for_http_mutation();
    char rel[FOS_ASSETS_PATH_MAX];
    if (!asset_query_path(req, true, rel, sizeof(rel))) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid path");
    }
    if (!fos_assets_available()) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "assets storage not mounted");
    }
    int total = req->content_len;
    if (total <= 0) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad length");
    }
    /* Chunked mode: bytes accumulate in a part file across requests sharing
     * upload_id; complete=1 commits the part to `path`. Offsets make chunk
     * retries idempotent (a resent chunk overwrites itself). */
    char upload_id[FOS_ASSETS_UPLOAD_ID_MAX] = "";
    bool chunked = asset_query_param(req, "upload_id", upload_id, sizeof(upload_id));
    long long offset = 0;
    bool complete = true;
    if (chunked) {
        if (!fos_assets_valid_upload_id(upload_id)) {
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid upload id");
        }
        char val[24];
        if (asset_query_param(req, "offset", val, sizeof(val))) offset = atoll(val);
        if (asset_query_param(req, "complete", val, sizeof(val))) {
            complete = strcmp(val, "1") == 0;
        }
    }
    const char *asset_err = NULL;
    fos_assets_writer_t writer;
    esp_err_t begin = chunked
        ? fos_assets_chunk_begin(upload_id, offset, &writer, &asset_err)
        : fos_assets_write_begin(rel, &writer, &asset_err);
    if (begin != ESP_OK) {
        if (asset_err && strcmp(asset_err, "chunk_gap") == 0) {
            /* An earlier chunk is missing — client must restart from 0. */
            httpd_resp_set_status(req, "409 Conflict");
            httpd_resp_set_type(req, "application/json");
            return httpd_resp_sendstr(req, "{\"error\":\"chunk_gap\"}");
        }
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR,
                                   asset_err ? asset_err : "write failed");
    }
    size_t cap = 16 * 1024;
    char *chunk = fos_big_malloc(cap);
    if (!chunk) {
        cap = 4096;
        chunk = malloc(cap);
    }
    if (!chunk) {
        if (chunked) fos_assets_chunk_close(&writer);
        else fos_assets_write_abort(&writer);
        return httpd_resp_send_500(req);
    }
    int received = 0;
    int stalls = 0;
    esp_err_t err = ESP_OK;
    while (received < total) {
        int want = total - received;
        if (want > (int)cap) want = (int)cap;
        int r = httpd_req_recv(req, chunk, want);
        if (r == HTTPD_SOCK_ERR_TIMEOUT) {
            if (++stalls <= FOS_UPLOAD_RECV_STALL_LIMIT) continue;
            err = ESP_FAIL;
            break;
        }
        if (r <= 0) {
            err = ESP_FAIL;
            break;
        }
        stalls = 0;
        if (fos_assets_write_chunk(&writer, chunk, (size_t)r) != ESP_OK) {
            err = ESP_FAIL;
            break;
        }
        received += r;
    }
    free(chunk);
    if (err != ESP_OK) {
        /* Keep the part on chunked failures so the client can retry the
         * same offset; single-shot uploads roll back as before. */
        if (chunked) fos_assets_chunk_close(&writer);
        else fos_assets_write_abort(&writer);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "write failed");
    }
    long long part_size = 0;
    if (chunked) {
        if (fos_assets_chunk_finish(&writer, complete ? rel : NULL, &part_size,
                                    &asset_err) != ESP_OK) {
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR,
                                       asset_err ? asset_err : "write failed");
        }
    } else if (fos_assets_write_commit(&writer, &asset_err) != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR,
                                   asset_err ? asset_err : "write failed");
    }
    if (chunked && !complete) {
        char reply[96];
        snprintf(reply, sizeof(reply), "{\"pending\":true,\"received\":%lld}", part_size);
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_sendstr(req, reply);
    }
    log_http_command(req, "assetUpload", chunked ? (size_t)part_size : (size_t)total);
    struct stat st;
    bool have_stat = fos_assets_stat(rel, &st) == ESP_OK;
    char *escaped = json_escape_dup(rel);
    if (!escaped) return httpd_resp_send_500(req);
    char reply[FOS_ASSETS_PATH_MAX * 2 + 96];
    snprintf(reply, sizeof(reply),
             "{\"path\":\"%s\",\"size\":%lld,\"mtime\":%lld,\"is_dir\":false}",
             escaped,
             have_stat ? (long long)st.st_size
                       : (chunked ? part_size : (long long)total),
             (long long)(have_stat ? st.st_mtime : 0));
    free(escaped);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, reply);
}

/* mkdir + delete share a form body of `path=...`; rename reads src + dst. */
static esp_err_t asset_mutate_post_handler(httpd_req_t *req, const char *op)
{
    keep_awake_for_http_mutation();
    char *body = NULL;
    if (read_request_body(req, 2048, false, &body) != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad length");
    }
    char raw[FOS_ASSETS_PATH_MAX];
    char rel[FOS_ASSETS_PATH_MAX];
    char dst_rel[FOS_ASSETS_PATH_MAX];
    bool ok_paths = false;
    if (strcmp(op, "rename") == 0) {
        char raw_dst[FOS_ASSETS_PATH_MAX];
        ok_paths = form_value(body, "src", raw, sizeof(raw)) &&
                   form_value(body, "dst", raw_dst, sizeof(raw_dst)) &&
                   fos_assets_sanitize_write_path(raw, rel, sizeof(rel)) &&
                   fos_assets_sanitize_write_path(raw_dst, dst_rel, sizeof(dst_rel));
    } else {
        ok_paths = form_value(body, "path", raw, sizeof(raw)) &&
                   fos_assets_sanitize_write_path(raw, rel, sizeof(rel));
    }
    free(body);
    if (!ok_paths) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid path");
    }
    const char *asset_err = NULL;
    esp_err_t err;
    if (strcmp(op, "mkdir") == 0) {
        err = fos_assets_mkdir(rel, &asset_err);
    } else if (strcmp(op, "delete") == 0) {
        err = fos_assets_delete(rel, &asset_err);
    } else {
        err = fos_assets_rename(rel, dst_rel, &asset_err);
    }
    if (err != ESP_OK) {
        return httpd_resp_send_err(
            req,
            err == ESP_ERR_NOT_FOUND ? HTTPD_404_NOT_FOUND
                                     : HTTPD_500_INTERNAL_SERVER_ERROR,
            asset_err ? asset_err : "failed");
    }
    log_http_command_from_path(req, 0);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, "{\"ok\":true}");
}

/* Explicit SD-card maintenance. Boot never formats a card it merely failed to
 * mount, and never re-probes the socket after boot (fos_assets_sd.c), so these
 * two actions are the only ways to put a filesystem on a blank card or to pick
 * up a card that was inserted while the frame was running:
 *
 *   POST /api/action/remount-sd  |  POST /api/frames/<id>/assets/remount-sd
 *   POST /api/action/format-sd   |  POST /api/frames/<id>/assets/format-sd
 *
 * format-sd ERASES the card: it writes a fresh filesystem to a card that
 * carries no volume this firmware can mount (a blank card, or an exFAT card
 * whose contents the frame cannot see). A card that mounts is never touched.
 * Callers must warn the user before POSTing it. */
static esp_err_t sd_maintenance_post_handler(httpd_req_t *req, bool format)
{
    REQUIRE_PROTECTED_ACCESS();
    keep_awake_for_http_mutation();
    log_http_command(req, format ? "format-sd" : "remount-sd", 0);

    esp_err_t err = format ? fos_assets_sd_format() : fos_assets_sd_remount();
    if (err != ESP_OK) {
        const char *detail = fos_assets_sd_last_error();
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR,
                                   (detail && detail[0]) ? detail : esp_err_to_name(err));
    }
    char *body = NULL;
    int len = asprintf(&body, "{\"ok\":true,\"mounted\":true,\"capacityBytes\":%llu}",
                       (unsigned long long)fos_assets_sd_capacity_bytes());
    if (len < 0 || !body) {
        free(body);
        return httpd_resp_send_500(req);
    }
    httpd_resp_set_type(req, "application/json");
    esp_err_t send_err = httpd_resp_sendstr(req, body);
    free(body);
    return send_err;
}

static esp_err_t sd_remount_post_handler(httpd_req_t *req)
{
    return sd_maintenance_post_handler(req, false);
}

static esp_err_t sd_format_post_handler(httpd_req_t *req)
{
    return sd_maintenance_post_handler(req, true);
}

static bool frame_api_suffix(httpd_req_t *req, char *suffix, size_t suffix_len)
{
    char path[256];
    if (!copy_request_path(req, path, sizeof(path))) return false;
    const char *prefix = "/api/frames/";
    if (strncmp(path, prefix, strlen(prefix)) != 0) return false;
    char *p = path + strlen(prefix);
    char *end = NULL;
    unsigned long frame_id = strtoul(p, &end, 10);
    if (end == p) return false;
    if (fos_config()->frame_id != 0 && frame_id != fos_config()->frame_id) return false;
    if (*end == '\0') {
        strlcpy(suffix, "/", suffix_len);
        return true;
    }
    if (*end != '/') return false;
    strlcpy(suffix, end, suffix_len);
    return true;
}

static esp_err_t frame_api_get_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    char suffix[160];
    if (!frame_api_suffix(req, suffix, sizeof(suffix))) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
    }
    if (strcmp(suffix, "/") == 0) return frame_detail_get_handler(req);
    if (strcmp(suffix, "/ping") == 0) return frame_api_ping_get_handler(req);
    if (strcmp(suffix, "/state") == 0) return state_alias_get_handler(req);
    if (strcmp(suffix, "/states") == 0) return states_alias_get_handler(req);
    if (strcmp(suffix, "/uploaded_scenes") == 0) return uploaded_scenes_get_handler(req);
    if (strcmp(suffix, "/image") == 0 || strncmp(suffix, "/scene_images/", 14) == 0) {
        return preview_bmp_handler(req);
    }
    if (strcmp(suffix, "/logs") == 0) return logs_get_handler(req);
    if (strcmp(suffix, "/metrics") == 0) return metrics_get_handler(req);
    if (strcmp(suffix, "/assets") == 0) return assets_list_get_handler(req);
    if (strcmp(suffix, "/asset") == 0) return asset_file_get_handler(req);
    return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
}

static esp_err_t frame_api_post_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();

    char suffix[160];
    if (!frame_api_suffix(req, suffix, sizeof(suffix))) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
    }
    if (strcmp(suffix, "/") == 0) return frame_update_post_handler(req);
    if (strcmp(suffix, "/reload") == 0) return reload_post_handler(req);
    if (strcmp(suffix, "/uploadScenes") == 0 ||
        strcmp(suffix, "/upload_scenes") == 0 ||
        strcmp(suffix, "/uploaded_scenes") == 0) {
        return scenes_post_handler(req);
    }
    if (strcmp(suffix, "/assets/upload") == 0) return asset_upload_post_handler(req);
    if (strcmp(suffix, "/assets/mkdir") == 0) return asset_mutate_post_handler(req, "mkdir");
    if (strcmp(suffix, "/assets/delete") == 0) return asset_mutate_post_handler(req, "delete");
    if (strcmp(suffix, "/assets/rename") == 0) return asset_mutate_post_handler(req, "rename");
    if (strcmp(suffix, "/assets/remount-sd") == 0) return sd_remount_post_handler(req);
    if (strcmp(suffix, "/assets/format-sd") == 0) return sd_format_post_handler(req);
    const char *event_prefix = "/event/";
    if (strncmp(suffix, event_prefix, strlen(event_prefix)) == 0) {
        char event_name[96];
        strlcpy(event_name, suffix + strlen(event_prefix), sizeof(event_name));
        url_decode(event_name);
        return handle_event_post(req, event_name);
    }
    return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
}

static esp_err_t scene_select_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();
    keep_awake_for_http_mutation();

    int total = req->content_len;
    if (total <= 0 || total > 512) {
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

    char scene_id[128];
    bool has_scene = form_value(body, "scene_id", scene_id, sizeof(scene_id));
    free(body);
    if (!has_scene || !scene_id[0]) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing scene_id");
    }
    log_http_command(req, "setCurrentScene", (size_t)total);
    esp_err_t err = fos_scenes_select(scene_id);
    if (err != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, esp_err_to_name(err));
    }
    if (s_render_cb) s_render_cb();
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true,\"queued\":true}", HTTPD_RESP_USE_STRLEN);
}

/* Local scene push: accept a scenes.json array, persist it to /state
 * and apply it on the next render — hot scene update over the LAN without
 * touching the backend. */
static esp_err_t scenes_post_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();
    keep_awake_for_http_mutation();

    int total = req->content_len;
    if (total <= 0 || total > 512 * 1024) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad length");
    }
    char *body = fos_big_malloc(total + 1);
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

    log_http_command(req, "uploadScenes", (size_t)total);
    esp_err_t err = fos_http_store_uploaded_scenes_payload(body, total);
    free(body);
    if (err != ESP_OK) {
        const char *detail = fos_scenes_last_error();
        return httpd_resp_send_err(
            req,
            HTTPD_500_INTERNAL_SERVER_ERROR,
            (detail && detail[0]) ? detail : esp_err_to_name(err));
    }
    if (s_render_cb) s_render_cb();
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}

/* Force a backend scenes sync on the next render pass. */
static esp_err_t scenes_sync_handler(httpd_req_t *req)
{
    REQUIRE_PROTECTED_ACCESS();
    keep_awake_for_http_mutation();

    log_http_command(req, "scenes_sync", 0);
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

/* Incoming-request logging: every route is registered through a trampoline
 * (logged_dispatch) that times the real handler and emits one JSON log line
 * via frameos_nim_log_hook. Per-route state lives in a static table; each
 * registration (plain + TLS server both call register_routes) gets its own
 * slot, whose address becomes the registered user_ctx. */
typedef struct {
    esp_err_t (*handler)(httpd_req_t *req);
    void *user_ctx;
    httpd_method_t method;
    char uri[32];
} logged_route_t;

/* 27 routes per server (13 GET + 14 POST), x2 servers (http + https), or
 * 27 + 7 captive-portal probes in portal mode. 64 leaves headroom. */
#define FOS_HTTP_MAX_LOGGED_ROUTES 64
static logged_route_t s_logged_routes[FOS_HTTP_MAX_LOGGED_ROUTES];
static size_t s_logged_route_count = 0;

static bool path_has_suffix(const char *path, const char *suffix)
{
    size_t path_len = strlen(path);
    size_t suffix_len = strlen(suffix);
    if (suffix_len > path_len) return false;
    return strcmp(path + path_len - suffix_len, suffix) == 0;
}

/* True when POST <path> is a "frame update" (/api/frames/<id> or
 * /api/frames/<id>/), which already logs its own http:command line. */
static bool path_is_frame_update_root(const char *path)
{
    const char *prefix = "/api/frames/";
    size_t prefix_len = strlen(prefix);
    if (strncmp(path, prefix, prefix_len) != 0) return false;
    const char *p = path + prefix_len;
    if (*p < '0' || *p > '9') return false;
    while (*p >= '0' && *p <= '9') p++;
    return *p == '\0' || (p[0] == '/' && p[1] == '\0');
}

static bool should_log_request(int method, const char *path)
{
    /* High-frequency polling / image endpoints: never log. Matched on the
     * ACTUAL request path so /api/frames/<id>/... wildcards are covered. */
    if (path_has_suffix(path, "/ping") ||
        path_has_suffix(path, "/image") ||
        path_has_suffix(path, "/logs") ||
        path_has_suffix(path, "/metrics") ||
        path_has_suffix(path, "/status") ||
        strcmp(path, "/api/preview.bmp") == 0 ||
        strstr(path, "/scene_images/") != NULL) {
        return false;
    }

    /* Captive-portal probe paths (registered in portal mode only). */
    if (strcmp(path, "/generate_204") == 0 ||
        strcmp(path, "/gen_204") == 0 ||
        strcmp(path, "/hotspot-detect.html") == 0 ||
        strcmp(path, "/connecttest.txt") == 0 ||
        strcmp(path, "/ncsi.txt") == 0 ||
        strcmp(path, "/redirect") == 0 ||
        strcmp(path, "/success.txt") == 0) {
        return false;
    }

    /* POSTs whose handlers already emit an http:command line with command
     * detail (log_http_command / log_http_command_from_path) would double
     * log; keep the richer http:command line and skip http:request. */
    if (method == HTTP_POST) {
        if (strncmp(path, "/api/action/", strlen("/api/action/")) == 0 ||
            strstr(path, "/event/") != NULL ||
            path_has_suffix(path, "/reload") ||
            path_has_suffix(path, "/uploadScenes") ||
            path_has_suffix(path, "/upload_scenes") ||
            path_has_suffix(path, "/uploaded_scenes") ||
            path_has_suffix(path, "/assets/upload") ||
            path_has_suffix(path, "/assets/mkdir") ||
            path_has_suffix(path, "/assets/delete") ||
            path_has_suffix(path, "/assets/rename") ||
            path_has_suffix(path, "/assets/remount-sd") ||
            path_has_suffix(path, "/assets/format-sd") ||
            strcmp(path, "/api/scenes") == 0 ||
            path_is_frame_update_root(path)) {
            return false;
        }
    }

    return true;
}

static esp_err_t logged_dispatch(httpd_req_t *req)
{
    logged_route_t *route = (logged_route_t *)req->user_ctx;
    /* Restore the original user_ctx before dispatching: handlers such as
     * action_handler read their callback out of req->user_ctx. */
    req->user_ctx = route->user_ctx;

    char path[272];
    bool have_path = copy_request_path(req, path, sizeof(path));
    if (!have_path || !should_log_request(req->method, path)) {
        return route->handler(req);
    }

    int64_t start_us = esp_timer_get_time();
    esp_err_t err = route->handler(req);
    int64_t elapsed_ms = (esp_timer_get_time() - start_us) / 1000;

    char *escaped_path = json_escape_dup(path);
    if (escaped_path) {
        char log_line[640];
        snprintf(log_line, sizeof(log_line),
                 "{\"event\":\"http:request\",\"source\":\"esp32\",\"method\":\"%s\","
                 "\"path\":\"%s\",\"ok\":%s,\"ms\":%lld}",
                 http_method_name(req->method), escaped_path,
                 err == ESP_OK ? "true" : "false", (long long)elapsed_ms);
        free(escaped_path);
        frameos_nim_log_hook(log_line);
    }
    return err;
}

static esp_err_t register_logged_route(httpd_handle_t server, const httpd_uri_t *route)
{
    if (s_logged_route_count >= FOS_HTTP_MAX_LOGGED_ROUTES) {
        ESP_LOGE(TAG, "logged route table full, cannot register %s", route->uri);
        return ESP_ERR_NO_MEM;
    }
    logged_route_t *slot = &s_logged_routes[s_logged_route_count];
    slot->handler = route->handler;
    slot->user_ctx = route->user_ctx;
    slot->method = route->method;
    strlcpy(slot->uri, route->uri, sizeof(slot->uri));

    httpd_uri_t wrapped = *route;
    wrapped.handler = logged_dispatch;
    wrapped.user_ctx = slot;
    esp_err_t err = httpd_register_uri_handler(server, &wrapped);
    if (err == ESP_OK) s_logged_route_count++;
    return err;
}

static esp_err_t register_routes(httpd_handle_t server, bool portal_mode)
{
    esp_err_t err = ESP_OK;
#define REGISTER_ROUTE(route) do { \
        err = register_logged_route(server, &(route)); \
        if (err != ESP_OK) return err; \
    } while (0)

    const httpd_uri_t root = {.uri = "/", .method = HTTP_GET, .handler = root_get_handler};
    const httpd_uri_t ping = {.uri = "/ping", .method = HTTP_GET, .handler = ping_get_handler};
    const httpd_uri_t status = {.uri = "/status", .method = HTTP_GET, .handler = status_get_handler};
    const httpd_uri_t image = {.uri = "/image", .method = HTTP_GET, .handler = preview_bmp_handler};
    const httpd_uri_t state = {.uri = "/state", .method = HTTP_GET, .handler = state_alias_get_handler};
    const httpd_uri_t states = {.uri = "/states", .method = HTTP_GET, .handler = states_alias_get_handler};
    const httpd_uri_t uploaded = {.uri = "/getUploadedScenes", .method = HTTP_GET, .handler = uploaded_scenes_get_handler};
    const httpd_uri_t api_apps = {.uri = "/api/apps", .method = HTTP_GET, .handler = api_apps_get_handler};
    const httpd_uri_t api_frames = {.uri = "/api/frames", .method = HTTP_GET, .handler = frames_get_handler};
    const httpd_uri_t preview = {.uri = "/api/preview.bmp", .method = HTTP_GET, .handler = preview_bmp_handler};
    const httpd_uri_t setup = {.uri = "/api/setup", .method = HTTP_POST, .handler = setup_post_handler};
    const httpd_uri_t scenes_info = {.uri = "/api/scenes", .method = HTTP_GET, .handler = scenes_get_handler};
    const httpd_uri_t scene_state = {.uri = "/api/scene-state", .method = HTTP_GET, .handler = scene_state_get_handler};
    REGISTER_ROUTE(root);
    REGISTER_ROUTE(ping);
    REGISTER_ROUTE(status);
    REGISTER_ROUTE(image);
    REGISTER_ROUTE(state);
    REGISTER_ROUTE(states);
    REGISTER_ROUTE(uploaded);
    REGISTER_ROUTE(api_apps);
    REGISTER_ROUTE(api_frames);
    REGISTER_ROUTE(preview);
    REGISTER_ROUTE(setup);
    REGISTER_ROUTE(scenes_info);
    REGISTER_ROUTE(scene_state);

    httpd_uri_t render = {.uri = "/api/action/render", .method = HTTP_POST, .handler = action_handler, .user_ctx = s_render_cb};
    httpd_uri_t ota = {.uri = "/api/action/ota", .method = HTTP_POST, .handler = action_handler, .user_ctx = s_ota_cb};
    httpd_uri_t action_restart = {.uri = "/api/action/restart", .method = HTTP_POST, .handler = restart_post_handler};
    httpd_uri_t action_reboot = {.uri = "/api/action/reboot", .method = HTTP_POST, .handler = restart_post_handler};
    httpd_uri_t scene = {.uri = "/api/action/scene", .method = HTTP_POST, .handler = scene_select_handler};
    httpd_uri_t remount_sd = {.uri = "/api/action/remount-sd", .method = HTTP_POST, .handler = sd_remount_post_handler};
    httpd_uri_t format_sd = {.uri = "/api/action/format-sd", .method = HTTP_POST, .handler = sd_format_post_handler};
    REGISTER_ROUTE(render);
    REGISTER_ROUTE(ota);
    REGISTER_ROUTE(action_restart);
    REGISTER_ROUTE(action_reboot);
    REGISTER_ROUTE(scene);
    REGISTER_ROUTE(remount_sd);
    REGISTER_ROUTE(format_sd);

    httpd_uri_t scenes = {.uri = "/api/scenes", .method = HTTP_POST, .handler = scenes_post_handler};
    httpd_uri_t scenes_sync = {.uri = "/api/action/scenes_sync", .method = HTTP_POST, .handler = scenes_sync_handler};
    httpd_uri_t upload_scenes = {.uri = "/uploadScenes", .method = HTTP_POST, .handler = scenes_post_handler};
    httpd_uri_t reload = {.uri = "/reload", .method = HTTP_POST, .handler = reload_post_handler};
    httpd_uri_t event = {.uri = "/event/*", .method = HTTP_POST, .handler = event_post_handler};
    httpd_uri_t frame_api_get = {.uri = "/api/frames/*", .method = HTTP_GET, .handler = frame_api_get_handler};
    httpd_uri_t frame_api_post = {.uri = "/api/frames/*", .method = HTTP_POST, .handler = frame_api_post_handler};
    REGISTER_ROUTE(scenes);
    REGISTER_ROUTE(scenes_sync);
    REGISTER_ROUTE(upload_scenes);
    REGISTER_ROUTE(reload);
    REGISTER_ROUTE(event);
    REGISTER_ROUTE(frame_api_get);
    REGISTER_ROUTE(frame_api_post);

    if (portal_mode) {
        static const char *probes[] = {
            "/generate_204", "/gen_204", "/hotspot-detect.html",
            "/connecttest.txt", "/ncsi.txt", "/redirect", "/success.txt",
        };
        for (size_t i = 0; i < sizeof(probes) / sizeof(probes[0]); i++) {
            httpd_uri_t probe = {.uri = probes[i], .method = HTTP_GET, .handler = probe_handler};
            REGISTER_ROUTE(probe);
        }
        err = httpd_register_err_handler(server, HTTPD_404_NOT_FOUND, portal_redirect_handler);
        if (err != ESP_OK) return err;
    }

    return ESP_OK;
#undef REGISTER_ROUTE
}

static void configure_httpd_defaults(httpd_config_t *config)
{
    config->max_uri_handlers = 40;
    config->max_open_sockets = 7;
    config->backlog_conn = 8;
    config->recv_wait_timeout = 5;
    config->send_wait_timeout = 5;
    config->lru_purge_enable = true;
    config->stack_size = 8192;
#if CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM
    /* HTTP handlers update SPIFFS state. SPI flash operations disable cache,
     * so the httpd task stack must remain in internal RAM. */
    config->task_caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
#endif
    config->uri_match_fn = httpd_uri_match_wildcard;
}

esp_err_t fos_http_start(bool portal_mode)
{
    if (s_http_server || s_https_server) return ESP_OK;
    s_portal_mode = portal_mode;
    s_logged_route_count = 0;

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    configure_httpd_defaults(&config);
    esp_err_t err = httpd_start(&s_http_server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed: %s", esp_err_to_name(err));
        return err;
    }

    err = register_routes(s_http_server, portal_mode);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "http route registration failed: %s", esp_err_to_name(err));
        httpd_stop(s_http_server);
        s_http_server = NULL;
        return err;
    }

    ESP_LOGI(TAG, "http server up (%s mode)", portal_mode ? "portal" : "status");
    if (!portal_mode) {
        fos_config_t *frame_config = fos_config();
        bool has_tls_material = frame_config->tls_server_cert[0] && frame_config->tls_server_key[0];
        if (frame_config->tls_enable && has_tls_material) {
            if (https_heap_ready()) {
                httpd_ssl_config_t tls_config = HTTPD_SSL_CONFIG_DEFAULT();
                configure_httpd_defaults(&tls_config.httpd);
                /* TLS sockets cost ~40KB each before route handlers allocate
                 * their own response buffers. Keep this tiny on ESP32-S3 so a
                 * browser cannot starve the renderer or AES write path. */
                tls_config.httpd.max_open_sockets = FOS_HTTPS_MAX_OPEN_SOCKETS;
                tls_config.httpd.backlog_conn = FOS_HTTPS_BACKLOG_CONN;
                tls_config.httpd.stack_size = 12288;
                tls_config.port_secure = frame_config->tls_port > 0 ? frame_config->tls_port : 8443;
                tls_config.servercert = (const uint8_t *)frame_config->tls_server_cert;
                tls_config.servercert_len = strlen(frame_config->tls_server_cert) + 1;
                tls_config.prvtkey_pem = (const uint8_t *)frame_config->tls_server_key;
                tls_config.prvtkey_len = strlen(frame_config->tls_server_key) + 1;

                err = httpd_ssl_start(&s_https_server, &tls_config);
                if (err == ESP_OK) {
                    err = register_routes(s_https_server, false);
                    if (err != ESP_OK) {
                        ESP_LOGE(TAG, "https route registration failed: %s", esp_err_to_name(err));
                        httpd_ssl_stop(s_https_server);
                        s_https_server = NULL;
                    } else {
                        ESP_LOGI(TAG, "https server up on port %u", (unsigned)tls_config.port_secure);
                    }
                } else {
                    ESP_LOGE(TAG, "httpd_ssl_start failed: %s", esp_err_to_name(err));
                }
            }
        } else if (frame_config->tls_enable) {
            ESP_LOGW(TAG, "https requested but TLS certificate or key is missing");
        }
    }
    return ESP_OK;
}

bool fos_http_is_running(void)
{
    return s_http_server != NULL || s_https_server != NULL;
}

void fos_http_stop(void)
{
    if (s_https_server) {
        httpd_ssl_stop(s_https_server);
        s_https_server = NULL;
    }
    if (s_http_server) {
        httpd_stop(s_http_server);
        s_http_server = NULL;
    }
}
