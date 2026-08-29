/*
 * The firmware's CloudVerbContext (see fos_cloud_verbs.h). The verb layer
 * itself is Nim (frameos/cloud/verbs.nim) and shared with the Linux runtime;
 * everything here is a binding from one of its callbacks onto the module
 * that owns the state. No verb name appears in this file on purpose.
 */
#include "fos_cloud_verbs.h"

#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "esp_app_desc.h"
#include "esp_log.h"

#include "cJSON.h"

#include "fos_assets.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_ota.h"
#include "fos_scenes.h"
#include "fos_schedule.h"
#include "fos_settings.h"
#include "frameos_nim.h"

static const char *TAG = "fos_cloud_verbs";

/* cJSON_PrintUnformatted allocates through cJSON's hooks (malloc); handing
 * that buffer out as the malloc'd result keeps one allocation per reply. */
static char *print_and_delete(cJSON *json)
{
    if (json == NULL) return NULL;
    char *text = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    return text;
}

void fos_cloud_cb_free(void *p) { free(p); }

/* ------------------------------------------------------------ content */

const char *fos_cloud_cb_apply_scenes(const char *scenes_json, size_t len,
                                      const char *scene_id, const char *checksum)
{
    if (scenes_json == NULL || len == 0) return "invalid_scenes";
    uint32_t generation = fos_scenes_apply_generation();
    /* Declared CLOUD so the store remembers who installed these scenes:
     * apply_network_policy() keeps the RFC1918 deny alive on that flag even
     * after a demotion drops FOS_CLOUD_ENROLLED. */
    esp_err_t err = fos_scenes_set_json_from(scenes_json, len, FOS_SCENES_SOURCE_CLOUD);
    if (err != ESP_OK) {
        const char *detail = fos_scenes_last_error();
        ESP_LOGW(TAG, "set_scenes: store failed: %s", (detail && detail[0]) ? detail : "?");
        return (detail && detail[0]) ? detail : "scene_store_failed";
    }
    /* Queued now, applied by the render task AFTER the payload loads —
     * fos_client.c applies pending scenes before pending selection, so the
     * id exists by then. Unknown ids are dropped there. */
    if (scene_id != NULL && scene_id[0] != '\0') fos_scenes_select(scene_id);
    fos_client_render_now();
    /* scene_ack follows once the render task has the payload live
     * (fos_cloud.c ws_poll_scene_ack), carrying this checksum. */
    fos_cloud_arm_scene_ack(checksum ? checksum : "", generation);
    return "";
}

const char *fos_cloud_cb_apply_settings(const char *settings_json)
{
    cJSON *settings = settings_json ? cJSON_Parse(settings_json) : NULL;
    if (!cJSON_IsObject(settings)) {
        cJSON_Delete(settings);
        return "invalid_settings";
    }
    const char *err = NULL;
    bool reboot = false;
    esp_err_t result = fos_settings_apply_cloud_json(settings, &err, &reboot);
    cJSON_Delete(settings);
    if (result != ESP_OK) return err ? err : "persist_failed";
    if (reboot) fos_cloud_schedule_reboot();
    return "";
}

const char *fos_cloud_cb_set_schedule(const char *schedule_json, int utc_offset_minutes,
                                      bool has_offset)
{
    /* The chip carries no tz database, so the provider sends the frame's
     * current UTC offset alongside the schedule (the backend poll does the
     * same via the `frame` object). Apply it first: without it a cloud-only
     * frame evaluates every event in UTC. */
    if (has_offset) fos_schedule_set_utc_offset_minutes(utc_offset_minutes);
    if (schedule_json == NULL || schedule_json[0] == '\0') {
        fos_schedule_set_json(NULL, 0);
        return "";
    }
    if (fos_schedule_set_json(schedule_json, strlen(schedule_json)) != ESP_OK) {
        return "invalid_schedule";
    }
    return "";
}

const char *fos_cloud_cb_select_scene(const char *scene_id)
{
    if (fos_scenes_select(scene_id) != ESP_OK) return "unknown_scene";
    fos_client_render_now();
    return "";
}

void fos_cloud_cb_render_now(void) { fos_client_render_now(); }

void fos_cloud_cb_restart(void) { fos_cloud_schedule_reboot(); }

void fos_cloud_cb_request_upgrade(void) { fos_ota_request_cloud_update(); }

void fos_cloud_cb_refresh_service_settings(void) { fos_settings_request_sync(); }

/* ------------------------------------------------------------ telemetry */

const char *fos_cloud_cb_version(void) { return esp_app_get_description()->version; }

char *fos_cloud_cb_state_json(void)
{
    cJSON *state = cJSON_CreateObject();
    if (state == NULL) return NULL;
    fos_cloud_add_static_state(state);
    return print_and_delete(state);
}

char *fos_cloud_cb_logs_json(void)
{
    frameos_log_entry_t *entries = calloc(FOS_NIM_LOG_RING_CAP, sizeof(*entries));
    if (entries == NULL) return NULL;
    size_t count = frameos_nim_log_recent(entries, FOS_NIM_LOG_RING_CAP);
    cJSON *logs = cJSON_CreateArray();
    for (size_t i = 0; i < count; i++) {
        if (logs != NULL) {
            cJSON *entry = fos_cloud_log_line_entry(entries[i].line, entries[i].timestamp);
            if (entry != NULL) cJSON_AddItemToArray(logs, entry);
        }
        free(entries[i].line);
    }
    free(entries);
    return print_and_delete(logs);
}

char *fos_cloud_cb_metrics_json(void)
{
    /* recent() returns oldest-first; the wire shape is a single sample, so
     * the newest is the reply. */
    fos_metrics_sample_t samples[32] = {0};
    size_t count = fos_client_metrics_recent(samples, 32);
    char *newest = NULL;
    for (size_t i = 0; i < count; i++) {
        if (i + 1 == count) newest = samples[i].json;
        else free(samples[i].json);
    }
    return newest; /* a strdup from fos_client; ours to hand out */
}

/* ------------------------------------------------------------ assets */

char *fos_cloud_cb_assets_list_json(void)
{
    cJSON *listing = cJSON_CreateObject();
    if (listing == NULL) return NULL;
    cJSON *assets = cJSON_AddArrayToObject(listing, "assets");
    bool truncated = false;
    if (assets != NULL && fos_assets_available()) fos_assets_list_json(assets, &truncated);
    if (truncated) cJSON_AddBoolToObject(listing, "truncated", true);
    return print_and_delete(listing);
}

const char *fos_cloud_cb_asset_read(const char *path)
{
    char rel[FOS_ASSETS_PATH_MAX];
    if (!fos_assets_sanitize_path(path, rel, sizeof(rel))) return "invalid_path";
    if (!fos_assets_available()) return "not_found";
    struct stat st;
    if (fos_assets_stat(rel, &st) != ESP_OK) return "not_found";
    if (S_ISDIR(st.st_mode)) return "is_directory";
    if ((size_t)st.st_size > FOS_CLOUD_ASSET_MAX_FILE_BYTES) return "too_large";
    /* Validated with a stat, no reads: the bytes are streamed from the cloud
     * task after the ack, 24 KiB at a time. */
    fos_cloud_queue_asset_read(FOS_CLOUD_READ_ASSET, rel);
    return "";
}

const char *fos_cloud_cb_image_read(void)
{
    /* Even before this boot's first render: the stream job waits for the
     * render (up to FOS_CLOUD_IMAGE_WAIT_MAX_US) instead of answering
     * no_image seconds before there is one. */
    fos_cloud_queue_asset_read(FOS_CLOUD_READ_IMAGE, "");
    return "";
}

static cJSON *stored_entry(const char *rel, long long fallback_size)
{
    cJSON *asset = cJSON_CreateObject();
    if (asset == NULL) return NULL;
    struct stat st;
    bool have_stat = fos_assets_stat(rel, &st) == ESP_OK;
    cJSON_AddStringToObject(asset, "path", rel);
    cJSON_AddNumberToObject(asset, "size", have_stat ? (double)st.st_size : (double)fallback_size);
    cJSON_AddNumberToObject(asset, "mtime", have_stat ? (double)st.st_mtime : 0);
    cJSON_AddBoolToObject(asset, "is_dir", false);
    return asset;
}

char *fos_cloud_cb_asset_write(const char *path, const uint8_t *data, size_t len,
                               const char **err)
{
    char rel[FOS_ASSETS_PATH_MAX];
    if (!fos_assets_sanitize_write_path(path, rel, sizeof(rel))) {
        *err = "invalid_path";
        return NULL;
    }
    if (!fos_assets_available()) {
        *err = "not_found";
        return NULL;
    }
    *err = NULL;
    if (fos_assets_write_file(rel, data, len, err) != ESP_OK) {
        if (*err == NULL) *err = "write_failed";
        return NULL;
    }
    char *text = print_and_delete(stored_entry(rel, (long long)len));
    if (text == NULL) *err = "no_memory";
    return text;
}

char *fos_cloud_cb_asset_put_chunk(const char *upload_id, long long offset,
                                   const uint8_t *data, size_t len,
                                   const char *final_path, const char **err)
{
    if (!fos_assets_valid_upload_id(upload_id)) {
        *err = "invalid_upload_id";
        return NULL;
    }
    char rel[FOS_ASSETS_PATH_MAX] = "";
    if (final_path != NULL && !fos_assets_sanitize_write_path(final_path, rel, sizeof(rel))) {
        *err = "invalid_path";
        return NULL;
    }
    if (!fos_assets_available()) {
        *err = "not_found";
        return NULL;
    }
    /* The very same part protocol the USB/HTTP chunked upload uses (offset
     * 0 starts the part, a hole is chunk_gap, a resent chunk overwrites
     * itself), committed to `rel` on the final chunk. */
    *err = NULL;
    fos_assets_writer_t writer;
    if (fos_assets_chunk_begin(upload_id, offset, &writer, err) != ESP_OK) {
        if (*err == NULL) *err = "write_failed";
        return NULL;
    }
    if (fos_assets_write_chunk(&writer, data, len) != ESP_OK) {
        fos_assets_chunk_close(&writer);
        *err = "write_failed";
        return NULL;
    }
    long long received = 0;
    if (fos_assets_chunk_finish(&writer, final_path ? rel : NULL, &received, err) != ESP_OK) {
        if (*err == NULL) *err = "write_failed";
        return NULL;
    }
    cJSON *reply;
    if (final_path != NULL) {
        reply = stored_entry(rel, received);
    } else {
        reply = cJSON_CreateObject();
        if (reply != NULL) cJSON_AddNumberToObject(reply, "received", (double)received);
    }
    char *text = print_and_delete(reply);
    if (text == NULL) *err = "no_memory";
    return text;
}

static const char *write_path_op(const char *path, esp_err_t (*op)(const char *, const char **))
{
    char rel[FOS_ASSETS_PATH_MAX];
    if (!fos_assets_sanitize_write_path(path, rel, sizeof(rel))) return "invalid_path";
    if (!fos_assets_available()) return "not_found";
    const char *err = NULL;
    if (op(rel, &err) != ESP_OK) return err ? err : "write_failed";
    return "";
}

const char *fos_cloud_cb_asset_mkdir(const char *path) { return write_path_op(path, fos_assets_mkdir); }

const char *fos_cloud_cb_asset_delete(const char *path) { return write_path_op(path, fos_assets_delete); }

const char *fos_cloud_cb_asset_rename(const char *src, const char *dst)
{
    char src_rel[FOS_ASSETS_PATH_MAX];
    char dst_rel[FOS_ASSETS_PATH_MAX];
    if (!fos_assets_sanitize_write_path(src, src_rel, sizeof(src_rel)) ||
        !fos_assets_sanitize_write_path(dst, dst_rel, sizeof(dst_rel))) {
        return "invalid_path";
    }
    if (!fos_assets_available()) return "not_found";
    const char *err = NULL;
    if (fos_assets_rename(src_rel, dst_rel, &err) != ESP_OK) return err ? err : "write_failed";
    return "";
}
