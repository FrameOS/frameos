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

/* Pull scenes from the backend if they changed (sha256 ETag); apply on this
 * task. Call from the render task only. `force` refetches unconditionally. */
esp_err_t fos_scenes_sync(bool force);
bool fos_scenes_state_mounted(void);

/* Persist a scenes JSON payload (local push, e.g. POST /api/scenes) and mark
 * it pending. Safe from any task; trigger a render to apply.
 * fos_scenes_set_json() means FOS_SCENES_SOURCE_LOCAL; every non-local caller
 * must declare itself via fos_scenes_set_json_from(). */
esp_err_t fos_scenes_set_json(const char *json, size_t len);
esp_err_t fos_scenes_set_json_from(const char *json, size_t len,
                                   fos_scenes_source_t source);

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

/* Ask the render task to force a backend sync on its next pass. */
void fos_scenes_request_sync(void);

/* Queue a scene switch. Safe from any task; the render task applies it before
 * the next render so Nim/QuickJS scene state stays single-threaded. */
esp_err_t fos_scenes_select(const char *scene_id);

/* Apply a queued scene switch. Render task only. True if selection changed. */
bool fos_scenes_apply_pending_selection(void);

/* Apply pending scenes (file → Nim). Render task only. True if applied. */
bool fos_scenes_apply_pending(void);

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
