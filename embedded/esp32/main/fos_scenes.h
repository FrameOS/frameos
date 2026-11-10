/*
 * Interpreted-scene storage and sync.
 *
 * Scenes are the backend's scenes.json array, stored on the `state` SPIFFS
 * partition (/state/scenes.json) so they survive reboots and deep sleep,
 * and hot-loaded into the Nim runtime (QuickJS) without reflashing.
 *
 * Threading: everything that touches the Nim runtime happens on the render
 * (fos_client) task. HTTP/console producers persist the payload and set a
 * pending flag; the render loop applies it before the next render.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

struct cJSON;

/* Who installed the scenes a frame is holding. Not cosmetic: fos_cloud.c keys
 * the RFC1918 LAN deny (fos_netguard) on this, so provider-pushed scenes stay
 * fenced off the owner's LAN even after the frame is demoted from cloud
 * management. Persisted in /state/scene-index.json (top-level "source") and
 * mirrored in NVS so the answer survives reboots and the store→apply window. */
typedef enum {
    FOS_SCENES_SOURCE_LOCAL = 0,   /* HTTP POST /uploadScenes, USB console, portal */
    FOS_SCENES_SOURCE_BACKEND,     /* fos_scenes_sync() from the configured backend */
    FOS_SCENES_SOURCE_CLOUD,       /* cloud provider's set_scenes over the WS link */
} fos_scenes_source_t;

/* Mount /state and mark any cached scenes.json for loading. */
esp_err_t fos_scenes_init(void);

/* Pull scenes from the backend if they changed (sha256 ETag) and take them
 * (fos_scenes_take_backend_payload). Render task only. `force` refetches
 * unconditionally. */
esp_err_t fos_scenes_sync(bool force);

#define FOS_SCENES_ETAG_LEN 80
/* The backend's scenes when they changed since the etag held (or a sync was
 * asked for, or `force`): the body, malloc'd for the caller, its etag in
 * `etag_out`; NULL when unchanged or on an error (logged, in `out_err`). Any
 * task: the backend link task fetches with it, so the download is off the
 * render task (fos_client.c). */
char *fos_scenes_backend_fetch(bool force, size_t *out_len, char *etag_out, size_t etag_len,
                               esp_err_t *out_err);
/* A payload fetched with fos_scenes_backend_fetch: into the runtime now, and
 * onto flash by the scene store's own task (the combined file, then the etag
 * and the source). Takes `body`. Render task only. */
esp_err_t fos_scenes_take_backend_payload(char *body, size_t len, const char *etag);
/* The store task still has a payload to write. A deep sleep and a restart wait
 * for it (fos_scenes_store_wait: false when `timeout_ms` ran out first). */
bool fos_scenes_store_busy(void);
bool fos_scenes_store_wait(uint32_t timeout_ms);
bool fos_scenes_state_mounted(void);

/* Persist a scenes JSON payload (local push, e.g. POST /api/scenes) and mark
 * it pending. Safe from any task; trigger a render to apply.
 * fos_scenes_set_json() means FOS_SCENES_SOURCE_LOCAL; every non-local caller
 * must declare itself via fos_scenes_set_json_from(). */
esp_err_t fos_scenes_set_json(const char *json, size_t len);
esp_err_t fos_scenes_set_json_from(const char *json, size_t len,
                                   fos_scenes_source_t source);

/* One scene at a time. Add or replace one scene (a JSON object with an `id`),
 * remove one, or apply a control plane's patch (`put`: the scenes that
 * changed, `order`: every id the frame should hold, in order; the rest go).
 * Safe from any task: the bytes are on flash when this returns and the render
 * task picks the change up (fos_scenes_apply_pending), reloading the resident
 * scene only if it is what changed. A scene already on the frame is never
 * overwritten in place, so a failed write keeps the one it had.
 * `out_id` receives the scene's id. `etag` is what fos_scenes_etag() reports
 * afterwards (NULL: "local", as for a whole-set upload). */
esp_err_t fos_scenes_put(const char *json, size_t len, fos_scenes_source_t source,
                         char *out_id, size_t out_id_len);
esp_err_t fos_scenes_delete(const char *scene_id, fos_scenes_source_t source);
esp_err_t fos_scenes_apply_patch(const struct cJSON *put, const struct cJSON *order,
                                 fos_scenes_source_t source, const char *etag);

/* One stored scene's JSON; caller frees. NULL when there is no such scene. */
char *fos_scenes_get_json(const char *scene_id, size_t *out_len);

/* What /state holds, added to `report` (nothing when NULL):
 * stateTotalBytes / stateUsedBytes (the partition, `esp_spiffs_info`),
 * scenesBytes and sceneCount. The cloud's hardware.storage, the backend
 * hello's storage and the scene list's all come from here. */
void fos_scenes_add_storage_json(struct cJSON *report);

/* The index ({"scenes":[{"id","name","refreshInterval","slot","bytes",...}],
 * "default","source"}) and "storage" as above. Caller cJSON_free()s. */
char *fos_scenes_list_json(void);

/* Source of the stored scenes. Safe to read from any task (plain volatile
 * int, same convention as the other fos_scenes flags; it changes only when a
 * new payload is stored or applied). Defaults to LOCAL on a pre-upgrade
 * store whose index has no "source" key. */
fos_scenes_source_t fos_scenes_source(void);
bool fos_scenes_from_cloud(void);

/* Last storage/sync error detail, suitable for HTTP/USB responses. */
const char *fos_scenes_last_error(void);

/* Copy the persisted scenes JSON array. Caller owns the returned buffer. */
char *fos_scenes_json_copy(size_t *out_len);

/* One scene of the payload by id, read off its slot on the lazy path, for
 * the Nim runtime when a resident split names a panel that is not resident
 * (frameos/src/embedded/embedded_runtime.nim). Caller frees; NULL when the
 * payload has no such scene. */
char *fos_scenes_read_scene_json(const char *scene_id, size_t *out_len);

/* Ask the render task to force a backend sync on its next pass. */
void fos_scenes_request_sync(void);

/* Queue a scene switch. Safe from any task; the render task applies it before
 * the next render so Nim/QuickJS scene state stays single-threaded. */
esp_err_t fos_scenes_select(const char *scene_id);

/* Apply a queued scene switch. Render task only. True if selection changed. */
bool fos_scenes_apply_pending_selection(void);

/* Apply pending scenes (file → Nim). Render task only. True if applied. */
bool fos_scenes_apply_pending(void);

/* A one-scene change is waiting for the render task. The wait between renders
 * picks it up without a render, unless it is the scene showing. */
bool fos_scenes_patch_pending(void);
/* fos_scenes_take_switched() would say true; does not consume it. */
bool fos_scenes_switched_pending(void);

/* A payload or a selection is waiting for the render task. A deep-sleeping
 * frame checks this before it sleeps: work that landed during the render
 * gets a pass now instead of after the sleep (fos_client.c). */
bool fos_scenes_work_pending(void);
bool fos_scenes_selection_pending(void);

/* True once per switch: the render task changed the resident scene, or
 * applied a payload pushed since boot, since the last call. The pass that
 * sees it renders even when it woke only to check in — the panel shows the
 * previous scene. Render task only. */
bool fos_scenes_take_switched(void);
/* The scene settings (system/sceneSettings) are on the panel: what they show
 * of the frame (fos_frame_settings.c) changed, so render them again. */
bool fos_scenes_settings_shown(void);

/* Monotonic count of apply attempts made by the render task, and whether the
 * most recent one loaded into the runtime. A producer records the generation
 * before calling fos_scenes_set_json() and polls until it changes, which is
 * how the cloud client learns that a pushed payload actually went live before
 * it reports `scene_ack`. Safe to read from any task. */
uint32_t fos_scenes_apply_generation(void);
bool fos_scenes_apply_succeeded(void);

/* Number of scenes currently loaded into the Nim runtime. */
int fos_scenes_loaded(void);

/* ETag of the last synced payload ("" when none). */
const char *fos_scenes_etag(void);

/* True when /state holds a scene payload (the combined scenes.json or the
 * per-scene index an earlier boot split it into). False on a fresh or
 * wiped state partition — a SPIFFS autoformat after corruption, a flash
 * relayout — even when NVS still remembers what used to be there. */
bool fos_scenes_stored(void);

/* Called right before an out-of-memory restart (frameos_nim_glue.c): remember
 * the scene that was resident, so the boot-time restore does not put the same
 * scene straight back on the panel — a scene that aborts on every render
 * would otherwise loop the board (abort, leak, abort, restart, restore,
 * …) faster than the cloud can switch it away. */
void fos_scenes_mark_oom_restart(void);

/* Remove every file on the /state partition: the scene payload and its
 * split slots, the schedule, the cached cloud payloads, the OTA spill.
 * `factory-reset` calls this before erasing NVS, so a handed-on board does
 * not bring the previous owner's scenes — and the secrets typed into their
 * node fields — back on the next enrollment. The SD card is left alone (it
 * is the owner's photos; format it with `sd format`). */
void fos_scenes_wipe_state(void);
