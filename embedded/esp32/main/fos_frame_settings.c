/*
 * The frame's own settings, the second tab of the settings panel on the
 * screen (system/sceneSettings, docs/scene-settings.md "The frame tab"): how
 * the frame is doing (Wi-Fi, address, who manages it, the version) and what
 * can be set on it there and then — the Wi-Fi network and, on a frame no
 * control plane manages, the rotation.
 *
 * The Nim scene asks through three hooks (embedded_runtime.nim); every call
 * comes on the render task. What the tab shows changes under it (a join, a
 * scan), and main.c renders the panel again when it does
 * (fos_wifi_set_change_hook, fos_scenes_settings_shown).
 */
#include "fos_frame_settings.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_system.h"

#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_mem.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_frame_settings";

/* A scan when the tab comes up off Wi-Fi, unless one is this fresh. */
#define SCAN_FRESH_US (30LL * 1000000)

/* What the last Save could not do, for the tab's first note; "" = nothing.
 * Render task only. */
static char s_refused[96] = "";

/* Who manages the frame, and so sets the rotation: the plane pushes its own
 * value back (a backend's settings poll, the cloud's set_settings), so the
 * tab shows it and leaves it alone. NULL = nobody, the frame does. */
static const char *rotation_owner(void)
{
    const fos_config_t *config = fos_config();
    if (config->backend_url[0]) return "FrameOS backend";
    if (config->cloud_url[0] && fos_cloud_state() != FOS_CLOUD_NONE) return "FrameOS Cloud";
    return NULL;
}

/* The tab's JSON, written as text: the fixed parts are literals, and what
 * the frame says (a network's name) is escaped on its way in. A buffer of
 * JSON_CAP holds the worst case: every name in range and the saved one, 32
 * bytes each, every byte escaped to \u00XX. */
#define JSON_CAP (1536 + (FOS_WIFI_SCAN_MAX + 1) * (32 * 6 + 16))

typedef struct {
    char *buf;
    size_t len;
} out_t;

static void put(out_t *out, const char *text)
{
    size_t n = strlen(text);
    if (out->len + n < JSON_CAP) {
        memcpy(out->buf + out->len, text, n + 1);
        out->len += n;
    }
}

static void put_string(out_t *out, const char *text)
{
    char one[8];
    put(out, "\"");
    for (const unsigned char *c = (const unsigned char *)text; *c; c++) {
        if (*c == '"' || *c == '\\') snprintf(one, sizeof(one), "\\%c", *c);
        else if (*c < 0x20) snprintf(one, sizeof(one), "\\u%04x", *c);
        else snprintf(one, sizeof(one), "%c", *c);
        put(out, one);
    }
    put(out, "\"");
}

/* One status row, `["label","text"],`: every item of a list is written with
 * its comma, and the last one trimmed (trim_comma). */
static void put_row(out_t *out, const char *label, const char *text)
{
    put(out, "[\"");
    put(out, label);
    put(out, "\",");
    put_string(out, text);
    put(out, "],");
}

static void trim_comma(out_t *out)
{
    if (out->len > 0 && out->buf[out->len - 1] == ',') out->buf[--out->len] = '\0';
}

char *fos_frame_settings_json(void)
{
    const fos_config_t *config = fos_config();
    out_t out = {.buf = fos_big_malloc(JSON_CAP), .len = 0};
    if (out.buf == NULL) return NULL;
    out.buf[0] = '\0';
    fos_wifi_state_t state = fos_wifi_state();
    const char *ssid = config->wifi_ssid;
    uint8_t reason = fos_wifi_join_reason();
    /* The network's name, quoted, and the words around it. */
    char line[FOS_STR_LEN + 64];
    if (state == FOS_WIFI_CONNECTED) snprintf(line, sizeof(line), "Connected to \xe2\x80\x9c%s\xe2\x80\x9d", ssid);
    else if (state == FOS_WIFI_PORTAL) snprintf(line, sizeof(line), "Setup hotspot \xe2\x80\x9c%s\xe2\x80\x9d", fos_wifi_ap_ssid());
    else if (!ssid[0]) snprintf(line, sizeof(line), "Not set up");
    else if (fos_wifi_join_reason_not_found(reason)) snprintf(line, sizeof(line), "Can't find \xe2\x80\x9c%s\xe2\x80\x9d", ssid);
    else if (fos_wifi_join_reason_auth(reason)) snprintf(line, sizeof(line), "Wrong password for \xe2\x80\x9c%s\xe2\x80\x9d?", ssid);
    else if (state == FOS_WIFI_CONNECTING) snprintf(line, sizeof(line), "Connecting to \xe2\x80\x9c%s\xe2\x80\x9d\xe2\x80\xa6", ssid);
    else snprintf(line, sizeof(line), "Not connected");

    put(&out, "{\"status\":[");
    put_row(&out, "Wi-Fi", line);
    if (state == FOS_WIFI_CONNECTED) {
        snprintf(line, sizeof(line), "%d dBm", fos_wifi_rssi());
        put_row(&out, "Signal", line);
        put_row(&out, "Address", fos_wifi_ip());
    }
    if (s_refused[0]) put_row(&out, "Not saved", s_refused);
    const char *owner = rotation_owner();
    if (owner != NULL) {
        put_row(&out, "Managed by", owner);
        snprintf(line, sizeof(line), "%u\xc2\xb0, set there", (unsigned)config->rotate);
        put_row(&out, "Rotation", line);
    }
    const esp_app_desc_t *app = esp_app_get_description();
    put_row(&out, "Version", app->version);
    trim_comma(&out);

    put(&out, "],\"fields\":[{\"name\":\"wifiSsid\",\"label\":\"Wi-Fi network\",\"type\":\"string\","
              "\"select\":true,\"other\":\"Other network\xe2\x80\xa6\","
              "\"otherPlaceholder\":\"Network name\",\"placeholder\":\"Choose a network\",\"options\":[");
    /* The networks in range, by name (the scan sorted them), after the saved
     * one if it is not among them (out of range, or no scan yet). */
    fos_wifi_network_t *networks = fos_big_malloc(FOS_WIFI_SCAN_MAX * sizeof(*networks));
    int count = networks ? fos_wifi_scan_results(networks, FOS_WIFI_SCAN_MAX) : 0;
    bool saved = !ssid[0];
    for (int i = 0; i < count && !saved; i++) saved = strcmp(networks[i].ssid, ssid) == 0;
    if (!saved) {
        put(&out, "{\"value\":");
        put_string(&out, ssid);
        put(&out, "},");
    }
    for (int i = 0; i < count; i++) {
        put(&out, "{\"value\":");
        put_string(&out, networks[i].ssid);
        put(&out, "},");
    }
    free(networks);
    trim_comma(&out);
    /* The stored password is never shown: empty keeps it for the same
     * network, and is none (an open network) for another. */
    put(&out, config->wifi_pass[0]
                  ? "]},{\"name\":\"wifiPassword\",\"label\":\"Password\",\"type\":\"string\",\"secret\":true,"
                    "\"placeholder\":\"Saved (type to change)\"}"
                  : "]},{\"name\":\"wifiPassword\",\"label\":\"Password\",\"type\":\"string\",\"secret\":true,"
                    "\"placeholder\":\"Password\"}");
    if (owner == NULL) {
        put(&out, ",{\"name\":\"rotate\",\"label\":\"Rotation (restarts the frame)\",\"type\":\"integer\",\"options\":["
                  "{\"value\":\"0\",\"label\":\"0\xc2\xb0\"},{\"value\":\"90\",\"label\":\"90\xc2\xb0\"},"
                  "{\"value\":\"180\",\"label\":\"180\xc2\xb0\"},{\"value\":\"270\",\"label\":\"270\xc2\xb0\"}]}");
    }
    put(&out, "],\"values\":{\"wifiSsid\":");
    put_string(&out, ssid);
    snprintf(line, sizeof(line), ",\"rotate\":%u},\"actions\":[{\"id\":\"scan\",\"label\":\"%s\",\"under\":\"wifiSsid\"}]}",
             (unsigned)config->rotate, fos_wifi_scanning() ? "Scanning\xe2\x80\xa6" : "Scan for networks");
    put(&out, line);
    return out.buf;
}

static void restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(1500)); /* the log line goes out first */
    esp_restart();
}

static void log_applied(const char *changes)
{
    char line[192];
    snprintf(line, sizeof(line), "{\"event\":\"settings:frame\",\"source\":\"esp32\",\"origin\":\"panel\","
             "\"changes\":\"%s\"}", changes);
    frameos_nim_log_hook(line);
}

void fos_frame_settings_apply(const char *json)
{
    cJSON *root = json ? cJSON_Parse(json) : NULL;
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return;
    }
    fos_config_t *config = fos_config();
    bool wifi = false, restart = false;
    char changes[96] = "";
    s_refused[0] = '\0';

    const cJSON *ssid = cJSON_GetObjectItem(root, "wifiSsid");
    const cJSON *pass = cJSON_GetObjectItem(root, "wifiPassword");
    const char *new_ssid = cJSON_IsString(ssid) ? ssid->valuestring : config->wifi_ssid;
    const char *new_pass = cJSON_IsString(pass) ? pass->valuestring : "";
    if (new_ssid[0] && strlen(new_ssid) <= 32 && strlen(new_pass) < sizeof(config->wifi_pass) &&
        (new_pass[0] == '\0' || strlen(new_pass) >= 8)) {
        if (strcmp(new_ssid, config->wifi_ssid) != 0) {
            /* Another network: its password, or none (an open one). */
            strlcpy(config->wifi_ssid, new_ssid, sizeof(config->wifi_ssid));
            strlcpy(config->wifi_pass, new_pass, sizeof(config->wifi_pass));
            wifi = true;
        } else if (new_pass[0] && strcmp(new_pass, config->wifi_pass) != 0) {
            strlcpy(config->wifi_pass, new_pass, sizeof(config->wifi_pass));
            wifi = true;
        } else if (fos_wifi_state() != FOS_WIFI_CONNECTED) {
            /* The same again on a frame that is off it: try now. */
            wifi = true;
        }
    } else if (cJSON_IsString(ssid) || cJSON_IsString(pass)) {
        strlcpy(s_refused,
                !new_ssid[0] || strlen(new_ssid) > 32 ? "A network name is 1 to 32 characters"
                                                      : "A password is 8 to 63 characters",
                sizeof(s_refused));
        ESP_LOGW(TAG, "Wi-Fi refused: %s", s_refused);
    }

    const cJSON *rotate = cJSON_GetObjectItem(root, "rotate");
    uint16_t rot = 0;
    if (cJSON_IsNumber(rotate) && rotation_owner() == NULL &&
        fos_config_normalize_rotate(rotate->valuedouble, &rot) && rot != config->rotate) {
        config->rotate = rot;
        restart = true;
    }
    cJSON_Delete(root);

    if (wifi) strlcat(changes, "wifi", sizeof(changes));
    if (restart) strlcat(changes, changes[0] ? ",rotate" : "rotate", sizeof(changes));
    if (!changes[0]) return;
    esp_err_t err = fos_config_save();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "frame settings not saved: %s", esp_err_to_name(err));
    }
    ESP_LOGI(TAG, "frame settings from the panel: %s", changes);
    log_applied(changes);
    if (restart || (wifi && fos_wifi_state() == FOS_WIFI_PORTAL)) {
        /* The runtime sizes its canvas at init (fos_settings.c does the same
         * for a rotation from a plane), and a frame on the setup hotspot
         * comes back without it, as the portal's own form does. The new
         * network is joined after it. */
        if (xTaskCreate(restart_task, "fos_fs_restart", 2048, NULL, 5, NULL) != pdPASS) esp_restart();
        return;
    }
    if (wifi) {
        err = fos_wifi_start_background();
        if (err != ESP_OK) ESP_LOGW(TAG, "joining \"%s\" failed to start: %s", config->wifi_ssid, esp_err_to_name(err));
    }
}

/* Wi-Fi changed (joined, lost, a failure, a scan): the panel says so, and is
 * drawn again if it is up. On a new address, a backend hears at once where the
 * frame is now (the commands pull reports it); a cloud session comes back by
 * itself with a hello that does. From the event or scan task: bits set, no
 * more. */
static void on_wifi_change(void)
{
    static char reported[16] = "";
    if (fos_scenes_settings_shown()) fos_client_render_now();
    if (fos_wifi_state() == FOS_WIFI_CONNECTED && strcmp(fos_wifi_ip(), reported) != 0) {
        strlcpy(reported, fos_wifi_ip(), sizeof(reported));
        fos_client_request_commands_sync();
    }
}

void fos_frame_settings_init(void)
{
    fos_wifi_set_change_hook(on_wifi_change);
}

void fos_frame_settings_action(const char *action)
{
    if (action == NULL) return;
    if (strcmp(action, "scan") == 0) {
        fos_wifi_scan_start();
    } else if (strcmp(action, "open") == 0) {
        int64_t age = fos_wifi_scan_age_us();
        if (fos_wifi_state() != FOS_WIFI_CONNECTED && !fos_wifi_scanning() && (age < 0 || age > SCAN_FRESH_US)) {
            fos_wifi_scan_start();
        }
    }
}
