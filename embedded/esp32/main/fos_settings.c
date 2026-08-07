#include "fos_settings.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"

#include "cJSON.h"
#include "fos_config.h"
#include "fos_mem.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_settings";

#define SETTINGS_MAX_BYTES (16 * 1024)
#define SETTINGS_ETAG_LEN 96

/* RAM-only: settings are refetched once per boot, then 304 thereafter. */
static char s_etag[SETTINGS_ETAG_LEN] = "";
static volatile bool s_sync_requested = false;

void fos_settings_request_sync(void)
{
    s_sync_requested = true;
}

static esp_err_t collect_etag_handler(esp_http_client_event_t *evt)
{
    if (evt->event_id == HTTP_EVENT_ON_HEADER &&
        strcasecmp(evt->header_key, "ETag") == 0) {
        char *etag_out = (char *)evt->user_data;
        snprintf(etag_out, SETTINGS_ETAG_LEN, "%s", evt->header_value);
    }
    return ESP_OK;
}

static void log_settings_event(const char *status, const char *detail)
{
    char line[256];
    snprintf(line, sizeof(line),
             "{\"event\":\"settings:sync\",\"source\":\"esp32\","
             "\"status\":\"%s\",\"detail\":\"%s\"}",
             status, detail ? detail : "");
    frameos_nim_log_hook(line);
}

/* Apply the `frame` object. Returns true when anything changed. */
static bool apply_frame_settings(const cJSON *frame)
{
    fos_config_t *config = fos_config();
    bool changed = false;

    const cJSON *interval = cJSON_GetObjectItem(frame, "interval");
    if (cJSON_IsNumber(interval) && interval->valuedouble >= 1 &&
        interval->valuedouble <= 7 * 86400) {
        uint32_t seconds = (uint32_t)interval->valuedouble;
        if (seconds < 5) seconds = 5; /* same floor as the local admin API */
        if (config->interval_sec != seconds) {
            config->interval_sec = seconds;
            changed = true;
        }
    }

    const cJSON *name = cJSON_GetObjectItem(frame, "name");
    if (cJSON_IsString(name) && name->valuestring[0] &&
        strcmp(config->hostname, name->valuestring) != 0 &&
        strlen(name->valuestring) < sizeof(config->hostname)) {
        strlcpy(config->hostname, name->valuestring, sizeof(config->hostname));
        changed = true;
    }

    const cJSON *render_mode = cJSON_GetObjectItem(frame, "renderMode");
    if (cJSON_IsString(render_mode)) {
        fos_render_mode_t mode = strcmp(render_mode->valuestring, "remote") == 0
                                     ? FOS_RENDER_REMOTE
                                     : FOS_RENDER_LOCAL;
        if (config->render_mode != mode) {
            config->render_mode = mode;
            changed = true;
        }
    }

    const cJSON *deep_sleep = cJSON_GetObjectItem(frame, "deepSleep");
    if (cJSON_IsBool(deep_sleep) &&
        config->deep_sleep != (bool)cJSON_IsTrue(deep_sleep)) {
        config->deep_sleep = cJSON_IsTrue(deep_sleep);
        changed = true;
    }

    const cJSON *wake_schedule = cJSON_GetObjectItem(frame, "wakeSchedule");
    if (cJSON_IsBool(wake_schedule) &&
        config->wake_schedule != (bool)cJSON_IsTrue(wake_schedule)) {
        config->wake_schedule = cJSON_IsTrue(wake_schedule);
        changed = true;
    }

    return changed;
}

esp_err_t fos_settings_sync(bool force)
{
    fos_config_t *config = fos_config();
    if (s_sync_requested) {
        force = true;
        s_sync_requested = false;
    }
    if (!config->backend_url[0] || config->frame_id == 0 || !config->api_key[0]) {
        return ESP_ERR_INVALID_STATE;
    }
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) return ESP_ERR_INVALID_STATE;

    char url[FOS_URL_LEN + 64];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/settings",
             config->backend_url, (unsigned long)config->frame_id);
    char auth[FOS_STR_LEN + 16];
    snprintf(auth, sizeof(auth), "Bearer %s", config->api_key);

    char response_etag[SETTINGS_ETAG_LEN] = "";
    esp_http_client_config_t http_config = {
        .url = url,
        .timeout_ms = 15000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 2048,
        .event_handler = collect_etag_handler,
        .user_data = response_etag,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (client == NULL) return ESP_FAIL;
    esp_http_client_set_header(client, "Authorization", auth);
    if (!force && s_etag[0]) {
        esp_http_client_set_header(client, "If-None-Match", s_etag);
    }

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        return err;
    }
    int64_t content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);

    if (status == 304) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_OK;
    }
    if (status != 200 || content_length > SETTINGS_MAX_BYTES) {
        if (status != 404) { /* older backends have no settings route */
            ESP_LOGW(TAG, "settings sync: HTTP %d from %s", status, url);
        }
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }

    size_t cap = content_length > 0 ? (size_t)content_length : 4096;
    char *buf = malloc(cap + 1);
    if (buf == NULL) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }
    size_t total = 0;
    while (total < cap) {
        int r = esp_http_client_read(client, buf + total, cap - total);
        if (r < 0) {
            free(buf);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return ESP_FAIL;
        }
        if (r == 0) break;
        total += (size_t)r;
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    buf[total] = '\0';

    cJSON *root = cJSON_ParseWithLength(buf, total);
    free(buf);
    if (root == NULL || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        log_settings_event("error", "unparseable");
        return ESP_FAIL;
    }

    /* Only the `frame` object is applied today; the app-secret keys in the
     * payload (homeAssistant/openAI/...) have no on-device consumer yet. */
    const cJSON *frame = cJSON_GetObjectItem(root, "frame");
    bool changed = cJSON_IsObject(frame) ? apply_frame_settings(frame) : false;
    cJSON_Delete(root);

    if (changed) {
        if (fos_config_save() != ESP_OK) {
            log_settings_event("error", "persist-failed");
            return ESP_FAIL;
        }
        log_settings_event("applied", "");
        ESP_LOGI(TAG, "settings applied from backend (interval=%lu render_mode=%d)",
                 (unsigned long)config->interval_sec, (int)config->render_mode);
    }
    if (response_etag[0]) {
        strlcpy(s_etag, response_etag, sizeof(s_etag));
    }
    return ESP_OK;
}
