#include "fos_http.h"

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

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

#include "cJSON.h"
#include "fos_assets_sd.h"
#include "fos_battery.h"
#include "fos_client.h"
#include "fos_config.h"
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

static httpd_handle_t s_http_server = NULL;
static httpd_handle_t s_https_server = NULL;
static bool s_portal_mode = false;
static fos_action_cb s_render_cb = NULL;
static fos_action_cb s_ota_cb = NULL;

static esp_err_t scenes_post_handler(httpd_req_t *req);
static void log_http_command(httpd_req_t *req, const char *event_name, size_t body_len);
static void log_http_command_from_path(httpd_req_t *req, size_t body_len);

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
    char *body = heap_caps_malloc((size_t)total + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
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

esp_err_t fos_http_store_uploaded_scenes_payload(const char *body, size_t len)
{
    const char *payload = body;
    size_t payload_len = len;
    char *owned_payload = NULL;
    cJSON *root = body ? cJSON_Parse(body) : NULL;

    if (cJSON_IsObject(root)) {
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
    }

    esp_err_t err = fos_scenes_set_json(payload, payload_len);
    if (owned_payload) cJSON_free(owned_payload);
    cJSON_Delete(root);
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
    ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.6rem}"
    ".metric{background:#f6f6f6;border:1px solid #ddd;padding:.5rem}.metric b{display:block}"
    "code{background:#eee;padding:0 .3rem}</style></head><body>"
    "<h1>FrameOS</h1><p>Configure this frame. It reboots and connects after saving.</p>";

static esp_err_t root_get_handler(httpd_req_t *req)
{
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
        "`<div class='metric'><b>Assets</b>${s.assets&&s.assets.sdMounted?'SD mounted':(s.assets&&s.assets.sdEnabled?'SD unavailable':'SD off')}</div>`;"
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
    size_t internal_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    size_t psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    size_t psram_total = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
    const char *scene_json = frameos_nim_scene_info_json();
    if (!scene_json || !scene_json[0]) scene_json = "{\"loaded\":0,\"available\":0,\"hasScene\":false,\"scenes\":[]}";
    fos_storage_info_t storage;
    collect_storage_info(&storage);

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
    if (!app_name || !app_version || !idf_version || !partition || !ip ||
        !panel || !pins_json || !sd_pins_json || !assets_path || !backend || !ssid || !nim_info) {
        free(app_name); free(app_version); free(idf_version); free(partition); free(ip);
        free(panel); free(pins_json); free(sd_pins_json); free(assets_path); free(backend); free(ssid); free(nim_info);
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
        "\"sdMaxFrequencyKHz\":%lu,\"sdCapacityBytes\":%llu},"
        "\"ota\":{\"supported\":%s,\"slotBytes\":%u,\"retryAttempts\":64,\"requestMode\":\"early-reboot\","
        "\"resumable\":true,\"bootRequestSupported\":true,"
        "\"partialRequestBytes\":524288,\"wifiSettleMs\":3000},"
        "\"wifi\":{\"state\":%d,\"ip\":\"%s\",\"rssi\":%d,\"timeSynced\":%s},"
        "\"battery\":{\"present\":%s,\"millivolts\":%d,\"percent\":%d},"
        "\"render\":{\"count\":%lu,\"lastMs\":%lld,\"previewReady\":%s,\"previewRenderCount\":%lu,"
        "\"previewWidth\":%d,\"previewHeight\":%d,\"previewFormat\":%d,\"previewBytes\":%u,"
        "\"lastRefreshSkipped\":%s,\"snapshotMode\":\"%s\"},"
        "\"nim\":{\"info\":\"%s\"},\"scenes\":%s,"
        "\"config\":{\"frameId\":%lu,\"panel\":\"%s\",\"renderMode\":\"%s\","
        "\"intervalSec\":%lu,\"serverSendLogs\":%s,\"tlsEnabled\":%s,\"tlsActive\":%s,\"tlsPort\":%u,"
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
        storage.ota_slots > 0 ? "true" : "false", (unsigned)storage.ota_slot_bytes,
        (int)fos_wifi_state(), ip, fos_wifi_rssi(),
        fos_wifi_time_synced() ? "true" : "false",
        fos_battery_present() ? "true" : "false",
        fos_battery_millivolts(), fos_battery_percent(),
        (unsigned long)render_count, render_ms, preview_ready ? "true" : "false",
        (unsigned long)preview_render_count,
        preview_width, preview_height, (int)preview_format, (unsigned)preview_len,
        fos_client_last_refresh_skipped() ? "true" : "false",
        fos_client_snapshot_mode(),
        nim_info, scene_json,
        (unsigned long)config->frame_id, panel,
        config->render_mode == FOS_RENDER_LOCAL ? "local" : "remote",
        (unsigned long)config->interval_sec, config->server_send_logs ? "true" : "false",
        config->tls_enable ? "true" : "false", s_https_server ? "true" : "false", (unsigned)config->tls_port,
        config->deep_sleep ? "true" : "false",
        config->wake_schedule ? "true" : "false",
        pins_json, backend, ssid);
    free(app_name); free(app_version); free(idf_version); free(partition); free(ip);
    free(panel); free(pins_json); free(sd_pins_json); free(assets_path); free(backend); free(ssid); free(nim_info);
    if (len < 0 || !json) {
        free(json);
        return NULL;
    }
    return json;
}

static esp_err_t status_get_handler(httpd_req_t *req)
{
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

    uint8_t *packed = heap_caps_malloc(packed_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!packed) packed = malloc(packed_len);
    if (!packed) return ESP_ERR_NO_MEM;
    esp_err_t err = fos_client_snapshot_copy(packed, packed_len, &width, &height, &format, NULL, NULL);
    if (err != ESP_OK) {
        free(packed);
        return ESP_ERR_NOT_FOUND;
    }

    uint16_t bit_count = format == FOS_PIXEL_1BPP ? 1 : 4;
    size_t palette_entries = bit_count == 1 ? 2 : 16;
    size_t row_payload = (((size_t)width * bit_count) + 7u) / 8u;
    size_t row_stride = (row_payload + 3u) & ~3u;
    size_t pixel_bytes = row_stride * (size_t)height;
    size_t palette_bytes = palette_entries * 4u;
    if (pixel_bytes > UINT32_MAX - 54u - palette_bytes) {
        free(packed);
        return ESP_ERR_INVALID_SIZE;
    }
    size_t bmp_len = 54u + palette_bytes + pixel_bytes;
    uint8_t *bmp = heap_caps_malloc(bmp_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
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
    put_u32le(&bmp[18], (uint32_t)width);
    put_u32le(&bmp[22], (uint32_t)height);
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
    for (int y = height - 1; y >= 0; y--) {
        uint8_t *row = pixels + row_index * row_stride;
        memset(row, 0, row_stride);
        for (int x = 0; x < width; x++) {
            uint8_t index = preview_palette_index(packed, width, height, format, x, y);
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
    uint8_t *bmp = NULL;
    size_t bmp_len = 0;
    char scene_id[128];
    scene_id[0] = '\0';
    esp_err_t err = fos_http_preview_bmp_alloc(&bmp, &bmp_len, scene_id, sizeof(scene_id));
    if (err == ESP_ERR_NOT_FOUND) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "no preview rendered yet");
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
    const char *json = frameos_nim_scene_info_json();
    if (!json || !json[0]) {
        json = "{\"loaded\":0,\"available\":0,\"hasScene\":false,\"scenes\":[]}";
    }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, json);
}

static esp_err_t scene_state_get_handler(httpd_req_t *req)
{
    const char *json = frameos_nim_scene_state_json();
    if (!json || !json[0]) {
        json = "{}";
    }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, json);
}

static esp_err_t state_alias_get_handler(httpd_req_t *req)
{
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
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"apps\":[]}", HTTPD_RESP_USE_STRLEN);
}

static esp_err_t frame_api_ping_get_handler(httpd_req_t *req)
{
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req,
        "{\"ok\":true,\"mode\":\"http\",\"target\":\"frame\","
        "\"elapsed_ms\":0,\"status\":200,\"message\":\"pong\"}",
        HTTPD_RESP_USE_STRLEN);
}

static esp_err_t frame_api_frame_payload(httpd_req_t *req, bool list)
{
    fos_config_t *config = fos_config();
    char *panel = json_escape_dup(config->panel);
    char *ip = json_escape_dup(fos_wifi_ip());
    if (!panel || !ip) {
        free(panel); free(ip);
        return httpd_resp_send_500(req);
    }
    int width = fos_display_present() ? fos_display_width() : 800;
    int height = fos_display_present() ? fos_display_height() : 480;
    char *json = NULL;
    const char *prefix = list ? "{\"frames\":[" : "{\"frame\":";
    const char *suffix = list ? "]}" : "}";
    int len = asprintf(&json,
        "%s{\"id\":%lu,\"name\":\"frame %lu\",\"mode\":\"embedded\","
        "\"frame_host\":\"%s\",\"frame_port\":80,\"device\":\"waveshare.%s\","
        "\"width\":%d,\"height\":%d,\"status\":\"online\","
        "\"server_send_logs\":%s}%s",
        prefix, (unsigned long)config->frame_id, (unsigned long)config->frame_id,
        ip, panel, width, height, config->server_send_logs ? "true" : "false", suffix);
    free(panel); free(ip);
    if (len < 0 || !json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send(req, json, len);
    free(json);
    return err;
}

static esp_err_t frames_get_handler(httpd_req_t *req)
{
    return frame_api_frame_payload(req, true);
}

static esp_err_t frame_detail_get_handler(httpd_req_t *req)
{
    return frame_api_frame_payload(req, false);
}

static esp_err_t reload_post_handler(httpd_req_t *req)
{
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
    if (strcmp(suffix, "/logs") == 0) {
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_send(req, "{\"logs\":[]}", HTTPD_RESP_USE_STRLEN);
    }
    if (strcmp(suffix, "/metrics") == 0) {
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_send(req, "{\"metrics\":[]}", HTTPD_RESP_USE_STRLEN);
    }
    if (strcmp(suffix, "/assets") == 0) {
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_send(req, "{\"assets\":[]}", HTTPD_RESP_USE_STRLEN);
    }
    return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
}

static esp_err_t frame_api_post_handler(httpd_req_t *req)
{
    char suffix[160];
    if (!frame_api_suffix(req, suffix, sizeof(suffix))) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
    }
    if (strcmp(suffix, "/reload") == 0) return reload_post_handler(req);
    if (strcmp(suffix, "/uploadScenes") == 0 || strcmp(suffix, "/uploaded_scenes") == 0) {
        return scenes_post_handler(req);
    }
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

    log_http_command(req, "uploadScenes", (size_t)total);
    esp_err_t err = fos_http_store_uploaded_scenes_payload(body, total);
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

static esp_err_t register_routes(httpd_handle_t server, bool portal_mode)
{
    esp_err_t err = ESP_OK;
#define REGISTER_ROUTE(route) do { \
        err = httpd_register_uri_handler(server, &(route)); \
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
    httpd_uri_t scene = {.uri = "/api/action/scene", .method = HTTP_POST, .handler = scene_select_handler};
    REGISTER_ROUTE(render);
    REGISTER_ROUTE(ota);
    REGISTER_ROUTE(scene);

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
    config->max_uri_handlers = 32;
    config->max_open_sockets = 7;
    config->backlog_conn = 8;
    config->recv_wait_timeout = 5;
    config->send_wait_timeout = 5;
    config->lru_purge_enable = true;
    config->stack_size = 8192;
#if CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM
    config->task_caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
#endif
    config->uri_match_fn = httpd_uri_match_wildcard;
}

esp_err_t fos_http_start(bool portal_mode)
{
    if (s_http_server || s_https_server) return ESP_OK;
    s_portal_mode = portal_mode;

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
