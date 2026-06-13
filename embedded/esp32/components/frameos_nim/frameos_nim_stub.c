/* Stub used when the Nim runtime hasn't been compiled in (no nimcache/).
 * See build_nim.sh for producing the real thing. */
#include "frameos_nim.h"

bool frameos_nim_available(void) { return false; }
bool frameos_nim_init(int width, int height, const char *frame_name, uint32_t max_http_response_bytes)
{
    (void)width; (void)height; (void)frame_name; (void)max_http_response_bytes;
    return false;
}
int frameos_nim_render(uint8_t *buf, size_t len, int pixel_format)
{
    (void)buf; (void)len; (void)pixel_format;
    return -1;
}
int frameos_nim_render_1bpp(uint8_t *buf, size_t len) { return frameos_nim_render(buf, len, 1); }
const char *frameos_nim_info(void) { return "nim runtime not compiled in"; }
int frameos_nim_load_scenes(const char *json)
{
    (void)json;
    return 0;
}
double frameos_nim_scene_interval(void) { return 0; }
bool frameos_nim_render_requested(void) { return false; }
bool frameos_nim_send_event(const char *event, const char *payload_json)
{
    (void)event; (void)payload_json;
    return false;
}
uint8_t *fos_nim_http_request(const char *method, const char *url,
                              const void *body, size_t body_len,
                              int timeout_ms, size_t max_bytes,
                              int *out_status, size_t *out_len)
{
    (void)method; (void)url; (void)body; (void)body_len;
    (void)timeout_ms; (void)max_bytes;
    *out_status = 0;
    *out_len = 0;
    return 0;
}
void fos_nim_http_free(void *ptr) { (void)ptr; }
