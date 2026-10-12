/* One HTTP client for the firmware's small pulls and posts. See the header. */
#include "fos_backend_http.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"

#include "fos_config.h"
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

/* The body, however it is delimited: Content-Length sizes the buffer once;
 * a chunked answer grows it up to the cap. */
static void read_body(esp_http_client_handle_t client, size_t max_body, fos_http_response_t *res)
{
    if (res->content_length > (int64_t)max_body) {
        res->too_large = true;
        return;
    }
    size_t cap = res->content_length > 0 ? (size_t)res->content_length
                 : max_body < FOS_HTTP_FIRST_CHUNK ? max_body
                                                   : FOS_HTTP_FIRST_CHUNK;
    char *buf = fos_big_malloc(cap + 1);
    if (buf == NULL) return;
    size_t total = 0;
    while (true) {
        if (total == cap) {
            if (cap >= max_body) {
                /* More than the cap and still coming. */
                res->too_large = true;
                free(buf);
                return;
            }
            size_t new_cap = cap * 2 > max_body ? max_body : cap * 2;
            char *grown = fos_big_realloc(buf, new_cap + 1);
            if (grown == NULL) {
                free(buf);
                return;
            }
            buf = grown;
            cap = new_cap;
        }
        int r = esp_http_client_read(client, buf + total, (int)(cap - total));
        if (r < 0) {
            free(buf);
            return;
        }
        if (r == 0) break;
        total += (size_t)r;
    }
    buf[total] = '\0';
    res->body = buf;
    res->body_len = total;
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
    esp_http_client_config_t http_config = {
        .url = req->url,
        .method = req->body ? HTTP_METHOD_POST : HTTP_METHOD_GET,
        .timeout_ms = req->timeout_ms > 0 ? req->timeout_ms : 15000,
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
    esp_err_t err = esp_http_client_open(client, body_len);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s: connect failed: %s", req->url, fos_http_err_name(err));
        esp_http_client_cleanup(client);
        return err;
    }
    if (body_len > 0 && esp_http_client_write(client, req->body, body_len) != body_len) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }
    res->content_length = esp_http_client_fetch_headers(client);
    res->status = esp_http_client_get_status_code(client);
    if (max_body > 0 && res->status != 304 && res->status != 204) {
        read_body(client, max_body, res);
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return ESP_OK;
}
