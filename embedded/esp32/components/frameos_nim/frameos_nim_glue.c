/* Glue between the firmware and the Nim-generated C (nimcache/).
 * Owns NimMain() (one-shot Nim module init), the log hook, and the
 * outbound-HTTP hook the Nim http_client HAL calls into. */
#include "frameos_nim.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"

/* Nim's os module calls lstat()/readlink(); newlib/VFS has no symlinks, so
 * stat() is exact and every path is a non-symlink (EINVAL per POSIX). */
int lstat(const char *path, struct stat *st)
{
    return stat(path, st);
}

ssize_t readlink(const char *path, char *buf, size_t bufsize)
{
    (void)path; (void)buf; (void)bufsize;
    errno = EINVAL;
    return -1;
}

extern void NimMain(void);
extern bool fos_nim_init_impl(int width, int height, const char *name, int max_http_response_bytes);
extern int fos_nim_render_impl(uint8_t *buf, size_t len, int pixel_format);
extern int fos_nim_render_1bpp_impl(uint8_t *buf, size_t len);
extern const char *fos_nim_info_impl(void);
extern int fos_nim_load_scenes_impl(const char *json);
extern double fos_nim_scene_interval_impl(void);
extern bool fos_nim_render_requested_impl(void);
extern bool fos_nim_send_event_impl(const char *event, const char *payload_json);

static bool s_nim_started = false;
static bool s_nim_ready = false;

bool frameos_nim_available(void) { return true; }

bool frameos_nim_init(int width, int height, const char *frame_name, uint32_t max_http_response_bytes)
{
    if (!s_nim_started) {
        NimMain();
        s_nim_started = true;
    }
    s_nim_ready = fos_nim_init_impl(width, height, frame_name, (int)max_http_response_bytes);
    return s_nim_ready;
}

int frameos_nim_render(uint8_t *buf, size_t len, int pixel_format)
{
    if (!s_nim_ready) return -1;
    return fos_nim_render_impl(buf, len, pixel_format);
}

int frameos_nim_render_1bpp(uint8_t *buf, size_t len)
{
    return frameos_nim_render(buf, len, 1);
}

const char *frameos_nim_info(void)
{
    if (!s_nim_ready) return "nim runtime compiled in, not initialized";
    return fos_nim_info_impl();
}

int frameos_nim_load_scenes(const char *json)
{
    if (!s_nim_ready || json == NULL) return 0;
    return fos_nim_load_scenes_impl(json);
}

double frameos_nim_scene_interval(void)
{
    if (!s_nim_ready) return 0;
    return fos_nim_scene_interval_impl();
}

bool frameos_nim_render_requested(void)
{
    if (!s_nim_ready) return false;
    return fos_nim_render_requested_impl();
}

bool frameos_nim_send_event(const char *event, const char *payload_json)
{
    if (!s_nim_ready || event == NULL) return false;
    return fos_nim_send_event_impl(event, payload_json ? payload_json : "{}");
}

void frameos_nim_log_hook(const char *msg)
{
    ESP_LOGI("nim", "%s", msg);
}

/* ------------------------------------------------------- outbound HTTP */

static const char *TAG = "fos_nim_http";

uint8_t *fos_nim_http_request(const char *method, const char *url,
                              const void *body, size_t body_len,
                              int timeout_ms, size_t max_bytes,
                              int *out_status, size_t *out_len)
{
    *out_status = 0;
    *out_len = 0;

    esp_http_client_method_t http_method = HTTP_METHOD_GET;
    if (method != NULL) {
        if (strcmp(method, "POST") == 0) http_method = HTTP_METHOD_POST;
        else if (strcmp(method, "PUT") == 0) http_method = HTTP_METHOD_PUT;
        else if (strcmp(method, "PATCH") == 0) http_method = HTTP_METHOD_PATCH;
        else if (strcmp(method, "DELETE") == 0) http_method = HTTP_METHOD_DELETE;
        else if (strcmp(method, "HEAD") == 0) http_method = HTTP_METHOD_HEAD;
    }

    esp_http_client_config_t config = {
        .url = url,
        .method = http_method,
        .timeout_ms = timeout_ms > 0 ? timeout_ms : 30000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 4096,
        .max_redirection_count = 5,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) return NULL;

    if (body != NULL && body_len > 0) {
        if (esp_http_client_get_header(client, "Content-Type", NULL) != ESP_OK) {
            esp_http_client_set_header(client, "Content-Type", "application/json");
        }
    }

    esp_err_t err = esp_http_client_open(client, body_len);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s %s: connect failed: %s", method ? method : "GET", url,
                 esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return NULL;
    }
    if (body != NULL && body_len > 0) {
        if (esp_http_client_write(client, body, body_len) < 0) {
            ESP_LOGW(TAG, "%s %s: body write failed", method, url);
            esp_http_client_cleanup(client);
            return NULL;
        }
    }

    int64_t content_length = esp_http_client_fetch_headers(client);
    *out_status = esp_http_client_get_status_code(client);

    if (max_bytes == 0) max_bytes = 10 * 1024 * 1024;
    if (content_length > 0 && (size_t)content_length > max_bytes) {
        ESP_LOGW(TAG, "%s: response too large (%lld > %u)", url,
                 content_length, (unsigned)max_bytes);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        *out_status = 0;
        return NULL;
    }

    /* Grow in PSRAM; bodies can be multi-MB images. */
    size_t cap = (content_length > 0) ? (size_t)content_length : 16384;
    if (cap > max_bytes) cap = max_bytes;
    if (cap < 1024) cap = 1024;
    uint8_t *buf = heap_caps_malloc(cap + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) buf = malloc(cap + 1);
    if (buf == NULL) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        *out_status = 0;
        return NULL;
    }

    size_t total = 0;
    while (true) {
        if (total == cap) {
            if (cap >= max_bytes) {
                ESP_LOGW(TAG, "%s: response exceeded %u bytes", url, (unsigned)max_bytes);
                fos_nim_http_free(buf);
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                *out_status = 0;
                return NULL;
            }
            size_t new_cap = cap * 2;
            if (new_cap > max_bytes) new_cap = max_bytes;
            uint8_t *new_buf = heap_caps_realloc(buf, new_cap + 1,
                                                 MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (new_buf == NULL) new_buf = realloc(buf, new_cap + 1);
            if (new_buf == NULL) {
                fos_nim_http_free(buf);
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                *out_status = 0;
                return NULL;
            }
            buf = new_buf;
            cap = new_cap;
        }
        int r = esp_http_client_read(client, (char *)buf + total, cap - total);
        if (r < 0) {
            fos_nim_http_free(buf);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            *out_status = 0;
            return NULL;
        }
        if (r == 0) break;
        total += r;
    }

    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    buf[total] = 0;
    *out_len = total;
    return buf;
}

void fos_nim_http_free(void *ptr)
{
    free(ptr); /* heap_caps allocations free through the same heap free */
}
