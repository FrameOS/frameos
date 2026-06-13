/*
 * Interpreted-scene storage and sync (M3).
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
#include "esp_err.h"

/* Mount /state and mark any cached scenes.json for loading. */
esp_err_t fos_scenes_init(void);

/* Pull scenes from the backend if they changed (sha256 ETag); apply on this
 * task. Call from the render task only. `force` refetches unconditionally. */
esp_err_t fos_scenes_sync(bool force);

/* Persist a scenes JSON payload (local push, e.g. POST /api/scenes) and mark
 * it pending. Safe from any task; trigger a render to apply. */
esp_err_t fos_scenes_set_json(const char *json, size_t len);

/* Ask the render task to force a backend sync on its next pass. */
void fos_scenes_request_sync(void);

/* Apply pending scenes (file → Nim). Render task only. True if applied. */
bool fos_scenes_apply_pending(void);

/* Number of scenes currently loaded into the Nim runtime. */
int fos_scenes_loaded(void);

/* ETag of the last synced payload ("" when none). */
const char *fos_scenes_etag(void);
