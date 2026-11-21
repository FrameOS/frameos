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
#include "esp_system.h"
#include "esp_timer.h"
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
#include "fos_store_scan.h"
#include "fos_slot_cache.h"
#include "fos_spiffs_footprint.h"
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
/* The most scenes a set holds (the store's index); a payload of more is
 * refused, not cut. */
#define SCENES_SET_MAX FOS_SCENE_STORE_SCENES
#define SCENES_SLOT_PATH_LEN 48
/* The most a set may be to be held in memory whole: a payload a producer
 * hands over in one block (a USB or HTTP upload, the cloud's one message), a
 * backend's answer read into blocks, a combined scenes.json. It is no limit
 * on what a frame stores: a backend's answer over it (or one there is no
 * memory for) is read straight into the store, a scene at a time, and then
 * /state is what bounds it (backend_spool). 529 KB of scenes were refused
 * whole on a reTerminal Sticky with 24 MB of /state (`payload-too-large`,
 * the hardware bench, 2026-11-18). */
#define SCENES_HELD_MAX_BYTES (512 * 1024)
/* How long a download waits for its body's block (fos_http_request_t
 * alloc_wait_ms): an e-paper render holds its PSRAM for a few seconds. */
#define SCENES_BODY_WAIT_MS 8000
#define ETAG_LEN 80
_Static_assert(ETAG_LEN == FOS_SCENES_ETAG_LEN, "fos_scenes.h hands out etags of this length");
_Static_assert(FOS_SCENE_PIECES_MAX == SCENES_SET_MAX, "a backend set holds no more scenes than the store");
#define SCENE_ID_LEN 128
#define SCENE_ERROR_LEN 256

static bool s_mounted = false;
static volatile bool s_pending = false;
/* What is pending is a change the per-scene store already holds (one scene
 * put or deleted), not a combined payload: only the catalog is read again,
 * and the resident scene reloads only if that scene is what changed. */
static volatile bool s_patch_pending = false;
/* A producer (the cloud, HTTP or the console task) is writing and splitting a
 * whole payload under the store lock (fos_scenes_set_json_from): the slots the
 * render task's index names are being replaced. The render task reads none
 * meanwhile and does not wait on the lock: a switch waits for the apply that
 * follows, which reads the new index first. */
static volatile bool s_store_changing = false;
static bool store_split_behind(void);
static bool store_sweep_behind(void);
static void store_split_stored(void);
static bool backend_set_written(uint32_t timeout_ms);
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
 * `scenes.switcher`, `scenes.settings`, and on a desktop a scene's own
 * settings, `scenes.settingsWindow`): no slot on flash, never the scene a
 * reboot or a deep sleep comes back to. */
static bool is_built_in_scene(const char *scene_id)
{
    return scene_id != NULL &&
           (strcmp(scene_id, FOS_SCENE_SWITCHER_ID) == 0 || strcmp(scene_id, FOS_SCENE_SETTINGS_ID) == 0 ||
            strncmp(scene_id, FOS_SCENE_SETTINGS_WINDOW_PREFIX, sizeof(FOS_SCENE_SETTINGS_WINDOW_PREFIX) - 1) == 0);
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

/* The render task is waiting for the store lock. Whoever holds it then
 * writes as fast as flash goes (store_pace): pacing exists to leave the
 * render task free, and it is not free while it waits here. Worse, the
 * input hold that pacing waits out is released by the render task alone:
 * a tap, then a scene pull, and the store task waited for the hold while
 * holding this lock, and the render task waited for the lock (the reTerminal
 * E1003 rendered nothing more, 2026-11-10). */
static volatile bool s_render_waits_for_store = false;

static void store_lock(void)
{
    if (s_scene_file_lock == NULL) return;
    if (fos_client_on_render_task()) {
        if (xSemaphoreTakeRecursive(s_scene_file_lock, 0) == pdTRUE) return;
        s_render_waits_for_store = true;
        xSemaphoreTakeRecursive(s_scene_file_lock, portMAX_DELAY);
        s_render_waits_for_store = false;
        return;
    }
    xSemaphoreTakeRecursive(s_scene_file_lock, portMAX_DELAY);
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

static void etag_get(char *out, size_t out_len);

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
    char etag[ETAG_LEN];
    etag_get(etag, sizeof(etag));
    json_escape_value(etag, etag_esc, sizeof(etag_esc));
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

/* At most FOS_SCENE_STORE_MAX_BYTES, in PSRAM when there is some (the store's hooks). */
static char *read_file(const char *path, size_t *out_len)
{
    return fos_scene_store_read_file(path, out_len);
}

/* The scenes read last (fos_slot_cache.h: a scene shown before is not looked
 * up on flash again). Under s_scene_file_lock; the file read and the copies
 * outside it. */
static fos_slot_cache_t s_slot_cache;

static void slot_cache_lock(void)
{
    store_lock();
}

static void slot_cache_unlock(void)
{
    store_unlock();
}

static void slot_cache_clear(void)
{
    slot_cache_lock();
    fos_slot_cache_clear(&s_slot_cache);
    slot_cache_unlock();
}

static char *copy_bytes(const char *src, size_t len)
{
    char *copy = fos_big_malloc(len + 1);
    if (copy == NULL) copy = malloc(len + 1);
    if (copy == NULL) return NULL;
    memcpy(copy, src, len);
    copy[len] = 0;
    return copy;
}

/* A slot file's bytes, malloc'd for the caller to free, from the cache when
 * it holds them. */
static char *read_slot_file(int slot, const char *path, size_t *out_len)
{
    slot_cache_lock();
    uint32_t generation = fos_slot_cache_generation(&s_slot_cache);
    size_t held_len = 0;
    const char *held = fos_slot_cache_find(&s_slot_cache, slot, &held_len);
    char *copy = held != NULL ? copy_bytes(held, held_len) : NULL;
    slot_cache_unlock();
    if (copy != NULL) {
        if (out_len != NULL) *out_len = held_len;
        return copy;
    }
    size_t len = 0;
    /* Under the store lock: a whole set stored as changes empties the file a
     * scene had before (fos_scene_store_apply_set) from the store task, and
     * this read must not meet it half emptied. Recursive, and the store task
     * never calls the runtime: the lock order holds. */
    store_lock();
    char *json = read_file(path, &len);
    store_unlock();
    if (out_len != NULL) *out_len = len;
    if (json == NULL || !fos_slot_cache_wants(len)) return json;
    char *kept = copy_bytes(json, len);
    if (kept == NULL) return json;
    slot_cache_lock();
    fos_slot_cache_keep(&s_slot_cache, slot, kept, len, generation);
    slot_cache_unlock();
    return json;
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

/* The store's `has_room`: whether /state takes `len` more bytes beside what
 * it holds, by its own count (what is not allocated: erased pages and the
 * deleted ones a collection gives back), with an eighth and 64 KB over for
 * what SPIFFS keeps to itself. Asked, not collected for: no is an answer (a
 * whole set then goes in one scene at a time), and a collection that cannot
 * make the room logs four errors on its way to saying so. A yes the writes
 * then belie costs nothing: the set goes the long way. */
#define STORE_ROOM_SPARE (64 * 1024)

static bool store_has_room(size_t len)
{
    size_t total = 0, used = 0;
    state_usage(&total, &used);
    return total > used && total - used >= len + len / 8 + STORE_ROOM_SPARE;
}

/* The old file stays until the new one is whole: a write that finds no room
 * fails and keeps it. (It used to delete the old file and write again, and
 * a second failure left neither: a frame rebooted with no scenes.) The store
 * runs make_room() first. */
static esp_err_t store_write_err(fos_scene_store_err_t err, const char *path, size_t len)
{
    if (err == FOS_SCENE_STORE_OK) return ESP_OK;
    int err_no = errno; /* the store keeps it for this */
    set_scene_error("write", path, len, err_no);
    ESP_LOGE(TAG, "%s", s_last_error);
    return scene_err_from_errno(err_no, err == FOS_SCENE_STORE_ERR_NO_SPACE ? ESP_ERR_NO_MEM : ESP_FAIL);
}

static esp_err_t write_file_replace_locked(const char *path, const char *tmp_path,
                                           const char *data, size_t len)
{
    return store_write_err(fos_scene_store_write_file(path, tmp_path, data, len), path, len);
}

/* s_etag is what the next conditional GET sends: read by the backend link
 * task (fos_scenes_backend_fetch), set by the render task when it takes a
 * payload and by the store task when a write failed. Copied under this. */
static portMUX_TYPE s_etag_mux = portMUX_INITIALIZER_UNLOCKED;

static void etag_get(char *out, size_t out_len)
{
    portENTER_CRITICAL(&s_etag_mux);
    strlcpy(out, s_etag, out_len);
    portEXIT_CRITICAL(&s_etag_mux);
}

static void etag_set(const char *etag)
{
    portENTER_CRITICAL(&s_etag_mux);
    strlcpy(s_etag, etag ? etag : "", sizeof(s_etag));
    portEXIT_CRITICAL(&s_etag_mux);
}

/* One scenes GET at a time, and the ETag of a payload fetched but not taken
 * yet (the link task's slot, or a forced sync's own) is what the next one
 * sends: a deploy's forced sync on the render task and the link task's poll
 * both fetched the same 372 KB set after a push, and the second could not be
 * read (SenseCAP, 2026-11-15). Under s_etag_mux; cleared at the take. */
static SemaphoreHandle_t s_fetch_lock = NULL;
static char s_fetched_etag[ETAG_LEN] = "";

static void fetched_set(const char *etag)
{
    portENTER_CRITICAL(&s_etag_mux);
    strlcpy(s_fetched_etag, etag, sizeof(s_fetched_etag));
    portEXIT_CRITICAL(&s_etag_mux);
}

static void load_etag(void)
{
    size_t len = 0;
    char *etag = read_file(SCENES_ETAG_PATH, &len);
    etag_set(etag != NULL ? etag : "");
    free(etag);
}

static void save_etag_file(const char *etag)
{
    FILE *f = fopen(SCENES_ETAG_PATH, "wb");
    if (f != NULL) {
        fwrite(etag, 1, strlen(etag), f);
        fclose(f);
    }
}

static void save_etag(const char *etag)
{
    etag_set(etag);
    save_etag_file(etag ? etag : "");
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

/* The render task's map of the set, as many rows as the index has scenes
 * (slots_reserve): 128 of them are 17 KB, which is PSRAM's to hold. */
static scene_slot_t *s_slots = NULL;
static int s_slots_cap = 0;
static int s_slot_count = 0;
static char s_default_scene_id[SCENE_ID_LEN] = "";

static bool slots_reserve(int count)
{
    if (count <= s_slots_cap) return true;
    scene_slot_t *rows = fos_big_malloc(sizeof(*rows) * (size_t)count);
    if (rows == NULL) rows = malloc(sizeof(*rows) * (size_t)count);
    if (rows == NULL) return false;
    free(s_slots);
    s_slots = rows;
    s_slots_cap = count;
    return true;
}

/* Room for the scenes of one set as the store's puts; the caller frees it. */
static fos_scene_store_put_t *puts_new(void)
{
    fos_scene_store_put_t *puts = fos_big_malloc(sizeof(*puts) * SCENES_SET_MAX);
    if (puts == NULL) puts = malloc(sizeof(*puts) * SCENES_SET_MAX);
    return puts;
}

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
                               fos_scene_store_put_t *out, int max_items)
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
                out[count].json = json + start;
                out[count].len = i + 1 - start;
                count++;
            }
            continue;
        }
    }
    return depth == 0 ? count : -1;
}

/* Whether /state holds a combined payload (SCENES_PATH), kept in step with
 * every write and unlink of it here, so the apply and every change stop
 * asking flash: a stat is a SPIFFS lookup by name, half a second on a 24 MB
 * partition. -1: not known, look once. A plain word, read from any task. */
static volatile int s_combined = -1;

static bool combined_stored(void)
{
    if (s_combined < 0) {
        struct stat st;
        s_combined = stat(SCENES_PATH, &st) == 0 ? 1 : 0;
    }
    return s_combined == 1;
}

static void combined_set(bool stored)
{
    s_combined = stored ? 1 : 0;
}

void fos_scenes_wipe_state(void)
{
    slot_cache_clear();
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
    fos_scene_store_forget();
    s_combined = -1;
    ESP_LOGI(TAG, "wipe: removed %d file(s) from /state", removed);
}

static void remove_slots(void)
{
    /* Every slot file there is; the store knows which (fos_scene_store.h). */
    slot_cache_clear();
    fos_scene_store_remove_slots();
}

/* A combined payload whose split ran out of room, by its length: the boots
 * after it load it whole without trying again. Each try writes slots until
 * the partition is full and spends its garbage collections getting there:
 * 40 s of every boot of a reTerminal E1002 holding a 389,616-byte set
 * (2026-11-10), on a battery every wake. The next payload stored clears it. */
#define SPLIT_NO_ROOM_NVS_KEY "split_noroom"
static bool s_split_out_of_room = false;

static uint32_t split_no_room_len(void)
{
    nvs_handle_t nvs;
    uint32_t len = 0;
    if (nvs_open("frameos", NVS_READONLY, &nvs) != ESP_OK) return 0;
    if (nvs_get_u32(nvs, SPLIT_NO_ROOM_NVS_KEY, &len) != ESP_OK) len = 0;
    nvs_close(nvs);
    return len;
}

static void set_split_no_room_len(uint32_t len)
{
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return;
    if (len != 0) {
        nvs_set_u32(nvs, SPLIT_NO_ROOM_NVS_KEY, len);
    } else {
        nvs_erase_key(nvs, SPLIT_NO_ROOM_NVS_KEY);
    }
    nvs_commit(nvs);
    nvs_close(nvs);
}

/* Split the combined payload, through the store a one-scene change uses.
 * The set from before goes first: its files are not this set's, and the room
 * they take is. Replaced one by one instead, the split held the combined
 * file, the new slots and the old ones at once: a 389,616-byte 20-scene push
 * over the same set ran out of room at the fifth scene on the reTerminal
 * E1002's 1 MB /state, every time (2026-11-10; tests/test_fos_spiffs_gc.c
 * replays it). On any failure the index is gone and the combined file stays,
 * so the caller loads that whole: a frame never loses its scenes to a failed
 * optimization. A payload that is not an array changes nothing. */
static esp_err_t split_puts_locked(const fos_scene_store_put_t *puts, int count, size_t len)
{
    if (count <= 0) {
        return ESP_ERR_INVALID_ARG;
    }
    fos_scene_store_remove_index();
    remove_slots();
    /* The producer declared the source when it stored the payload; the index
     * is written at apply time, so the value rode across in s_pending_source. */
    fos_scene_store_change_t change = {
        .puts = puts, .put_count = count, .replace_all = true,
        .source = scene_source_str(s_pending_source),
    };
    s_split_out_of_room = false;
    fos_scene_store_result_t result;
    fos_scene_store_err_t err = fos_scene_store_apply(&change, &result, NULL, NULL);
    if (err != FOS_SCENE_STORE_OK) {
        ESP_LOGW(TAG, "split failed: %s", fos_scene_store_err_str(err));
        /* Out of room, not any failure: a cJSON allocation that failed is
         * worth another try at the next boot (split_noroom). What it wrote is
         * no set's: the room goes back. */
        s_split_out_of_room = err == FOS_SCENE_STORE_ERR_NO_SPACE;
        remove_slots();
        return s_split_out_of_room ? ESP_ERR_NO_MEM : ESP_FAIL;
    }
    /* Only now is the combined file redundant. */
    unlink(SCENES_PATH);
    combined_set(false);
    ESP_LOGI(TAG, "split %d scene(s) into per-scene files (%u bytes total)",
             count, (unsigned)len);
    return ESP_OK;
}

static esp_err_t split_scenes_locked(const char *json, size_t len)
{
    fos_scene_store_put_t *puts = puts_new();
    if (puts == NULL) return ESP_FAIL;
    esp_err_t err = split_puts_locked(puts, scan_array_elements(json, len, puts, SCENES_SET_MAX), len);
    free(puts);
    return err;
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
    /* The store's reader: the index, or its copy when a power cut tore the
     * index while it was rewritten in place (fos_scene_store.h). */
    cJSON *index = fos_scene_store_read_index();
    if (index == NULL) return 0;
    {
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
    int listed = cJSON_GetArraySize(scenes);
    if (listed > SCENES_SET_MAX) listed = SCENES_SET_MAX;
    if (cJSON_IsArray(scenes) && slots_reserve(listed)) {
        const cJSON *entry = NULL;
        cJSON_ArrayForEach(entry, scenes) {
            if (s_slot_count >= listed) break;
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
    if (s_slot_count > 0) {
        /* The runtime now knows every scene by name without parsing one. */
        char *catalog = cJSON_PrintUnformatted(index);
        if (catalog != NULL) frameos_nim_set_scene_catalog(catalog);
        cJSON_free(catalog);
    }
    cJSON_Delete(index);
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
    if (s_store_changing) {
        log_scene_event("scenes:load", "skipped", "embedded", scene_id ? scene_id : "",
                        "store-changing", 0, 0, 0, ESP_ERR_INVALID_STATE);
        return NULL;
    }
    int slot = slot_for_scene(scene_id);
    if (slot < 0) {
        ESP_LOGW(TAG, "embedded scene %s is not in the payload", scene_id ? scene_id : "?");
        log_scene_event("scenes:load", "error", "embedded", scene_id ? scene_id : "",
                        "embedded-scene-missing", 0, 0, 0, ESP_ERR_NOT_FOUND);
        return NULL;
    }
    char path[SCENES_SLOT_PATH_LEN];
    slot_path(slot, path, sizeof(path));
    char *json = read_slot_file(slot, path, out_len);
    log_scene_event("scenes:load", json ? "ok" : "error", "embedded", scene_id,
                    json ? "embedded-scene-read" : "embedded-scene-unreadable",
                    json ? *out_len : 0, json ? 1 : 0, 0, json ? ESP_OK : ESP_FAIL);
    return json;
}

/* A scene's file again, for the runtime to read an app's files from when an
 * interpreter starts (the parsed scene keeps none, docs/esp32-memory.md):
 * fos_scenes_read_scene_json without its log lines, which would be one a JS
 * app started. On the render task, from the slot cache when it has it. */
char *fos_scenes_read_scene_file(const char *scene_id, size_t *out_len)
{
    if (s_store_changing) return NULL;
    int slot = slot_for_scene(scene_id);
    if (slot < 0) return NULL;
    char path[SCENES_SLOT_PATH_LEN];
    slot_path(slot, path, sizeof(path));
    return read_slot_file(slot, path, out_len);
}

static bool load_scene_slot(int slot, const char *scene_id, const char *origin)
{
    if (s_store_changing) return false; /* the apply after it loads the new set */
    char path[SCENES_SLOT_PATH_LEN];
    slot_path(slot, path, sizeof(path));
    size_t len = 0;
    char *json = read_slot_file(slot, path, &len);
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

    fos_boot_scene_t scenes[SCENES_SET_MAX];
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

/* `count` scenes, each read where it lies by the runtime (frameos_nim_load_scenes):
 * never a copy of the whole set (a 378 KB set aborted the reTerminal E1004 out
 * of memory with 1.5 MB free in 300 KB blocks, 2026-11-16). `len`: the set's. */
static bool load_into_nim(const char *const *scenes, const size_t *lens, int count, size_t len,
                          const char *origin)
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
    count = count > 0 ? frameos_nim_load_scenes(scenes, lens, count) : 0;
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
 * change for one of those is a change to what the resident scene draws. A
 * change always lands in a slot the index before it did not name (the old
 * files stay until the sweep), so a slot outside `before` is a changed scene. */
static bool resident_embeds_changed(const fos_scene_store_slots_t *before, const char *resident_path)
{
    char *json = NULL;
    bool found = false;
    for (int i = 0; i < s_slot_count && !found; i++) {
        if (fos_scene_store_slots_has(before, s_slots[i].slot)) continue;
        if (json == NULL) {
            size_t len = 0;
            json = read_file(resident_path, &len);
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
    char resident[SCENE_ID_LEN];
    snprintf(resident, sizeof(resident), "%s", s_resident_scene_id);
    int before_slot = slot_for_scene(resident);
    fos_scene_store_slots_t before = {{0}};
    for (int i = 0; i < s_slot_count; i++) fos_scene_store_slots_put(&before, s_slots[i].slot, true);

    /* Under the lock: a put swapping the index would otherwise be read as
     * no index at all. */
    store_lock();
    int count = load_scene_index();
    store_unlock();

    bool ok = count > 0;
    if (ok) {
        int resident_slot = slot_for_scene(resident);
        char path[SCENES_SLOT_PATH_LEN];
        slot_path(resident_slot, path, sizeof(path));
        if (resident_slot < 0 || resident_slot != before_slot || resident_embeds_changed(&before, path)) {
            s_scene_switched = true;
            fos_display_loading_begin(xTaskGetTickCount(), fos_config()->rotate);
            if (resident_slot >= 0) {
                ok = load_scene_slot(resident_slot, resident, "stored");
                if (!ok && !s_store_changing && before_slot >= 0 && before_slot != resident_slot) {
                    /* A scene the runtime refuses does not take the working
                     * one with it: the old file is still there until the
                     * sweep below. The apply still reports the failure. */
                    ESP_LOGW(TAG, "scene %s refused; going back to slot %d", resident, before_slot);
                    store_lock();
                    fos_scene_store_repoint(resident, before_slot);
                    fos_slot_cache_clear(&s_slot_cache);
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
        ESP_LOGW(TAG, "scene index unreadable");
    }
    if (count > 0) {
        store_lock();
        /* Not while another change waits for its own apply: s_slots still
         * names the slot that change replaced. Its apply sweeps. The files
         * are emptied by the store task: a write for every page they held,
         * 25 scenes replaced were seconds of this task before its render. */
        if (!s_patch_pending) {
            if (!store_sweep_behind()) fos_scene_store_sweep();
            fos_slot_cache_clear(&s_slot_cache);
        }
        store_unlock();
    }
    s_apply_ok = ok;
    s_apply_generation++;
    return ok;
}

bool fos_scenes_apply_pending(void)
{
    if (!s_pending || !s_mounted) return false;
    /* A store-first set is being written (s_store_changing): no scene loads
     * until it is on flash (load_scene_slot), and its write leaves this apply
     * pending again. Applied now, a patch stored just before it read that
     * "not now" as the runtime refusing the resident scene, pointed the scene
     * back at its previous file and kept it there: the reTerminal E1004 wore
     * the layout of a push four pushes old (`layout:missing` after every
     * desktop push, the hardware bench, 2026-11-16). */
    if (s_store_changing) return false;
    /* A combined payload stored since wins over a change made before it. */
    if (s_patch_pending && !combined_stored()) return apply_index_change();
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
    char *json = combined_stored() ? read_file(SCENES_PATH, &len) : NULL;
    if (json == NULL) {
        /* No combined file: either a previous apply already split it (the
         * normal steady state) or there is genuinely nothing stored. */
        ok = activate_from_index("stored");
        if (!ok) {
            ESP_LOGW(TAG, "no readable %s", SCENES_PATH);
            log_scene_event("scenes:load", "error", "stored", "", "read-failed",
                            0, 0, 0, ESP_ERR_NOT_FOUND);
        }
    } else if (split_no_room_len() != (uint32_t)len && split_scenes(json, len) == ESP_OK) {
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
        if (s_split_out_of_room) {
            s_split_out_of_room = false;
            set_split_no_room_len((uint32_t)len);
            ESP_LOGW(TAG, "%u-byte scene set: no room to split it beside itself; loaded whole until the next push",
                     (unsigned)len);
        }
        int slots_before = s_slot_count;
        s_slot_count = 0;
        /* More scenes than a store holds is refused, not cut. */
        /* Where each scene starts and how long it is: one block for both. */
        const char **starts = fos_big_malloc((sizeof(*starts) + sizeof(size_t)) * (SCENES_SET_MAX + 1));
        size_t *lens = (size_t *)(starts + SCENES_SET_MAX + 1);
        int count = starts ? fos_store_split_scenes(json, len, starts, lens, SCENES_SET_MAX + 1) : 0;
        ok = load_into_nim(starts, lens, count > SCENES_SET_MAX ? 0 : count, len, "stored");
        free(starts);
        free(json);
        json = NULL;
        if (ok) {
            fos_scene_store_remove_index();
        } else {
            unlink(SCENES_PATH);
            combined_set(false);
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
/* One aligned word, read without the lock: a stale value only delays a report. */
uint32_t fos_scenes_store_generation(void) { return fos_slot_cache_generation(&s_slot_cache); }
/* Set only beside s_pending, once /state is mounted, and cleared with it. */
bool fos_scenes_patch_pending(void) { return s_patch_pending; }

int fos_scenes_loaded(void) { return s_loaded; }
const char *fos_scenes_etag(void) { return s_etag; }

bool fos_scenes_stored(void)
{
    if (!s_mounted) return false;
    struct stat st;
    if (combined_stored() && stat(SCENES_PATH, &st) == 0 && st.st_size > 2) return true;
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
    char *buf = combined_stored() ? read_file(SCENES_PATH, out_len) : NULL;
    cJSON *index = buf ? NULL : fos_scene_store_read_index();
    const cJSON *scenes = cJSON_GetObjectItem(index, "scenes");
    size_t cap = 3; /* "[", "]" and the NUL */
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, scenes) {
        cap += (size_t)cJSON_GetObjectItem(entry, "bytes")->valueint + 1; /* + comma */
    }
    if (cJSON_GetArraySize(scenes) > 0) {
        buf = fos_big_malloc(cap);
        if (buf == NULL) buf = malloc(cap);
    }
    if (index != NULL && buf != NULL) {
        size_t used = 0;
        buf[used++] = '[';
        cJSON_ArrayForEach(entry, scenes) {
            char path[SCENES_SLOT_PATH_LEN];
            slot_path(fos_scene_store_entry_slot(entry), path, sizeof(path));
            size_t part_len = 0;
            char *part = read_file(path, &part_len);
            /* A comma, the scene, and room left for "]" and the NUL. */
            if (part == NULL || used + 1 + part_len + 2 > cap) {
                free(part);
                free(buf);
                buf = NULL;
                break;
            }
            if (used > 1) buf[used++] = ',';
            memcpy(buf + used, part, part_len);
            used += part_len;
            free(part);
        }
        if (buf != NULL) {
            buf[used++] = ']';
            buf[used] = '\0';
            if (out_len != NULL) *out_len = used;
        }
    }
    cJSON_Delete(index);
    store_unlock();
    return buf;
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

    /* A whole payload is being split, or was and waits for its apply: the
     * index this task holds names slots that are the new set's now. The
     * selection stays queued; the apply reads the new index first. */
    if (s_store_changing || (s_pending && !s_patch_pending)) return false;

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
    if (s_slot_count > 0 && frameos_nim_scene_running(scene_id)) {
        /* Running in a window of a desktop layout already (docs/scene-layouts.md
         * "Windows"): brought to the front, nothing read off flash. */
        if (!frameos_nim_set_scene(scene_id)) {
            ESP_LOGW(TAG, "scene selection failed: %s", scene_id);
            log_scene_event("scenes:select", "error", "queued", scene_id,
                            "apply-failed", 0, 0, 0, ESP_FAIL);
            fos_client_loading_end();
            return false;
        }
        snprintf(s_resident_scene_id, sizeof(s_resident_scene_id), "%s", scene_id);
    } else if (s_slot_count > 0) {
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
    fos_slot_cache_clear(&s_slot_cache);
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

/* The firmware from #709 kept a picture of each scene for the scene switcher
 * in /state (th-<hash>.bin). The switcher shows names only on an ESP32 now
 * (docs/scene-switcher.md), so those files go, once: listing the partition
 * takes seconds on a large one, and NVS remembers it was done. */
static void drop_old_scene_pictures(void)
{
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return;
    uint8_t done = 0;
    if (nvs_get_u8(nvs, "th_swept", &done) != ESP_OK || !done) {
        DIR *dir = opendir("/state");
        if (dir != NULL) {
            int removed = 0;
            struct dirent *entry;
            while ((entry = readdir(dir)) != NULL) {
                if (strncmp(entry->d_name, "th-", 3) != 0) continue;
                char path[sizeof("/state/") + sizeof(entry->d_name)];
                snprintf(path, sizeof(path), "/state/%s", entry->d_name);
                if (unlink(path) == 0) removed++;
            }
            closedir(dir);
            if (removed > 0) ESP_LOGI(TAG, "removed %d old scene picture(s) from /state", removed);
        }
        nvs_set_u8(nvs, "th_swept", 1);
        nvs_commit(nvs);
    }
    nvs_close(nvs);
}

static void store_pace_hook(void);

/* Between two committed steps of a whole set stored as changes (each leaves a
 * whole set on flash): the lock goes for a moment, so a render waiting to read
 * a scene file (a layout, read by id on every pass) reads one. Held across a
 * whole set, 23 scenes rewritten on the reTerminal E1003's 24 MB /state held
 * its render task 3.5 minutes (2026-11-10). The lock is taken once by every
 * caller of fos_scene_store_apply_set, so one give lets it go. */
static void store_between_hook(void)
{
    store_unlock();
    vTaskDelay(1);
    store_lock();
}

esp_err_t fos_scenes_init(void)
{
    if (s_scene_file_lock == NULL) {
        s_scene_file_lock = xSemaphoreCreateRecursiveMutex();
        s_fetch_lock = xSemaphoreCreateMutex();
    }
    fos_scene_store_hooks_t store_hooks = {
        .make_room = make_room, .big_alloc = fos_big_malloc, .pace = store_pace_hook,
        .between = store_between_hook, .has_room = store_has_room,
    };
    fos_scene_store_set_hooks(&store_hooks);
    /* Before the mount: a frame whose /state failed still holds its bundled
     * scenes, and a dispatch node switches between those too. */
    frameos_nim_set_scene_select_hook(select_scene_from_runtime);
    esp_err_t err = mount_state();
    if (err != ESP_OK) return err;
    drop_old_scene_pictures();
    /* A power cut inside the store's remove + rename of the index, and the
     * files a change left for a sweep that never came. Under the lock: the
     * sweep lets it go after each file (store_between_hook). */
    if (fos_scene_store_recover_index()) ESP_LOGW(TAG, "scene index recovered");
    store_lock();
    fos_scene_store_sweep();
    store_unlock();
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
    bool combined = stat(SCENES_PATH, &st) == 0;
    combined_set(combined);
    if (combined && st.st_size > 2) {
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

static esp_err_t store_set_as_changes_locked(const char *json, size_t len, fos_scenes_source_t source);
/* What the last set stored as changes wrote, for its log line. */
static char s_set_summary[64];

esp_err_t fos_scenes_set_json_from(const char *json, size_t len,
                                   fos_scenes_source_t source)
{
    const char *origin = scene_source_str((int)source);
    s_last_error[0] = '\0';
    if (json == NULL || len == 0 || len > SCENES_HELD_MAX_BYTES) {
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
    /* "Updating" on the glass until the apply on the render task has loaded
     * it: flash writes the whole way (fos_lcd_st7701s_updating_begin). */
    fos_display_updating_begin();
    s_store_changing = true; /* before the lock: the render task looks first */
    store_lock();
    /* On a per-scene store, as changes to it, one scene at a time: nothing
     * to split after, and the apply reads the new index. */
    err = store_set_as_changes_locked(json, len, source);
    if (err == ESP_OK) {
        s_last_error[0] = '\0';
        if (split_no_room_len() != 0) set_split_no_room_len(0);
        save_etag("local");
        s_pending_source = (int)source;
        persist_scene_source((int)source);
        s_payload_stored_since_boot = true;
        s_pending = true;
        s_store_changing = false;
        store_unlock();
        fos_client_render_now();
        log_scene_event("event:uploadScenes", "stored", origin, "", s_set_summary, len, 0, 0, ESP_OK);
        return ESP_OK;
    }
    if (err != ESP_ERR_NOT_FOUND) {
        /* Some of the set may be on flash, every scene in it whole: the
         * apply loads what is there, and the producer sends the set again. */
        s_pending = true;
        s_store_changing = false;
        store_unlock();
        fos_client_render_now();
        log_scene_event("event:uploadScenes", "error", origin, "",
                        s_last_error[0] ? s_last_error : "store-failed", len, 0, 0, err);
        return err;
    }
    err = write_file_replace(SCENES_PATH, SCENES_TMP_PATH, json, len);
    if (err == ESP_OK) combined_set(true);
    if (err != ESP_OK) {
        s_store_changing = false;
        store_unlock();
        fos_display_updating_end(false);
        log_scene_event("event:uploadScenes", "error", origin, "",
                        s_last_error[0] ? s_last_error : "store-failed",
                        len, 0, 0, err);
        return err;
    }
    s_last_error[0] = '\0';
    if (split_no_room_len() != 0) set_split_no_room_len(0);
    /* "local" etag for cloud pushes too: it means "not the backend's payload,
     * do not clobber on the next backend sync pass" (see fos_scenes_sync). */
    save_etag("local");
    /* Recorded only after the payload is on flash, so a failed store cannot
     * relabel whatever is still resident. */
    s_pending_source = (int)source;
    persist_scene_source((int)source);
    s_payload_stored_since_boot = true;
    store_unlock();
    /* Split by the store task (store_split_stored), which then marks it
     * pending; s_store_changing stays up until it has. Without the task, here. */
    if (!store_split_behind()) store_split_stored();
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

/* By fos_scene_store_err_t: a refused change is the caller's (HTTP 400), a
 * missing scene a 404, no room the cloud's `no_room`. */
static const esp_err_t STORE_ERR_TO_ESP[] = {
    ESP_OK, ESP_ERR_INVALID_ARG, ESP_ERR_NOT_FOUND, ESP_ERR_NO_MEM, ESP_ERR_NO_MEM,
    ESP_FAIL, ESP_ERR_NO_MEM, ESP_ERR_INVALID_ARG, ESP_ERR_INVALID_ARG,
};
_Static_assert(sizeof(STORE_ERR_TO_ESP) / sizeof(STORE_ERR_TO_ESP[0]) == FOS_SCENE_STORE_ERR_MISSING_SCENE + 1,
               "one esp_err_t per store error");

/* A one-scene change is made on the per-scene store. A combined payload not
 * yet split is split here (a frame that last synced from a backend holds one
 * until its next boot), unless the render task is about to apply it. */
static esp_err_t ensure_split_locked(void)
{
    /* A whole payload stored since boot and split already, waiting for the
     * render task's apply: a change now would be applied as a patch to an
     * index the runtime has not loaded, and the payload's own apply skipped. */
    if (s_pending && s_payload_stored_since_boot && !s_patch_pending) {
        set_scene_simple_error("a scene upload is waiting to be applied, try again", 0);
        return ESP_ERR_INVALID_STATE;
    }
    struct stat st;
    if (!combined_stored() || stat(SCENES_PATH, &st) != 0 || st.st_size <= 2) return ESP_OK;
    if (s_pending) {
        set_scene_simple_error("a scene upload is waiting to be applied, try again", 0);
        return ESP_ERR_INVALID_STATE;
    }
    size_t len = 0;
    char *json = read_file(SCENES_PATH, &len);
    esp_err_t err = json ? split_scenes_locked(json, len) : ESP_FAIL;
    free(json);
    if (err != ESP_OK) {
        set_scene_simple_error("the stored scenes cannot be split per scene, upload them all", 0);
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

/* A whole set stored as changes to the per-scene store, one scene at a time
 * (fos_scene_store_apply_set): the scenes stored already are kept, and /state
 * never holds more than the stored set and one scene. Written whole beside
 * the set it replaced, a 415 KB set did not fit the reTerminal E1002's 1 MB
 * /state (ENOSPC, 2026-11-10), and a push that changed one scene of twenty
 * wrote all twenty. ESP_ERR_NOT_FOUND, nothing written, when there is no
 * per-scene store to change (a first set, or a whole payload not split yet):
 * the caller stores the set whole. Under the store lock. */
static esp_err_t store_puts_as_changes_locked(const fos_scene_store_put_t *puts, int count, size_t len,
                                              fos_scenes_source_t source)
{
    if (combined_stored() || count <= 0) return ESP_ERR_NOT_FOUND;
    fos_scene_store_set_result_t result;
    fos_scene_store_err_t err = fos_scene_store_apply_set(puts, count, scene_source_str((int)source), &result,
                                                          forget_dropped_scene, NULL);
    fos_slot_cache_clear(&s_slot_cache);
    if (err == FOS_SCENE_STORE_ERR_NOT_FOUND) return ESP_ERR_NOT_FOUND;
    if (err != FOS_SCENE_STORE_OK) {
        set_scene_simple_error(fos_scene_store_err_str(err), len);
        return STORE_ERR_TO_ESP[err];
    }
    snprintf(s_set_summary, sizeof(s_set_summary), "as-changes: %d written%s, %d kept, %d dropped", result.written,
             result.at_once ? " at once" : "", result.kept, result.dropped);
    ESP_LOGI(TAG, "%d-scene set stored %s (%u bytes)", result.scene_count, s_set_summary,
             (unsigned)result.written_bytes);
    return ESP_OK;
}

static esp_err_t store_set_as_changes_locked(const char *json, size_t len, fos_scenes_source_t source)
{
    fos_scene_store_put_t *puts = puts_new();
    if (puts == NULL) return ESP_ERR_NO_MEM;
    esp_err_t err = store_puts_as_changes_locked(puts, scan_array_elements(json, len, puts, SCENES_SET_MAX), len, source);
    free(puts);
    return err;
}

/* A change somebody waits to see (it activates a scene: "Push & activate", a
 * put with activate) is written as fast as flash goes, not paced around
 * renders: the panel is about to show it, and a 30 KB scene paced behind an
 * e-paper render waited up to half a second for each 2 KB. Set under the store
 * lock by the one writer holding it (store_pace_hook reads it). */
static volatile bool s_store_urgent = false;

/* How long a one-scene change waits for a backend set the store task is
 * writing; past it the change is refused (a backend's patch: the whole set
 * next pass). As long as a spooled set waits (SPOOL_STORE_WAIT_MS). */
#define CHANGE_STORE_WAIT_MS 90000

static esp_err_t apply_store_change(fos_scene_store_change_t *change, fos_scenes_source_t source,
                                    const char *etag, const char *event, bool urgent,
                                    fos_scene_store_result_t *result)
{
    memset(result, 0, sizeof(*result));
    s_last_error[0] = '\0';
    /* A backend set the runtime took whole is written by the store task as
     * changes against the index on flash, after its etag is already the one
     * a patch is read against. A change applied first was undone by that
     * write: the Code editor, put right after the frame's own scenes went
     * back, came out "4 written at once, 0 kept, 1 dropped", and every sync
     * after it was a 304 (the reTerminal E1002, the hardware bench,
     * 2026-11-20). The set goes on flash first, then the change on top. */
    if (!backend_set_written(CHANGE_STORE_WAIT_MS)) {
        set_scene_simple_error("store-busy", result->put_bytes);
        log_scene_event(event, "error", scene_source_str((int)source), "", s_last_error, 0, 0, 0,
                        ESP_ERR_TIMEOUT);
        return ESP_ERR_TIMEOUT;
    }
    /* A local edit leaves the set whose it was: scenes the cloud pushed stay
     * fenced off the LAN (fos_cloud.c) however one of them was edited. */
    int effective = source == FOS_SCENES_SOURCE_LOCAL ? (s_pending ? s_pending_source : s_source) : (int)source;
    change->source = scene_source_str(effective);
    esp_err_t err = mount_state();
    if (err == ESP_OK) {
        store_lock();
        s_store_urgent = urgent; /* the split first, if one is owed: it is waited for too */
        err = ensure_split_locked();
        if (err == ESP_OK) {
            fos_scene_store_err_t store_err = fos_scene_store_apply(change, result, forget_dropped_scene, NULL);
            /* The slots it wrote, and the ones a sweep may give to the next put. */
            fos_slot_cache_clear(&s_slot_cache);
            err = STORE_ERR_TO_ESP[store_err];
            if (err != ESP_OK) set_scene_simple_error(fos_scene_store_err_str(store_err), result->put_bytes);
        }
        if (err == ESP_OK) {
            /* Inside the lock: the render task's sweep must see the change
             * coming before it treats a slot the old index named as unused. */
            s_patch_pending = true;
            s_pending = true;
        }
        s_store_urgent = false;
        store_unlock();
    }
    if (err == ESP_OK) {
        save_etag(etag ? etag : "local");
        if (source == FOS_SCENES_SOURCE_LOCAL && effective == FOS_SCENES_SOURCE_CLOUD) {
            /* The cloud's checksum no longer describes what the frame holds. */
            fos_cloud_forget_applied_scenes();
        }
        s_pending_source = effective;
        persist_scene_source(effective);
        fos_client_wake_for_events();
    }
    log_scene_event(event, err == ESP_OK ? "stored" : "error", scene_source_str((int)source),
                    result->first_put_id, err == ESP_OK ? "pending-apply" : s_last_error,
                    result->put_bytes, result->scene_count, 0, err);
    return err;
}

esp_err_t fos_scenes_put(const char *json, size_t len, fos_scenes_source_t source, bool urgent,
                         char *out_id, size_t out_id_len)
{
    /* An empty or broken scene is the store's to refuse: it says why. */
    fos_scene_store_put_t put = {.json = json, .len = len};
    fos_scene_store_change_t change = {.puts = &put, .put_count = 1};
    fos_scene_store_result_t result;
    esp_err_t err = apply_store_change(&change, source, NULL, "scenes:put", urgent, &result);
    snprintf(out_id, out_id_len, "%s", result.first_put_id);
    return err;
}

esp_err_t fos_scenes_delete(const char *scene_id, fos_scenes_source_t source)
{
    fos_scene_store_change_t change = {.remove_id = scene_id};
    fos_scene_store_result_t result;
    return apply_store_change(&change, source, NULL, "scenes:delete", false, &result);
}

esp_err_t fos_scenes_apply_patch(const cJSON *put, const cJSON *order,
                                 fos_scenes_source_t source, const char *etag, bool urgent)
{
    if (!cJSON_IsArray(order)) return ESP_ERR_INVALID_ARG;
    /* The message's own tree: each scene is printed for its file by the
     * store, one at a time, next to the message it arrived in. */
    fos_scene_store_change_t change = {.put_items = cJSON_IsArray(put) ? put : NULL, .order = order};
    fos_scene_store_result_t result;
    return apply_store_change(&change, source, etag, "scenes:patch", urgent, &result);
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

/* What a file costs /state, in the partition's own units: the pages it takes,
 * data and index, at the data a page carries (fos_spiffs_footprint.h), so a
 * scene's size, the scenes' sum and stateUsedBytes add up. */
static size_t state_footprint(size_t bytes)
{
    return fos_spiffs_footprint(bytes, CONFIG_SPIFFS_PAGE_SIZE, CONFIG_SPIFFS_OBJ_NAME_LEN,
                                CONFIG_SPIFFS_META_LENGTH);
}

/* Each scene's footprint by id, worked out once per change of the store (the
 * slot cache's generation moves with every one): the report goes out with
 * every check-in and must not read the store each time. Under the store lock. */
static uint32_t s_sizes_generation = 0;
static cJSON *s_scene_sizes = NULL; /* {"<id>": bytes} */
static size_t s_scenes_footprint = 0;
static int s_scene_sizes_count = 0;

static void scene_sizes_refresh_locked(void)
{
    uint32_t generation = fos_slot_cache_generation(&s_slot_cache);
    if (s_scene_sizes != NULL && generation == s_sizes_generation) return;
    cJSON_Delete(s_scene_sizes);
    s_scene_sizes = cJSON_CreateObject();
    s_scenes_footprint = 0;
    s_scene_sizes_count = 0;
    s_sizes_generation = generation;
    if (s_scene_sizes == NULL) return;
    struct stat st;
    cJSON *index = fos_scene_store_read_index();
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(index, "scenes")) {
        const cJSON *id = cJSON_GetObjectItem(entry, "id");
        const cJSON *bytes = cJSON_GetObjectItem(entry, "bytes");
        if (!cJSON_IsString(id) || !cJSON_IsNumber(bytes)) continue;
        size_t footprint = state_footprint((size_t)bytes->valuedouble);
        cJSON_AddNumberToObject(s_scene_sizes, id->valuestring, (double)footprint);
        s_scenes_footprint += footprint;
        s_scene_sizes_count++;
    }
    cJSON_Delete(index);
    if (s_scene_sizes_count > 0) {
        /* The index and its copy beside it (scene-index.tmp, the same bytes:
         * fos_scene_store.h). */
        if (stat(SCENES_INDEX_PATH, &st) == 0) s_scenes_footprint += 2 * state_footprint((size_t)st.st_size);
        return;
    }
    if (!combined_stored() || stat(SCENES_PATH, &st) != 0 || st.st_size <= 2) return;
    /* Not split (yet): the combined file is what /state holds, and each scene
     * is reported at what its own file will take once it is. */
    s_scenes_footprint = state_footprint((size_t)st.st_size);
    size_t len = 0;
    char *json = read_file(SCENES_PATH, &len);
    fos_scene_store_put_t *items = puts_new();
    int count = json != NULL && items != NULL ? scan_array_elements(json, len, items, SCENES_SET_MAX) : -1;
    for (int i = 0; i < count; i++) {
        cJSON *scene = cJSON_ParseWithLength(items[i].json, items[i].len);
        const cJSON *id = cJSON_GetObjectItem(scene, "id");
        if (cJSON_IsString(id) && id->valuestring != NULL) {
            cJSON_AddNumberToObject(s_scene_sizes, id->valuestring, (double)state_footprint(items[i].len));
            s_scene_sizes_count++;
        }
        cJSON_Delete(scene);
    }
    free(items);
    free(json);
}

void fos_scenes_add_storage_json(cJSON *report)
{
    if (report == NULL || !s_mounted) return;
    size_t total = 0, used = 0;
    state_usage(&total, &used);
    store_lock();
    scene_sizes_refresh_locked();
    cJSON *sizes = s_scene_sizes != NULL ? cJSON_Duplicate(s_scene_sizes, true) : NULL;
    size_t scenes_bytes = s_scenes_footprint;
    int count = s_scene_sizes_count > 0 ? s_scene_sizes_count : s_loaded;
    store_unlock();
    cJSON_AddNumberToObject(report, "stateTotalBytes", (double)total);
    cJSON_AddNumberToObject(report, "stateUsedBytes", (double)used);
    cJSON_AddNumberToObject(report, "scenesBytes", (double)scenes_bytes);
    cJSON_AddNumberToObject(report, "sceneCount", count);
    if (sizes != NULL) cJSON_AddItemToObject(report, "sceneBytes", sizes);
}

cJSON *fos_scenes_read_index(void)
{
    if (mount_state() != ESP_OK) return NULL;
    store_lock();
    cJSON *tree = fos_scene_store_read_index();
    store_unlock();
    return tree;
}

bool fos_scenes_showing(const char *scene_id)
{
    return scene_id != NULL && scene_id[0] && !s_built_in_shown && strcmp(s_resident_scene_id, scene_id) == 0;
}

char *fos_scenes_list_json(void)
{
    cJSON *tree = fos_scenes_read_index();
    if (tree == NULL) tree = cJSON_CreateObject(); /* not split: the storage alone */
    fos_scenes_add_storage_json(cJSON_AddObjectToObject(tree, "storage"));
    char *json = cJSON_PrintUnformatted(tree);
    cJSON_Delete(tree);
    return json;
}

/* A backend set read in pieces (fos_scene_pieces.h) as the store's puts,
 * into the caller's array: the render task's patch and the store task's
 * write each have their own. */
static fos_scene_store_put_t *set_puts(const fos_scene_set_t *set, fos_scene_store_put_t *puts)
{
    for (int i = 0; i < set->count; i++) puts[i] = (fos_scene_store_put_t){.json = set->scenes[i], .len = set->lens[i]};
    return puts;
}

static void scene_set_free(fos_scene_set_t *set)
{
    if (set == NULL) return;
    if (set->staged != 0) {
        /* Read straight into the store and not committed (a commit spends
         * the id, and this is nothing then): its files go back. */
        store_lock();
        fos_scene_store_stage_drop(set->staged);
        store_unlock();
    }
    for (int i = 0; i < set->count; i++) free(set->scenes[i]);
    free(set->rest);
    free(set);
}

/* A backend's answer to `?patch=1` when it knows what this frame holds:
 * {"patch":true,"base":"<etag>","order":[...],"put":[...]}. Anything not
 * against the set this frame holds forces the whole payload next pass.
 *
 * Read in pieces: the scenes of `put` each in a block of its own, and `rest`
 * the patch without them (`"put":[]`), a few KB parsed as a tree. As one
 * tree, a 365 KB patch (fifteen scenes, each with a new desktop layout) did
 * not fit beside the panel's render on the reTerminal E1004, and as one
 * block it did not fit either (patch-refused, no-memory: the hardware bench,
 * 2026-11-16). */
static esp_err_t apply_backend_patch(const fos_scene_set_t *set, const char *etag)
{
    if (!fos_json_depth_ok(set->rest, set->rest_len, FOS_JSON_MAX_DEPTH)) return ESP_ERR_INVALID_ARG;
    cJSON *patch = cJSON_ParseWithLength(set->rest, set->rest_len);
    const cJSON *base = cJSON_GetObjectItem(patch, "base");
    const cJSON *order = cJSON_GetObjectItem(patch, "order");
    esp_err_t err;
    char held[ETAG_LEN];
    etag_get(held, sizeof(held));
    if (!cJSON_IsString(base) || base->valuestring == NULL || strcmp(base->valuestring, held) != 0) {
        s_sync_requested = true;
        err = patch == NULL ? ESP_ERR_NO_MEM : ESP_ERR_INVALID_STATE;
    } else if (!cJSON_IsArray(order)) {
        s_sync_requested = true;
        err = ESP_ERR_INVALID_ARG;
    } else {
        /* On the render task, which never paces itself. The scenes are the
         * blocks they were read into, or (`staged`) in the store already. */
        fos_scene_store_put_t *puts = set->staged ? NULL : puts_new();
        fos_scene_store_change_t change = {.order = order, .staged = set->staged};
        if (puts != NULL) {
            change.puts = set_puts(set, puts);
            change.put_count = set->count;
        }
        fos_scene_store_result_t result;
        err = puts != NULL || set->staged
                  ? apply_store_change(&change, FOS_SCENES_SOURCE_BACKEND, etag, "scenes:patch", false, &result)
                  : ESP_ERR_NO_MEM;
        free(puts);
        if (err != ESP_OK) s_sync_requested = true;
    }
    cJSON_Delete(patch);
    return err;
}

/* ------------------------------------------- a backend set, into the store
 *
 * A backend's answer too big to hold (over SCENES_HELD_MAX_BYTES, or one
 * there was no block for) is not held: fos_scene_pieces_read_to hands each
 * scene's bytes to this sink as they come off the socket, and the store
 * writes them to a slot file no index names (fos_scene_store_stage_*). What
 * the frame shows and what /state's index names are as they were until the
 * render task takes the set (fos_scenes_take_backend_payload) and switches
 * the index in one change. The limit on a set is then the room on /state and
 * the scenes an index holds, not a block of memory: the reTerminal Sticky
 * refused 529 KB with 24 MB of /state (`payload-too-large`), and the E1004 a
 * 465 KB set whose largest scene found no block in PSRAM split up by its
 * 13.3" panel's render (`no-memory`; the hardware bench, 2026-11-18).
 *
 * The lock is taken for each call, never across them: a render reads its
 * scene file between two writes, which are paced like every write off the
 * render task (store_pace_hook). */
typedef struct {
    unsigned int id;           /* the store's staging; 0 before the first scene */
    fos_scene_store_err_t err; /* why the store refused, when it did */
    bool busy;                 /* another payload is being stored or waits for its apply */
    bool updating;             /* "Updating" is on the glass */
    int scenes;                /* written or found stored, for the `scenes:toStore` line */
} spool_t;

/* Under the store lock. */
static fos_http_body_err_t spool_answer(spool_t *spool, fos_scene_store_err_t err)
{
    spool->err = err;
    /* The staging is gone: another set was stored meanwhile (a producer's
     * whole payload, a set the store task writes). Not this answer's fault,
     * and not to be remembered against it. */
    if (err != FOS_SCENE_STORE_OK && spool->id != 0 && !fos_scene_store_staging(spool->id)) spool->busy = true;
    return err == FOS_SCENE_STORE_OK          ? FOS_HTTP_BODY_OK
           : err == FOS_SCENE_STORE_ERR_NO_MEMORY ? FOS_HTTP_BODY_NO_MEMORY
                                                  : FOS_HTTP_BODY_INVALID;
}

/* How long the first scene of an answer waits for the store task to finish
 * the set it is writing (one taken whole before this one): the store has
 * one staging at a time, and a 524 KB set written behind a render took 20 s
 * on the reTerminal Sticky. The answer waits in the socket meanwhile. */
#define SPOOL_STORE_WAIT_MS 90000

static fos_http_body_err_t spool_begin(void *ctx)
{
    spool_t *spool = ctx;
    fos_scene_store_err_t err = FOS_SCENE_STORE_OK;
    /* The store task's own staging first: begun now, this one would end it
     * and that set would never reach flash. On the render task (a sync
     * somebody asked for) the store task is told it is waited for, as when
     * that task waits for the lock: its pace waits out an input hold only
     * the render task releases. */
    if (spool->id == 0) {
        bool render = fos_client_on_render_task();
        if (render) s_render_waits_for_store = true;
        fos_scenes_store_wait(SPOOL_STORE_WAIT_MS);
        if (render) s_render_waits_for_store = false;
    }
    store_lock();
    if (spool->id == 0) {
        /* The first scene. Not beside a whole payload a producer is storing
         * or one that waits for its apply: the set this one is read against
         * is about to be another. */
        bool combined = combined_stored();
        if (s_store_changing || fos_scenes_store_busy() || (s_pending && !s_patch_pending) ||
            ensure_split_locked() != ESP_OK) {
            spool->busy = true;
            store_unlock();
            return FOS_HTTP_BODY_INVALID;
        }
        if (combined) {
            /* A combined payload was split for it: the render task reads the
             * index that made, as after any change. */
            s_patch_pending = true;
            s_pending = true;
        }
        spool->id = fos_scene_store_stage_open();
        if (spool->id == 0) err = FOS_SCENE_STORE_ERR_NO_MEMORY;
    }
    if (err == FOS_SCENE_STORE_OK && !spool->updating) {
        /* Flash writes from here until the answer is read: "Updating" on an
         * LCD, whose refill starves while they run. */
        spool->updating = true;
        fos_display_updating_begin();
    }
    if (err == FOS_SCENE_STORE_OK) err = fos_scene_store_stage_begin(spool->id);
    fos_http_body_err_t answer = spool_answer(spool, err);
    store_unlock();
    return answer;
}

static fos_http_body_err_t spool_bytes(void *ctx, const char *bytes, size_t len)
{
    spool_t *spool = ctx;
    store_lock();
    fos_scene_store_err_t err = fos_scene_store_stage_write(spool->id, bytes, len);
    fos_http_body_err_t answer = spool_answer(spool, err);
    store_unlock();
    return answer;
}

static fos_http_body_err_t spool_end(void *ctx)
{
    spool_t *spool = ctx;
    store_lock();
    fos_scene_store_err_t err = fos_scene_store_stage_end(spool->id, NULL);
    if (err == FOS_SCENE_STORE_OK) spool->scenes++;
    fos_http_body_err_t answer = spool_answer(spool, err);
    store_unlock();
    return answer;
}

/* One line for an answer read into the store: how much and how long, in the
 * words of every scene line (`detail` is the time). Where the time went
 * (opening, writing and closing each file) was a line of its own with three
 * timers behind it, 400 bytes of flash for a number read once: a slot file
 * that does not exist yet is a second to make on a 24 MB /state, and the
 * rest is the bytes. */
static void log_spool(const spool_t *spool, size_t bytes, int64_t took_us, bool ok)
{
    char took[16];
    snprintf(took, sizeof(took), "%d ms", (int)(took_us / 1000));
    log_scene_event("scenes:toStore", ok ? "ok" : "error", "backend", "", took, bytes, spool->scenes, 200, ESP_OK);
}

/* What /state takes beside what it holds, less the index written twice and
 * a margin, is the most a set read into the store may be. */
#define SPOOL_ROOM_MARGIN (128 * 1024)

/* The ETag of an answer the store could not take (no room on /state, more
 * scenes than an index holds, a scene that is not one): said once, and not
 * read again until it changes, the frame restarts or, where room was what it
 * wanted, /state has that much. A sync somebody asks for does not try it
 * again: a backend asks with every commands answer while the frame is
 * behind, and megabytes would come down every ten seconds to be refused the
 * same way. Under s_etag_mux. */
static char s_refused_etag[ETAG_LEN] = "";
static size_t s_refused_room = 0; /* the room it wanted; 0: room was not it */

static void refused_set(const char *etag, size_t room_wanted)
{
    portENTER_CRITICAL(&s_etag_mux);
    strlcpy(s_refused_etag, etag ? etag : "", sizeof(s_refused_etag));
    s_refused_room = room_wanted;
    portEXIT_CRITICAL(&s_etag_mux);
}

/* ------------------------------------------------------------- backend */

/* A backend payload the render task took into the runtime goes to flash on a
 * task of its own: the combined file, then the etag and the source (only a
 * payload on flash may claim them), then the previous payload's index. The
 * write of a 337 KB set was most of the 8 s a backend sync held the render
 * task on a reTerminal E1003, with every tap waiting (2026-11-10). The newest
 * payload waits as the next and one superseded before it was written is
 * dropped; a deep sleep and a restart wait for the writes
 * (fos_scenes_store_wait, the shutdown handler). */
typedef struct {
    fos_scene_set_t *set; /* the job's own (scene_set_free); NULL: no job */
    char etag[ETAG_LEN];
    /* The runtime did not take it whole (store_first): written as fast as
     * flash goes, and applied from flash once it is, one scene at a time. */
    bool reload;
} store_job_t;

#define STORE_TASK_STACK 6144
static portMUX_TYPE s_store_mux = portMUX_INITIALIZER_UNLOCKED;
static store_job_t s_store_next;   /* under s_store_mux */
/* The store task is writing a backend set (store_backend_payload); under
 * s_store_mux. With s_store_next.set, what a one-scene change waits for. */
static bool s_store_writing_set = false;
/* A whole payload a producer stored waits to be split (store_split_stored);
 * under s_store_mux. */
static bool s_store_split_wanted = false;
/* The files the last change stopped naming wait to be emptied
 * (store_sweep_behind); under s_store_mux. */
static bool s_store_sweep_wanted = false;
static volatile bool s_store_busy; /* a job waits or runs; under s_store_mux */

/* Every erase and page program of a flash write turns the cache off, and both
 * cores wait it out: a render running beside the store task's 337 KB took
 * 5.6 s instead of 2, and the events behind it waited up to 6.9 s
 * (2026-11-10, the E1003). So the write goes in the time between: before
 * each 2 KB it waits while someone taps (the render task releases the input
 * hold within a minute of the last tap) and, up to half a second, while a
 * render runs (a scene that never stops rendering still gets stored). Never
 * while the render task waits for the store lock: it can release no hold
 * then, and every wait is one more for it (s_render_waits_for_store). */
#define STORE_PACE_RENDER_MAX_US (500 * 1000)

static TaskHandle_t s_store_task;

static void store_pace(void)
{
    int64_t render_until = esp_timer_get_time() + STORE_PACE_RENDER_MAX_US;
    for (;;) {
        if (s_render_waits_for_store) {
            return;
        } else if (fos_client_input_held()) {
            vTaskDelay(pdMS_TO_TICKS(50));
            render_until = esp_timer_get_time() + STORE_PACE_RENDER_MAX_US;
        } else if (fos_client_render_in_flight() && esp_timer_get_time() < render_until) {
            vTaskDelay(pdMS_TO_TICKS(10));
        } else {
            return;
        }
    }
}

/* The store module's pace hook: every write goes through it, and every writer
 * but the render task waits out renders and taps (the store task, and a
 * producer splitting the payload it stored); the render task never waits for
 * itself. An RGB LCD's write goes as fast as it can, behind "Updating".
 *
 * A set the runtime did not take whole (store_job_t `reload`) is not paced
 * either: the frame shows the set from before until it is on flash, so
 * nothing is gained by waiting (a paced 465 KB set took two and a half
 * minutes on the reTerminal E1004, 2026-11-16). Its own flag, not
 * s_store_urgent: the store lets go of the lock between scenes, and a writer
 * taking it then clears that one. */
static volatile bool s_store_job_urgent = false;

static void store_pace_hook(void)
{
    if (!s_store_urgent && !(s_store_job_urgent && xTaskGetCurrentTaskHandle() == s_store_task) &&
        !fos_client_on_render_task() && !fos_display_is_lcd()) {
        store_pace();
    }
}

static void store_backend_payload(const store_job_t *job)
{
    /* "Updating" on an LCD while flash is written (its refill starves while
     * the cache is off), and so as fast as it goes there: nobody sees the
     * scene behind it. On e-paper it is paced around renders and taps,
     * unless the runtime waits for it (`reload`). */
    if (job->reload) s_store_changing = true; /* before the lock: the render task looks first */
    fos_display_updating_begin();
    store_lock();
    s_store_job_urgent = job->reload;
    fos_slot_cache_clear(&s_slot_cache);
    /* Paced through the store's hook (store_pace_hook). On a per-scene store,
     * as changes to it: only the scenes that changed are written, one at a
     * time, and the index names the set the runtime runs. */
    const fos_scene_set_t *set = job->set;
    fos_scene_store_put_t *set_scenes = puts_new();
    const fos_scene_store_put_t *puts = set_scenes ? set_puts(set, set_scenes) : NULL;
    esp_err_t err = puts ? store_puts_as_changes_locked(puts, set->count, set->bytes, FOS_SCENES_SOURCE_BACKEND)
                         : ESP_ERR_NO_MEM;
    bool as_changes = err == ESP_OK;
    bool split = false;
    if (err == ESP_ERR_NOT_FOUND && set->bytes > FOS_SCENE_STORE_MAX_BYTES) {
        /* No per-scene store yet, and more than one file may be: straight
         * into its scenes' files, never a combined file nothing could read
         * back. */
        err = split_puts_locked(puts, set->count, set->bytes);
        split = err == ESP_OK;
        if (err == ESP_OK && split_no_room_len() != 0) set_split_no_room_len(0);
    } else if (err == ESP_ERR_NOT_FOUND) {
        /* The combined file, written from the scenes in hand. */
        err = store_write_err(fos_scene_store_write_set(SCENES_PATH, SCENES_TMP_PATH, puts, set->count), SCENES_PATH,
                              set->bytes);
        if (err == ESP_OK) combined_set(true);
        if (err == ESP_OK && split_no_room_len() != 0) set_split_no_room_len(0);
        if (err == ESP_OK && job->reload) {
            /* Split now, from the scenes in hand, so the apply loads one.
             * A split that fails leaves the combined file for the apply to
             * load whole, as a producer's does (store_split_stored). */
            split = split_puts_locked(puts, set->count, set->bytes) == ESP_OK;
            if (!split && s_split_out_of_room) {
                s_split_out_of_room = false;
                set_split_no_room_len((uint32_t)set->bytes);
            }
        }
    } else if (err == ESP_OK && split_no_room_len() != 0) {
        set_split_no_room_len(0);
    }
    free(set_scenes);
    s_store_job_urgent = false;
    bool reload = job->reload;
    if (reload) {
        /* A newer set waits to be written: it is the one to apply (the
         * runtime may hold it whole already), and this one is not. */
        portENTER_CRITICAL(&s_store_mux);
        if (s_store_next.set != NULL) {
            s_store_next.reload = true;
            reload = false;
        }
        portEXIT_CRITICAL(&s_store_mux);
    }
    if (reload) {
        /* What flash holds now (this set; some of it, each scene whole, when
         * the write failed part way; the set before when it failed first) is
         * loaded by the apply, which makes one scene resident and gives the
         * runtime the catalog. Left as it was, the runtime ran the set before
         * against a store holding this one: every scene start read flash for
         * the old set's layout and logged `layout:missing` until the next
         * push (the reTerminal E1004, the hardware bench, 2026-11-16). Inside
         * the lock, as a producer's stored set: a one-scene change waiting on
         * it must see the set waiting for its apply. */
        s_pending = true;
        if (err == ESP_OK) s_payload_stored_since_boot = true;
    }
    if (job->reload) s_store_changing = false;
    store_unlock();
    if (err == ESP_OK) {
        save_etag_file(job->etag);
        persist_scene_source(FOS_SCENES_SOURCE_BACKEND);
        /* Stored whole beside a runtime that took it whole: the per-scene
         * index the boot split wrote describes the PREVIOUS payload (the
         * render task stopped using it when it took this one); the next boot
         * splits this one again. Not the index a split just wrote. */
        if (!as_changes && !split && !job->reload) fos_scene_store_remove_index();
        log_scene_event("scenes:store", "ok", "backend", "",
                        as_changes ? s_set_summary : split ? "written, split" : "written",
                        set->bytes, 0, 0, ESP_OK);
    } else {
        log_scene_event("scenes:store", "error", "backend", "",
                        s_last_error[0] ? s_last_error : "store-failed", set->bytes, 0, 0, err);
    }
    if (reload) {
        /* The apply ends "Updating" (fos_scenes_apply_pending); the new set
         * renders now, not at the next timed pass. */
        fos_client_render_now();
    } else {
        fos_display_updating_end(false);
    }
    if (err == ESP_OK) return;
    /* The runtime runs the new set (or, store-first, the one before) and flash
     * holds the one before. Unless a newer payload is on its way, the next
     * poll sends the stored etag again: the backend answers with this set,
     * and it is written then. */
    portENTER_CRITICAL(&s_store_mux);
    bool newer = s_store_next.set != NULL;
    portEXIT_CRITICAL(&s_store_mux);
    if (!newer) load_etag();
}

/* The whole payload a producer stored (fos_scenes_set_json_from: a cloud
 * push, an HTTP or USB upload), split into its per-scene files here: not on
 * the producer's task (the cloud's is its WebSocket's, which must keep
 * answering) and not in the render task's apply, where a 389 KB set was
 * seconds of slot writes with no key or tap answered (the reTerminal E1002,
 * 2026-11-10). Paced like every write off the render task. Pending for the
 * apply once split, which reads the new index and loads one scene; the
 * cloud's scene_ack waits for that apply. A split that fails leaves the
 * combined file for the apply to load whole (split_noroom when it ran out of
 * room, so no boot tries again). */
static void store_split_stored(void)
{
    store_lock();
    size_t len = 0;
    char *json = read_file(SCENES_PATH, &len);
    if (json != NULL && split_scenes_locked(json, len) != ESP_OK && s_split_out_of_room) {
        s_split_out_of_room = false;
        set_split_no_room_len((uint32_t)len);
        ESP_LOGW(TAG, "%u-byte scene set: no room to split it beside itself; loaded whole until the next push",
                 (unsigned)len);
    }
    free(json);
    /* Inside the lock: a one-scene change waiting on it must see the payload
     * waiting for its apply (ensure_split_locked), not a store to patch. */
    s_pending = true;
    s_store_changing = false;
    store_unlock();
    /* The pass the producer asked for (the cloud's set_scenes renders at once)
     * ran while this split did, with nothing pending yet: on a frame that next
     * renders in an hour the payload waited that long and the cloud's
     * scene_ack timed out (the E1002, 2026-11-10). The new set renders now. */
    fos_client_render_now();
}

/* The files a change stopped naming, emptied for the next put: off the
 * render task, paced like every write here, the lock let go after each file.
 * Not while a change waits for its apply, or a set is being stored: the
 * render task's map still names the files that change replaced, and its
 * apply asks again. */
static void store_sweep(void)
{
    store_lock();
    if (!s_patch_pending && !s_store_changing) {
        fos_scene_store_sweep();
        fos_slot_cache_clear(&s_slot_cache);
    }
    store_unlock();
}

static void store_task(void *arg)
{
    (void)arg;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        for (;;) {
            portENTER_CRITICAL(&s_store_mux);
            store_job_t job = s_store_next;
            s_store_next = (store_job_t){0};
            s_store_writing_set = job.set != NULL;
            bool split = job.set == NULL && s_store_split_wanted;
            if (split) s_store_split_wanted = false;
            /* Last: a set or a split comes first, and leaves an apply that
             * asks for the sweep again. */
            bool sweep = job.set == NULL && !split && s_store_sweep_wanted;
            if (sweep) s_store_sweep_wanted = false;
            if (job.set == NULL && !split && !sweep) s_store_busy = false;
            portEXIT_CRITICAL(&s_store_mux);
            if (job.set != NULL) {
                store_backend_payload(&job);
                scene_set_free(job.set);
                portENTER_CRITICAL(&s_store_mux);
                s_store_writing_set = false;
                portEXIT_CRITICAL(&s_store_mux);
            } else if (split) {
                store_split_stored();
            } else if (sweep) {
                store_sweep();
            } else {
                break;
            }
        }
    }
}

static void store_shutdown(void)
{
    fos_scenes_store_wait(20000);
}

static bool store_task_ready(void)
{
    if (s_store_task != NULL) return true;
    if (xTaskCreatePinnedToCore(store_task, "fos_store", STORE_TASK_STACK, NULL, tskIDLE_PRIORITY + 2,
                                &s_store_task, tskNO_AFFINITY) != pdPASS) {
        s_store_task = NULL;
        return false;
    }
    esp_register_shutdown_handler(store_shutdown);
    return true;
}

/* The stored payload to the store task for its split; false when there is no
 * task (the caller splits). */
static bool store_wanted_behind(bool *wanted)
{
    if (!store_task_ready()) return false;
    portENTER_CRITICAL(&s_store_mux);
    *wanted = true;
    bool start = !s_store_busy;
    s_store_busy = true;
    portEXIT_CRITICAL(&s_store_mux);
    if (start) xTaskNotifyGive(s_store_task);
    return true;
}

static bool store_split_behind(void)
{
    return store_wanted_behind(&s_store_split_wanted);
}

/* The sweep to the store task; false when there is no task (the caller
 * sweeps). */
static bool store_sweep_behind(void)
{
    return store_wanted_behind(&s_store_sweep_wanted);
}

/* `set` to the store task, which frees it; false (and `set` still the
 * caller's) when there is no task. */
static bool store_behind(fos_scene_set_t *set, const char *etag, bool reload)
{
    if (!store_task_ready()) return false;
    portENTER_CRITICAL(&s_store_mux);
    fos_scene_set_t *dropped = s_store_next.set;
    s_store_next.set = set;
    /* A store-first set dropped for this one leaves its apply (and the
     * s_store_changing it raised) to this one. */
    s_store_next.reload = reload || (dropped != NULL && s_store_next.reload);
    strlcpy(s_store_next.etag, etag ? etag : "", sizeof(s_store_next.etag));
    bool start = !s_store_busy;
    s_store_busy = true;
    portEXIT_CRITICAL(&s_store_mux);
    scene_set_free(dropped);
    if (start) xTaskNotifyGive(s_store_task);
    return true;
}

bool fos_scenes_store_wait(uint32_t timeout_ms)
{
    if (s_store_task == NULL || xTaskGetCurrentTaskHandle() == s_store_task) return true;
    int64_t until = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    while (s_store_busy) {
        if (esp_timer_get_time() >= until) {
            ESP_LOGW(TAG, "scene store still writing after %u ms", (unsigned)timeout_ms);
            return false;
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    return true;
}

bool fos_scenes_store_busy(void)
{
    return s_store_busy;
}

static bool backend_set_waiting(void)
{
    portENTER_CRITICAL(&s_store_mux);
    bool waiting = s_store_next.set != NULL || s_store_writing_set;
    portEXIT_CRITICAL(&s_store_mux);
    return waiting;
}

/* Whether no backend set waits to be written, after waiting up to
 * `timeout_ms` for the one that does (apply_store_change). On the render
 * task the store task is told it is waited for, so its pace stops waiting
 * out renders and the input hold only this task releases. */
static bool backend_set_written(uint32_t timeout_ms)
{
    if (s_store_task == NULL || xTaskGetCurrentTaskHandle() == s_store_task || !backend_set_waiting()) return true;
    bool render = fos_client_on_render_task();
    if (render) s_render_waits_for_store = true;
    int64_t until = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    bool written = true;
    int64_t from = esp_timer_get_time();
    while (backend_set_waiting()) {
        if (esp_timer_get_time() >= until) {
            ESP_LOGW(TAG, "a backend set still being written after %u ms: change refused", (unsigned)timeout_ms);
            written = false;
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    if (render) s_render_waits_for_store = false;
    if (written) {
        /* A warning, so a console at the default level shows it: each one is
         * a change this race would have dropped. */
        ESP_LOGW(TAG, "a change waited %u ms for the backend set's write",
                 (unsigned)((esp_timer_get_time() - from) / 1000));
    }
    return written;
}

fos_scene_set_t *fos_scenes_backend_fetch(bool force, char *etag_out, size_t etag_len, esp_err_t *out_err)
{
    esp_err_t err = ESP_OK;
    fos_scene_set_t *set = NULL;
    if (etag_out && etag_len) etag_out[0] = '\0';
    bool log_unchanged = force;
    /* A poll skips while another fetch runs; a forced sync waits for it. */
    if (s_fetch_lock && xSemaphoreTake(s_fetch_lock, force ? pdMS_TO_TICKS(35000) : 0) != pdTRUE) {
        if (out_err) *out_err = ESP_ERR_TIMEOUT;
        return NULL;
    }
    if (__atomic_exchange_n(&s_sync_requested, false, __ATOMIC_SEQ_CST)) {
        force = true;
        log_unchanged = true;
    }
    fos_config_t *config = fos_config();
    char etag[ETAG_LEN];
    portENTER_CRITICAL(&s_etag_mux);
    bool fetched = s_fetched_etag[0] != '\0';
    strlcpy(etag, fetched ? s_fetched_etag : s_etag, sizeof(etag));
    portEXIT_CRITICAL(&s_etag_mux);
    if (!config->backend_url[0] || config->frame_id == 0) {
        err = ESP_ERR_INVALID_STATE;
    } else if (fos_wifi_state() != FOS_WIFI_CONNECTED) {
        err = ESP_ERR_INVALID_STATE;
    } else if (!force && strcmp(etag, "local") == 0) {
        /* A locally-pushed payload (uploadScenes over HTTP/USB, e.g. the Assets
         * panel's Play button) wins until a deploy or an explicit sync request:
         * without this, the next pass refetched the backend set and clobbered
         * the local push before it was even applied. */
    } else if ((err = mount_state()) == ESP_OK) {
        char url[FOS_URL_LEN + 64];
        fos_backend_url("/embedded/scenes?patch=1", url, sizeof(url));
        char auth[FOS_STR_LEN + 16];
        fos_backend_auth(auth, sizeof(auth));
        /* A forced sync (a deploy, "Push & activate", a preview) says what it
         * holds too: the backend answers 304 or the scenes that changed
         * (`?patch=1`), not the whole list, which was every push's full
         * download, parse and write. Not when the frame holds no set: then it
         * wants all of it whatever its ETag says. */
        bool holds_set = s_slot_count > 0 || s_loaded > 0;
        size_t state_total = 0, state_used = 0;
        state_usage(&state_total, &state_used);
        size_t room = state_total > state_used + SPOOL_ROOM_MARGIN ? state_total - state_used - SPOOL_ROOM_MARGIN : 0;
        char refused[ETAG_LEN];
        portENTER_CRITICAL(&s_etag_mux);
        /* Refused for want of room, and the room is there now: read again. */
        if (s_refused_room != 0 && room >= s_refused_room) s_refused_etag[0] = '\0';
        strlcpy(refused, s_refused_etag, sizeof(refused));
        portEXIT_CRITICAL(&s_etag_mux);
        /* Each scene in a block of its own (fos_scene_pieces.h): one block
         * the size of the answer did not fit beside a photo on the
         * reTerminal E1004 (no-memory, 378-415 KB, 2026-11-16). An answer
         * over what is held in memory, or one there was no block for (the
         * second try), goes straight into the store (backend_spool). */
        fos_scene_set_t *pieces = calloc(1, sizeof(*pieces));
        fos_http_response_t response = {0};
        spool_t spool = {0};
        fos_scene_sink_t sink = {.begin = spool_begin, .bytes = spool_bytes, .end = spool_end, .ctx = &spool};
        const char *held = (fetched || (etag[0] && strcmp(etag, "local") != 0 && (!force || holds_set))) ? etag : NULL;
        /* How the answer is read: held in memory up to SCENES_HELD_MAX_BYTES
         * and into the store past it; all of it into the store; all of it
         * held, however big. The first is tried, and one of the others once
         * when it could not be. */
        enum { READ_EITHER, READ_TO_STORE, READ_HELD } how = READ_EITHER;
        size_t held_whole = 0;
        size_t declared = 0; /* the answer's length as it said it; 0: it did not */
        for (int attempt = 0; attempt < 2; attempt++) {
            fos_http_request_t request = {
                .url = url,
                .auth = auth,
                .if_none_match = held,
                .timeout_ms = 30000,
                .buffer_size = 4096,
                /* Off the render task a render may hold the block for a moment;
                 * on it nothing else is running to give it back. */
                .alloc_wait_ms = fos_client_on_render_task() ? 0 : SCENES_BODY_WAIT_MS,
                .scene_set = pieces,
                .scene_sink = how == READ_HELD ? NULL : &sink,
                .scene_held_max = how == READ_EITHER ? SCENES_HELD_MAX_BYTES : 0,
                .skip_etag = refused,
            };
            size_t most = how == READ_HELD ? held_whole : room > SCENES_HELD_MAX_BYTES ? room : SCENES_HELD_MAX_BYTES;
            spool = (spool_t){0};
            int64_t started = esp_timer_get_time();
            err = pieces ? fos_http_fetch(&request, most, &response) : ESP_ERR_NO_MEM;
            if (spool.updating) fos_display_updating_end(false);
            if (err == ESP_OK && response.spooled && spool.id != 0) {
                log_spool(&spool, pieces->bytes, esp_timer_get_time() - started,
                          !response.too_large && response.body_err == ESP_OK);
            }
            declared = response.content_length > 0 ? (size_t)response.content_length : 0;
            if (err != ESP_OK || response.status != 200 || response.skipped || attempt > 0) break;
            /* Held in memory, there was no block for one of its scenes, or
             * (its length not declared) it came to more than is held: once
             * more, into the store, which needs neither. */
            bool no_block = !response.spooled && !response.too_large && response.body_err == ESP_ERR_NO_MEM;
            bool undeclared = !response.spooled && response.too_large && declared == 0;
            /* More than /state has room for beside the set it holds, though
             * not more than /state: a small partition's set that replaces
             * most of the one before (a 1 MB /state holding 680 KB has room
             * for 120 KB more). Held in memory where there is twice that
             * much, it is stored a scene at a time, the scenes it drops
             * first (fos_scene_store_apply_set). */
            bool beside = response.too_large && declared > 0 && declared + SPOOL_ROOM_MARGIN < state_total &&
                          heap_caps_get_free_size(MALLOC_CAP_SPIRAM) >= 2 * declared;
            if (no_block || undeclared) {
                how = READ_TO_STORE;
            } else if (beside) {
                how = READ_HELD;
                held_whole = declared;
            } else {
                break;
            }
            /* Why it is read again: held in memory whole (no room for it
             * beside the set on /state), or into the store (no block for a
             * scene of it, or its length not said). */
            log_scene_event("scenes:sync", "retry", "backend", "",
                            how == READ_HELD ? "held" : no_block ? "no-memory" : "to-store", declared, 0,
                            response.status, ESP_ERR_NO_MEM);
        }
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "scenes sync: connect failed: %s", esp_err_to_name(err));
            log_scene_event("scenes:sync", "error", "backend", "", "connect-failed", 0, 0, 0, err);
        } else if (response.status == 304) {
            if (log_unchanged) {
                log_scene_event("scenes:sync", "ok", "backend", "", "unchanged", 0, s_loaded, 304, ESP_OK);
            }
        } else if (response.status != 200) {
            ESP_LOGW(TAG, "scenes sync: HTTP %d from %s", response.status, url);
            log_scene_event("scenes:sync", "error", "backend", "", "http-error", 0, 0, response.status, ESP_FAIL);
            err = ESP_FAIL;
        } else if (response.skipped) {
            /* The answer the store refused, unchanged: said once, then. */
            err = ESP_ERR_NO_MEM;
        } else if (response.too_large) {
            /* More than /state has room for: nothing of it was read. The
             * line says how much it was, or (its length not said) the room. */
            set_scene_simple_error(fos_scene_store_err_str(FOS_SCENE_STORE_ERR_NO_SPACE), declared);
            log_scene_event("scenes:sync", "error", "backend", "", "payload-too-large",
                            declared ? declared : room, 0, response.status, ESP_ERR_NO_MEM);
            refused_set(response.etag, declared);
            err = ESP_ERR_NO_MEM;
        } else if (response.body_err != ESP_OK) {
            /* What the answer said it was, and whether there was no buffer
             * for a scene of it, it was not a scene answer, the store had no
             * room or no slot for it, or the read broke off: "read-failed,
             * 0 bytes" said none of it. */
            err = response.body_err;
            const char *detail = err == ESP_ERR_NO_MEM               ? "no-memory"
                                 : err == ESP_ERR_INVALID_RESPONSE ? "invalid"
                                                                   : "read-failed";
            if (response.spooled) {
                /* What the store took of it goes back. */
                store_lock();
                fos_scene_store_stage_drop(spool.id);
                store_unlock();
                if (spool.busy) {
                    detail = "busy";
                } else if (spool.err != FOS_SCENE_STORE_OK && spool.err != FOS_SCENE_STORE_ERR_NO_MEMORY) {
                    /* The store's own words for it ("no room on /state",
                     * "no free scene slot", "not one scene object with an
                     * id"), and the same answer would be refused the same
                     * way. */
                    detail = fos_scene_store_err_str(spool.err);
                    err = STORE_ERR_TO_ESP[spool.err];
                    refused_set(response.etag, spool.err == FOS_SCENE_STORE_ERR_NO_SPACE ? declared : 0);
                }
            }
            log_scene_event("scenes:sync", "error", "backend", "", detail, declared, 0, response.status, err);
        } else {
            set = pieces;
            pieces = NULL;
            if (response.spooled) set->staged = spool.id;
            if (etag_out && etag_len) strlcpy(etag_out, response.etag, etag_len);
            fetched_set(response.etag);
        }
        free(pieces); /* read nothing, or kept nothing */
    }
    if (s_fetch_lock) xSemaphoreGive(s_fetch_lock);
    if (out_err) *out_err = err;
    return set;
}

/* Whether the runtime can take a whole backend payload of `len` bytes now
 * (load_into_nim): the instant switch to a new set. It parses every scene of
 * it (each copied alone since 2026-11-16), and holds them all until the
 * next set: a 420 KB set took 750 KB of PSRAM on the reTerminal E1003, and a
 * 378 KB one on the E1004 failed its copy with 1.5 MB free whose largest
 * block was 296 KB, after letting go of the scene it showed (the hardware
 * bench, 2026-11-16). Without the room, the set goes store-first, as the
 * cloud's do: written, then applied one scene at a time. Asked once per set
 * taken, so the walk for the largest block is affordable. */
#define WHOLE_LOAD_LARGEST_FACTOR 2
#define WHOLE_LOAD_FREE_FACTOR 4
static bool runtime_room_for_whole(size_t len)
{
    if (heap_caps_get_total_size(MALLOC_CAP_SPIRAM) == 0) return true;
    return heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM) >= WHOLE_LOAD_LARGEST_FACTOR * len &&
           heap_caps_get_free_size(MALLOC_CAP_SPIRAM) >= WHOLE_LOAD_FREE_FACTOR * len;
}

static esp_err_t take_backend_payload(fos_scene_set_t *set, const char *etag)
{
    if (set == NULL || set->rest == NULL) {
        scene_set_free(set);
        return ESP_ERR_INVALID_ARG;
    }
    size_t len = set->bytes;
    esp_err_t err = mount_state();
    if (err != ESP_OK) {
        scene_set_free(set);
        return err;
    }
    /* An object, not the array a whole payload is: only the scenes that
     * changed since the set this frame holds (`?patch=1`). Written here,
     * scene by scene through the store.
     *
     * Or a whole set read straight into the store (backend_spool): its
     * scenes are in their files, and this is the one change that makes them
     * the set, as a patch that names every scene. The scenes stored already
     * stayed as they were, so the scene showing reloads only if it changed.
     * How many were written and how many found stored is in the `scenes:set`
     * line's bytes (those written) and count. */
    bool patch = set->rest[0] == '{';
    if (patch || set->staged != 0) {
        if (patch) {
            err = apply_backend_patch(set, etag);
        } else {
            fos_scene_store_change_t change = {.staged = set->staged};
            fos_scene_store_result_t result;
            err = apply_store_change(&change, FOS_SCENES_SOURCE_BACKEND, etag, "scenes:set", false, &result);
            if (err != ESP_OK) s_sync_requested = true;
        }
        scene_set_free(set);
        log_scene_event("scenes:sync", err == ESP_OK ? "updated" : "error", "backend", "",
                        err != ESP_OK ? (patch ? "patch-refused" : "set-refused") : patch ? "patched" : "to-store",
                        len, 0, 200, err);
        return err;
    }
    /* What the next conditional GET sends, now: the link task polls on while
     * the store task writes, and must not fetch this payload again. */
    etag_set(etag);
    /* Backend-served payload: declare it before load_into_nim promotes the
     * pending source (persisted with the write: the boot split records it). */
    s_pending_source = FOS_SCENES_SOURCE_BACKEND;
    ESP_LOGI(TAG, "scenes updated from backend (%u bytes, etag %s)", (unsigned)len,
             etag && etag[0] ? etag : "none");
    bool whole = runtime_room_for_whole(len);
    log_scene_event("scenes:sync", "updated", "backend", "", whole ? "taken" : "taken-to-store", len, 0, 200,
                    ESP_OK);
    if (whole) {
        /* The index on flash describes the PREVIOUS payload. With it in place
         * a selection went through the slots: a scene new in this payload was
         * "not found" (the voice chat's show_image, E1002 2026-10-24:
         * apply-failed with four scenes live) and a known id reloaded its
         * stale slot file. The runtime holds the whole new payload from here.
         * The store task writes it into the per-scene store as changes, the
         * scenes that changed one at a time (store_set_as_changes_locked);
         * without one, whole, for the next boot to split (and removes the old
         * index once the payload is on flash). */
        int slots_before = s_slot_count;
        s_slot_count = 0;
        s_resident_scene_id[0] = '\0';
        whole = load_into_nim((const char *const *)set->scenes, set->lens, set->count, len, "backend");
        /* Refused (out of memory, as a 378 KB set was on the E1004): the
         * slots from before are still on flash, and the set goes store-first. */
        if (!whole) s_slot_count = slots_before;
    }
    if (whole) {
        /* The new set on the panel now. Taken from the idle wait (the link
         * task's download, or a deploy's poke pulling it itself), nothing
         * else rendered it until the next timed pass: a deploy to the
         * reTerminal E1003 showing Form showcase (hourly) sat at "first
         * render", the Sticky's showed minutes late (2026-11-10). Inside a
         * pass it costs one render. */
        fos_client_render_now();
    } else {
        /* Store-first, as a set the cloud pushes: written by the store task,
         * then applied from flash one scene at a time (store_backend_payload
         * marks it pending). The set from before keeps the panel until then;
         * a selection waits for the new one (s_store_changing). */
        s_store_changing = true;
    }
    if (store_behind(set, etag, !whole)) return ESP_OK;
    /* No store task: written here, as it always was. */
    store_job_t job = {.set = set, .reload = !whole};
    strlcpy(job.etag, etag ? etag : "", sizeof(job.etag));
    store_backend_payload(&job);
    scene_set_free(set);
    return ESP_OK;
}

esp_err_t fos_scenes_take_backend_payload(fos_scene_set_t *set, const char *etag)
{
    /* The fetched set is what a conditional GET names until it is taken, on
     * every way out. Cleared before the take, a patch or a set read into the
     * store had a second or two with neither ETag in place (its own is saved
     * once the index is switched): the link task's poll asked with the one
     * before and the backend sent the set again, 529 KB into the store a
     * second time, with a deploy's sync waiting for it on the render task
     * (the reTerminal Sticky, the hardware bench, 2026-11-18). */
    esp_err_t err = take_backend_payload(set, etag);
    fetched_set("");
    return err;
}

esp_err_t fos_scenes_sync(bool force)
{
    char etag[ETAG_LEN];
    esp_err_t err = ESP_OK;
    fos_scene_set_t *set = fos_scenes_backend_fetch(force, etag, sizeof(etag), &err);
    if (set == NULL) return err;
    return fos_scenes_take_backend_payload(set, etag);
}

bool fos_scenes_settings_shown(void)
{
    return s_settings_shown;
}
