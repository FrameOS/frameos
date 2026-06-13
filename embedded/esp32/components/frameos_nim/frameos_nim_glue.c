/* Glue between the firmware and the Nim-generated C (nimcache/).
 * Owns NimMain() (one-shot Nim module init), the log hook, and the
 * outbound-HTTP hook the Nim http_client HAL calls into. */
#include "frameos_nim.h"

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

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
extern bool fos_nim_init_impl(int width, int height, const char *name, int max_http_response_bytes,
                              const char *backend_url, int frame_id);
extern int fos_nim_render_impl(uint8_t *buf, size_t len, int pixel_format);
extern int fos_nim_render_1bpp_impl(uint8_t *buf, size_t len);
extern const char *fos_nim_info_impl(void);
extern const char *fos_nim_scene_info_json_impl(void);
extern const char *fos_nim_scene_state_json_impl(void);
extern bool fos_nim_set_scene_impl(const char *scene_id);
extern int fos_nim_load_scenes_impl(const char *json);
extern double fos_nim_scene_interval_impl(void);
extern bool fos_nim_render_requested_impl(void);
extern bool fos_nim_send_event_impl(const char *event, const char *payload_json);

static bool s_nim_started = false;
static bool s_nim_ready = false;
static SemaphoreHandle_t s_nim_lock = NULL;
static char s_backend_url[256] = "";
static char s_backend_embedded_prefix[320] = "";
static char s_backend_auth[192] = "";

static bool nim_lock_take(void)
{
    if (s_nim_lock == NULL) return true;
    return xSemaphoreTake(s_nim_lock, portMAX_DELAY) == pdTRUE;
}

static void nim_lock_give(void)
{
    if (s_nim_lock != NULL) xSemaphoreGive(s_nim_lock);
}

bool frameos_nim_available(void) { return true; }

static void configure_backend_auth(const char *backend_url, uint32_t frame_id, const char *api_key)
{
    s_backend_url[0] = '\0';
    s_backend_embedded_prefix[0] = '\0';
    s_backend_auth[0] = '\0';
    if (backend_url == NULL || backend_url[0] == '\0') return;

    strlcpy(s_backend_url, backend_url, sizeof(s_backend_url));
    size_t len = strlen(s_backend_url);
    while (len > 0 && s_backend_url[len - 1] == '/') {
        s_backend_url[--len] = '\0';
    }
    if (s_backend_url[0] == '\0') return;

    snprintf(s_backend_embedded_prefix, sizeof(s_backend_embedded_prefix),
             "%s/api/frames/%lu/embedded/", s_backend_url, (unsigned long)frame_id);
    if (api_key != NULL && api_key[0] != '\0') {
        snprintf(s_backend_auth, sizeof(s_backend_auth), "Bearer %s", api_key);
    }
}

bool frameos_nim_init(int width, int height, const char *frame_name,
                      uint32_t max_http_response_bytes, const char *backend_url,
                      uint32_t frame_id, const char *api_key)
{
    configure_backend_auth(backend_url, frame_id, api_key);
    if (s_nim_lock == NULL) {
        s_nim_lock = xSemaphoreCreateMutex();
        if (s_nim_lock == NULL) {
            ESP_LOGW("fos_nim", "failed to create Nim runtime mutex");
        }
    }
    if (!nim_lock_take()) return false;
    if (!s_nim_started) {
        NimMain();
        s_nim_started = true;
    }
    s_nim_ready = fos_nim_init_impl(width, height, frame_name, (int)max_http_response_bytes,
                                    s_backend_url, (int)frame_id);
    nim_lock_give();
    return s_nim_ready;
}

int frameos_nim_render(uint8_t *buf, size_t len, int pixel_format)
{
    if (!s_nim_ready) return -1;
    if (!nim_lock_take()) return -1;
    int result = fos_nim_render_impl(buf, len, pixel_format);
    nim_lock_give();
    return result;
}

int frameos_nim_render_1bpp(uint8_t *buf, size_t len)
{
    return frameos_nim_render(buf, len, 1);
}

const char *frameos_nim_info(void)
{
    if (!s_nim_ready) return "nim runtime compiled in, not initialized";
    if (!nim_lock_take()) return "nim runtime busy";
    const char *info = fos_nim_info_impl();
    nim_lock_give();
    return info;
}

const char *frameos_nim_scene_info_json(void)
{
    if (!s_nim_ready) return "{\"loaded\":0,\"available\":0,\"hasScene\":false,\"scenes\":[]}";
    if (!nim_lock_take()) return "{\"loaded\":0,\"available\":0,\"hasScene\":false,\"busy\":true,\"scenes\":[]}";
    const char *json = fos_nim_scene_info_json_impl();
    nim_lock_give();
    return json;
}

const char *frameos_nim_scene_state_json(void)
{
    if (!s_nim_ready) return "{}";
    if (!nim_lock_take()) return "{\"busy\":true}";
    const char *json = fos_nim_scene_state_json_impl();
    nim_lock_give();
    return json;
}

bool frameos_nim_set_scene(const char *scene_id)
{
    if (!s_nim_ready || scene_id == NULL) return false;
    if (!nim_lock_take()) return false;
    bool ok = fos_nim_set_scene_impl(scene_id);
    nim_lock_give();
    return ok;
}

int frameos_nim_load_scenes(const char *json)
{
    if (!s_nim_ready || json == NULL) return 0;
    if (!nim_lock_take()) return 0;
    int count = fos_nim_load_scenes_impl(json);
    nim_lock_give();
    return count;
}

double frameos_nim_scene_interval(void)
{
    if (!s_nim_ready) return 0;
    if (!nim_lock_take()) return 0;
    double interval = fos_nim_scene_interval_impl();
    nim_lock_give();
    return interval;
}

bool frameos_nim_render_requested(void)
{
    if (!s_nim_ready) return false;
    if (!nim_lock_take()) return false;
    bool requested = fos_nim_render_requested_impl();
    nim_lock_give();
    return requested;
}

bool frameos_nim_send_event(const char *event, const char *payload_json)
{
    if (!s_nim_ready || event == NULL) return false;
    if (!nim_lock_take()) return false;
    bool ok = fos_nim_send_event_impl(event, payload_json ? payload_json : "{}");
    nim_lock_give();
    return ok;
}

void frameos_nim_log_hook(const char *msg)
{
    ESP_LOGI("nim", "%s", msg);
}

/* ------------------------------------------------------- outbound HTTP */

static const char *TAG = "fos_nim_http";
#define FOS_NIM_HTTP_NIM_COPY_LIMIT (4u * 1024u * 1024u)

static uint8_t *http_error_response(int *out_status, size_t *out_len, const char *fmt, ...)
{
    char message[256];
    va_list args;
    va_start(args, fmt);
    vsnprintf(message, sizeof(message), fmt, args);
    va_end(args);

    size_t len = strlen(message);
    uint8_t *buf = heap_caps_malloc(len + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) buf = malloc(len + 1);
    if (buf == NULL) {
        *out_status = 0;
        *out_len = 0;
        return NULL;
    }
    memcpy(buf, message, len + 1);
    *out_status = 599;
    *out_len = len;
    return buf;
}

static bool should_authorize_backend_url(const char *url)
{
    if (url == NULL || s_backend_embedded_prefix[0] == '\0' || s_backend_auth[0] == '\0') {
        return false;
    }
    size_t prefix_len = strlen(s_backend_embedded_prefix);
    return strncmp(url, s_backend_embedded_prefix, prefix_len) == 0;
}

static char *trim_ascii(char *s)
{
    if (s == NULL) return s;
    while (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n') s++;
    char *end = s + strlen(s);
    while (end > s && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r' || end[-1] == '\n')) {
        *--end = '\0';
    }
    return s;
}

static bool set_extra_headers(esp_http_client_handle_t client, const char *headers, size_t headers_len)
{
    bool has_content_type = false;
    if (headers == NULL || headers_len == 0) return false;

    char *copy = malloc(headers_len + 1);
    if (copy == NULL) {
        ESP_LOGW(TAG, "failed to allocate HTTP header block");
        return false;
    }
    memcpy(copy, headers, headers_len);
    copy[headers_len] = '\0';

    char *line = copy;
    for (char *p = copy; ; p++) {
        if (*p != '\n' && *p != '\0') continue;
        bool done = (*p == '\0');
        *p = '\0';

        char *colon = strchr(line, ':');
        if (colon != NULL) {
            *colon = '\0';
            char *name = trim_ascii(line);
            char *value = trim_ascii(colon + 1);
            if (name[0] != '\0') {
                esp_http_client_set_header(client, name, value);
                if (strcasecmp(name, "Content-Type") == 0) has_content_type = true;
            }
        }

        if (done) break;
        line = p + 1;
    }

    free(copy);
    return has_content_type;
}

uint8_t *fos_nim_http_request(const char *method, const char *url,
                              const void *body, size_t body_len,
                              const char *headers, size_t headers_len,
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
    esp_http_client_set_header(client, "Accept-Encoding", "identity");
    esp_http_client_set_header(client, "User-Agent", "FrameOS-ESP32/1");
    bool has_content_type = set_extra_headers(client, headers, headers_len);
    if (should_authorize_backend_url(url)) {
        esp_http_client_set_header(client, "Authorization", s_backend_auth);
    }

    if (body != NULL && body_len > 0 && !has_content_type) {
        esp_http_client_set_header(client, "Content-Type", "application/json");
    }

    esp_err_t err = esp_http_client_open(client, body_len);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s %s: connect failed: %s", method ? method : "GET", url,
                 esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return http_error_response(out_status, out_len, "connect failed: %s", esp_err_to_name(err));
    }
    if (body != NULL && body_len > 0) {
        if (esp_http_client_write(client, body, body_len) < 0) {
            ESP_LOGW(TAG, "%s %s: body write failed", method, url);
            esp_http_client_cleanup(client);
            return http_error_response(out_status, out_len, "request body write failed");
        }
    }

    int64_t content_length = esp_http_client_fetch_headers(client);
    *out_status = esp_http_client_get_status_code(client);

    if (max_bytes == 0) max_bytes = 10 * 1024 * 1024;
    size_t nim_copy_limit = max_bytes;
    if (nim_copy_limit > FOS_NIM_HTTP_NIM_COPY_LIMIT) {
        nim_copy_limit = FOS_NIM_HTTP_NIM_COPY_LIMIT;
    }
    if (content_length > 0 && (size_t)content_length > nim_copy_limit) {
        ESP_LOGW(TAG, "%s: response too large (%lld > %u)", url,
                 content_length, (unsigned)nim_copy_limit);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return http_error_response(out_status, out_len, "response too large: %lld > %u bytes",
                                   content_length, (unsigned)nim_copy_limit);
    }

    /* Grow in PSRAM; bodies can be multi-MB images. */
    size_t cap = (content_length > 0) ? (size_t)content_length : 16384;
    if (cap > nim_copy_limit) cap = nim_copy_limit;
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
            if (cap >= nim_copy_limit) {
                ESP_LOGW(TAG, "%s: response exceeded %u bytes", url, (unsigned)nim_copy_limit);
                fos_nim_http_free(buf);
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                return http_error_response(out_status, out_len, "response exceeded %u bytes",
                                           (unsigned)nim_copy_limit);
            }
            size_t new_cap = cap * 2;
            if (new_cap > nim_copy_limit) new_cap = nim_copy_limit;
            uint8_t *new_buf = heap_caps_realloc(buf, new_cap + 1,
                                                 MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (new_buf == NULL) new_buf = realloc(buf, new_cap + 1);
            if (new_buf == NULL) {
                fos_nim_http_free(buf);
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                return http_error_response(out_status, out_len, "out of memory growing HTTP response buffer");
            }
            buf = new_buf;
            cap = new_cap;
        }
        int r = esp_http_client_read(client, (char *)buf + total, cap - total);
        if (r < 0) {
            fos_nim_http_free(buf);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return http_error_response(out_status, out_len, "response read failed");
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
