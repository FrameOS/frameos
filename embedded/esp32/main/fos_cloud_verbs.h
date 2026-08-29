/*
 * The firmware's side of the shared cloud verb layer.
 *
 * Provider→frame verbs (docs/cloud-frames.md) are dispatched by
 * frameos/src/frameos/cloud/verbs.nim — the same code the Linux runtime runs —
 * through src/embedded/embedded_cloud.nim, which is the ESP32's
 * CloudVerbContext. The callbacks below are what that context calls: thin
 * bindings onto the module that owns each piece of state. fos_cloud.c owns
 * the socket and never interprets a verb itself.
 *
 * Threading: every callback runs on the cloud task, inside the Nim runtime
 * lock (recursive — a callback may call back into the runtime).
 *
 * Conventions: a `const char *` return is "" for success or the wire error
 * token to ack, and is never freed. A `char *` return is a malloc'd JSON
 * string the Nim side copies and releases with fos_cloud_cb_free().
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* set_scenes: persist the interpreted-scene array to /state as a cloud-
 * sourced payload and let the render task hot-load it. `scene_id` (may be
 * "") names the pushed scene to activate; `checksum` (may be "") is what
 * the deferred scene_ack must carry once the payload is live. */
const char *fos_cloud_cb_apply_scenes(const char *scenes_json, size_t len,
                                      const char *scene_id, const char *checksum);
/* set_settings: apply an already shape-checked settings object to
 * fos_config and persist it (fos_settings_apply_cloud_json). Reboots the
 * device afterwards when a boot-time setting changed. */
const char *fos_cloud_cb_apply_settings(const char *settings_json);
/* set_schedule: `schedule_json` NULL clears the schedule; the offset applies
 * first when `has_offset` (the chip has no tz database). */
const char *fos_cloud_cb_set_schedule(const char *schedule_json, int utc_offset_minutes,
                                      bool has_offset);
/* set_current_scene: queue the switch for the render task and render. */
const char *fos_cloud_cb_select_scene(const char *scene_id);
void fos_cloud_cb_render_now(void);
/* reboot / restart_runtime / a settings restart: deferred so the ack still
 * flushes over the socket first. Idempotent. */
void fos_cloud_cb_restart(void);
/* notify_update_available: the signed cloud OTA flow (fos_ota.h). */
void fos_cloud_cb_request_upgrade(void);
/* refresh_service_settings: ask the settings poll to pull before the next
 * render (fos_settings_request_sync). */
void fos_cloud_cb_refresh_service_settings(void);

/* The running firmware's version string (static). */
const char *fos_cloud_cb_version(void);
/* The hello-shaped fields the transport knows — frameos_version, hardware,
 * scenes_checksum — as one object; the runtime adds active_scene/states. */
char *fos_cloud_cb_state_json(void);
/* The on-device log ring as a log_batch `logs` array. */
char *fos_cloud_cb_logs_json(void);
/* The newest metrics sample object, or NULL before the first render pass. */
char *fos_cloud_cb_metrics_json(void);
/* {"assets": [...], "truncated": bool} for the SD card (empty listing when
 * no card is mounted). */
char *fos_cloud_cb_assets_list_json(void);

/* asset_get / image_get: validate now, stream later. "" means the transport
 * will emit the asset_chunk frames itself after the ack
 * (fos_cloud_queue_asset_read); otherwise the error to ack. */
const char *fos_cloud_cb_asset_read(const char *path);
const char *fos_cloud_cb_image_read(void);
/* asset_put: whole-file write. Returns the stored entry
 * {"path","size","mtime","is_dir"} or NULL with *err set. */
char *fos_cloud_cb_asset_write(const char *path, const uint8_t *data, size_t len,
                               const char **err);
/* asset_put_chunk: one offset-addressed write into the upload part; with a
 * non-NULL `final_path` the part is committed there and the stored entry is
 * returned, otherwise {"received": N}. NULL with *err set on failure. */
char *fos_cloud_cb_asset_put_chunk(const char *upload_id, long long offset,
                                   const uint8_t *data, size_t len,
                                   const char *final_path, const char **err);
const char *fos_cloud_cb_asset_mkdir(const char *path);
const char *fos_cloud_cb_asset_delete(const char *path);
const char *fos_cloud_cb_asset_rename(const char *src, const char *dst);
void fos_cloud_cb_free(void *p);
