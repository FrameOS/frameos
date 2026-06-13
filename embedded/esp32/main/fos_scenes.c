#include "fos_scenes.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_spiffs.h"

#include "fos_config.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_scenes";

#define SCENES_PATH "/state/scenes.json"
#define SCENES_TMP_PATH "/state/scenes.json.tmp"
#define SCENES_ETAG_PATH "/state/scenes.etag"
#define SCENES_MAX_BYTES (512 * 1024)
#define ETAG_LEN 80

static bool s_mounted = false;
static volatile bool s_pending = false;
static volatile bool s_sync_requested = false;
static int s_loaded = 0;
static char s_etag[ETAG_LEN] = "";

/* ------------------------------------------------------------- storage */

static esp_err_t mount_state(void)
{
    if (s_mounted) return ESP_OK;
    esp_vfs_spiffs_conf_t conf = {
        .base_path = "/state",
        .partition_label = "state",
        .max_files = 8,
        .format_if_mount_failed = true,
    };
    esp_err_t err = esp_vfs_spiffs_register(&conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "mounting state partition failed: %s", esp_err_to_name(err));
        return err;
    }
    size_t total = 0, used = 0;
    esp_spiffs_info("state", &total, &used);
    ESP_LOGI(TAG, "/state mounted: %u/%u bytes used", (unsigned)used, (unsigned)total);
    s_mounted = true;
    return ESP_OK;
}

static char *read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (f == NULL) return NULL;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size <= 0 || size > SCENES_MAX_BYTES) {
        fclose(f);
        return NULL;
    }
    char *buf = heap_caps_malloc(size + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) buf = malloc(size + 1);
    if (buf == NULL) {
        fclose(f);
        return NULL;
    }
    size_t read = fread(buf, 1, size, f);
    fclose(f);
    buf[read] = 0;
    if (out_len != NULL) *out_len = read;
    return buf;
}

static esp_err_t write_file_atomic(const char *path, const char *tmp_path,
                                   const char *data, size_t len)
{
    FILE *f = fopen(tmp_path, "wb");
    if (f == NULL) {
        ESP_LOGE(TAG, "open %s for write failed", tmp_path);
        return ESP_FAIL;
    }
    size_t written = fwrite(data, 1, len, f);
    fclose(f);
    if (written != len) {
        ESP_LOGE(TAG, "short write to %s (%u/%u)", tmp_path, (unsigned)written, (unsigned)len);
        remove(tmp_path);
        return ESP_FAIL;
    }
    remove(path);
    if (rename(tmp_path, path) != 0) {
        ESP_LOGE(TAG, "rename %s -> %s failed", tmp_path, path);
        return ESP_FAIL;
    }
    return ESP_OK;
}

static void load_etag(void)
{
    size_t len = 0;
    char *etag = read_file(SCENES_ETAG_PATH, &len);
    if (etag != NULL) {
        snprintf(s_etag, sizeof(s_etag), "%s", etag);
        free(etag);
    }
}

static void save_etag(const char *etag)
{
    snprintf(s_etag, sizeof(s_etag), "%s", etag ? etag : "");
    FILE *f = fopen(SCENES_ETAG_PATH, "wb");
    if (f != NULL) {
        fwrite(s_etag, 1, strlen(s_etag), f);
        fclose(f);
    }
}

/* --------------------------------------------------------------- apply */

static bool load_into_nim(const char *json)
{
    if (!frameos_nim_available()) {
        ESP_LOGW(TAG, "nim runtime unavailable, scenes not loaded");
        return false;
    }
    int count = frameos_nim_load_scenes(json);
    if (count <= 0) {
        ESP_LOGE(TAG, "scene payload rejected by runtime");
        return false;
    }
    s_loaded = count;
    ESP_LOGI(TAG, "%d scene(s) live", count);
    return true;
}

bool fos_scenes_apply_pending(void)
{
    if (!s_pending || !s_mounted) return false;
    s_pending = false;
    size_t len = 0;
    char *json = read_file(SCENES_PATH, &len);
    if (json == NULL) {
        ESP_LOGW(TAG, "no readable %s", SCENES_PATH);
        return false;
    }
    bool ok = load_into_nim(json);
    free(json);
    return ok;
}

int fos_scenes_loaded(void) { return s_loaded; }
const char *fos_scenes_etag(void) { return s_etag; }
void fos_scenes_request_sync(void) { s_sync_requested = true; }

/* ---------------------------------------------------------------- init */

esp_err_t fos_scenes_init(void)
{
    esp_err_t err = mount_state();
    if (err != ESP_OK) return err;
    load_etag();
    struct stat st;
    if (stat(SCENES_PATH, &st) == 0 && st.st_size > 2) {
        ESP_LOGI(TAG, "cached scenes.json (%ld bytes, etag %s)", (long)st.st_size,
                 s_etag[0] ? s_etag : "none");
        s_pending = true;
    } else {
        ESP_LOGI(TAG, "no cached scenes; will sync from backend");
    }
    return ESP_OK;
}

/* ------------------------------------------------------------ local push */

esp_err_t fos_scenes_set_json(const char *json, size_t len)
{
    if (json == NULL || len == 0 || len > SCENES_MAX_BYTES) return ESP_ERR_INVALID_ARG;
    esp_err_t err = mount_state();
    if (err != ESP_OK) return err;
    err = write_file_atomic(SCENES_PATH, SCENES_TMP_PATH, json, len);
    if (err != ESP_OK) return err;
    save_etag("local");
    s_pending = true;
    ESP_LOGI(TAG, "scenes payload stored (%u bytes), pending apply", (unsigned)len);
    return ESP_OK;
}

/* ------------------------------------------------------------- backend */

static esp_err_t collect_etag_handler(esp_http_client_event_t *evt)
{
    if (evt->event_id == HTTP_EVENT_ON_HEADER &&
        strcasecmp(evt->header_key, "ETag") == 0) {
        char *etag_out = (char *)evt->user_data;
        snprintf(etag_out, ETAG_LEN, "%s", evt->header_value);
    }
    return ESP_OK;
}

esp_err_t fos_scenes_sync(bool force)
{
    fos_config_t *config = fos_config();
    if (s_sync_requested) {
        force = true;
        s_sync_requested = false;
    }
    if (!config->backend_url[0] || config->frame_id == 0) return ESP_ERR_INVALID_STATE;
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) return ESP_ERR_INVALID_STATE;
    esp_err_t err = mount_state();
    if (err != ESP_OK) return err;

    char url[FOS_URL_LEN + 64];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/scenes",
             config->backend_url, (unsigned long)config->frame_id);
    char auth[FOS_STR_LEN + 16];
    snprintf(auth, sizeof(auth), "Bearer %s", config->api_key);

    char response_etag[ETAG_LEN] = "";
    esp_http_client_config_t http_config = {
        .url = url,
        .timeout_ms = 30000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 4096,
        .event_handler = collect_etag_handler,
        .user_data = response_etag,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (client == NULL) return ESP_FAIL;
    esp_http_client_set_header(client, "Authorization", auth);
    if (!force && s_etag[0] && strcmp(s_etag, "local") != 0) {
        esp_http_client_set_header(client, "If-None-Match", s_etag);
    }

    err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "scenes sync: connect failed: %s", esp_err_to_name(err));
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
    if (status != 200) {
        ESP_LOGW(TAG, "scenes sync: HTTP %d from %s", status, url);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }
    if (content_length > SCENES_MAX_BYTES) {
        ESP_LOGE(TAG, "scenes sync: payload too large (%lld)", content_length);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }

    size_t cap = content_length > 0 ? (size_t)content_length : 16384;
    char *buf = heap_caps_malloc(cap + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) buf = malloc(cap + 1);
    if (buf == NULL) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }
    size_t total = 0;
    while (true) {
        if (total == cap) {
            if (cap >= SCENES_MAX_BYTES) {
                free(buf);
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                return ESP_ERR_NO_MEM;
            }
            size_t new_cap = cap * 2 > SCENES_MAX_BYTES ? SCENES_MAX_BYTES : cap * 2;
            char *new_buf = heap_caps_realloc(buf, new_cap + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (new_buf == NULL) new_buf = realloc(buf, new_cap + 1);
            if (new_buf == NULL) {
                free(buf);
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                return ESP_ERR_NO_MEM;
            }
            buf = new_buf;
            cap = new_cap;
        }
        int r = esp_http_client_read(client, buf + total, cap - total);
        if (r < 0) {
            free(buf);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return ESP_FAIL;
        }
        if (r == 0) break;
        total += r;
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    buf[total] = 0;

    err = write_file_atomic(SCENES_PATH, SCENES_TMP_PATH, buf, total);
    if (err == ESP_OK) {
        save_etag(response_etag);
        ESP_LOGI(TAG, "scenes updated from backend (%u bytes, etag %s)",
                 (unsigned)total, response_etag[0] ? response_etag : "none");
        load_into_nim(buf);
    }
    free(buf);
    return err;
}
