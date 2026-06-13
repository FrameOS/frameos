#include "fos_ota.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "nvs.h"

#include "fos_config.h"
#include "fos_wifi.h"

static const char *TAG = "fos_ota";
static char s_auth_header[FOS_STR_LEN + 16];

static esp_err_t ota_http_init_cb(esp_http_client_handle_t client)
{
    return esp_http_client_set_header(client, "Authorization", s_auth_header);
}

void fos_ota_mark_boot_valid(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG, "first boot of new image on %s: marking valid", running->label);
        esp_ota_mark_app_valid_cancel_rollback();
    }
}

/* sha256 of the last applied (or first seen) backend OTA artifact */
static esp_err_t load_applied_sha(char *out, size_t out_len)
{
    nvs_handle_t nvs;
    out[0] = '\0';
    if (nvs_open("frameos", NVS_READONLY, &nvs) != ESP_OK) return ESP_FAIL;
    size_t len = out_len;
    esp_err_t err = nvs_get_str(nvs, "ota_sha", out, &len);
    nvs_close(nvs);
    return err;
}

static void store_applied_sha(const char *sha)
{
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return;
    nvs_set_str(nvs, "ota_sha", sha);
    nvs_commit(nvs);
    nvs_close(nvs);
}

/* GET the manifest; returns the artifact sha256 in `sha` or an error. */
static esp_err_t fetch_manifest_sha(const fos_config_t *config, char *sha, size_t sha_len)
{
    char url[FOS_URL_LEN + 96];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/ota/manifest",
             config->backend_url, (unsigned long)config->frame_id);

    esp_http_client_config_t http_config = {
        .url = url,
        .timeout_ms = 20000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 2048,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (!client) return ESP_FAIL;
    esp_http_client_set_header(client, "Authorization", s_auth_header);

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        return err;
    }
    esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    char body[512];
    int read = esp_http_client_read(client, body, sizeof(body) - 1);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    if (status != 200 || read <= 0) {
        ESP_LOGI(TAG, "no OTA manifest (HTTP %d)", status);
        return ESP_ERR_NOT_FOUND;
    }
    body[read] = '\0';

    cJSON *json = cJSON_Parse(body);
    if (!json) return ESP_FAIL;
    const cJSON *sha_item = cJSON_GetObjectItem(json, "sha256");
    if (!cJSON_IsString(sha_item) || strlen(sha_item->valuestring) < 32) {
        cJSON_Delete(json);
        return ESP_FAIL;
    }
    strlcpy(sha, sha_item->valuestring, sha_len);
    cJSON_Delete(json);
    return ESP_OK;
}

esp_err_t fos_ota_check_and_apply(void)
{
    fos_config_t *config = fos_config();
    if (!config->backend_url[0] || config->frame_id == 0) {
        ESP_LOGW(TAG, "no backend configured, skipping OTA check");
        return ESP_ERR_INVALID_STATE;
    }
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) {
        return ESP_ERR_INVALID_STATE;
    }
    snprintf(s_auth_header, sizeof(s_auth_header), "Bearer %s", config->api_key);

    char manifest_sha[80];
    esp_err_t err = fetch_manifest_sha(config, manifest_sha, sizeof(manifest_sha));
    if (err != ESP_OK) {
        return err == ESP_ERR_NOT_FOUND ? ESP_OK : err;
    }

    char applied_sha[80];
    if (load_applied_sha(applied_sha, sizeof(applied_sha)) != ESP_OK || !applied_sha[0]) {
        /* First contact after a USB flash: assume the running image is the
         * latest backend build and just record it. */
        ESP_LOGI(TAG, "recording current OTA baseline %.*s…", 12, manifest_sha);
        store_applied_sha(manifest_sha);
        return ESP_OK;
    }
    if (strcmp(applied_sha, manifest_sha) == 0) {
        ESP_LOGI(TAG, "firmware up to date (%.*s…)", 12, manifest_sha);
        return ESP_OK;
    }

    char url[FOS_URL_LEN + 96];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/ota/download",
             config->backend_url, (unsigned long)config->frame_id);
    ESP_LOGI(TAG, "updating %.*s… -> %.*s… from %s",
             12, applied_sha, 12, manifest_sha, url);

    esp_http_client_config_t http_config = {
        .url = url,
        .timeout_ms = 60000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = true,
        .buffer_size = 4096,
    };
    esp_https_ota_config_t ota_config = {
        .http_config = &http_config,
        .http_client_init_cb = ota_http_init_cb,
    };

    esp_https_ota_handle_t handle = NULL;
    err = esp_https_ota_begin(&ota_config, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "OTA begin failed: %s", esp_err_to_name(err));
        return err;
    }
    while ((err = esp_https_ota_perform(handle)) == ESP_ERR_HTTPS_OTA_IN_PROGRESS) {
        /* keep pulling */
    }
    if (err != ESP_OK || !esp_https_ota_is_complete_data_received(handle)) {
        ESP_LOGE(TAG, "OTA download failed: %s", esp_err_to_name(err));
        esp_https_ota_abort(handle);
        return err == ESP_OK ? ESP_FAIL : err;
    }
    err = esp_https_ota_finish(handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "OTA finish failed: %s", esp_err_to_name(err));
        return err;
    }
    store_applied_sha(manifest_sha);
    ESP_LOGI(TAG, "OTA update applied, rebooting into new image");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK;
}

static void ota_task(void *arg)
{
    uint32_t interval_hours = (uint32_t)(uintptr_t)arg;
    if (interval_hours == 0) interval_hours = 24;
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(interval_hours * 3600u * 1000u));
        fos_ota_check_and_apply();
    }
}

void fos_ota_start_periodic_task(uint32_t interval_hours)
{
    xTaskCreate(ota_task, "fos_ota", 8192, (void *)(uintptr_t)interval_hours, 4, NULL);
}
