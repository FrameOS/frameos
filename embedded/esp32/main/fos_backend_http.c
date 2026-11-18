/* One HTTP client for the firmware's small pulls and posts. See the header. */
#include "fos_backend_http.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "fos_config.h"
#include "fos_http_body.h"
#include "fos_mem.h"

static const char *TAG = "fos_http";

/* A body of unknown length (chunked) starts here and doubles up to the cap. */
#define FOS_HTTP_FIRST_CHUNK (16 * 1024)

static esp_err_t collect_etag_handler(esp_http_client_event_t *evt)
{
    if (evt->event_id == HTTP_EVENT_ON_HEADER && strcasecmp(evt->header_key, "ETag") == 0) {
        fos_http_response_t *res = (fos_http_response_t *)evt->user_data;
        snprintf(res->etag, sizeof(res->etag), "%s", evt->header_value);
    }
    return ESP_OK;
}

bool fos_backend_url(const char *suffix, char *out, size_t out_len)
{
    const fos_config_t *config = fos_config();
    if (!config->backend_url[0] || config->frame_id == 0) {
        out[0] = '\0';
        return false;
    }
    int n = snprintf(out, out_len, "%s/api/frames/%lu%s", config->backend_url,
                     (unsigned long)config->frame_id, suffix ? suffix : "");
    return n > 0 && (size_t)n < out_len;
}

void fos_backend_auth(char *out, size_t out_len)
{
    snprintf(out, out_len, "Bearer %s", fos_config()->api_key);
}

void fos_http_response_free(fos_http_response_t *res)
{
    free(res->body);
    res->body = NULL;
    res->body_len = 0;
}

/* Between two tries for a body's buffer (alloc_wait_ms). */
#define FOS_HTTP_ALLOC_RETRY_MS 100

typedef struct {
    esp_http_client_handle_t client;
    int alloc_wait_ms;
} body_io_ctx_t;

static int body_io_read(void *ctx, char *buf, int len)
{
    return esp_http_client_read(((body_io_ctx_t *)ctx)->client, buf, len);
}

/* The body's first buffer, in one block. A render beside the download (the
 * link task's) holds the PSRAM it needs for a second or two on an e-paper
 * board; the answer waits in the socket meanwhile. */
static void *body_io_alloc(void *ctx, size_t bytes)
{
    int wait_ms = ((body_io_ctx_t *)ctx)->alloc_wait_ms;
    void *buf = fos_big_malloc(bytes);
    int64_t until = esp_timer_get_time() + (int64_t)wait_ms * 1000;
    while (buf == NULL && esp_timer_get_time() < until) {
        vTaskDelay(pdMS_TO_TICKS(FOS_HTTP_ALLOC_RETRY_MS));
        buf = fos_big_malloc(bytes);
    }
    if (buf == NULL) {
        ESP_LOGW(TAG, "no %u-byte block for the body (PSRAM largest %u of %u free)", (unsigned)bytes,
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    }
    return buf;
}

static void *body_io_realloc(void *ctx, void *ptr, size_t bytes)
{
    (void)ctx;
    return fos_big_realloc(ptr, bytes);
}

static void body_io_free(void *ctx, void *ptr)
{
    (void)ctx;
    free(ptr);
}

static void read_body(esp_http_client_handle_t client, size_t max_body, const fos_http_request_t *req,
                      fos_http_response_t *res)
{
    body_io_ctx_t ctx = {.client = client, .alloc_wait_ms = req->alloc_wait_ms};
    fos_http_body_io_t io = {
        .read = body_io_read, .alloc = body_io_alloc, .realloc = body_io_realloc, .free = body_io_free, .ctx = &ctx,
    };
    fos_http_body_err_t err;
    if (req->scene_set == NULL) {
        err = fos_http_body_read(res->content_length, max_body, FOS_HTTP_FIRST_CHUNK, &io, &res->body, &res->body_len);
    } else {
        /* Too much to hold: each scene to the sink as it is read. Else each
         * into a block of its own (no sink), up to what is held. */
        const fos_scene_sink_t *sink = req->scene_sink;
        if (sink != NULL && !(req->scene_held_max == 0 || res->content_length > (int64_t)req->scene_held_max)) {
            if (req->scene_held_max < max_body) max_body = req->scene_held_max;
            sink = NULL;
        }
        res->spooled = sink != NULL;
        err = fos_scene_pieces_read_to(res->content_length, max_body, &io, sink, req->scene_set);
    }
    res->too_large = err == FOS_HTTP_BODY_TOO_LARGE;
    res->body_err = err == FOS_HTTP_BODY_OK || err == FOS_HTTP_BODY_TOO_LARGE ? ESP_OK
                    : err == FOS_HTTP_BODY_NO_MEMORY                          ? ESP_ERR_NO_MEM
                    : err == FOS_HTTP_BODY_INVALID                            ? ESP_ERR_INVALID_RESPONSE
                                                                              : ESP_FAIL;
    if (err == FOS_HTTP_BODY_READ_FAILED) {
        ESP_LOGW(TAG, "body read failed or cut short (%lld bytes declared)", (long long)res->content_length);
    }
}

/* A connect that fails within this long never waited on the network: the
 * peer refused or the route was not there. A connect that spent timeout_ms
 * is not retried, it would only double the wait on an unreachable host. */
#define FOS_HTTP_FAST_CONNECT_FAIL_US (2 * 1000 * 1000)
/* A backend that is up accepts a connection in milliseconds (a TLS handshake
 * in a second or two), so the connect gets a short timeout of its own and the
 * request and its reply keep the long one, as the log upload does
 * (frameos_nim_glue.c). With the request's 15-30 s on the connect, a backend
 * whose host answers ping but whose port is closed or filtered cost ~18 s per
 * round trip, three to a pass (the hardware bench, 2026-11-15). */
#define FOS_HTTP_CONNECT_TIMEOUT_MS 5000
#define FOS_HTTPS_CONNECT_TIMEOUT_MS 10000
#define FOS_HTTP_CONNECT_RETRY_DELAY_MS 1000

static uint32_t s_connect_retries = 0;

uint32_t fos_http_connect_retries(void)
{
    return s_connect_retries;
}

const char *fos_http_err_name(esp_err_t err)
{
    switch (err) {
    case ESP_ERR_HTTP_MAX_REDIRECT: return "ESP_ERR_HTTP_MAX_REDIRECT";
    case ESP_ERR_HTTP_CONNECT: return "ESP_ERR_HTTP_CONNECT";
    case ESP_ERR_HTTP_WRITE_DATA: return "ESP_ERR_HTTP_WRITE_DATA";
    case ESP_ERR_HTTP_FETCH_HEADER: return "ESP_ERR_HTTP_FETCH_HEADER";
    case ESP_ERR_HTTP_INVALID_TRANSPORT: return "ESP_ERR_HTTP_INVALID_TRANSPORT";
    case ESP_ERR_HTTP_CONNECTING: return "ESP_ERR_HTTP_CONNECTING";
    case ESP_ERR_HTTP_EAGAIN: return "ESP_ERR_HTTP_EAGAIN";
    case ESP_ERR_HTTP_CONNECTION_CLOSED: return "ESP_ERR_HTTP_CONNECTION_CLOSED";
#ifdef ESP_ERR_HTTP_READ_TIMEOUT
    case ESP_ERR_HTTP_READ_TIMEOUT: return "ESP_ERR_HTTP_READ_TIMEOUT";
#endif
#ifdef ESP_ERR_HTTP_INCOMPLETE_DATA
    case ESP_ERR_HTTP_INCOMPLETE_DATA: return "ESP_ERR_HTTP_INCOMPLETE_DATA";
#endif
    default: return esp_err_to_name(err);
    }
}

esp_err_t fos_http_fetch(const fos_http_request_t *req, size_t max_body, fos_http_response_t *res)
{
    memset(res, 0, sizeof(*res));
    int timeout_ms = req->timeout_ms > 0 ? req->timeout_ms : 15000;
    int connect_timeout_ms = strncmp(req->url, "https://", 8) == 0 ? FOS_HTTPS_CONNECT_TIMEOUT_MS
                                                                   : FOS_HTTP_CONNECT_TIMEOUT_MS;
    if (connect_timeout_ms > timeout_ms) connect_timeout_ms = timeout_ms;
    esp_http_client_config_t http_config = {
        .url = req->url,
        .method = req->body ? HTTP_METHOD_POST : HTTP_METHOD_GET,
        .timeout_ms = connect_timeout_ms,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = req->buffer_size > 0 ? req->buffer_size : 2048,
        .event_handler = collect_etag_handler,
        .user_data = res,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (client == NULL) return ESP_ERR_NO_MEM;
    if (req->auth) esp_http_client_set_header(client, "Authorization", req->auth);
    if (req->if_none_match && req->if_none_match[0]) {
        esp_http_client_set_header(client, "If-None-Match", req->if_none_match);
    }
    if (req->no_store) esp_http_client_set_header(client, "Cache-Control", "no-store");
    if (req->body) esp_http_client_set_header(client, "Content-Type", "application/json");

    int body_len = req->body ? (int)strlen(req->body) : 0;
    int64_t open_started_us = esp_timer_get_time();
    esp_err_t err = esp_http_client_open(client, body_len);
    if (err == ESP_ERR_HTTP_CONNECT &&
        esp_timer_get_time() - open_started_us < FOS_HTTP_FAST_CONNECT_FAIL_US) {
        /* The first request after a deep-sleep wake did this twice in one
         * day on an E1004: scenes and settings both refused within the same
         * millisecond, the log upload 0.7 s later went through, and the
         * pass rendered without the account's keys. One retry, one second
         * on; the metrics line counts them (httpConnectRetries). */
        s_connect_retries++;
        ESP_LOGW(TAG, "%s: connect refused, retrying once", req->url);
        esp_http_client_close(client);
        vTaskDelay(pdMS_TO_TICKS(FOS_HTTP_CONNECT_RETRY_DELAY_MS));
        err = esp_http_client_open(client, body_len);
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s: connect failed: %s", req->url, fos_http_err_name(err));
        esp_http_client_cleanup(client);
        return err;
    }
    esp_http_client_set_timeout_ms(client, timeout_ms);
    if (body_len > 0 && esp_http_client_write(client, req->body, body_len) != body_len) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }
    res->content_length = esp_http_client_fetch_headers(client);
    res->status = esp_http_client_get_status_code(client);
    if (res->status == 200 && req->skip_etag != NULL && req->skip_etag[0] && strcmp(res->etag, req->skip_etag) == 0) {
        res->skipped = true;
    } else if (max_body > 0 && res->status != 304 && res->status != 204 &&
               (req->scene_set == NULL || res->status == 200)) {
        read_body(client, max_body, req, res);
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return ESP_OK;
}
