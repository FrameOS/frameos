#include "fos_ota.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs.h"

#include "fos_config.h"
#include "fos_http.h"
#include "fos_wifi.h"

static const char *TAG = "fos_ota";
#define FOS_OTA_MAX_ATTEMPTS 64
#define FOS_OTA_HTTP_TIMEOUT_MS 15000
#define FOS_OTA_RECONNECT_TIMEOUT_MS 30000
#define FOS_OTA_REQUEST_SIZE (512 * 1024)
#define FOS_OTA_RETRY_DELAY_MS 1000
#define FOS_OTA_WIFI_SETTLE_MS 3000
#define FOS_OTA_BOOT_REQUEST_KEY "ota_req"

static char s_auth_header[FOS_STR_LEN + 16];
static StaticSemaphore_t s_ota_lock_storage;
static SemaphoreHandle_t s_ota_lock = NULL;
static portMUX_TYPE s_ota_lock_mux = portMUX_INITIALIZER_UNLOCKED;
static TaskHandle_t s_ota_task_handle = NULL;
static volatile bool s_ota_busy = false;

typedef struct {
    char sha[80];
    char elf_sha[80];
} ota_manifest_t;

static const char *wifi_state_name(fos_wifi_state_t state)
{
    switch (state) {
        case FOS_WIFI_OFFLINE: return "offline";
        case FOS_WIFI_CONNECTING: return "connecting";
        case FOS_WIFI_CONNECTED: return "connected";
        case FOS_WIFI_PORTAL: return "portal";
        default: return "unknown";
    }
}

static bool ota_supported(void)
{
    return esp_ota_get_next_update_partition(NULL) != NULL;
}

static bool load_boot_request(void)
{
    nvs_handle_t nvs;
    uint8_t value = 0;
    if (nvs_open("frameos", NVS_READONLY, &nvs) != ESP_OK) return false;
    esp_err_t err = nvs_get_u8(nvs, FOS_OTA_BOOT_REQUEST_KEY, &value);
    nvs_close(nvs);
    return err == ESP_OK && value == 1;
}

static esp_err_t store_boot_request(bool pending)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("frameos", NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;
    if (pending) {
        err = nvs_set_u8(nvs, FOS_OTA_BOOT_REQUEST_KEY, 1);
    } else {
        err = nvs_erase_key(nvs, FOS_OTA_BOOT_REQUEST_KEY);
        if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    }
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}

static bool wait_for_wifi_connected(uint32_t timeout_ms)
{
    int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    while (fos_wifi_state() != FOS_WIFI_CONNECTED) {
        if (esp_timer_get_time() >= deadline) return false;
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    return true;
}

static SemaphoreHandle_t ota_lock(void)
{
    if (s_ota_lock != NULL) return s_ota_lock;
    taskENTER_CRITICAL(&s_ota_lock_mux);
    if (s_ota_lock == NULL) {
        s_ota_lock = xSemaphoreCreateMutexStatic(&s_ota_lock_storage);
    }
    taskEXIT_CRITICAL(&s_ota_lock_mux);
    return s_ota_lock;
}

static bool elf_sha_matches_manifest(const char *running_elf_sha, const char *manifest_elf_sha)
{
    size_t running_len = strlen(running_elf_sha);
    if (running_len < 8 || running_len > strlen(manifest_elf_sha)) return false;
    return strncmp(running_elf_sha, manifest_elf_sha, running_len) == 0;
}

static esp_err_t ota_http_init_cb(esp_http_client_handle_t client)
{
    return esp_http_client_set_header(client, "Authorization", s_auth_header);
}

static esp_err_t perform_ota_download(const esp_https_ota_config_t *ota_config,
                                      int attempt, int max_attempts,
                                      size_t *resume_bytes)
{
    esp_https_ota_handle_t handle = NULL;
    ESP_LOGW(TAG, "OTA attempt %d/%d begin: resume=%u internal=%u psram=%u wifi=%s",
             attempt, max_attempts,
             (unsigned)(resume_bytes ? *resume_bytes : 0),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
             wifi_state_name(fos_wifi_state()));

    esp_err_t err = esp_https_ota_begin(ota_config, &handle);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "OTA begin failed on attempt %d/%d: %s",
                 attempt, max_attempts, esp_err_to_name(err));
        return err;
    }

    ESP_LOGW(TAG, "OTA download started: size=%d bytes",
             esp_https_ota_get_image_size(handle));
    int last_progress_bucket = resume_bytes ? (int)(*resume_bytes / (256 * 1024)) : -1;
    while ((err = esp_https_ota_perform(handle)) == ESP_ERR_HTTPS_OTA_IN_PROGRESS) {
        int read = esp_https_ota_get_image_len_read(handle);
        if (resume_bytes && read > 0 && (size_t)read > *resume_bytes) {
            *resume_bytes = (size_t)read;
        }
        int bucket = read / (256 * 1024);
        if (bucket != last_progress_bucket && read > 0) {
            last_progress_bucket = bucket;
            ESP_LOGW(TAG, "OTA download progress: %d/%d bytes",
                     read, esp_https_ota_get_image_size(handle));
        }
    }
    int read = esp_https_ota_get_image_len_read(handle);
    if (resume_bytes && read > 0 && (size_t)read > *resume_bytes) {
        *resume_bytes = (size_t)read;
    }
    if (err != ESP_OK || !esp_https_ota_is_complete_data_received(handle)) {
        ESP_LOGW(TAG, "OTA download failed on attempt %d/%d at %u bytes: %s",
                 attempt, max_attempts, (unsigned)(resume_bytes ? *resume_bytes : 0),
                 esp_err_to_name(err == ESP_OK ? ESP_FAIL : err));
        esp_https_ota_abort(handle);
        return err == ESP_OK ? ESP_FAIL : err;
    }

    ESP_LOGW(TAG, "OTA download complete: %d bytes",
             esp_https_ota_get_image_len_read(handle));
    err = esp_https_ota_finish(handle);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "OTA finish failed on attempt %d/%d: %s",
                 attempt, max_attempts, esp_err_to_name(err));
    }
    return err;
}

void fos_ota_mark_boot_valid(void)
{
    if (!ota_supported()) return;

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

/* GET the manifest; returns the app artifact hash and the built ELF hash. */
static esp_err_t fetch_manifest(const fos_config_t *config, ota_manifest_t *manifest)
{
    char url[FOS_URL_LEN + 96];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/ota/manifest",
             config->backend_url, (unsigned long)config->frame_id);
    ESP_LOGI(TAG, "checking OTA manifest: %s", url);

    esp_http_client_config_t http_config = {
        .url = url,
        .timeout_ms = 20000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 2048,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (!client) {
        ESP_LOGE(TAG, "OTA manifest client init failed");
        return ESP_FAIL;
    }
    esp_http_client_set_header(client, "Authorization", s_auth_header);
    manifest->sha[0] = '\0';
    manifest->elf_sha[0] = '\0';

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "OTA manifest connect failed: %s", esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return err;
    }
    int64_t content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    char body[768];
    int read = esp_http_client_read(client, body, sizeof(body) - 1);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    if (status != 200 || read <= 0) {
        ESP_LOGI(TAG, "no OTA manifest (HTTP %d, length=%lld, read=%d)",
                 status, content_length, read);
        return ESP_ERR_NOT_FOUND;
    }
    body[read] = '\0';

    cJSON *json = cJSON_Parse(body);
    if (!json) {
        ESP_LOGW(TAG, "OTA manifest parse failed");
        return ESP_FAIL;
    }
    const cJSON *sha_item = cJSON_GetObjectItem(json, "sha256");
    if (!cJSON_IsString(sha_item) || strlen(sha_item->valuestring) < 32) {
        cJSON_Delete(json);
        ESP_LOGW(TAG, "OTA manifest missing sha256");
        return ESP_FAIL;
    }
    strlcpy(manifest->sha, sha_item->valuestring, sizeof(manifest->sha));
    const cJSON *elf_sha_item = cJSON_GetObjectItem(json, "elfSha256");
    if (cJSON_IsString(elf_sha_item) && strlen(elf_sha_item->valuestring) >= 32) {
        strlcpy(manifest->elf_sha, elf_sha_item->valuestring, sizeof(manifest->elf_sha));
    }
    cJSON_Delete(json);
    ESP_LOGI(TAG, "OTA manifest received: image=%.*s… elf=%s%.*s",
             12, manifest->sha,
             manifest->elf_sha[0] ? "" : "(none)",
             manifest->elf_sha[0] ? 12 : 0,
             manifest->elf_sha);
    return ESP_OK;
}

static esp_err_t ota_check_and_apply_locked(void)
{
    ESP_LOGI(TAG, "OTA check started");
    if (!ota_supported()) {
        ESP_LOGI(TAG, "no OTA app partition in this flash layout; skipping OTA check");
        return ESP_ERR_NOT_SUPPORTED;
    }

    fos_config_t *config = fos_config();
    if (!config->backend_url[0] || config->frame_id == 0) {
        ESP_LOGW(TAG, "no backend configured, skipping OTA check");
        return ESP_ERR_INVALID_STATE;
    }
    if (!config->api_key[0]) {
        ESP_LOGW(TAG, "no frame API key configured, skipping OTA check");
        return ESP_ERR_INVALID_STATE;
    }
    fos_wifi_state_t wifi_state = fos_wifi_state();
    if (wifi_state != FOS_WIFI_CONNECTED) {
        ESP_LOGW(TAG, "Wi-Fi state=%s; OTA requires connected station mode",
                 wifi_state_name(wifi_state));
        return ESP_ERR_INVALID_STATE;
    }
    snprintf(s_auth_header, sizeof(s_auth_header), "Bearer %s", config->api_key);

    ota_manifest_t manifest;
    esp_err_t err = fetch_manifest(config, &manifest);
    if (err != ESP_OK) {
        if (err != ESP_ERR_NOT_FOUND) {
            ESP_LOGW(TAG, "OTA manifest check failed: %s", esp_err_to_name(err));
        }
        return err == ESP_ERR_NOT_FOUND ? ESP_OK : err;
    }

    char running_elf_sha[80];
    running_elf_sha[0] = '\0';
    esp_app_get_elf_sha256(running_elf_sha, sizeof(running_elf_sha));

    char applied_sha[80];
    bool has_applied_sha = load_applied_sha(applied_sha, sizeof(applied_sha)) == ESP_OK && applied_sha[0];
    bool manifest_has_elf_sha = manifest.elf_sha[0] != '\0';
    bool running_matches_manifest = manifest_has_elf_sha &&
        running_elf_sha[0] != '\0' &&
        elf_sha_matches_manifest(running_elf_sha, manifest.elf_sha);

    if (running_matches_manifest) {
        if (!has_applied_sha || strcmp(applied_sha, manifest.sha) != 0) {
            ESP_LOGI(TAG, "recording current OTA baseline %.*s…", 12, manifest.sha);
            store_applied_sha(manifest.sha);
        } else {
            ESP_LOGI(TAG, "firmware up to date (%.*s…)", 12, manifest.sha);
        }
        return ESP_OK;
    }

    if (!manifest_has_elf_sha && has_applied_sha && strcmp(applied_sha, manifest.sha) == 0) {
        ESP_LOGI(TAG, "firmware up to date (%.*s…)", 12, manifest.sha);
        return ESP_OK;
    }
    if (manifest_has_elf_sha && !running_elf_sha[0] &&
        has_applied_sha && strcmp(applied_sha, manifest.sha) == 0) {
        ESP_LOGW(TAG, "running ELF hash unavailable; trusting stored OTA baseline %.*s…", 12, manifest.sha);
        return ESP_OK;
    }

    char url[FOS_URL_LEN + 96];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/ota/download",
             config->backend_url, (unsigned long)config->frame_id);
    if (has_applied_sha) {
        ESP_LOGI(TAG, "updating %.*s… -> %.*s… from %s",
                 12, applied_sha, 12, manifest.sha, url);
    } else {
        ESP_LOGI(TAG, "applying OTA image %.*s… from %s", 12, manifest.sha, url);
    }

    esp_http_client_config_t http_config = {
        .url = url,
        .timeout_ms = FOS_OTA_HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = false,
        .buffer_size = 2048,
        .buffer_size_tx = 1024,
    };
    esp_https_ota_config_t base_ota_config = {
        .http_config = &http_config,
        .http_client_init_cb = ota_http_init_cb,
        .partial_http_download = true,
        .max_http_request_size = FOS_OTA_REQUEST_SIZE,
    };

    bool stopped_http = false;
    esp_err_t last_err = ESP_FAIL;
    size_t resume_bytes = 0;
    for (int attempt = 1; attempt <= FOS_OTA_MAX_ATTEMPTS; attempt++) {
        if (!wait_for_wifi_connected(attempt == 1 ? 5000 : FOS_OTA_RECONNECT_TIMEOUT_MS)) {
            last_err = ESP_ERR_INVALID_STATE;
            ESP_LOGW(TAG, "OTA attempt %d/%d skipped: Wi-Fi state=%s",
                     attempt, FOS_OTA_MAX_ATTEMPTS, wifi_state_name(fos_wifi_state()));
            continue;
        }
        if (attempt > 1) {
            vTaskDelay(pdMS_TO_TICKS(FOS_OTA_WIFI_SETTLE_MS));
        }

        if (!stopped_http && fos_http_is_running()) {
            ESP_LOGI(TAG, "stopping local HTTP server for OTA headroom: internal=%u psram=%u",
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
            fos_http_stop();
            stopped_http = true;
            vTaskDelay(pdMS_TO_TICKS(100));
        }

        esp_https_ota_config_t ota_config = base_ota_config;
        ota_config.ota_resumption = resume_bytes > 0;
        ota_config.ota_image_bytes_written = resume_bytes;
        last_err = perform_ota_download(&ota_config, attempt, FOS_OTA_MAX_ATTEMPTS,
                                        &resume_bytes);
        if (last_err == ESP_OK) {
            store_applied_sha(manifest.sha);
            ESP_LOGW(TAG, "OTA update applied, rebooting into new image");
            vTaskDelay(pdMS_TO_TICKS(500));
            esp_restart();
            return ESP_OK;
        }

        if (attempt < FOS_OTA_MAX_ATTEMPTS) {
            ESP_LOGW(TAG, "OTA attempt %d/%d failed: %s; retrying after reconnect from %u bytes",
                     attempt, FOS_OTA_MAX_ATTEMPTS, esp_err_to_name(last_err),
                     (unsigned)resume_bytes);
            vTaskDelay(pdMS_TO_TICKS(FOS_OTA_RETRY_DELAY_MS));
        }
    }

    ESP_LOGE(TAG, "OTA failed after %d attempts: %s",
             FOS_OTA_MAX_ATTEMPTS, esp_err_to_name(last_err));
    if (stopped_http) {
        fos_http_start(false);
    }
    return last_err;
}

esp_err_t fos_ota_check_and_apply(void)
{
    SemaphoreHandle_t lock = ota_lock();
    if (lock == NULL) {
        ESP_LOGE(TAG, "OTA lock unavailable");
        return ESP_ERR_NO_MEM;
    }
    if (xSemaphoreTake(lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "OTA check already in progress; skipping concurrent request");
        return ESP_ERR_INVALID_STATE;
    }

    s_ota_busy = true;
    esp_err_t err = ota_check_and_apply_locked();
    s_ota_busy = false;
    xSemaphoreGive(lock);
    return err;
}

bool fos_ota_busy(void)
{
    return s_ota_busy;
}

bool fos_ota_boot_request_pending(void)
{
    return load_boot_request();
}

esp_err_t fos_ota_run_boot_request(void)
{
    if (!load_boot_request()) return ESP_OK;

    ESP_LOGW(TAG, "boot OTA request found; checking before runtime startup");
    esp_err_t clear_err = store_boot_request(false);
    if (clear_err != ESP_OK) {
        ESP_LOGW(TAG, "failed to clear boot OTA request: %s", esp_err_to_name(clear_err));
    }
    return fos_ota_check_and_apply();
}

static void ota_task(void *arg)
{
    uint32_t interval_hours = (uint32_t)(uintptr_t)arg;
    if (interval_hours == 0) interval_hours = 24;
    TickType_t interval_ticks = pdMS_TO_TICKS(interval_hours * 3600u * 1000u);
    while (true) {
        uint32_t notifications = ulTaskNotifyTake(pdTRUE, interval_ticks);
        bool manual = notifications > 0;
        if (manual) {
            vTaskDelay(pdMS_TO_TICKS(250));
        }
        ESP_LOGW(TAG, "%s OTA check waking", manual ? "manual" : "periodic");
        esp_err_t err = fos_ota_check_and_apply();
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "%s OTA check failed: %s",
                     manual ? "manual" : "periodic", esp_err_to_name(err));
        }
    }
}

void fos_ota_start_periodic_task(uint32_t interval_hours)
{
    if (s_ota_task_handle != NULL) return;
    if (!ota_supported()) {
        ESP_LOGI(TAG, "no OTA app partition in this flash layout; periodic OTA disabled");
        return;
    }
    BaseType_t created = xTaskCreate(ota_task, "fos_ota", 8192,
                                     (void *)(uintptr_t)interval_hours, 4,
                                     &s_ota_task_handle);
    if (created != pdPASS) {
        s_ota_task_handle = NULL;
        ESP_LOGE(TAG, "OTA task start failed: internal=%u psram=%u",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    }
}

esp_err_t fos_ota_request_check(void)
{
    if (!ota_supported()) return ESP_ERR_NOT_SUPPORTED;
    esp_err_t err = store_boot_request(true);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to store OTA request: %s", esp_err_to_name(err));
        return err;
    }
    ESP_LOGW(TAG, "OTA requested; rebooting into early updater");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK;
}
