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
/* The scene canvas: one PSRAM block of `len` bytes claimed once and kept for
 * the device's uptime (fos_display_canvas_bytes() for the selected panel).
 * Call at boot, before Wi-Fi, so the multi-MB contiguous run exists before
 * the heap fragments; the Nim renderer draws every frame into it. Returns
 * false (and keeps any earlier reservation) when PSRAM cannot supply it;
 * the renderer then falls back to its heap. */
bool frameos_nim_reserve_canvas(size_t len);
/* The reserved block, claiming (or growing) it on demand. NULL on failure. */
void *frameos_nim_canvas_buffer(size_t len);
size_t frameos_nim_canvas_reserved(void);
/* One-time init: panel dimensions + the backend credentials the runtime's own
 * uploads use. Safe to call when unavailable (returns false). Allocates the
 * Nim heap (PSRAM via malloc). */
bool frameos_nim_init(int width, int height, const char *frame_name,
                      uint32_t max_http_response_bytes, const char *backend_url,
                      const char *api_key, bool server_send_logs, int rotate);
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
/* Same, but gives up after timeout_ms (-1 = wait forever) and returns NULL
 * when the runtime is busy rendering. For tasks that must stay responsive
 * (the cloud WebSocket task's hello/get_state): a render holds the runtime
 * lock for its whole duration, over a minute on a 13.3" panel. */
const char *frameos_nim_scene_info_json_wait(int timeout_ms);
/* JSON state for the active interpreted scene. */
const char *frameos_nim_scene_state_json(void);
const char *frameos_nim_scene_state_json_wait(int timeout_ms);
/* Select an interpreted scene by id; the next render initializes it. */
bool frameos_nim_set_scene(const char *scene_id);

/* Install interpreted scenes from JSON (the backend's scenes.json array
 * format); code nodes run on QuickJS, app nodes on the AOT-compiled standard
 * library. Returns the number of scenes loaded (0 = bad payload or runtime
 * unavailable). Hot-swaps live scenes. */
int frameos_nim_load_scenes(const char *json);
/* Lazy scene loading (fos_scenes.c per-scene store). The catalog is every
 * scene available on flash — ids and names only, nothing parsed — so a frame
 * can list and switch scenes while holding just one in memory. load_scene
 * makes exactly one resident, tearing down the previous one. */
int frameos_nim_set_scene_catalog(const char *index_json);
int frameos_nim_load_scene(const char *scene_json);
/* Install the service settings the settings poll just fetched
 * (docs/cloud-frames.md, "Service settings"). `json` is the `settings` OBJECT
 * — group → field → value — for the six cloud-owned groups (frameOS, github,
 * homeAssistant, immich, openAI, unsplash), never the whole response envelope.
 * Each of the six absent from it is DELETED on the device; no other settings
 * key is touched. "{}" (or NULL) clears all six, which is what a
 * `403 insufficient_scope` means. Values never appear in a log line. */
void frameos_nim_apply_service_settings(const char *json);
/* Refresh interval requested by the active scene, seconds; 0 = no opinion. */
/* Per-node memory profile in the interpreter (console `set debug 1`). */
void frameos_nim_set_debug(int enabled);
/* Value-pipeline differential: 0 materializes every image edge. */
void frameos_nim_set_fusion(int enabled);
/* Fallback fit for image consumers without their own placement
 * (contain/cover/stretch/center; console `set scaling_mode`, settings sync,
 * cloud set_settings). Applied live — no restart. */
void frameos_nim_set_scaling_mode(const char *mode);
/* Facts for the built-in status screen (drawn when no scene is loaded):
 * a JSON object with name, panel, ip, portal, portal_ssid, portal_ip,
 * cloud_url, cloud_state, cloud_connected, backend_url, version. Push it
 * before a render pass that may draw that screen; stored, not rendered. */
void frameos_nim_set_status_info(const char *info_json);
/* The frame's IANA time zone name (frameConfig.timeZone in scenes: the
 * weather app's open-meteo `timezone=`, `frame.timeZone` in JS apps). The
 * C side installs the matching POSIX rule itself (fos_tz.h); this only
 * tells scenes the name. "" = UTC. Applied live. */
void frameos_nim_set_time_zone(const char *time_zone);
/* Load a per-zone tzdata slice (lib/tz.nim shape) into chrono and get back
 * the POSIX TZ rule in force for `time_zone` now, for setenv("TZ"). False
 * (rule_out = "") when the runtime is not up — thin clients have no chrono
 * and keep UTC — or the slice does not hold the zone. */
bool frameos_nim_load_tz_data(const char *slice_json, const char *time_zone, char *rule_out, size_t rule_len);
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

/* Streaming GET: the caller pulls the body off the socket in pieces, so no
 * copy of it is ever buffered in PSRAM or spilled to flash. Same policy,
 * redirect and error handling as the buffering fetch. Returns NULL with a
 * diagnostic in err_buf on transport failure; an HTTP error status comes
 * back as an open stream with *out_status >= 400 (read the body for the
 * detail, or just close it). *out_content_length is -1 when the response
 * has no Content-Length. */
typedef struct fos_nim_http_stream fos_nim_http_stream;
fos_nim_http_stream *fos_nim_http_stream_open(
    const char *url, const char *headers, size_t headers_len,
    int timeout_ms, int *out_status, int64_t *out_content_length,
    char *err_buf, size_t err_buf_len);
/* > 0 bytes read, 0 at end of body, < 0 on a transport error. */
int fos_nim_http_stream_read(fos_nim_http_stream *stream, void *buf, size_t len);
void fos_nim_http_stream_close(fos_nim_http_stream *stream);

#ifdef __cplusplus
}
#endif
