/*
 * C surface of the FrameOS Nim runtime.
 *
 * The real implementation is Nim code from frameos/src/embedded compiled to C
 * (see build_nim.sh) and dropped into this component's nimcache/ directory.
 * When no nimcache is present the stub implementation reports "unavailable"
 * and the firmware falls back to thin-client mode.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* True when the Nim runtime is compiled in. */
bool frameos_nim_available(void);
/* One-time init: panel dimensions + frame/backend identity. Safe to call when
 * unavailable (returns false). Allocates the Nim heap (PSRAM via malloc). */
bool frameos_nim_init(int width, int height, const char *frame_name,
                      uint32_t max_http_response_bytes, const char *backend_url,
                      uint32_t frame_id, const char *api_key,
                      bool server_send_logs, int rotate);
/* Render the current scene into `buf` using the FOS_PIXEL_* wire format.
 * Returns 0 on success. */
int frameos_nim_render(uint8_t *buf, size_t len, int pixel_format);
/* Render the current scene and allocate the packed output after the full RGBA
 * scene image is created. The caller owns `*buf` and must free it with free().
 * This lowers peak PSRAM on large panels. */
int frameos_nim_render_alloc(uint8_t **buf, size_t *len, int pixel_format);
/* Backward-compatible 1bpp entrypoint used by older builds/tests. */
int frameos_nim_render_1bpp(uint8_t *buf, size_t len);
/* Free-form info string (Nim/runtime versions, render counter). */
const char *frameos_nim_info(void);
/* JSON with current interpreted-scene state and selectable scenes. */
const char *frameos_nim_scene_info_json(void);
/* JSON state for the active interpreted scene. */
const char *frameos_nim_scene_state_json(void);
/* Select an interpreted scene by id; the next render initializes it. */
bool frameos_nim_set_scene(const char *scene_id);

/* Install interpreted scenes from JSON (the backend's scenes.json array
 * format); code nodes run on QuickJS, app nodes on the AOT-compiled standard
 * library. Returns the number of scenes loaded (0 = bad payload or runtime
 * unavailable). Hot-swaps live scenes. */
int frameos_nim_load_scenes(const char *json);
/* Drop the Nim side's cached service settings (app secrets); the next app
 * use refetches them. Called when the ETag'd settings poll sees changes. */
void frameos_nim_invalidate_settings(void);
/* Install the service settings the settings poll just fetched
 * (docs/cloud-frames.md, "Service settings"). `json` is the `settings` OBJECT
 * — group → field → value — for the six cloud-owned groups (frameOS, github,
 * homeAssistant, immich, openAI, unsplash), never the whole response envelope.
 * Each of the six absent from it is DELETED on the device; no other settings
 * key is touched. "{}" (or NULL) clears all six, which is what a
 * `403 insufficient_scope` means. Values never appear in a log line. */
void frameos_nim_apply_service_settings(const char *json);
/* Refresh interval requested by the active scene, seconds; 0 = no opinion. */
double frameos_nim_scene_interval(void);
/* Sleep override from the scene's last render (logic/nextSleepDuration);
 * negative = no override. Consult only right after a successful render. */
double frameos_nim_next_sleep(void);
/* True once when a scene event requested a redraw (clears the flag). */
bool frameos_nim_render_requested(void);
/* Deliver a JSON event payload to the current interpreted scene. */
bool frameos_nim_send_event(const char *event, const char *payload_json);

/* Provided by the firmware for the Nim side (logging hook). */
void frameos_nim_log_hook(const char *msg);

/* Recent-log ring (see frameos_nim_glue.c). Entries come back oldest-first;
 * each `line` is a strdup the caller must free. `timestamp` is epoch seconds
 * (values before ~1e9 mean the clock was not SNTP-synced yet). */
#define FOS_NIM_LOG_RING_CAP 128
typedef struct {
    double timestamp;
    char *line;
} frameos_log_entry_t;
size_t frameos_nim_log_recent(frameos_log_entry_t *out, size_t max);
/* Optional tap invoked with every structured log line (on the logging
 * task!). Used by the cloud client to forward logs over its WebSocket; the
 * tap must be cheap and never block. Pass NULL to remove. */
void frameos_nim_set_log_tap(void (*tap)(const char *line));
/* Enable/disable backend log upload after network state changes. The baked
 * config still gates this; passing true has no effect when logs are disabled. */
void frameos_nim_set_log_upload_enabled(bool enabled);
/* Send queued Nim/runtime logs to the FrameOS backend, if enabled. */
void frameos_nim_flush_logs(void);

/* Outbound HTTP(S) for the Nim side (apps, frameos.fetchText in JS apps):
 * esp_http_client + cert bundle. Returns a malloc'd body (caller frees with
 * fos_nim_http_free), sets *out_status and *out_len. Transport and size
 * errors are returned as HTTP-like status 599 with a short diagnostic body;
 * NULL is reserved for allocation failures before an error body can be made. */
uint8_t *fos_nim_http_request(const char *method, const char *url,
                              const void *body, size_t body_len,
                              const char *headers, size_t headers_len,
                              int timeout_ms, size_t max_bytes,
                              int *out_status, size_t *out_len);
void fos_nim_http_free(void *ptr);

/* Chunked variant: the body is returned as a malloc'd array of fixed-size
 * PSRAM chunks, so no download ever needs one large contiguous allocation.
 * Image decoders consume the chunks as segments. Free the array and its
 * buffers with fos_nim_http_free_chunks. Error semantics match
 * fos_nim_http_request (single status-599 chunk with a diagnostic body). */
typedef struct {
    uint8_t *data;
    size_t len;
} fos_nim_http_chunk;

fos_nim_http_chunk *fos_nim_http_request_chunked(
                              const char *method, const char *url,
                              const void *body, size_t body_len,
                              const char *headers, size_t headers_len,
                              int timeout_ms, size_t max_bytes,
                              int *out_status, size_t *out_chunk_count);
void fos_nim_http_free_chunks(fos_nim_http_chunk *chunks, size_t count);

/* Spill-capable variant. Behaves exactly like fos_nim_http_request_chunked
 * until PSRAM buffering would breach the free-memory reserve; then, if a
 * spill directory has been registered (fos_nim_http_set_spill_dir) and both
 * out_spill_path/out_spill_len are non-NULL, the ENTIRE body is streamed to
 * a temp file instead of failing with an OOM error. On spill the returned
 * chunk array holds a single empty chunk, *out_spill_path is a malloc'd
 * path (free with fos_nim_http_free; the caller also owns deleting the
 * file) and *out_spill_len is the body size. Passing NULL spill out-params
 * disables spilling for that request. */
fos_nim_http_chunk *fos_nim_http_request_chunked_spill(
                              const char *method, const char *url,
                              const void *body, size_t body_len,
                              const char *headers, size_t headers_len,
                              int timeout_ms, size_t max_bytes,
                              int *out_status, size_t *out_chunk_count,
                              char **out_spill_path, size_t *out_spill_len);

/* Registers where oversized HTTP bodies may spill (empty/NULL disables —
 * the boot default, keeping the feature off until the firmware wires it).
 * max_spill_bytes additionally caps a single spilled body, on top of the
 * request's own max_bytes; 0 = no extra cap (SD card). Intended wiring:
 * /srv/assets/.cache when the SD card mounts, else /state (SPIFFS) with a
 * small cap derived from esp_spiffs_info free space. Call from one task
 * before renders start; leftover http-spill-*.tmp files from a crash should
 * be swept at boot. */
void fos_nim_http_set_spill_dir(const char *dir, size_t max_spill_bytes);
/* Debug knob: force bodies to spill once `threshold` bytes are buffered,
 * even with PSRAM free (0 = off). Lets the spill decode path be validated
 * on frames that would otherwise never hit real memory pressure. */
void fos_nim_http_set_spill_force_bytes(size_t threshold);

#ifdef __cplusplus
}
#endif
