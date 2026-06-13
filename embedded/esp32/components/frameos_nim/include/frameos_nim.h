/*
 * C surface of the FrameOS Nim runtime (M2: Nim core on the metal).
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
                      uint32_t frame_id, const char *api_key);
/* Render the current scene into `buf` using the FOS_PIXEL_* wire format.
 * Returns 0 on success. */
int frameos_nim_render(uint8_t *buf, size_t len, int pixel_format);
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

/* M3: interpreted scenes. Install scenes from JSON (the backend's
 * scenes.json array format); code nodes run on QuickJS, app nodes on the
 * AOT-compiled standard library. Returns the number of scenes loaded
 * (0 = bad payload or runtime unavailable). Hot-swaps live scenes. */
int frameos_nim_load_scenes(const char *json);
/* Refresh interval requested by the active scene, seconds; 0 = no opinion. */
double frameos_nim_scene_interval(void);
/* True once when a scene event requested a redraw (clears the flag). */
bool frameos_nim_render_requested(void);
/* Deliver a JSON event payload to the current interpreted scene. */
bool frameos_nim_send_event(const char *event, const char *payload_json);

/* Provided by the firmware for the Nim side (logging hook). */
void frameos_nim_log_hook(const char *msg);

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

#ifdef __cplusplus
}
#endif
