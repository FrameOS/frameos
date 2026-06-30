#include "fos_scenes.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_spiffs.h"
#include "freertos/FreeRTOS.h"

#include "fos_config.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_scenes";

#define SCENES_PATH "/state/scenes.json"
#define SCENES_TMP_PATH "/state/scenes.json.tmp"
#define SCENES_ETAG_PATH "/state/scenes.etag"
#define SCENES_MAX_BYTES (512 * 1024)
#define ETAG_LEN 80
#define SCENE_ID_LEN 128
#define SCENE_ERROR_LEN 256

static bool s_mounted = false;
static volatile bool s_pending = false;
static volatile bool s_sync_requested = false;
static volatile bool s_scene_select_pending = false;
static int s_loaded = 0;
static char s_etag[ETAG_LEN] = "";
static char s_pending_scene_id[SCENE_ID_LEN] = "";
static char s_last_error[SCENE_ERROR_LEN] = "";
static portMUX_TYPE s_scene_select_lock = portMUX_INITIALIZER_UNLOCKED;

static void json_escape_value(const char *src, char *out, size_t out_len)
{
    if (!out || out_len == 0) return;
    out[0] = '\0';
    if (!src) return;

    size_t used = 0;
    for (const unsigned char *p = (const unsigned char *)src; *p && used + 1 < out_len; p++) {
        unsigned char c = *p;
        if (c == '"' || c == '\\') {
            if (used + 2 >= out_len) break;
            out[used++] = '\\';
            out[used++] = (char)c;
        } else if (c == '\n' || c == '\r' || c == '\t') {
            if (used + 2 >= out_len) break;
            out[used++] = '\\';
            out[used++] = c == '\n' ? 'n' : (c == '\r' ? 'r' : 't');
        } else if (c < 0x20) {
            if (used + 6 >= out_len) break;
            int written = snprintf(out + used, out_len - used, "\\u%04x", (unsigned)c);
            if (written != 6) break;
            used += 6;
        } else {
            out[used++] = (char)c;
        }
    }
    out[used] = '\0';
}

static void log_scene_event(const char *event, const char *status, const char *origin,
                            const char *scene_id, const char *detail, size_t bytes,
                            int scene_count, int http_status, esp_err_t esp_err)
{
    char event_esc[64];
    char status_esc[64];
    char origin_esc[64];
    char scene_id_esc[192];
    char detail_esc[128];
    char etag_esc[128];
    char err_name_esc[64];
    json_escape_value(event, event_esc, sizeof(event_esc));
    json_escape_value(status, status_esc, sizeof(status_esc));
    json_escape_value(origin, origin_esc, sizeof(origin_esc));
    json_escape_value(scene_id, scene_id_esc, sizeof(scene_id_esc));
    json_escape_value(detail, detail_esc, sizeof(detail_esc));
    json_escape_value(s_etag, etag_esc, sizeof(etag_esc));
    json_escape_value(esp_err == ESP_OK ? "OK" : esp_err_to_name(esp_err),
                      err_name_esc, sizeof(err_name_esc));

    char log_line[1024];
    snprintf(log_line, sizeof(log_line),
             "{\"event\":\"%s\",\"source\":\"esp32\",\"status\":\"%s\","
             "\"origin\":\"%s\",\"sceneId\":\"%s\",\"detail\":\"%s\","
             "\"bytes\":%u,\"sceneCount\":%d,\"loadedScenes\":%d,"
             "\"httpStatus\":%d,\"etag\":\"%s\",\"freeHeap\":%u,\"freePsram\":%u,"
             "\"espErr\":%d,\"espErrName\":\"%s\"}",
             event_esc, status_esc, origin_esc, scene_id_esc, detail_esc,
             (unsigned)bytes, scene_count, s_loaded, http_status, etag_esc,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
             (int)esp_err, err_name_esc);
    frameos_nim_log_hook(log_line);
}

const char *fos_scenes_last_error(void)
{
    return s_last_error;
}

static esp_err_t scene_err_from_errno(int err_no, esp_err_t fallback)
{
    switch (err_no) {
    case 0:
        return fallback;
    case ENOSPC:
        return ESP_ERR_NO_MEM;
    case ENOENT:
        return ESP_ERR_NOT_FOUND;
    case EINVAL:
        return ESP_ERR_INVALID_ARG;
    default:
        return fallback;
    }
}

static void state_usage(size_t *total, size_t *used)
{
    if (total) *total = 0;
    if (used) *used = 0;
    size_t local_total = 0;
    size_t local_used = 0;
    if (esp_spiffs_info("state", &local_total, &local_used) == ESP_OK) {
        if (total) *total = local_total;
        if (used) *used = local_used;
    }
}

static void set_scene_error(const char *operation, const char *path,
                            size_t payload_len, int err_no)
{
    size_t total = 0;
    size_t used = 0;
    state_usage(&total, &used);
    snprintf(s_last_error, sizeof(s_last_error),
             "%s %s failed: errno=%d (%s), payload=%u, stateUsed=%u, stateTotal=%u",
             operation ? operation : "scene storage",
             path ? path : "",
             err_no,
             err_no ? strerror(err_no) : "none",
             (unsigned)payload_len,
             (unsigned)used,
             (unsigned)total);
}

static void set_scene_simple_error(const char *message, size_t payload_len)
{
    size_t total = 0;
    size_t used = 0;
    state_usage(&total, &used);
    snprintf(s_last_error, sizeof(s_last_error),
             "%s, payload=%u, stateUsed=%u, stateTotal=%u",
             message ? message : "scene storage failed",
             (unsigned)payload_len,
             (unsigned)used,
             (unsigned)total);
}

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
        set_scene_simple_error("mount /state failed", 0);
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
    remove(tmp_path);
    errno = 0;
    FILE *f = fopen(tmp_path, "wb");
    if (f == NULL) {
        int err_no = errno;
        set_scene_error("open", tmp_path, len, err_no);
        ESP_LOGE(TAG, "%s", s_last_error);
        return scene_err_from_errno(err_no, ESP_FAIL);
    }
    size_t written = 0;
    int err_no = 0;
    while (written < len) {
        size_t chunk = len - written;
        if (chunk > 2048) chunk = 2048;
        errno = 0;
        size_t chunk_written = fwrite(data + written, 1, chunk, f);
        if (chunk_written == 0) {
            err_no = errno;
            break;
        }
        written += chunk_written;
    }
    if (ferror(f) && err_no == 0) err_no = errno;
    fclose(f);
    if (written != len) {
        if (err_no == 0) err_no = ENOSPC;
        set_scene_error("short write", tmp_path, len, err_no);
        ESP_LOGE(TAG, "%s (written=%u/%u)", s_last_error,
                 (unsigned)written, (unsigned)len);
        remove(tmp_path);
        return scene_err_from_errno(err_no, ESP_ERR_NO_MEM);
    }
    remove(path);
    errno = 0;
    if (rename(tmp_path, path) != 0) {
        int err_no = errno;
        set_scene_error("rename", path, len, err_no);
        ESP_LOGE(TAG, "%s", s_last_error);
        return scene_err_from_errno(err_no, ESP_FAIL);
    }
    return ESP_OK;
}

static esp_err_t write_file_replace(const char *path, const char *tmp_path,
                                    const char *data, size_t len)
{
    esp_err_t err = write_file_atomic(path, tmp_path, data, len);
    if (err == ESP_OK) return ESP_OK;

    ESP_LOGW(TAG, "atomic write failed for %s; freeing old file and retrying", path);
    remove(path);
    remove(tmp_path);
    errno = 0;
    FILE *f = fopen(tmp_path, "wb");
    if (f == NULL) {
        int err_no = errno;
        set_scene_error("retry open", tmp_path, len, err_no);
        ESP_LOGE(TAG, "%s", s_last_error);
        return scene_err_from_errno(err_no, ESP_FAIL);
    }
    size_t written = 0;
    int err_no = 0;
    while (written < len) {
        size_t chunk = len - written;
        if (chunk > 2048) chunk = 2048;
        errno = 0;
        size_t chunk_written = fwrite(data + written, 1, chunk, f);
        if (chunk_written == 0) {
            err_no = errno;
            break;
        }
        written += chunk_written;
    }
    if (ferror(f) && err_no == 0) err_no = errno;
    fclose(f);
    if (written != len) {
        if (err_no == 0) err_no = ENOSPC;
        set_scene_error("retry short write", tmp_path, len, err_no);
        ESP_LOGE(TAG, "%s (written=%u/%u)", s_last_error,
                 (unsigned)written, (unsigned)len);
        remove(tmp_path);
        return scene_err_from_errno(err_no, ESP_ERR_NO_MEM);
    }
    errno = 0;
    if (rename(tmp_path, path) != 0) {
        int err_no = errno;
        set_scene_error("retry rename", path, len, err_no);
        ESP_LOGE(TAG, "%s", s_last_error);
        remove(tmp_path);
        return scene_err_from_errno(err_no, ESP_FAIL);
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

static bool load_into_nim(const char *json, size_t len, const char *origin)
{
    if (!frameos_nim_available()) {
        ESP_LOGW(TAG, "nim runtime unavailable, scenes not loaded");
        log_scene_event("scenes:load", "error", origin, "", "nim-unavailable",
                        len, 0, 0, ESP_ERR_INVALID_STATE);
        return false;
    }
    int count = frameos_nim_load_scenes(json);
    if (count <= 0) {
        ESP_LOGE(TAG, "scene payload rejected by runtime");
        log_scene_event("scenes:load", "error", origin, "", "runtime-rejected",
                        len, count, 0, ESP_FAIL);
        return false;
    }
    s_loaded = count;
    ESP_LOGI(TAG, "%d scene(s) live", count);
    log_scene_event("scenes:load", "ok", origin, "", "runtime-loaded",
                    len, count, 0, ESP_OK);
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
        log_scene_event("scenes:load", "error", "stored", "", "read-failed",
                        0, 0, 0, ESP_ERR_NOT_FOUND);
        return false;
    }
    bool ok = load_into_nim(json, len, "stored");
    free(json);
    return ok;
}

int fos_scenes_loaded(void) { return s_loaded; }
const char *fos_scenes_etag(void) { return s_etag; }
void fos_scenes_request_sync(void) { s_sync_requested = true; }

char *fos_scenes_json_copy(size_t *out_len)
{
    if (out_len != NULL) *out_len = 0;
    esp_err_t err = mount_state();
    if (err != ESP_OK) return NULL;
    return read_file(SCENES_PATH, out_len);
}

esp_err_t fos_scenes_select(const char *scene_id)
{
    if (scene_id == NULL || scene_id[0] == '\0') return ESP_ERR_INVALID_ARG;
    portENTER_CRITICAL(&s_scene_select_lock);
    snprintf(s_pending_scene_id, sizeof(s_pending_scene_id), "%s", scene_id);
    s_scene_select_pending = true;
    portEXIT_CRITICAL(&s_scene_select_lock);
    ESP_LOGI(TAG, "scene selection queued: %s", scene_id);
    return ESP_OK;
}

bool fos_scenes_apply_pending_selection(void)
{
    char scene_id[SCENE_ID_LEN];
    bool pending;

    portENTER_CRITICAL(&s_scene_select_lock);
    pending = s_scene_select_pending;
    if (pending) {
        snprintf(scene_id, sizeof(scene_id), "%s", s_pending_scene_id);
        s_scene_select_pending = false;
        s_pending_scene_id[0] = '\0';
    }
    portEXIT_CRITICAL(&s_scene_select_lock);

    if (!pending) return false;
    if (!frameos_nim_set_scene(scene_id)) {
        ESP_LOGW(TAG, "scene selection failed: %s", scene_id);
        log_scene_event("scenes:select", "error", "queued", scene_id,
                        "apply-failed", 0, 0, 0, ESP_FAIL);
        return false;
    }
    ESP_LOGI(TAG, "scene selected: %s", scene_id);
    log_scene_event("event:setCurrentScene", "ok", "queued", scene_id,
                    "selected", 0, 0, 0, ESP_OK);
    return true;
}

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
    s_last_error[0] = '\0';
    if (json == NULL || len == 0 || len > SCENES_MAX_BYTES) {
        set_scene_simple_error("invalid scenes payload length", len);
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t err = mount_state();
    if (err != ESP_OK) return err;
    err = write_file_replace(SCENES_PATH, SCENES_TMP_PATH, json, len);
    if (err != ESP_OK) {
        log_scene_event("event:uploadScenes", "error", "local", "",
                        s_last_error[0] ? s_last_error : "store-failed",
                        len, 0, 0, err);
        return err;
    }
    s_last_error[0] = '\0';
    save_etag("local");
    s_pending = true;
    ESP_LOGI(TAG, "scenes payload stored (%u bytes), pending apply", (unsigned)len);
    log_scene_event("event:uploadScenes", "stored", "local", "", "pending-apply",
                    len, 0, 0, ESP_OK);
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
    bool log_unchanged = force;
    if (s_sync_requested) {
        force = true;
        log_unchanged = true;
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
        log_scene_event("scenes:sync", "error", "backend", "", "connect-failed",
                        0, 0, 0, err);
        esp_http_client_cleanup(client);
        return err;
    }
    int64_t content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);

    if (status == 304) {
        if (log_unchanged) {
            log_scene_event("scenes:sync", "ok", "backend", "", "unchanged",
                            0, s_loaded, status, ESP_OK);
        }
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_OK;
    }
    if (status != 200) {
        ESP_LOGW(TAG, "scenes sync: HTTP %d from %s", status, url);
        log_scene_event("scenes:sync", "error", "backend", "", "http-error",
                        0, 0, status, ESP_FAIL);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }
    if (content_length > SCENES_MAX_BYTES) {
        ESP_LOGE(TAG, "scenes sync: payload too large (%lld)", content_length);
        log_scene_event("scenes:sync", "error", "backend", "", "payload-too-large",
                        (size_t)content_length, 0, status, ESP_ERR_NO_MEM);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }

    size_t cap = content_length > 0 ? (size_t)content_length : 16384;
    char *buf = heap_caps_malloc(cap + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) buf = malloc(cap + 1);
    if (buf == NULL) {
        log_scene_event("scenes:sync", "error", "backend", "", "out-of-memory",
                        (size_t)(content_length > 0 ? content_length : 0),
                        0, status, ESP_ERR_NO_MEM);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }
    size_t total = 0;
    while (true) {
        if (total == cap) {
            if (cap >= SCENES_MAX_BYTES) {
                log_scene_event("scenes:sync", "error", "backend", "", "payload-too-large",
                                cap, 0, status, ESP_ERR_NO_MEM);
                free(buf);
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                return ESP_ERR_NO_MEM;
            }
            size_t new_cap = cap * 2 > SCENES_MAX_BYTES ? SCENES_MAX_BYTES : cap * 2;
            char *new_buf = heap_caps_realloc(buf, new_cap + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (new_buf == NULL) new_buf = realloc(buf, new_cap + 1);
            if (new_buf == NULL) {
                log_scene_event("scenes:sync", "error", "backend", "", "out-of-memory",
                                new_cap, 0, status, ESP_ERR_NO_MEM);
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
            log_scene_event("scenes:sync", "error", "backend", "", "read-failed",
                            total, 0, status, ESP_FAIL);
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

    err = write_file_replace(SCENES_PATH, SCENES_TMP_PATH, buf, total);
    if (err == ESP_OK) {
        save_etag(response_etag);
        ESP_LOGI(TAG, "scenes updated from backend (%u bytes, etag %s)",
                 (unsigned)total, response_etag[0] ? response_etag : "none");
        log_scene_event("scenes:sync", "updated", "backend", "", "stored",
                        total, 0, status, ESP_OK);
        load_into_nim(buf, total, "backend");
    } else {
        log_scene_event("scenes:sync", "error", "backend", "", "store-failed",
                        total, 0, status, err);
    }
    free(buf);
    return err;
}
