#include "fos_scenes.h"

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_spiffs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "cJSON.h"
#include "fos_backend_http.h"
#include "fos_boot_scene.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_events_gen.h"
#include "fos_json_guard.h"
#include "fos_mem.h"
#include "fos_scene_state.h"
#include "fos_scene_store.h"
#include "fos_wifi.h"
#include "frameos_display.h"
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
#define SCENES_INDEX_PATH "/state/" FOS_SCENE_STORE_INDEX_NAME
#define SCENES_INDEX_TMP_PATH "/state/" FOS_SCENE_STORE_INDEX_TMP_NAME
#define SCENES_SLOT_TMP_PATH "/state/" FOS_SCENE_STORE_SLOT_TMP_NAME
/* Above this the payload stays in one file and the legacy path runs: the
 * split's bookkeeping is bounded, and a frame with this many scenes is not
 * the case this optimizes for. */
#define SCENES_SLOT_MAX FOS_SCENE_STORE_SLOTS
#define SCENES_SLOT_PATH_LEN 48
#define SCENES_MAX_BYTES (512 * 1024)
#define ETAG_LEN 80
#define SCENE_ID_LEN 128
#define SCENE_ERROR_LEN 256

static bool s_mounted = false;
static volatile bool s_pending = false;
/* What is pending is a change the per-scene store already holds (one scene
 * put or deleted), not a combined payload: only the catalog is read again,
 * and the resident scene reloads only if that scene is what changed. */
static volatile bool s_patch_pending = false;
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
/* When the queued selection was first asked for (a FreeRTOS tick): the wait
 * the LCD's loading mark counts from (fos_client_loading_begin). A newer
 * selection replacing a queued one keeps it: the wait began with the first. */
static uint32_t s_pending_since = 0;
static char s_last_error[SCENE_ERROR_LEN] = "";
static portMUX_TYPE s_scene_select_lock = portMUX_INITIALIZER_UNLOCKED;
/* The render task switched the resident scene (or applied a payload that
 * arrived after boot): the panel shows something else now, so the pass must
 * render even if it woke only to check in. Taken by fos_client.c. */
static bool s_scene_switched = false;
/* The queued selection was read back from NVS on this boot: a deep sleep had
 * cut in between the queue and the apply (fos_scenes_select). */
static bool s_boot_pending_selection = false;
/* A payload was stored since boot (not the cached one init re-applies). */
static bool s_payload_stored_since_boot = false;
/* The runtime shows a scene of its own (the scene switcher, the scene
 * settings) over the resident one, which stays loaded for the way back. */
static bool s_built_in_shown = false;
/* That scene is the settings (fos_scenes_settings_shown). */
static volatile bool s_settings_shown = false;
/* How long a frame that deep-sleeps stays up with the switcher on its panel:
 * the switcher's own idle timeout on e-paper (system/sceneSwitcher), so the
 * keys that walk it are heard, and it goes back before the frame sleeps. */
#define BUILT_IN_SCENE_AWAKE_MS (5 * 60 * 1000)

/* A scene the runtime draws itself (docs/events-contract.json
 * `scenes.switcher`, `scenes.settings`): no slot on flash, never the scene
 * a reboot or a deep sleep comes back to. */
static bool is_built_in_scene(const char *scene_id)
{
    return scene_id != NULL &&
           (strcmp(scene_id, FOS_SCENE_SWITCHER_ID) == 0 || strcmp(scene_id, FOS_SCENE_SETTINGS_ID) == 0);
}
/* Serializes the store: the USB upload (console task) and the backend sync
 * (fos_client task) share one tmp path, and two concurrent write+rename
 * dances delete each other's tmp file (rename then fails ENOENT on a freshly
 * written file). A one-scene change, the split, a whole-store read and the
 * sweep each hold it for the duration, so nobody sees the index mid-swap or a
 * slot the sweep is removing. Recursive, because those compose. Created in
 * fos_scenes_init(), which runs before either task starts.
 *
 * Never take it while calling into the Nim runtime from a task other than
 * the render task, and never block on the runtime holding it: the runtime
 * lock is only ever taken first. */
static SemaphoreHandle_t s_scene_file_lock = NULL;

static void store_lock(void)
{
    if (s_scene_file_lock != NULL) xSemaphoreTakeRecursive(s_scene_file_lock, portMAX_DELAY);
}

static void store_unlock(void)
{
    if (s_scene_file_lock != NULL) xSemaphoreGiveRecursive(s_scene_file_lock);
}

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
    json_escape_value(esp_err == ESP_OK ? "OK" : fos_http_err_name(esp_err),
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

/* Erased pages for `len` more bytes, made now. SPIFFS reuses a deleted
 * file's pages only after a garbage collection, and left to itself it runs
 * one inside the write, by erase age: with 460 KB of photos beside them,
 * scene writes on the SenseCAP's 1 MB /state failed with ENOSPC at 54-64%
 * used. esp_spiffs_gc goes through fos_spiffs_gc.c, which erases the blocks
 * holding only deleted pages first; SPIFFS's own collection after it stops
 * after 10 blocks (SPIFFS_ERR_FULL when those were not enough), so it is
 * asked again, a few times. It returns at once when the room is already
 * there. */
#define SCENES_WRITE_MARGIN 4096
#define SCENES_GC_ROUNDS 4

static void make_room(size_t len)
{
    esp_err_t err = ESP_OK;
    for (int round = 0; round < SCENES_GC_ROUNDS; round++) {
        err = esp_spiffs_gc("state", len + SCENES_WRITE_MARGIN);
        if (err == ESP_OK) return;
    }
    ESP_LOGW(TAG, "/state: no room for %u bytes after %d garbage collections (%s)",
             (unsigned)(len + SCENES_WRITE_MARGIN), SCENES_GC_ROUNDS, esp_err_to_name(err));
}

static esp_err_t write_file_atomic(const char *path, const char *tmp_path,
                                   const char *data, size_t len)
{
    remove(tmp_path);
    make_room(len);
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

/* The old file stays until the new one is whole: a write that finds no room
 * fails and keeps it. (It used to delete the old file and write again, and
 * a second failure left neither: a frame rebooted with no scenes.) */
static esp_err_t write_file_replace_locked(const char *path, const char *tmp_path,
                                           const char *data, size_t len)
{
    return write_file_atomic(path, tmp_path, data, len);
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

/* A queued selection that has not been applied yet. The queue itself is RAM,
 * and a deep-sleeping frame loses it: the cloud's "install and activate"
 * reached an E1004 while a button wake was already rendering, the frame
 * slept right after that render, and the next wake came up on the old scene
 * with the new one merely stored (2026-10-12). Written when the selection is
 * queued, erased once the render task applied it, re-queued at init. */
#define PENDING_SCENE_NVS_KEY "pending_scene"

static void persist_pending_scene(const char *scene_id)
{
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return;
    char current[SCENE_ID_LEN] = "";
    size_t len = sizeof(current);
    bool present = nvs_get_str(nvs, PENDING_SCENE_NVS_KEY, current, &len) == ESP_OK && current[0];
    if (scene_id == NULL || scene_id[0] == '\0') {
        if (present) {
            nvs_erase_key(nvs, PENDING_SCENE_NVS_KEY);
            nvs_commit(nvs);
        }
    } else if (!present || strcmp(current, scene_id) != 0) {
        nvs_set_str(nvs, PENDING_SCENE_NVS_KEY, scene_id);
        nvs_commit(nvs);
    }
    nvs_close(nvs);
}

static bool read_pending_scene(char *scene_id, size_t len)
{
    scene_id[0] = '\0';
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READONLY, &nvs) != ESP_OK) return false;
    bool present = nvs_get_str(nvs, PENDING_SCENE_NVS_KEY, scene_id, &len) == ESP_OK && scene_id[0];
    nvs_close(nvs);
    return present;
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

/* The scene an out-of-memory restart was rendering (fos_scenes_mark_oom_restart).
 * Read and erased once, on the first restore after that boot. */
#define OOM_SCENE_NVS_KEY "oom_scene"

static char s_resident_scene_id[SCENE_ID_LEN]; /* defined with the slot store below */

void fos_scenes_mark_oom_restart(void)
{
    if (!s_resident_scene_id[0]) return;
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return;
    if (nvs_set_str(nvs, OOM_SCENE_NVS_KEY, s_resident_scene_id) == ESP_OK) {
        nvs_commit(nvs);
    }
    nvs_close(nvs);
}

/* Returns true when `scene_id` is the scene the last OOM restart was
 * rendering; the mark is consumed either way, so one boot skips it and a
 * later restore (a fresh boot, a cloud switch back) may try it again. */
static bool consume_oom_scene_mark(const char *scene_id)
{
    char marked[SCENE_ID_LEN] = "";
    size_t len = sizeof(marked);
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return false;
    bool present = nvs_get_str(nvs, OOM_SCENE_NVS_KEY, marked, &len) == ESP_OK && marked[0];
    if (present) {
        nvs_erase_key(nvs, OOM_SCENE_NVS_KEY);
        nvs_commit(nvs);
    }
    nvs_close(nvs);
    return present && strcmp(marked, scene_id) == 0;
}

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
    if (consume_oom_scene_mark(scene_id)) {
        /* The scene that drove the last restart out of memory: leave the
         * payload's first scene active so the board renders something and
         * the cloud can switch it, instead of aborting again before the
         * session is even up (13.3" bench, 2026-09-05). */
        s_last_scene_settled = true;
        ESP_LOGW(TAG, "last scene %s aborted out of memory before the restart; keeping default",
                 scene_id);
        log_scene_event("scenes:restore", "skipped", "nvs", scene_id, "oom-restart",
                        0, 0, 0, ESP_OK);
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
    bool is_layout;
} scene_slot_t;

static scene_slot_t s_slots[SCENES_SLOT_MAX];
static int s_slot_count = 0;
static char s_default_scene_id[SCENE_ID_LEN] = "";

static void slot_path(int slot, char *out, size_t out_len)
{
    fos_scene_store_slot_path(slot, out, out_len);
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

void fos_scenes_wipe_state(void)
{
    /* SPIFFS has a flat namespace: readdir("/state") lists every file,
     * whatever slashes its name carries. */
    DIR *dir = opendir("/state");
    if (dir == NULL) {
        ESP_LOGW(TAG, "wipe: /state not mounted");
        return;
    }
    int removed = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        /* d_name is up to 255 bytes; sized so -Wformat-truncation is happy. */
        char path[sizeof("/state/") + sizeof(entry->d_name)];
        snprintf(path, sizeof(path), "/state/%s", entry->d_name);
        if (unlink(path) == 0) removed++;
    }
    closedir(dir);
    ESP_LOGI(TAG, "wipe: removed %d file(s) from /state", removed);
}

static void remove_slots_from(int first_slot)
{
    /* Every slot: one-scene changes leave gaps, so a run can't stop at one. */
    for (int slot = first_slot; slot < SCENES_SLOT_MAX; slot++) {
        char path[SCENES_SLOT_PATH_LEN];
        slot_path(slot, path, sizeof(path));
        unlink(path);
    }
}

/* Split the combined payload. On any failure nothing is deleted and the index
 * is removed, so the caller falls back to loading the combined file whole —
 * a frame never loses its scenes to a failed optimization. */
static esp_err_t split_scenes_locked(const char *json, size_t len)
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
    /* The scene marked default, else the first that is not a layout. */
    char default_id[SCENE_ID_LEN] = "";
    bool default_marked = false;
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
        cJSON_AddNumberToObject(entry, "bytes", (double)item_len);
        cJSON_AddItemToArray(scenes, entry);
        /* A layout (docs/scene-layouts.md) is read by id when a scene names
         * it; it is in no list and never what a frame boots to. */
        const cJSON *settings = cJSON_GetObjectItem(item, "settings");
        bool is_layout = cJSON_IsTrue(cJSON_GetObjectItem(settings, "isLayout"));
        if (is_layout) {
            cJSON_AddBoolToObject(entry, "isLayout", true);
        } else {
            bool marked = cJSON_IsTrue(cJSON_GetObjectItem(item, "default"));
            if (default_id[0] == '\0' || (marked && !default_marked)) {
                snprintf(default_id, sizeof(default_id), "%s", id->valuestring);
                default_marked = marked;
            }
        }
        cJSON_Delete(item);
    }
    if (default_id[0] != '\0') cJSON_AddStringToObject(index, "default", default_id);

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

static esp_err_t split_scenes(const char *json, size_t len)
{
    store_lock();
    esp_err_t err = split_scenes_locked(json, len);
    store_unlock();
    return err;
}

/* Read the index, hand the catalog to the runtime, and fill the id→slot map.
 * Returns the scene count, 0 when there is no usable index. */
static int load_scene_index(void)
{
    s_slot_count = 0;
    s_default_scene_id[0] = '\0';
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
        const cJSON *fallback = cJSON_GetObjectItem(index, "default");
        if (cJSON_IsString(fallback) && fallback->valuestring != NULL) {
            snprintf(s_default_scene_id, sizeof(s_default_scene_id), "%s", fallback->valuestring);
        }
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
            s_slots[s_slot_count].is_layout = cJSON_IsTrue(cJSON_GetObjectItem(entry, "isLayout"));
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
static char s_resident_scene_id[SCENE_ID_LEN]; /* forward-declared above */

/* A resident scene may embed others: a split screen's panels are scene nodes
 * pointing at sibling scenes of the same payload. The runtime asks for each
 * one by id while the split starts (interpreter.nim `sceneLoader`): its slot
 * file, malloc'd for the caller to free, or NULL. Called from inside
 * frameos_nim_load_scene/render on the render task, under the runtime lock:
 * takes no lock itself. Only these scenes are read; the rest of the payload
 * stays on flash as before. */
char *fos_scenes_read_scene_json(const char *scene_id, size_t *out_len)
{
    int slot = slot_for_scene(scene_id);
    if (slot < 0) {
        ESP_LOGW(TAG, "embedded scene %s is not in the payload", scene_id ? scene_id : "?");
        log_scene_event("scenes:load", "error", "embedded", scene_id ? scene_id : "",
                        "embedded-scene-missing", 0, 0, 0, ESP_ERR_NOT_FOUND);
        return NULL;
    }
    char path[SCENES_SLOT_PATH_LEN];
    slot_path(slot, path, sizeof(path));
    char *json = read_file(path, out_len);
    log_scene_event("scenes:load", json ? "ok" : "error", "embedded", scene_id,
                    json ? "embedded-scene-read" : "embedded-scene-unreadable",
                    json ? *out_len : 0, json ? 1 : 0, 0, json ? ESP_OK : ESP_FAIL);
    return json;
}

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
 * default. Never a layout (fos_boot_scene.h). */
static bool activate_from_index(const char *origin)
{
    if (load_scene_index() == 0) return false;

    fos_boot_scene_t scenes[SCENES_SLOT_MAX];
    for (int i = 0; i < s_slot_count; i++) {
        scenes[i] = (fos_boot_scene_t){.id = s_slots[i].id, .is_layout = s_slots[i].is_layout};
    }

    char scene_id[SCENE_ID_LEN] = "";
    size_t id_len = sizeof(scene_id);
    /* A selection queued before a deep sleep names the scene to come up on;
     * loading the previous one first would only be replaced by the pass. */
    if (!(read_pending_scene(scene_id, sizeof(scene_id)) && slot_for_scene(scene_id) >= 0)) {
        nvs_handle_t nvs;
        scene_id[0] = '\0';
        if (nvs_open("frameos", NVS_READONLY, &nvs) == ESP_OK) {
            if (nvs_get_str(nvs, LAST_SCENE_NVS_KEY, scene_id, &id_len) != ESP_OK) {
                scene_id[0] = '\0';
            }
            nvs_close(nvs);
        }
    }
    int pick = fos_boot_scene_pick(scenes, s_slot_count, scene_id, s_default_scene_id);
    if (pick >= 0 && strcmp(s_slots[pick].id, scene_id) == 0 && consume_oom_scene_mark(scene_id)) {
        /* The scene that drove the last restart out of memory. Rendering it
         * again here — before the cloud session is even up — would loop the
         * board; start on the next scene of the payload instead (a lone
         * scene has no alternative and is retried). */
        int other = fos_boot_scene_other(scenes, s_slot_count, scene_id);
        if (other >= 0) {
            ESP_LOGW(TAG, "last scene %s aborted out of memory before the restart; starting on %s",
                     scene_id, s_slots[other].id);
            log_scene_event("scenes:restore", "skipped", "nvs", scene_id, "oom-restart",
                            0, 0, 0, ESP_OK);
            pick = other;
        }
    }
    s_last_scene_settled = true; /* the index decides; no retry needed */
    if (pick < 0) {
        /* Layouts alone: a stored set with nothing to show, not a failed one. */
        log_scene_event("scenes:load", "skipped", origin, "", "only-layouts", 0, 0, 0, ESP_OK);
        return true;
    }
    snprintf(scene_id, sizeof(scene_id), "%s", s_slots[pick].id);
    return load_scene_slot(s_slots[pick].slot, scene_id, origin);
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

/* The index changed under a resident scene (one scene put or deleted): the
 * catalog is read again and the resident scene reloads only if it, or a
 * scene it embeds, is what changed. A change always lands in a new slot,
 * which is how that shows. */

/* A split's panels are other scenes of the set, referred to by id: a slot
 * change for one of those is a change to what the resident scene draws. */
static bool resident_embeds_changed(const scene_slot_t *before, int before_count,
                                    const char *resident, int resident_slot)
{
    char *json = NULL;
    bool found = false;
    for (int i = 0; i < s_slot_count && !found; i++) {
        if (strcmp(s_slots[i].id, resident) == 0) continue;
        bool same = false;
        for (int j = 0; j < before_count && !same; j++) {
            same = before[j].slot == s_slots[i].slot && strcmp(before[j].id, s_slots[i].id) == 0;
        }
        if (same) continue;
        if (json == NULL) {
            char path[SCENES_SLOT_PATH_LEN];
            slot_path(resident_slot, path, sizeof(path));
            size_t len = 0;
            json = read_file(path, &len);
            if (json == NULL) return true; /* cannot tell: reload */
        }
        found = strstr(json, s_slots[i].id) != NULL;
    }
    free(json);
    return found;
}

static bool apply_index_change(void)
{
    s_pending = false;
    s_patch_pending = false;
    scene_slot_t *before = malloc(sizeof(s_slots));
    int before_count = s_slot_count;
    if (before != NULL) memcpy(before, s_slots, sizeof(s_slots));
    char resident[SCENE_ID_LEN];
    snprintf(resident, sizeof(resident), "%s", s_resident_scene_id);

    /* Under the lock: a put swapping the index would otherwise be read as
     * no index at all. */
    store_lock();
    int count = load_scene_index();
    store_unlock();

    bool ok = count > 0;
    if (ok) {
        int resident_slot = resident[0] ? slot_for_scene(resident) : -1;
        int before_slot = -1;
        for (int i = 0; before != NULL && i < before_count; i++) {
            if (strcmp(before[i].id, resident) == 0) before_slot = before[i].slot;
        }
        bool reload = resident_slot < 0 || before == NULL || resident_slot != before_slot ||
                      resident_embeds_changed(before, before_count, resident, resident_slot);
        if (reload) {
            s_scene_switched = true;
            fos_display_loading_begin(xTaskGetTickCount(), fos_config()->rotate);
            if (resident_slot >= 0) {
                ok = load_scene_slot(resident_slot, resident, "stored");
                if (!ok && before_slot >= 0 && before_slot != resident_slot) {
                    /* A scene the runtime refuses does not take the working
                     * one with it: the old file is still there until the
                     * sweep below. The apply still reports the failure. */
                    ESP_LOGW(TAG, "scene %s refused; going back to slot %d", resident, before_slot);
                    store_lock();
                    fos_scene_store_repoint(resident, before_slot);
                    load_scene_index();
                    store_unlock();
                    load_scene_slot(before_slot, resident, "restored");
                }
            } else {
                ok = activate_from_index("stored");
            }
            if (!ok) fos_display_loading_end();
        }
    } else {
        ESP_LOGW(TAG, "scene index unreadable after a change");
    }
    free(before);
    if (count > 0) {
        store_lock();
        /* Not while another change waits for its own apply: s_slots still
         * names the slot that change replaced. Its apply sweeps. */
        if (!s_patch_pending) fos_scene_store_sweep();
        store_unlock();
    }
    s_apply_ok = ok;
    s_apply_generation++;
    return ok;
}

bool fos_scenes_apply_pending(void)
{
    if (!s_pending || !s_mounted) return false;
    {
        /* A combined payload stored since wins over a change made before it. */
        struct stat combined;
        if (s_patch_pending && stat(SCENES_PATH, &combined) != 0) return apply_index_change();
    }
    s_patch_pending = false;
    /* A new payload invalidates whatever is parsed, even if the id matches. */
    s_resident_scene_id[0] = '\0';
    s_pending = false;
    bool pushed = s_payload_stored_since_boot;
    if (s_payload_stored_since_boot) {
        /* Not the cached store init re-applies on every boot: a deploy that
         * landed while the frame was up. What it shows is stale now. */
        s_payload_stored_since_boot = false;
        s_scene_switched = true;
        /* A new scene set, from here to its first picture: as a switch. */
        fos_client_loading_begin(xTaskGetTickCount());
    }
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
         * a write that failed): the whole-payload path. The live set's index
         * goes only once this one has loaded: a payload the runtime refuses
         * as well used to take the frame's scenes with it (2026-11-08, an
         * upload stored cut short). Refused, it goes, and the set from before
         * comes back; the apply still reports the failure. */
        int slots_before = s_slot_count;
        s_slot_count = 0;
        ok = load_into_nim(json, len, "stored");
        free(json);
        json = NULL;
        if (ok) {
            unlink(SCENES_INDEX_PATH);
        } else {
            unlink(SCENES_PATH);
            s_slot_count = slots_before;
            if (!activate_from_index("restored")) {
                ESP_LOGW(TAG, "refused payload dropped; no earlier set to come back to");
            }
        }
    }
    free(json);
    /* The writes are over. A set that loaded renders now (s_scene_switched):
     * the "Updating" screen, with the loading mark over it, until its
     * first picture. One that did not gets the picture from before back. */
    fos_display_updating_end(ok);
    if (pushed && !ok) fos_client_loading_end();
    /* Publish the outcome before the generation, so a poller that sees a new
     * generation always reads the matching result. */
    s_apply_ok = ok;
    s_apply_generation++;
    return ok;
}

uint32_t fos_scenes_apply_generation(void) { return s_apply_generation; }
bool fos_scenes_apply_succeeded(void) { return s_apply_ok; }
bool fos_scenes_patch_pending(void) { return s_pending && s_patch_pending && s_mounted; }

int fos_scenes_loaded(void) { return s_loaded; }
const char *fos_scenes_etag(void) { return s_etag; }

bool fos_scenes_stored(void)
{
    if (!s_mounted) return false;
    struct stat st;
    if (stat(SCENES_PATH, &st) == 0 && st.st_size > 2) return true;
    return stat(SCENES_INDEX_PATH, &st) == 0 && st.st_size > 2;
}
void fos_scenes_request_sync(void) { s_sync_requested = true; }

/* The whole payload, for callers that download or re-upload it (the USB API,
 * the backend sync's etag comparison). On the lazy path the combined file no
 * longer exists, so it is rebuilt from the slots — in PSRAM, transiently, and
 * only when something actually asks. From the index on flash under the lock:
 * s_slots belongs to the render task, and this is not always it. */
char *fos_scenes_json_copy(size_t *out_len)
{
    if (out_len != NULL) *out_len = 0;
    esp_err_t err = mount_state();
    if (err != ESP_OK) return NULL;
    store_lock();
    char *combined = read_file(SCENES_PATH, out_len);
    if (combined != NULL) {
        store_unlock();
        return combined;
    }
    fos_scene_store_entry_t *entries = malloc(sizeof(*entries) * SCENES_SLOT_MAX);
    int count = entries ? fos_scene_store_read_entries(entries, SCENES_SLOT_MAX) : -1;
    if (count <= 0) {
        free(entries);
        store_unlock();
        return NULL;
    }
    size_t cap = 2; /* "[" + "]" */
    char *buf = NULL;
    for (int i = 0; i < count; i++) {
        char path[SCENES_SLOT_PATH_LEN];
        slot_path(entries[i].slot, path, sizeof(path));
        struct stat st;
        if (stat(path, &st) != 0) goto fail;
        cap += (size_t)st.st_size + 1; /* + comma */
    }
    buf = fos_big_malloc(cap + 1);
    if (buf == NULL) buf = malloc(cap + 1);
    if (buf == NULL) goto fail;
    size_t used = 0;
    buf[used++] = '[';
    for (int i = 0; i < count; i++) {
        char path[SCENES_SLOT_PATH_LEN];
        slot_path(entries[i].slot, path, sizeof(path));
        size_t part_len = 0;
        char *part = read_file(path, &part_len);
        if (part == NULL) goto fail;
        if (i > 0 && used < cap) buf[used++] = ',';
        if (used + part_len > cap) { free(part); goto fail; }
        memcpy(buf + used, part, part_len);
        used += part_len;
        free(part);
    }
    buf[used++] = ']';
    buf[used] = '\0';
    if (out_len != NULL) *out_len = used;
    free(entries);
    store_unlock();
    return buf;
fail:
    free(buf);
    free(entries);
    store_unlock();
    return NULL;
}

esp_err_t fos_scenes_select(const char *scene_id)
{
    if (scene_id == NULL || scene_id[0] == '\0') return ESP_ERR_INVALID_ARG;
    uint32_t now = xTaskGetTickCount();
    portENTER_CRITICAL(&s_scene_select_lock);
    snprintf(s_pending_scene_id, sizeof(s_pending_scene_id), "%s", scene_id);
    if (!s_scene_select_pending) s_pending_since = now;
    s_scene_select_pending = true;
    portEXIT_CRITICAL(&s_scene_select_lock);
    /* Outlive a deep sleep that cuts in before the render task gets to it
     * (PENDING_SCENE_NVS_KEY). Same value, no write: the cloud re-announces
     * the current scene on every reconnect. The scene switcher does not
     * outlive one: a frame wakes on the scene it was opened from. */
    if (!is_built_in_scene(scene_id)) persist_pending_scene(scene_id);
    ESP_LOGI(TAG, "scene selection queued: %s", scene_id);
    return ESP_OK;
}

bool fos_scenes_selection_pending(void)
{
    return s_scene_select_pending;
}

bool fos_scenes_work_pending(void)
{
    /* A payload the render task cannot apply (no /state) is not work. */
    return (s_pending && s_mounted) || s_scene_select_pending;
}

bool fos_scenes_switched_pending(void)
{
    return s_scene_switched;
}

bool fos_scenes_take_switched(void)
{
    bool switched = s_scene_switched;
    s_scene_switched = false;
    return switched;
}

bool fos_scenes_apply_pending_selection(void)
{
    char scene_id[SCENE_ID_LEN];
    bool pending;
    uint32_t asked_at = 0;

    portENTER_CRITICAL(&s_scene_select_lock);
    pending = s_scene_select_pending;
    if (pending) {
        snprintf(scene_id, sizeof(scene_id), "%s", s_pending_scene_id);
        asked_at = s_pending_since;
        s_scene_select_pending = false;
        s_pending_scene_id[0] = '\0';
    }
    portEXIT_CRITICAL(&s_scene_select_lock);

    if (!pending) return false;
    /* Consumed, whatever happens next: a selection that fails (an id this
     * payload does not carry) must not be retried on every boot. */
    persist_pending_scene(NULL);
    if (s_boot_pending_selection) {
        /* Queued before the sleep, applied now: the panel still shows the
         * scene from before, even when the boot restore already made this
         * one resident (activate_from_index). */
        s_boot_pending_selection = false;
        s_scene_switched = true;
    }
    if (is_built_in_scene(scene_id)) {
        /* The scene switcher (system/sceneSwitcher): the runtime draws it,
         * so there is no slot to load, and the resident scene stays parsed
         * for the way back. Not persisted: a reboot or a deep sleep comes
         * back on the scene it covers. A frame that deep-sleeps stays up a
         * while for the keys that walk it. Nothing loads, but its first
         * picture is a render like any other (drawn whole, 13 tiles take
         * ~2 s on the SenseCAP), so the loading mark counts from here too. */
        fos_client_loading_begin(asked_at);
        if (!frameos_nim_set_scene(scene_id)) {
            log_scene_event("scenes:select", "error", "queued", scene_id,
                            "apply-failed", 0, 0, 0, ESP_FAIL);
            fos_client_loading_end();
            return false;
        }
        s_built_in_shown = true;
        s_settings_shown = strcmp(scene_id, FOS_SCENE_SETTINGS_ID) == 0;
        s_scene_switched = true;
        fos_client_keep_awake_ms(BUILT_IN_SCENE_AWAKE_MS);
        ESP_LOGI(TAG, "scene selected: %s", scene_id);
        printf("scene changed: %s\n", scene_id); /* visible on the USB serial stream */
        log_scene_event("event:setCurrentScene", "ok", "queued", scene_id,
                        "selected", 0, 0, 0, ESP_OK);
        log_scene_event("render:sceneChange", "ok", "queued", scene_id,
                        "selected", 0, 0, 0, ESP_OK);
        return true;
    }
    if (s_built_in_shown) {
        /* Back from the switcher: whatever is chosen, the panel changes, and
         * the scene it covered is still resident, so the early return below
         * would skip the loading mark while that scene renders again. */
        s_built_in_shown = false;
        s_settings_shown = false;
        s_scene_switched = true;
        fos_client_loading_begin(asked_at);
    }
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
        /* Resident is not the same as persisted. The boot restore loads the
         * PENDING scene when one survived the sleep (activate_from_index),
         * and a fresh payload's apply does the same, so the scene the user
         * picked is resident here on the strength of pending_scene alone
         * while last_scene still names the one from before. Skipping the
         * write left an E1004 flipping back to its old scene on every timer
         * wake after a cloud switch (2026-10-12). */
        persist_last_scene(scene_id);
        s_last_scene_settled = true;
        return true;
    }
    /* Another scene, from here to its first picture: on an LCD the loading
     * mark shows if that takes a while, counted from when it was asked for.
     * Before the load below, which is part of the wait. */
    fos_client_loading_begin(asked_at);
    if (s_slot_count > 0) {
        if (!activate_scene_id(scene_id)) {
            ESP_LOGW(TAG, "scene selection failed: %s", scene_id);
            log_scene_event("scenes:select", "error", "queued", scene_id,
                            "apply-failed", 0, 0, 0, ESP_FAIL);
            fos_client_loading_end();
            return false;
        }
    } else if (!frameos_nim_set_scene(scene_id)) {
        ESP_LOGW(TAG, "scene selection failed: %s", scene_id);
        log_scene_event("scenes:select", "error", "queued", scene_id,
                        "apply-failed", 0, 0, 0, ESP_FAIL);
        fos_client_loading_end();
        return false;
    }
    persist_last_scene(scene_id);
    s_scene_switched = true;
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
    store_lock();
    esp_err_t err = write_file_replace_locked(path, tmp_path, data, len);
    store_unlock();
    return err;
}

/* A `setCurrentScene` that reached the Nim dispatcher — a scene's own
 * dispatch, or one fos_events.c handed over for the `state` it carries.
 * Runs under the runtime lock, on whichever task called into Nim (the render
 * task, or the HTTP / cloud / console task): queue only, like every other
 * caller — fos_scenes_apply_pending_selection does the work. */
static bool select_scene_from_runtime(const char *scene_id)
{
    return fos_scenes_select(scene_id) == ESP_OK;
}

esp_err_t fos_scenes_init(void)
{
    if (s_scene_file_lock == NULL) {
        s_scene_file_lock = xSemaphoreCreateRecursiveMutex();
    }
    fos_scene_store_hooks_t store_hooks = {.make_room = make_room, .big_alloc = fos_big_malloc};
    fos_scene_store_set_hooks(&store_hooks);
    /* Before the mount: a frame whose /state failed still holds its bundled
     * scenes, and a dispatch node switches between those too. */
    frameos_nim_set_scene_select_hook(select_scene_from_runtime);
    esp_err_t err = mount_state();
    if (err != ESP_OK) return err;
    /* A power cut inside the store's remove + rename of the index, and the
     * files a change left for a sweep that never came. */
    if (fos_scene_store_recover_index()) ESP_LOGW(TAG, "scene index recovered from its tmp file");
    fos_scene_store_sweep();
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
    {
        /* A selection the previous boot queued but never applied (a deep
         * sleep came first): back on the queue, applied by the first pass
         * right after the cached payload, and rendered (fos_scenes_take_switched). */
        char pending_id[SCENE_ID_LEN];
        if (read_pending_scene(pending_id, sizeof(pending_id))) {
            portENTER_CRITICAL(&s_scene_select_lock);
            snprintf(s_pending_scene_id, sizeof(s_pending_scene_id), "%s", pending_id);
            s_scene_select_pending = true;
            portEXIT_CRITICAL(&s_scene_select_lock);
            s_boot_pending_selection = true;
            ESP_LOGI(TAG, "scene selection restored from before the sleep: %s", pending_id);
            log_scene_event("scenes:select", "ok", "nvs", pending_id, "restored-pending",
                            0, 0, 0, ESP_OK);
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
    /* Refused before it is stored: a payload cut short would be applied in
     * place of the scenes the frame has, and fail there. */
    if (!fos_json_whole(json, len)) {
        set_scene_simple_error("scenes payload is not one whole JSON array or object", len);
        log_scene_event("event:uploadScenes", "error", origin, "", s_last_error, len, 0, 0, ESP_ERR_INVALID_ARG);
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t err = mount_state();
    if (err != ESP_OK) return err;
    /* "Updating" on the glass until the apply on the render task has
     * split it and loaded it: flash writes the whole way
     * (fos_lcd_st7701s_updating_begin). */
    fos_display_updating_begin();
    err = write_file_replace(SCENES_PATH, SCENES_TMP_PATH, json, len);
    if (err != ESP_OK) {
        fos_display_updating_end(false);
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
    s_payload_stored_since_boot = true;
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

/* ------------------------------------------------------- one scene at a time */

static esp_err_t store_err_to_esp(fos_scene_store_err_t err)
{
    switch (err) {
    case FOS_SCENE_STORE_OK: return ESP_OK;
    case FOS_SCENE_STORE_ERR_NOT_FOUND: return ESP_ERR_NOT_FOUND;
    case FOS_SCENE_STORE_ERR_INVALID:
    case FOS_SCENE_STORE_ERR_MISSING_SCENE: return ESP_ERR_INVALID_ARG;
    case FOS_SCENE_STORE_ERR_LAST_SCENE: return ESP_ERR_INVALID_STATE;
    case FOS_SCENE_STORE_ERR_NO_SLOTS:
    case FOS_SCENE_STORE_ERR_NO_SPACE:
    case FOS_SCENE_STORE_ERR_NO_MEMORY: return ESP_ERR_NO_MEM;
    default: return ESP_FAIL;
    }
}

/* A one-scene change is made on the per-scene store. A combined payload not
 * yet split is split here (a frame that last synced from a backend holds one
 * until its next boot), unless the render task is about to apply it. */
static esp_err_t ensure_split_locked(size_t bytes)
{
    struct stat st;
    if (stat(SCENES_PATH, &st) != 0 || st.st_size <= 2) return ESP_OK;
    if (s_pending) {
        set_scene_simple_error("a scene upload is waiting to be applied, try again", bytes);
        return ESP_ERR_INVALID_STATE;
    }
    size_t len = 0;
    char *json = read_file(SCENES_PATH, &len);
    if (json == NULL) {
        set_scene_simple_error("the stored scenes cannot be read", bytes);
        return ESP_FAIL;
    }
    esp_err_t err = split_scenes_locked(json, len);
    free(json);
    if (err != ESP_OK) {
        set_scene_simple_error("the stored scenes cannot be split per scene, upload them all", bytes);
        return ESP_ERR_INVALID_STATE;
    }
    return ESP_OK;
}

static void forget_dropped_scene(const char *scene_id, void *ctx)
{
    (void)ctx;
    /* The state a deleted scene kept across deep sleep, deleted with it. */
    fos_scene_state_forget(scene_id);
}

static esp_err_t apply_store_change(fos_scene_store_change_t *change, fos_scenes_source_t source,
                                    const char *etag, const char *event, size_t bytes,
                                    fos_scene_store_result_t *result)
{
    const char *origin = scene_source_str((int)source);
    s_last_error[0] = '\0';
    esp_err_t err = mount_state();
    if (err != ESP_OK) return err;
    /* A local edit leaves the set whose it was: scenes the cloud pushed stay
     * fenced off the LAN (fos_cloud.c) however one of them was edited. */
    int effective = source == FOS_SCENES_SOURCE_LOCAL ? (s_pending ? s_pending_source : s_source) : (int)source;
    change->source = scene_source_str(effective);

    store_lock();
    err = ensure_split_locked(bytes);
    if (err == ESP_OK) {
        fos_scene_store_err_t store_err = fos_scene_store_apply(change, result, forget_dropped_scene, NULL);
        if (store_err != FOS_SCENE_STORE_OK) {
            err = store_err_to_esp(store_err);
            set_scene_simple_error(fos_scene_store_err_str(store_err), bytes);
        }
    }
    if (err == ESP_OK) {
        /* Inside the lock: the render task's sweep must see the change coming
         * before it treats a slot the old index named as unused. */
        s_patch_pending = true;
        s_pending = true;
    }
    store_unlock();
    if (err != ESP_OK) {
        log_scene_event(event, "error", origin, "", s_last_error, bytes, 0, 0, err);
        return err;
    }
    save_etag(etag ? etag : "local");
    if (source == FOS_SCENES_SOURCE_LOCAL && effective == FOS_SCENES_SOURCE_CLOUD) {
        /* The cloud's checksum no longer describes what the frame holds. */
        fos_cloud_forget_applied_scenes();
    }
    s_pending_source = effective;
    persist_scene_source(effective);
    log_scene_event(event, "stored", origin, result->first_put_id, "pending-apply",
                    bytes, result->scene_count, 0, ESP_OK);
    return ESP_OK;
}

esp_err_t fos_scenes_put(const char *json, size_t len, fos_scenes_source_t source,
                         char *out_id, size_t out_id_len)
{
    if (json == NULL || len == 0) return ESP_ERR_INVALID_ARG;
    fos_scene_store_put_t put = {.json = json, .len = len};
    fos_scene_store_change_t change = {.puts = &put, .put_count = 1};
    fos_scene_store_result_t result;
    esp_err_t err = apply_store_change(&change, source, NULL, "scenes:put", len, &result);
    if (err != ESP_OK) return err;
    if (out_id != NULL && out_id_len > 0) snprintf(out_id, out_id_len, "%s", result.first_put_id);
    fos_client_wake_for_events();
    return ESP_OK;
}

esp_err_t fos_scenes_delete(const char *scene_id, fos_scenes_source_t source)
{
    if (scene_id == NULL || scene_id[0] == '\0') return ESP_ERR_INVALID_ARG;
    fos_scene_store_change_t change = {.remove_id = scene_id};
    fos_scene_store_result_t result;
    esp_err_t err = apply_store_change(&change, source, NULL, "scenes:delete", 0, &result);
    if (err != ESP_OK) return err;
    fos_client_wake_for_events();
    return ESP_OK;
}

esp_err_t fos_scenes_apply_patch(const cJSON *put, const cJSON *order,
                                 fos_scenes_source_t source, const char *etag)
{
    int put_count = cJSON_IsArray(put) ? cJSON_GetArraySize(put) : 0;
    int order_count = cJSON_IsArray(order) ? cJSON_GetArraySize(order) : 0;
    if (order_count <= 0 || order_count > SCENES_SLOT_MAX || put_count > SCENES_SLOT_MAX) {
        return ESP_ERR_INVALID_ARG;
    }
    fos_scene_store_put_t *puts = calloc((size_t)(put_count ? put_count : 1), sizeof(*puts));
    const char **ids = calloc((size_t)order_count, sizeof(*ids));
    if (puts == NULL || ids == NULL) {
        free(puts);
        free(ids);
        return ESP_ERR_NO_MEM;
    }
    esp_err_t err = ESP_OK;
    int printed = 0;
    size_t bytes = 0;
    const cJSON *item = NULL;
    cJSON_ArrayForEach(item, put) {
        /* One scene printed at a time, next to the message it arrived in. */
        char *json = cJSON_PrintUnformatted(item);
        if (json == NULL) {
            err = ESP_ERR_NO_MEM;
            break;
        }
        puts[printed].json = json;
        puts[printed].len = strlen(json);
        bytes += puts[printed].len;
        printed++;
    }
    int id_count = 0;
    cJSON_ArrayForEach(item, order) {
        if (!cJSON_IsString(item) || item->valuestring == NULL) {
            err = ESP_ERR_INVALID_ARG;
            break;
        }
        ids[id_count++] = item->valuestring;
    }
    if (err == ESP_OK) {
        fos_scene_store_change_t change = {.puts = puts, .put_count = printed, .order = ids, .order_count = id_count};
        fos_scene_store_result_t result;
        err = apply_store_change(&change, source, etag, "scenes:patch", bytes, &result);
        if (err == ESP_OK) fos_client_wake_for_events();
    }
    for (int i = 0; i < printed; i++) cJSON_free((void *)puts[i].json);
    free(puts);
    free(ids);
    return err;
}

char *fos_scenes_get_json(const char *scene_id, size_t *out_len)
{
    if (out_len != NULL) *out_len = 0;
    if (mount_state() != ESP_OK) return NULL;
    store_lock();
    char *json = fos_scene_store_read_scene(scene_id, out_len);
    store_unlock();
    return json;
}

void fos_scenes_storage_summary(fos_scenes_storage_t *out)
{
    memset(out, 0, sizeof(*out));
    if (!s_mounted) return;
    state_usage(&out->state_total_bytes, &out->state_used_bytes);
    store_lock();
    fos_scene_store_entry_t *entries = malloc(sizeof(*entries) * SCENES_SLOT_MAX);
    int count = entries ? fos_scene_store_read_entries(entries, SCENES_SLOT_MAX) : -1;
    if (count > 0) {
        out->scene_count = count;
        for (int i = 0; i < count; i++) out->scenes_bytes += entries[i].bytes;
    } else {
        /* Not split (yet): the combined payload's size. */
        struct stat st;
        if (stat(SCENES_PATH, &st) == 0) out->scenes_bytes = (size_t)st.st_size;
        out->scene_count = s_loaded;
    }
    free(entries);
    store_unlock();
}

char *fos_scenes_list_json(void)
{
    if (mount_state() != ESP_OK) return NULL;
    store_lock();
    cJSON *tree = fos_scene_store_list_tree();
    store_unlock();
    if (tree == NULL) return NULL;
    fos_scenes_storage_t storage;
    fos_scenes_storage_summary(&storage);
    cJSON *report = cJSON_AddObjectToObject(tree, "storage");
    if (report != NULL) {
        cJSON_AddNumberToObject(report, "stateTotalBytes", (double)storage.state_total_bytes);
        cJSON_AddNumberToObject(report, "stateUsedBytes", (double)storage.state_used_bytes);
        cJSON_AddNumberToObject(report, "scenesBytes", (double)storage.scenes_bytes);
        cJSON_AddNumberToObject(report, "sceneCount", storage.scene_count);
    }
    char *json = cJSON_PrintUnformatted(tree);
    cJSON_Delete(tree);
    return json;
}

/* A backend's answer to `?patch=1` when it knows what this frame holds:
 * {"patch":true,"base":"<etag>","order":[...],"put":[...]}. Anything not
 * against the set this frame holds forces the whole payload next pass. */
static esp_err_t apply_backend_patch(const char *body, size_t len, const char *etag)
{
    if (!fos_json_depth_ok(body, len, FOS_JSON_MAX_DEPTH)) return ESP_ERR_INVALID_ARG;
    cJSON *root = cJSON_ParseWithLength(body, len);
    if (root == NULL) return ESP_ERR_NO_MEM;
    esp_err_t err;
    const cJSON *base = cJSON_GetObjectItem(root, "base");
    if (!cJSON_IsString(base) || base->valuestring == NULL || strcmp(base->valuestring, s_etag) != 0) {
        s_sync_requested = true;
        err = ESP_ERR_INVALID_STATE;
    } else {
        err = fos_scenes_apply_patch(cJSON_GetObjectItem(root, "put"), cJSON_GetObjectItem(root, "order"),
                                     FOS_SCENES_SOURCE_BACKEND, etag);
        if (err != ESP_OK) s_sync_requested = true;
    }
    cJSON_Delete(root);
    return err;
}

/* ------------------------------------------------------------- backend */

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
    fos_backend_url("/embedded/scenes?patch=1", url, sizeof(url));
    char auth[FOS_STR_LEN + 16];
    fos_backend_auth(auth, sizeof(auth));
    fos_http_request_t request = {
        .url = url,
        .auth = auth,
        .if_none_match = (!force && strcmp(s_etag, "local") != 0) ? s_etag : NULL,
        .timeout_ms = 30000,
        .buffer_size = 4096,
    };
    fos_http_response_t response;
    err = fos_http_fetch(&request, SCENES_MAX_BYTES, &response);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "scenes sync: connect failed: %s", esp_err_to_name(err));
        log_scene_event("scenes:sync", "error", "backend", "", "connect-failed",
                        0, 0, 0, err);
        return err;
    }
    int status = response.status;
    if (status == 304) {
        if (log_unchanged) {
            log_scene_event("scenes:sync", "ok", "backend", "", "unchanged",
                            0, s_loaded, status, ESP_OK);
        }
        return ESP_OK;
    }
    if (status != 200) {
        ESP_LOGW(TAG, "scenes sync: HTTP %d from %s", status, url);
        log_scene_event("scenes:sync", "error", "backend", "", "http-error",
                        0, 0, status, ESP_FAIL);
        fos_http_response_free(&response);
        return ESP_FAIL;
    }
    if (response.too_large) {
        ESP_LOGE(TAG, "scenes sync: payload too large (%lld)", response.content_length);
        log_scene_event("scenes:sync", "error", "backend", "", "payload-too-large",
                        (size_t)(response.content_length > 0 ? response.content_length : SCENES_MAX_BYTES),
                        0, status, ESP_ERR_NO_MEM);
        return ESP_ERR_NO_MEM;
    }
    if (response.body == NULL) {
        log_scene_event("scenes:sync", "error", "backend", "", "read-failed",
                        0, 0, status, ESP_FAIL);
        return ESP_FAIL;
    }
    char *buf = response.body;
    size_t total = response.body_len;
    char response_etag[ETAG_LEN];
    strlcpy(response_etag, response.etag, sizeof(response_etag));

    /* An object, not the array a whole payload is: only the scenes that
     * changed since the set this frame holds. */
    if (total > 0 && buf[0] == '{') {
        err = apply_backend_patch(buf, total, response_etag);
        free(buf);
        log_scene_event("scenes:sync", err == ESP_OK ? "updated" : "error", "backend", "",
                        err == ESP_OK ? "patched" : "patch-refused", total, 0, status, err);
        return err;
    }

    /* "Updating" for the write; the picture from before comes back
     * after it, and the new set shows at the next render, as before. */
    fos_display_updating_begin();
    err = write_file_replace(SCENES_PATH, SCENES_TMP_PATH, buf, total);
    fos_display_updating_end(false);
    if (err == ESP_OK) {
        save_etag(response_etag);
        /* Backend-served payload: declare it before load_into_nim promotes
         * the pending source, and persist it so the boot-time split (this
         * path leaves the combined file for the next apply to split) records
         * "backend" in the index. */
        s_pending_source = FOS_SCENES_SOURCE_BACKEND;
        persist_scene_source(FOS_SCENES_SOURCE_BACKEND);
        /* The per-scene index the boot split wrote describes the PREVIOUS
         * payload. With it in place a selection went through the slots: a
         * scene new in this payload was "not found" (the voice chat's
         * show_image, E1002 2026-10-24: apply-failed with four scenes live)
         * and a known id reloaded its stale slot file. The runtime holds the
         * whole new payload from here; the next apply splits it again. */
        unlink(SCENES_INDEX_PATH);
        s_slot_count = 0;
        s_resident_scene_id[0] = '\0';
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

bool fos_scenes_settings_shown(void)
{
    return s_settings_shown;
}
