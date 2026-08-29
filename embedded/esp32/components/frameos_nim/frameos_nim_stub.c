/* Stub used when the Nim runtime hasn't been compiled in (no nimcache/).
 * See build_nim.sh for producing the real thing. */
#include "frameos_nim.h"

#include <stdio.h>

bool frameos_nim_available(void) { return false; }
void frameos_nim_set_render_buffer_hooks(void *(*acquire)(size_t len), void (*release)(void *ptr)) { (void)acquire; (void)release; }
bool frameos_nim_reserve_canvas(size_t len) { (void)len; return false; }
void *frameos_nim_canvas_buffer(size_t len) { (void)len; return NULL; }
size_t frameos_nim_canvas_reserved(void) { return 0; }
bool frameos_nim_init(int width, int height, const char *frame_name,
                      uint32_t max_http_response_bytes, const char *backend_url,
                      const char *api_key, bool server_send_logs, int rotate)
{
    (void)width; (void)height; (void)frame_name; (void)max_http_response_bytes;
    (void)backend_url; (void)api_key; (void)server_send_logs;
    (void)rotate;
    return false;
}
int frameos_nim_render(uint8_t *buf, size_t len, int pixel_format)
{
    (void)buf; (void)len; (void)pixel_format;
    return -1;
}
void frameos_nim_apply_service_settings(const char *json) { (void)json; }
int frameos_nim_set_scene_catalog(const char *index_json) { (void)index_json; return 0; }
int frameos_nim_load_scene(const char *scene_json) { (void)scene_json; return 0; }
int frameos_nim_render_alloc(uint8_t **buf, size_t *len, int pixel_format)
{
    (void)pixel_format;
    if (buf) *buf = NULL;
    if (len) *len = 0;
    return -1;
}
int frameos_nim_render_1bpp(uint8_t *buf, size_t len) { return frameos_nim_render(buf, len, 1); }
const char *frameos_nim_info(void) { return "nim runtime not compiled in"; }
const char *frameos_nim_scene_info_json(void) { return "{\"loaded\":0,\"available\":0,\"hasScene\":false,\"scenes\":[]}"; }
const char *frameos_nim_scene_state_json(void) { return "{}"; }
/* No runtime, no lock to wait for: the _wait variants never time out here. */
const char *frameos_nim_scene_info_json_wait(int timeout_ms) { (void)timeout_ms; return frameos_nim_scene_info_json(); }
const char *frameos_nim_scene_state_json_wait(int timeout_ms) { (void)timeout_ms; return frameos_nim_scene_state_json(); }
bool frameos_nim_scene_snapshot_wait(int timeout_ms, const char **info_json, const char **state_json)
{
    (void)timeout_ms;
    if (info_json) *info_json = frameos_nim_scene_info_json();
    if (state_json) *state_json = frameos_nim_scene_state_json();
    return true;
}
bool frameos_nim_set_scene(const char *scene_id)
{
    (void)scene_id;
    return false;
}
int frameos_nim_load_scenes(const char *json)
{
    (void)json;
    return 0;
}
void frameos_nim_set_debug(int enabled) { (void)enabled; }
void frameos_nim_set_fusion(int enabled) { (void)enabled; }
void frameos_nim_set_scaling_mode(const char *mode) { (void)mode; }
void frameos_nim_set_status_info(const char *info_json) { (void)info_json; }
void frameos_nim_set_time_zone(const char *time_zone) { (void)time_zone; }
bool frameos_nim_load_tz_data(const char *slice_json, const char *time_zone, char *rule_out, size_t rule_len)
{
    (void)slice_json; (void)time_zone;
    if (rule_out && rule_len) rule_out[0] = '\0';
    return false;
}
double frameos_nim_scene_interval(void) { return 0; }
double frameos_nim_next_sleep(void) { return -1; }
bool frameos_nim_render_requested(void) { return false; }
bool frameos_nim_send_event(const char *event, const char *payload_json)
{
    (void)event; (void)payload_json;
    return false;
}
void frameos_nim_log_hook(const char *msg) { (void)msg; }
int frameos_nim_cloud_verb(const char *msg, size_t len, const char *scopes_json,
                           const char *scenes_checksum, bool backend_managed,
                           int timeout_ms, const char **reply_json)
{
    (void)msg; (void)len; (void)scopes_json; (void)scenes_checksum; (void)backend_managed;
    (void)timeout_ms;
    *reply_json = NULL;
    return FRAMEOS_NIM_VERB_NO_RUNTIME;
}
size_t frameos_nim_log_recent(frameos_log_entry_t *out, size_t max)
{
    (void)out; (void)max;
    return 0;
}
void frameos_nim_set_log_tap(void (*tap)(const char *line)) { (void)tap; }
void frameos_nim_set_log_upload_enabled(bool enabled) { (void)enabled; }
void frameos_nim_flush_logs(void) {}
uint8_t *fos_nim_http_request(const char *method, const char *url,
                              const void *body, size_t body_len,
                              const char *headers, size_t headers_len,
                              int timeout_ms, size_t max_bytes,
                              int *out_status, size_t *out_len)
{
    (void)method; (void)url; (void)body; (void)body_len;
    (void)headers; (void)headers_len;
    (void)timeout_ms; (void)max_bytes;
    *out_status = 0;
    *out_len = 0;
    return 0;
}
void fos_nim_http_free(void *ptr) { (void)ptr; }
void fos_nim_http_set_spill_dir(const char *dir, size_t max_spill_bytes)
{
    (void)dir; (void)max_spill_bytes;
}
void fos_nim_http_set_spill_force_bytes(size_t threshold) { (void)threshold; }
fos_nim_http_chunk *fos_nim_http_request_chunked(const char *method, const char *url,
                                                 const void *body, size_t body_len,
                                                 const char *headers, size_t headers_len,
                                                 int timeout_ms, size_t max_bytes,
                                                 int *out_status, size_t *out_chunk_count)
{
    (void)method; (void)url; (void)body; (void)body_len; (void)headers; (void)headers_len;
    (void)timeout_ms; (void)max_bytes;
    if (out_status) *out_status = 0;
    if (out_chunk_count) *out_chunk_count = 0;
    return NULL;
}
fos_nim_http_chunk *fos_nim_http_request_chunked_spill(const char *method, const char *url,
                                                       const void *body, size_t body_len,
                                                       const char *headers, size_t headers_len,
                                                       int timeout_ms, size_t max_bytes,
                                                       int *out_status, size_t *out_chunk_count,
                                                       char **out_spill_path, size_t *out_spill_len)
{
    if (out_spill_path) *out_spill_path = NULL;
    if (out_spill_len) *out_spill_len = 0;
    return fos_nim_http_request_chunked(method, url, body, body_len, headers, headers_len,
                                        timeout_ms, max_bytes, out_status, out_chunk_count);
}
void fos_nim_http_free_chunks(fos_nim_http_chunk *chunks, size_t count) { (void)chunks; (void)count; }
fos_nim_http_stream *fos_nim_http_stream_open(const char *url, const char *headers, size_t headers_len,
                                              int timeout_ms, int *out_status, int64_t *out_content_length,
                                              char *err_buf, size_t err_buf_len)
{
    (void)url; (void)headers; (void)headers_len; (void)timeout_ms;
    if (out_status) *out_status = 0;
    if (out_content_length) *out_content_length = -1;
    if (err_buf && err_buf_len > 0) snprintf(err_buf, err_buf_len, "nim runtime not compiled in");
    return NULL;
}
int fos_nim_http_stream_read(fos_nim_http_stream *stream, void *buf, size_t len)
{
    (void)stream; (void)buf; (void)len;
    return -1;
}
void fos_nim_http_stream_close(fos_nim_http_stream *stream) { (void)stream; }
