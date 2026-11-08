/*
 * The frame page of the settings panel on the screen, behind its gear
 * (system/sceneSettings, docs/scene-settings.md "The frame page"): the facts
 * the page shows (Wi-Fi, address, who manages the frame, the version, the
 * rotation and render scale) and what it sets (the Wi-Fi network, the
 * rotation, the scale). The page has the words; this file has the facts.
 *
 * The Nim scene asks through three hooks (embedded_runtime.nim); every call
 * comes on the render task, under the runtime lock. What the page shows
 * changes under it (a join, a scan), and main.c renders the panel again when
 * it does (fos_wifi_set_change_hook, fos_scenes_settings_shown).
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

/* Who manages the frame: a plane that adopts what is set here (the cloud's
 * mirror from the hardware report, a backend from the `settings:frame` line).
 * NULL = nobody. */
static const char *manager(void)
{
    const fos_config_t *config = fos_config();
    if (config->backend_url[0]) return "FrameOS backend";
    if (config->cloud_url[0] && fos_cloud_state() != FOS_CLOUD_NONE) return "FrameOS Cloud";
    return NULL;
}

/* The page's facts as JSON, written as text: the keys are literals, and what
 * the frame says (a network's name) is escaped on its way in. A buffer of
 * JSON_CAP holds the worst case: every name in range and the saved one, 32
 * bytes each, every byte escaped to \u00XX. */
#define JSON_CAP (768 + (FOS_WIFI_SCAN_MAX + 1) * (32 * 6 + 4))

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

static void trim_comma(out_t *out)
{
    if (out->len > 0 && out->buf[out->len - 1] == ',') out->buf[--out->len] = '\0';
}

/* `,"key":"text"` */
static void put_pair(out_t *out, const char *key, const char *text)
{
    put(out, ",\"");
    put(out, key);
    put(out, "\":");
    put_string(out, text);
}

char *fos_frame_settings_json(void)
{
    /* Turned off by the frame's control plane, and not unlocked on the
     * device: no page, no gear. */
    if (!fos_config_frame_page_offered()) return NULL;
    const fos_config_t *config = fos_config();
    out_t out = {.buf = fos_big_malloc(JSON_CAP), .len = 0};
    if (out.buf == NULL) return NULL;
    out.buf[0] = '\0';
    fos_wifi_state_t state = fos_wifi_state();
    const char *ssid = config->wifi_ssid;
    uint8_t reason = fos_wifi_join_reason();
    const char *word = state == FOS_WIFI_CONNECTED                ? "connected"
                       : state == FOS_WIFI_PORTAL                 ? "hotspot"
                       : !ssid[0]                                 ? "unset"
                       : fos_wifi_join_reason_not_found(reason)   ? "notFound"
                       : fos_wifi_join_reason_auth(reason)        ? "auth"
                       : state == FOS_WIFI_CONNECTING             ? "connecting"
                                                                  : "off";
    char line[96];
    put(&out, "{\"wifi\":{\"state\":\"");
    put(&out, word);
    put(&out, "\"");
    put_pair(&out, "ssid", ssid);
    if (state == FOS_WIFI_PORTAL) put_pair(&out, "hotspot", fos_wifi_ap_ssid());
    if (state == FOS_WIFI_CONNECTED) {
        snprintf(line, sizeof(line), ",\"rssi\":%d", fos_wifi_rssi());
        put(&out, line);
        put_pair(&out, "ip", fos_wifi_ip());
    }
    /* The networks in range, by name (the scan sorted them). */
    put(&out, ",\"networks\":[");
    fos_wifi_network_t *networks = fos_big_malloc(FOS_WIFI_SCAN_MAX * sizeof(*networks));
    int count = networks ? fos_wifi_scan_results(networks, FOS_WIFI_SCAN_MAX) : 0;
    for (int i = 0; i < count; i++) {
        put_string(&out, networks[i].ssid);
        put(&out, ",");
    }
    free(networks);
    trim_comma(&out);
    snprintf(line, sizeof(line), "],\"scanning\":%s,\"password\":%s},\"rotate\":%u,\"renderScale\":%g",
             fos_wifi_scanning() ? "true" : "false", config->wifi_pass[0] ? "true" : "false",
             (unsigned)config->rotate, config->render_scale_milli / 1000.0);
    put(&out, line);
    if (manager() != NULL) put_pair(&out, "managedBy", manager());
    put_pair(&out, "version", esp_app_get_description()->version);
    if (s_refused[0]) put_pair(&out, "note", s_refused);
    /* Restart is a reboot here: the page shows Reboot alone. */
    put(&out, ",\"actions\":[]}");
    return out.buf;
}

static void restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(1500)); /* the log line goes out first */
    esp_restart();
}

/* One `settings:frame` line for what was saved, with the values a control
 * plane adopts (a backend reads it from the log, app/models/log.py; the cloud
 * follows the hardware report instead). Never the network's name. */
static void log_applied(const char *changes, bool rotate, bool scale)
{
    const fos_config_t *config = fos_config();
    char line[224];
    int n = snprintf(line, sizeof(line), "{\"event\":\"settings:frame\",\"source\":\"esp32\",\"origin\":\"panel\","
                     "\"changes\":\"%s\"", changes);
    if (rotate && n > 0 && n < (int)sizeof(line)) {
        n += snprintf(line + n, sizeof(line) - n, ",\"rotate\":%u", (unsigned)config->rotate);
    }
    if (scale && n > 0 && n < (int)sizeof(line)) {
        n += snprintf(line + n, sizeof(line) - n, ",\"renderScale\":%g", config->render_scale_milli / 1000.0);
    }
    if (n > 0 && n < (int)sizeof(line) - 1) strlcat(line, "}", sizeof(line));
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
    bool wifi = false, restart = false, scale = false;
    char changes[64] = "";
    s_refused[0] = '\0';

    const cJSON *ssid = cJSON_GetObjectItem(root, "wifiSsid");
    const cJSON *pass = cJSON_GetObjectItem(root, "wifiPassword");
    const char *new_ssid = cJSON_IsString(ssid) ? ssid->valuestring : config->wifi_ssid;
    const char *new_pass = cJSON_IsString(pass) ? pass->valuestring : "";
    if (!cJSON_IsString(ssid) && !cJSON_IsString(pass)) {
        /* No network on this Save. */
    } else if (new_ssid[0] && strlen(new_ssid) <= 32 && strlen(new_pass) < sizeof(config->wifi_pass) &&
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
    } else {
        strlcpy(s_refused,
                !new_ssid[0] || strlen(new_ssid) > 32 ? "A network name is 1 to 32 characters"
                                                      : "A password is 8 to 63 characters",
                sizeof(s_refused));
        ESP_LOGW(TAG, "Wi-Fi refused: %s", s_refused);
    }

    /* The rotation and the scale, on a managed frame too: its plane adopts
     * them (docs/scene-settings.md "What a control plane learns"). */
    const cJSON *rotate = cJSON_GetObjectItem(root, "rotate");
    uint16_t value = 0;
    if (cJSON_IsNumber(rotate) && fos_config_normalize_rotate(rotate->valuedouble, &value) && value != config->rotate) {
        config->rotate = value;
        restart = true;
    }
    const cJSON *render_scale = cJSON_GetObjectItem(root, "renderScale");
    if (cJSON_IsNumber(render_scale) && fos_config_normalize_render_scale(render_scale->valuedouble, &value) &&
        value != config->render_scale_milli) {
        /* Live: fos_client.c hands the runtime the scale on every pass. */
        config->render_scale_milli = value;
        scale = true;
    }
    cJSON_Delete(root);

    if (wifi) strlcat(changes, "wifi,", sizeof(changes));
    if (restart) strlcat(changes, "rotate,", sizeof(changes));
    if (scale) strlcat(changes, "renderScale,", sizeof(changes));
    if (!changes[0]) return;
    changes[strlen(changes) - 1] = '\0';
    esp_err_t err = fos_config_save();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "frame settings not saved: %s", esp_err_to_name(err));
    }
    ESP_LOGI(TAG, "frame settings from the panel: %s", changes);
    log_applied(changes, restart, scale);
    if (restart || (wifi && fos_wifi_state() == FOS_WIFI_PORTAL)) {
        /* The runtime sizes its canvas at init (fos_settings.c does the same
         * for a rotation from a plane), and a frame on the setup hotspot
         * comes back without it, as the portal's own form does. The new
         * network is joined after it; the hello after it reports the
         * rotation. */
        if (xTaskCreate(restart_task, "fos_fs_restart", 2048, NULL, 5, NULL) != pdPASS) esp_restart();
        return;
    }
    if (scale) {
        fos_cloud_request_state();
        fos_client_render_now();
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
