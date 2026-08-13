#include "fos_scenes.h"

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_spiffs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "cJSON.h"
#include "fos_client.h"
#include "fos_config.h"
#include "fos_mem.h"
#include "fos_wifi.h"
#include "frameos_nim.h"
#include "nvs.h"

static const char *TAG = "fos_scenes";

#define SCENES_PATH "/state/scenes.json"
#define SCENES_TMP_PATH "/state/scenes.json.tmp"
#define SCENES_ETAG_PATH "/state/scenes.etag"
/* Per-scene storage (the lazy path). A combined scenes.json is split into one
 * file per scene plus an index, so only the ACTIVE scene is ever parsed and
 * resident — scenes carrying a lot of JavaScript cost flash, not RAM.
 *
 * Slot NUMBERS, not scene ids, because CONFIG_SPIFFS_OBJ_NAME_LEN is 32 and a
 * scene id is a 36-character uuid: "/<uuid>.json" cannot be opened at all.
 * The id ↔ slot mapping lives in the index. */
#define SCENES_INDEX_PATH "/state/scene-index.json"
#define SCENES_INDEX_TMP_PATH "/state/scene-index.tmp"
#define SCENES_SLOT_PATH_FMT "/state/scene-%d.json"
#define SCENES_SLOT_TMP_PATH "/state/scene-slot.tmp"
/* Above this the payload stays in one file and the legacy path runs: the
 * split's bookkeeping is bounded, and a frame with this many scenes is not
 * the case this optimizes for. */
#define SCENES_SLOT_MAX 32
#define SCENES_SLOT_PATH_LEN 48
#define SCENES_MAX_BYTES (512 * 1024)
#define ETAG_LEN 80
#define SCENE_ID_LEN 128
#define SCENE_ERROR_LEN 256

static bool s_mounted = false;
static volatile bool s_pending = false;
/* Who installed the scenes. s_source is the RESIDENT store's source (what the
 * index on flash says, i.e. what the frame is rendering); s_pending_source is
 * the source declared by the producer of a stored-but-not-yet-applied payload,
 * promoted into s_source (and the index) when the apply succeeds. Plain
 * volatile ints, like the rest of the cross-task flags here: they change only
 * when a payload is stored/applied and single-word reads are atomic. The
 * pending source is mirrored to NVS so a reboot inside the store→apply window
 * (or before a combined scenes.json is first split) cannot launder a cloud
 * payload into "local" — fos_cloud.c keys the LAN deny on this. */
static volatile int s_source = FOS_SCENES_SOURCE_LOCAL;
static volatile int s_pending_source = FOS_SCENES_SOURCE_LOCAL;
/* Bumped once per pending-payload apply attempt by the render task; producers
 * poll it to learn whether their payload went live (see fos_scenes.h). */
static volatile uint32_t s_apply_generation = 0;
static volatile bool s_apply_ok = false;
static volatile bool s_sync_requested = false;
static volatile bool s_scene_select_pending = false;
static int s_loaded = 0;
static char s_etag[ETAG_LEN] = "";
static char s_pending_scene_id[SCENE_ID_LEN] = "";
static char s_last_error[SCENE_ERROR_LEN] = "";
static portMUX_TYPE s_scene_select_lock = portMUX_INITIALIZER_UNLOCKED;
/* Serializes writers of /state/scenes.json: the USB upload (console task)
 * and the backend sync (fos_client task) share one tmp path, and two
 * concurrent write+rename dances delete each other's tmp file (rename then
 * fails ENOENT on a freshly written file). Created in fos_scenes_init(),
 * which runs before either task starts. */
static SemaphoreHandle_t s_scene_file_lock = NULL;

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

bool fos_scenes_state_mounted(void)
{
    return s_mounted;
}

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
    char *buf = fos_big_malloc(size + 1);
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

static esp_err_t write_file_replace_locked(const char *path, const char *tmp_path,
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

/* Last explicitly selected scene, persisted so a reboot or power cut comes
 * back on the scene that was showing — not the first scene in the payload.
 * Same NVS namespace as fos_config; factory-reset clears it with the rest. */
#define LAST_SCENE_NVS_KEY "last_scene"

static void persist_last_scene(const char *scene_id)
{
    if (scene_id == NULL || scene_id[0] == '\0') return;
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return;
    char current[SCENE_ID_LEN] = "";
    size_t len = sizeof(current);
    if (nvs_get_str(nvs, LAST_SCENE_NVS_KEY, current, &len) != ESP_OK ||
        strcmp(current, scene_id) != 0) {
        nvs_set_str(nvs, LAST_SCENE_NVS_KEY, scene_id);
        nvs_commit(nvs);
    }
    nvs_close(nvs);
}

/* ----------------------------------------------------------- scene source */

#define SCENE_SOURCE_NVS_KEY "scene_source"

static const char *scene_source_str(int source)
{
    switch (source) {
    case FOS_SCENES_SOURCE_BACKEND: return "backend";
    case FOS_SCENES_SOURCE_CLOUD: return "cloud";
    default: return "local";
    }
}

/* Unknown or missing means LOCAL: pre-upgrade index files carry no "source"
 * key, and those frames were never under cloud management on this firmware. */
static int scene_source_from_str(const char *s)
{
    if (s != NULL) {
        if (strcmp(s, "backend") == 0) return FOS_SCENES_SOURCE_BACKEND;
        if (strcmp(s, "cloud") == 0) return FOS_SCENES_SOURCE_CLOUD;
    }
    return FOS_SCENES_SOURCE_LOCAL;
}

static void persist_scene_source(int source)
{
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return;
    uint8_t current = 0xff;
    if (nvs_get_u8(nvs, SCENE_SOURCE_NVS_KEY, &current) != ESP_OK ||
        current != (uint8_t)source) {
        nvs_set_u8(nvs, SCENE_SOURCE_NVS_KEY, (uint8_t)source);
        nvs_commit(nvs);
    }
    nvs_close(nvs);
}

fos_scenes_source_t fos_scenes_source(void)
{
    return (fos_scenes_source_t)s_source;
}

bool fos_scenes_from_cloud(void)
{
    return s_source == FOS_SCENES_SOURCE_CLOUD;
}

/* True once the boot-time restore succeeded or an explicit selection made
 * it moot. Until then every scene load retries: the first payload after
 * boot can be the baked single-scene default (fresh /state), and the
 * persisted scene only appears when the cached or backend payload lands. */
static bool s_last_scene_settled = false;

static void restore_last_scene(void)
{
    if (s_last_scene_settled) return;

    char scene_id[SCENE_ID_LEN] = "";
    size_t len = sizeof(scene_id);
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READONLY, &nvs) != ESP_OK) return;
    esp_err_t err = nvs_get_str(nvs, LAST_SCENE_NVS_KEY, scene_id, &len);
    nvs_close(nvs);
    if (err != ESP_OK || scene_id[0] == '\0') {
        s_last_scene_settled = true; /* nothing persisted */
        return;
    }

    /* A scene missing from this payload keeps the payload's first scene
     * active (the previous behavior) and retries on the next load. */
    if (frameos_nim_set_scene(scene_id)) {
        s_last_scene_settled = true;
        ESP_LOGI(TAG, "restored last scene: %s", scene_id);
        log_scene_event("scenes:restore", "ok", "nvs", scene_id, "restored",
                        0, 0, 0, ESP_OK);
    } else {
        ESP_LOGW(TAG, "last scene %s not in payload; keeping default", scene_id);
    }
}

/* ------------------------------------------------- per-scene split/lazy load
 *
 * The device receives one combined scenes.json (from the USB upload or the
 * backend/cloud sync) — that stays the wire format. What changes is what the
 * device keeps: the payload is split once, at apply time, into
 * /state/scene-<slot>.json plus /state/scene-index.json, and the combined file
 * is then deleted. Deleted, not kept: the `state` partition is 1 MB and a
 * payload may be 512 KB, so both copies do not fit.
 *
 * Splitting at APPLY time rather than at write time is what keeps this to one
 * code path — both producers already write scenes.json and set s_pending, and
 * neither needs to know any of this exists. */

/* Defined below, next to the other storage helpers. */
static esp_err_t write_file_replace(const char *path, const char *tmp_path,
                                    const char *data, size_t len);

typedef struct {
    char id[SCENE_ID_LEN];
    int slot;
} scene_slot_t;

static scene_slot_t s_slots[SCENES_SLOT_MAX];
static int s_slot_count = 0;

static void slot_path(int slot, char *out, size_t out_len)
{
    snprintf(out, out_len, SCENES_SLOT_PATH_FMT, slot);
}

static int slot_for_scene(const char *scene_id)
{
    if (scene_id == NULL || scene_id[0] == '\0') return -1;
    for (int i = 0; i < s_slot_count; i++) {
        if (strcmp(s_slots[i].id, scene_id) == 0) return s_slots[i].slot;
    }
    return -1;
}

/* Element boundaries of a top-level JSON array, without parsing it.
 *
 * cJSON would allocate a node per token, and with
 * CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL those small allocations land in
 * internal RAM — parsing a 300 KB payload whole is exactly the memory spike
 * this feature exists to avoid. A depth scan costs nothing and lets each
 * scene be written straight from the buffer we already hold; only the small
 * per-scene metadata parse below allocates, one scene at a time.
 *
 * Returns the element count, or -1 if the payload is not an array. */
static int scan_array_elements(const char *json, size_t len,
                               size_t *starts, size_t *ends, int max_items)
{
    size_t i = 0;
    while (i < len && isspace((unsigned char)json[i])) i++;
    if (i >= len || json[i] != '[') return -1;
    i++;
    int count = 0;
    int depth = 0;
    bool in_string = false, escaped = false;
    size_t start = 0;
    for (; i < len; i++) {
        char c = json[i];
        if (in_string) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') { in_string = true; continue; }
        if (c == '{' || c == '[') {
            if (depth == 0) start = i;
            depth++;
            continue;
        }
        if (c == '}' || c == ']') {
            if (depth == 0) break; /* closing bracket of the outer array */
            depth--;
            if (depth == 0) {
                if (count >= max_items) return -1; /* too many scenes */
                starts[count] = start;
                ends[count] = i + 1;
                count++;
            }
            continue;
        }
    }
    return depth == 0 ? count : -1;
}

/* Write one scene's raw bytes to its slot file. */
static esp_err_t write_slot(int slot, const char *data, size_t len)
{
    char path[SCENES_SLOT_PATH_LEN];
    slot_path(slot, path, sizeof(path));
    return write_file_replace(path, SCENES_SLOT_TMP_PATH, data, len);
}

static void remove_slots_from(int first_slot)
{
    for (int slot = first_slot; slot < SCENES_SLOT_MAX; slot++) {
        char path[SCENES_SLOT_PATH_LEN];
        slot_path(slot, path, sizeof(path));
        if (unlink(path) != 0) break; /* first gap ends the run */
    }
}

/* Split the combined payload. On any failure nothing is deleted and the index
 * is removed, so the caller falls back to loading the combined file whole —
 * a frame never loses its scenes to a failed optimization. */
static esp_err_t split_scenes(const char *json, size_t len)
{
    static size_t starts[SCENES_SLOT_MAX];
    static size_t ends[SCENES_SLOT_MAX];
    int count = scan_array_elements(json, len, starts, ends, SCENES_SLOT_MAX);
    if (count <= 0) {
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *index = cJSON_CreateObject();
    cJSON *scenes = cJSON_CreateArray();
    if (index == NULL || scenes == NULL) {
        cJSON_Delete(index);
        cJSON_Delete(scenes);
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddItemToObject(index, "scenes", scenes);
    /* The producer declared this when it stored the payload; the index is
     * written at apply time, so the value rode across in s_pending_source. */
    cJSON_AddStringToObject(index, "source", scene_source_str(s_pending_source));

    esp_err_t err = ESP_OK;
    int written = 0;
    for (int i = 0; i < count; i++) {
        size_t item_len = ends[i] - starts[i];
        err = write_slot(i, json + starts[i], item_len);
        if (err != ESP_OK) break;
        written++;
        /* One scene at a time: peak allocation is the largest scene, not the
         * whole payload. Only three fields survive into the index. */
        cJSON *item = cJSON_ParseWithLength(json + starts[i], item_len);
        const cJSON *id = cJSON_GetObjectItem(item, "id");
        if (!cJSON_IsString(id) || id->valuestring == NULL) {
            cJSON_Delete(item);
            err = ESP_ERR_INVALID_ARG;
            break;
        }
        cJSON *entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "id", id->valuestring);
        const cJSON *name = cJSON_GetObjectItem(item, "name");
        if (cJSON_IsString(name) && name->valuestring) {
            cJSON_AddStringToObject(entry, "name", name->valuestring);
        }
        const cJSON *refresh = cJSON_GetObjectItem(item, "refreshInterval");
        if (cJSON_IsNumber(refresh)) {
            cJSON_AddNumberToObject(entry, "refreshInterval", refresh->valuedouble);
        }
        cJSON_AddNumberToObject(entry, "slot", i);
        cJSON_AddItemToArray(scenes, entry);
        if (i == 0) cJSON_AddStringToObject(index, "default", id->valuestring);
        cJSON_Delete(item);
    }

    char *index_json = (err == ESP_OK) ? cJSON_PrintUnformatted(index) : NULL;
    cJSON_Delete(index);
    if (index_json == NULL) {
        remove_slots_from(0);
        unlink(SCENES_INDEX_PATH);
        return err == ESP_OK ? ESP_ERR_NO_MEM : err;
    }
    err = write_file_replace(SCENES_INDEX_PATH, SCENES_INDEX_TMP_PATH,
                             index_json, strlen(index_json));
    cJSON_free(index_json);
    if (err != ESP_OK) {
        remove_slots_from(0);
        unlink(SCENES_INDEX_PATH);
        return err;
    }
    /* Slots left over from a longer previous payload would otherwise linger
     * and eat the state partition. */
    remove_slots_from(written);
    /* Only now is the combined file redundant. */
    unlink(SCENES_PATH);
    ESP_LOGI(TAG, "split %d scene(s) into per-scene files (%u bytes total)",
             written, (unsigned)len);
    return ESP_OK;
}

/* Read the index, hand the catalog to the runtime, and fill the id→slot map.
 * Returns the scene count, 0 when there is no usable index. */
static int load_scene_index(void)
{
    s_slot_count = 0;
    size_t len = 0;
    char *index_json = read_file(SCENES_INDEX_PATH, &len);
    if (index_json == NULL || len == 0) {
        free(index_json);
        return 0;
    }
    cJSON *index = cJSON_ParseWithLength(index_json, len);
    if (index != NULL) {
        /* Missing key = pre-upgrade index = local. */
        const cJSON *source = cJSON_GetObjectItem(index, "source");
        s_source = scene_source_from_str(
            cJSON_IsString(source) ? source->valuestring : NULL);
    }
    const cJSON *scenes = cJSON_GetObjectItem(index, "scenes");
    if (cJSON_IsArray(scenes)) {
        const cJSON *entry = NULL;
        cJSON_ArrayForEach(entry, scenes) {
            if (s_slot_count >= SCENES_SLOT_MAX) break;
            const cJSON *id = cJSON_GetObjectItem(entry, "id");
            const cJSON *slot = cJSON_GetObjectItem(entry, "slot");
            if (!cJSON_IsString(id) || id->valuestring == NULL ||
                !cJSON_IsNumber(slot)) {
                continue;
            }
            snprintf(s_slots[s_slot_count].id, SCENE_ID_LEN, "%s", id->valuestring);
            s_slots[s_slot_count].slot = (int)slot->valuedouble;
            s_slot_count++;
        }
    }
    cJSON_Delete(index);
    if (s_slot_count > 0) {
        /* The runtime now knows every scene by name without parsing one. */
        frameos_nim_set_scene_catalog(index_json);
    }
    free(index_json);
    return s_slot_count;
}

/* Make one scene resident from its slot file. */
/* Which scene the Nim runtime currently holds parsed, so re-selecting it can
 * be recognised as a no-op. Empty means "nothing resident". */
static char s_resident_scene_id[SCENE_ID_LEN] = "";

static bool load_scene_slot(int slot, const char *scene_id, const char *origin)
{
    char path[SCENES_SLOT_PATH_LEN];
    slot_path(slot, path, sizeof(path));
    size_t len = 0;
    char *json = read_file(path, &len);
    if (json == NULL || len == 0) {
        free(json);
        ESP_LOGW(TAG, "scene slot %d unreadable (%s)", slot, scene_id ? scene_id : "?");
        log_scene_event("scenes:load", "error", origin, scene_id ? scene_id : "",
                        "slot-read-failed", 0, 0, 0, ESP_ERR_NOT_FOUND);
        return false;
    }
    size_t internal_before = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    int ok = frameos_nim_load_scene(json);
    free(json);
    if (!ok) {
        log_scene_event("scenes:load", "error", origin, scene_id ? scene_id : "",
                        "runtime-rejected", len, 0, 0, ESP_FAIL);
        return false;
    }
    s_loaded = 1;
    snprintf(s_resident_scene_id, sizeof(s_resident_scene_id), "%s",
             scene_id ? scene_id : "");
    size_t internal_after = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    ESP_LOGI(TAG, "scene slot %d live (%s); %d available, internal RAM %u -> %u",
             slot, scene_id ? scene_id : "?", s_slot_count,
             (unsigned)internal_before, (unsigned)internal_after);
    log_scene_event("scenes:load", "ok", origin, scene_id ? scene_id : "",
                    "runtime-loaded", len, 1, 0, ESP_OK);
    return true;
}

/* Boot/apply on the lazy path: catalog first, then exactly one scene — the
 * one persisted across reboots when it still exists, otherwise the index's
 * default. */
static bool activate_from_index(const char *origin)
{
    if (load_scene_index() == 0) return false;

    char scene_id[SCENE_ID_LEN] = "";
    size_t id_len = sizeof(scene_id);
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READONLY, &nvs) == ESP_OK) {
        if (nvs_get_str(nvs, LAST_SCENE_NVS_KEY, scene_id, &id_len) != ESP_OK) {
            scene_id[0] = '\0';
        }
        nvs_close(nvs);
    }
    int slot = slot_for_scene(scene_id);
    if (slot < 0) {
        /* Nothing persisted, or that scene is gone from the new payload. */
        slot = s_slots[0].slot;
        snprintf(scene_id, sizeof(scene_id), "%s", s_slots[0].id);
    }
    s_last_scene_settled = true; /* the index decides; no retry needed */
    return load_scene_slot(slot, scene_id, origin);
}

/* Switch scenes on the lazy path: read that scene's file and make it
 * resident, replacing the previous one. Returns false when the id is not on
 * flash, so callers can fall through to the legacy in-memory switch. */
static bool activate_scene_id(const char *scene_id)
{
    if (s_slot_count == 0) return false;
    int slot = slot_for_scene(scene_id);
    if (slot < 0) return false;
    return load_scene_slot(slot, scene_id, "select");
}

static bool load_into_nim(const char *json, size_t len, const char *origin)
{
    if (!frameos_nim_available()) {
        ESP_LOGW(TAG, "nim runtime unavailable, scenes not loaded");
        log_scene_event("scenes:load", "error", origin, "", "nim-unavailable",
                        len, 0, 0, ESP_ERR_INVALID_STATE);
        return false;
    }
    /* Measure what the payload actually costs in INTERNAL RAM. The Nim heap
     * is served by plain malloc, and CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL
     * (16 KB) sends every allocation below that size to internal RAM — so the
     * parsed scene graphs and the QuickJS context land in the scarce pool
     * while PSRAM sits mostly idle. That is what starves the TLS handshake
     * the cloud link needs (FOS_CLOUD_WS_MIN_INTERNAL_* in fos_cloud.c).
     *
     * Measured rather than estimated: scene cost varies enormously with node
     * count and inline JS, so a constant in the UI would be fiction. This
     * gives the control plane a real per-frame number to advise from. */
    size_t internal_before = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    int count = frameos_nim_load_scenes(json);
    if (count <= 0) {
        ESP_LOGE(TAG, "scene payload rejected by runtime");
        log_scene_event("scenes:load", "error", origin, "", "runtime-rejected",
                        len, count, 0, ESP_FAIL);
        return false;
    }
    size_t internal_after = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    size_t internal_cost = internal_before > internal_after
                               ? internal_before - internal_after : 0;
    s_loaded = count;
    /* Whole-payload path (no index to carry it): the loaded payload's source
     * becomes the resident source. The split path does this via the index. */
    s_source = s_pending_source;
    ESP_LOGI(TAG, "%d scene(s) live; internal RAM %u -> %u (%u B for %d scenes, ~%u B each)",
             count, (unsigned)internal_before, (unsigned)internal_after,
             (unsigned)internal_cost, count,
             (unsigned)(count > 0 ? internal_cost / (unsigned)count : 0));
    log_scene_event("scenes:load", "ok", origin, "", "runtime-loaded",
                    len, count, 0, ESP_OK);
    {
        /* Structured, so the workspace can advise on scene count from a
         * measurement taken on THIS frame with THESE scenes. */
        char event[288];
        snprintf(event, sizeof(event),
                 "{\"event\":\"scenes:memory\",\"source\":\"esp32\",\"scenes\":%d,"
                 "\"payloadBytes\":%u,\"internalBefore\":%u,\"internalAfter\":%u,"
                 "\"internalCost\":%u,\"internalCostPerScene\":%u,"
                 "\"largestInternalBlock\":%u,\"freePsram\":%u}",
                 count, (unsigned)len, (unsigned)internal_before,
                 (unsigned)internal_after, (unsigned)internal_cost,
                 (unsigned)(count > 0 ? internal_cost / (unsigned)count : 0),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        frameos_nim_log_hook(event);
    }
    restore_last_scene();
    return true;
}

bool fos_scenes_apply_pending(void)
{
    if (!s_pending || !s_mounted) return false;
    /* A new payload invalidates whatever is parsed, even if the id matches. */
    s_resident_scene_id[0] = '\0';
    s_pending = false;
    bool ok = false;
    size_t len = 0;
    char *json = read_file(SCENES_PATH, &len);
    if (json == NULL) {
        /* No combined file: either a previous apply already split it (the
         * normal steady state) or there is genuinely nothing stored. */
        ok = activate_from_index("stored");
        if (!ok) {
            ESP_LOGW(TAG, "no readable %s", SCENES_PATH);
            log_scene_event("scenes:load", "error", "stored", "", "read-failed",
                            0, 0, 0, ESP_ERR_NOT_FOUND);
        }
    } else if (split_scenes(json, len) == ESP_OK) {
        /* Split consumed the combined file; hold only the active scene. */
        free(json);
        json = NULL;
        ok = activate_from_index("stored");
        if (!ok) {
            ESP_LOGW(TAG, "per-scene load failed after split; nothing live");
        }
    } else {
        /* Payload the splitter cannot handle (not an array, too many scenes,
         * a write that failed): keep the old whole-payload behaviour. */
        unlink(SCENES_INDEX_PATH);
        s_slot_count = 0;
        ok = load_into_nim(json, len, "stored");
        free(json);
        json = NULL;
    }
    free(json);
    /* Publish the outcome before the generation, so a poller that sees a new
     * generation always reads the matching result. */
    s_apply_ok = ok;
    s_apply_generation++;
    return ok;
}

uint32_t fos_scenes_apply_generation(void) { return s_apply_generation; }
bool fos_scenes_apply_succeeded(void) { return s_apply_ok; }

int fos_scenes_loaded(void) { return s_loaded; }
const char *fos_scenes_etag(void) { return s_etag; }
void fos_scenes_request_sync(void) { s_sync_requested = true; }

/* The whole payload, for callers that download or re-upload it (the USB API,
 * the backend sync's etag comparison). On the lazy path the combined file no
 * longer exists, so it is rebuilt from the slots — in PSRAM, transiently, and
 * only when something actually asks. */
char *fos_scenes_json_copy(size_t *out_len)
{
    if (out_len != NULL) *out_len = 0;
    esp_err_t err = mount_state();
    if (err != ESP_OK) return NULL;
    char *combined = read_file(SCENES_PATH, out_len);
    if (combined != NULL) return combined;
    if (s_slot_count == 0 && load_scene_index() == 0) return NULL;

    size_t cap = 2; /* "[" + "]" */
    for (int i = 0; i < s_slot_count; i++) {
        char path[SCENES_SLOT_PATH_LEN];
        slot_path(s_slots[i].slot, path, sizeof(path));
        struct stat st;
        if (stat(path, &st) != 0) return NULL;
        cap += (size_t)st.st_size + 1; /* + comma */
    }
    char *buf = fos_big_malloc(cap + 1);
    if (buf == NULL) buf = malloc(cap + 1);
    if (buf == NULL) return NULL;
    size_t used = 0;
    buf[used++] = '[';
    for (int i = 0; i < s_slot_count; i++) {
        char path[SCENES_SLOT_PATH_LEN];
        slot_path(s_slots[i].slot, path, sizeof(path));
        size_t part_len = 0;
        char *part = read_file(path, &part_len);
        if (part == NULL) { free(buf); return NULL; }
        if (i > 0 && used < cap) buf[used++] = ',';
        if (used + part_len > cap) { free(part); free(buf); return NULL; }
        memcpy(buf + used, part, part_len);
        used += part_len;
        free(part);
    }
    buf[used++] = ']';
    buf[used] = '\0';
    if (out_len != NULL) *out_len = used;
    return buf;
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
    /* Already the resident scene: nothing to load. Re-parsing it would throw
     * away everything the runtime has built for it — the interpreted graph and
     * every JS app's QuickJS context and transpiled source — and rebuild the
     * lot. That is not a small waste: with the scene resident this frame
     * renders the bundled Weather scene in ~15 s, and reloading it first
     * takes ~69 s, because ~29 s of that is re-transpiling app sources that
     * did not change. The cloud re-announces the current scene on every
     * reconnect, so this path ran on essentially every render.
     *
     * A changed payload does not come through here: it sets s_pending and
     * goes through fos_scenes_apply_pending, which clears the resident id
     * above, so a redeploy still reloads. */
    if (s_slot_count > 0 && s_resident_scene_id[0] &&
        strcmp(scene_id, s_resident_scene_id) == 0) {
        log_scene_event("scenes:select", "ok", "queued", scene_id,
                        "already-resident", 0, 1, 0, ESP_OK);
        frameos_nim_set_scene(scene_id);
        return true;
    }
    if (s_slot_count > 0) {
        if (!activate_scene_id(scene_id)) {
            ESP_LOGW(TAG, "scene selection failed: %s", scene_id);
            log_scene_event("scenes:select", "error", "queued", scene_id,
                            "apply-failed", 0, 0, 0, ESP_FAIL);
            return false;
        }
    } else if (!frameos_nim_set_scene(scene_id)) {
        ESP_LOGW(TAG, "scene selection failed: %s", scene_id);
        log_scene_event("scenes:select", "error", "queued", scene_id,
                        "apply-failed", 0, 0, 0, ESP_FAIL);
        return false;
    }
    persist_last_scene(scene_id);
    s_last_scene_settled = true; /* explicit selection makes the boot restore moot */
    /* Picking a scene is the user saying "try this one instead", so a frame
     * paused after repeated out-of-memory renders gets another chance. */
    fos_client_clear_render_pause();
    ESP_LOGI(TAG, "scene selected: %s", scene_id);
    printf("scene changed: %s\n", scene_id); /* visible on the USB serial stream */
    log_scene_event("event:setCurrentScene", "ok", "queued", scene_id,
                    "selected", 0, 0, 0, ESP_OK);
    /* Pi parity: the UI's scene-activation and preview tasks complete on
     * render:sceneChange (see longRunningTasksModel). */
    log_scene_event("render:sceneChange", "ok", "queued", scene_id,
                    "selected", 0, 0, 0, ESP_OK);
    return true;
}

/* ---------------------------------------------------------------- init */

static esp_err_t write_file_replace(const char *path, const char *tmp_path,
                                    const char *data, size_t len)
{
    if (s_scene_file_lock != NULL) {
        xSemaphoreTake(s_scene_file_lock, portMAX_DELAY);
    }
    esp_err_t err = write_file_replace_locked(path, tmp_path, data, len);
    if (s_scene_file_lock != NULL) {
        xSemaphoreGive(s_scene_file_lock);
    }
    return err;
}

esp_err_t fos_scenes_init(void)
{
    if (s_scene_file_lock == NULL) {
        s_scene_file_lock = xSemaphoreCreateMutex();
    }
    esp_err_t err = mount_state();
    if (err != ESP_OK) return err;
    load_etag();
    /* Restore the stored scenes' source BEFORE any task can ask: main() calls
     * fos_cloud_start() after this, and its boot-time apply_network_policy()
     * must see "cloud" on a demoted frame that still holds provider-pushed
     * scenes — the LAN deny has to come up armed, not after the first apply.
     * NVS is written at store time and always matches what the index (or the
     * still-pending combined payload) carries; the first apply re-reads the
     * index and corrects any divergence. Missing key = pre-upgrade = local. */
    {
        nvs_handle_t nvs;
        if (nvs_open("frameos", NVS_READONLY, &nvs) == ESP_OK) {
            uint8_t stored = 0;
            if (nvs_get_u8(nvs, SCENE_SOURCE_NVS_KEY, &stored) == ESP_OK &&
                stored <= FOS_SCENES_SOURCE_CLOUD) {
                s_source = (int)stored;
                s_pending_source = (int)stored;
            }
            nvs_close(nvs);
        }
    }
    struct stat st;
    if (stat(SCENES_PATH, &st) == 0 && st.st_size > 2) {
        ESP_LOGI(TAG, "cached scenes.json (%ld bytes, etag %s)", (long)st.st_size,
                 s_etag[0] ? s_etag : "none");
        s_pending = true;
    } else if (stat(SCENES_INDEX_PATH, &st) == 0 && st.st_size > 2) {
        /* Already split by an earlier boot: the combined file is gone and the
         * index is the store. Apply still runs — it just loads one scene. */
        ESP_LOGI(TAG, "cached per-scene store (index %ld bytes, etag %s)",
                 (long)st.st_size, s_etag[0] ? s_etag : "none");
        s_pending = true;
    } else {
        ESP_LOGI(TAG, "no cached scenes; will sync from backend");
    }
    return ESP_OK;
}

/* ------------------------------------------------------------ local push */

esp_err_t fos_scenes_set_json_from(const char *json, size_t len,
                                   fos_scenes_source_t source)
{
    const char *origin = scene_source_str((int)source);
    s_last_error[0] = '\0';
    if (json == NULL || len == 0 || len > SCENES_MAX_BYTES) {
        set_scene_simple_error("invalid scenes payload length", len);
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t err = mount_state();
    if (err != ESP_OK) return err;
    err = write_file_replace(SCENES_PATH, SCENES_TMP_PATH, json, len);
    if (err != ESP_OK) {
        log_scene_event("event:uploadScenes", "error", origin, "",
                        s_last_error[0] ? s_last_error : "store-failed",
                        len, 0, 0, err);
        return err;
    }
    s_last_error[0] = '\0';
    /* "local" etag for cloud pushes too: it means "not the backend's payload,
     * do not clobber on the next backend sync pass" (see fos_scenes_sync). */
    save_etag("local");
    /* Recorded only after the payload is on flash, so a failed store cannot
     * relabel whatever is still resident. */
    s_pending_source = (int)source;
    persist_scene_source((int)source);
    s_pending = true;
    ESP_LOGI(TAG, "scenes payload stored (%u bytes, source %s), pending apply",
             (unsigned)len, origin);
    log_scene_event("event:uploadScenes", "stored", origin, "", "pending-apply",
                    len, 0, 0, ESP_OK);
    return ESP_OK;
}

esp_err_t fos_scenes_set_json(const char *json, size_t len)
{
    return fos_scenes_set_json_from(json, len, FOS_SCENES_SOURCE_LOCAL);
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
    /* A locally-pushed payload (uploadScenes over HTTP/USB — e.g. the Assets
     * panel's Play button) wins until a deploy or an explicit sync request:
     * without this, the next pass refetched the backend set and clobbered
     * the local push before it was even applied. */
    if (!force && strcmp(s_etag, "local") == 0) return ESP_OK;
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
    char *buf = fos_big_malloc(cap + 1);
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
            char *new_buf = fos_big_realloc(buf, new_cap + 1);
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
        /* Backend-served payload: declare it before load_into_nim promotes
         * the pending source, and persist it so the boot-time split (this
         * path leaves the combined file for the next apply to split) records
         * "backend" in the index. */
        s_pending_source = FOS_SCENES_SOURCE_BACKEND;
        persist_scene_source(FOS_SCENES_SOURCE_BACKEND);
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
